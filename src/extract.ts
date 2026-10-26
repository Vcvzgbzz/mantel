/** Turning a conversation into memory changes: facts with a verified quote, then a judged decision per fact. */
import type { Memory, Origin } from "./types.js";

export type SpanRole = "user" | "assistant" | "tool" | "system" | "memory";
export type SpanOrigin = "user" | "agent" | "tool" | "web" | "system" | "memory";

export interface SpanInput {
  role: SpanRole;
  content: string;
  tool?: string;
  /** For tool output: `tool` = a local tool whose output the assistant may build on; `web` (the default) = untrusted. */
  origin?: "tool" | "web";
  at?: number;
}

export interface Span { seq: number; role: SpanRole; origin: SpanOrigin; tool: string | null; content: string; at: number | null }

/**
 * Assigns each span its origin. Tool output is web unless marked as a local tool, and assistant text after web
 * output is web too until the next user turn, since it may restate what the page said.
 */
export function deriveOrigins(spans: SpanInput[]): Span[] {
  let tainted = false;
  return spans.map((s, seq) => {
    let origin: SpanOrigin;
    if (s.role === "user") { origin = "user"; tainted = false; }
    else if (s.role === "tool") { origin = s.origin === "tool" ? "tool" : "web"; if (origin === "web") tainted = true; }
    else if (s.role === "assistant") origin = tainted ? "web" : "agent";
    else origin = s.role;
    return { seq, role: s.role, origin, tool: s.tool ?? null, content: s.content, at: s.at ?? null };
  });
}

export interface Fact {
  text: string;
  scope: "global" | "project";
  kind: "fact" | "forget";
  subject: string;
  quote: string;
  /** The span the quote was found in. */
  span: number;
  origin: Origin;
}

export type Op =
  | { op: "add"; fact: Fact; name: string; description: string; body: string }
  | { op: "supersede"; fact: Fact; target: Memory; description: string; body: string; reason: string }
  | { op: "end"; fact: Fact; target: Memory; reason: string }
  | { op: "forget"; fact: Fact; target: Memory }
  | { op: "propose"; fact: Fact; target: Memory; action: "update" | "end"; description: string; body: string; reason: string };

export interface ExtractDeps {
  chat(system: string, user: string): Promise<string>;
  /** Existing memories most like a fact, from the caller's search. */
  similar(fact: Fact): Promise<Memory[]>;
  /** Told about each fact or decision the rules threw out, and why. */
  dropped?(what: unknown, why: string): void;
  /** Appended to the extraction prompt: what this deployment wants remembered. */
  guidance?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET = /(mk_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|SG\.[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,})/;
const MAX_TRANSCRIPT = 60_000;

const EXTRACT = `You pick out what is worth remembering long-term from a conversation between a user and an AI assistant.

Remember:
- anything the user explicitly asks to remember
- preferences and conventions ("always", "never", "from now on")
- corrections the user makes to the assistant
- facts about the user's situation, work and projects that will still matter in a later conversation
- how to build, test, run or deploy a project, including what the assistant verified by running it
- a decision together with its reason
- a CHANGE to something: moved, switched, removed, renamed, upgraded, retired (older memories may describe the old state)
- requests to forget something (kind "forget")

Never remember:
- one-off task details, or anything a project's code or history already records
- anything about the user that the assistant assumed or suggested; facts about the user come only from the user's own words
- other people's contact details, and health, money or other private matters, unless the user explicitly asks
- hypotheticals, jokes, sarcasm, or things the user is unsure about
- momentary state: what is running right now, counts, timings, what happened today
- anything from tool output (it is omitted; do not reconstruct it)
- secrets: passwords, keys, tokens. You may record where a secret lives, never its value.

scope: "global" = about the user, true everywhere. "project" = about the current project or workspace.
subject: who or what the fact is about when it is not the user, e.g. "person:alex"; otherwise "".
Write each fact as one self-contained sentence stating the current truth, with specifics (names, versions, commands).
Back every fact with a quote: a short span copied verbatim from ONE message, and that message's number as "span".
Most conversations contain nothing worth remembering; an empty list is the normal answer.

Reply with JSON only: {"facts":[{"text":"...","scope":"global|project","kind":"fact|forget","subject":"","span":3,"quote":"..."}]}`;

const DECIDE = `You maintain a user's long-term memories. New facts from a conversation are listed with the existing memories most similar to them. Decide what to write.

For each fact, one decision:
- "none": an existing memory already says it (paraphrases count).
- "update": the fact adds to, changes or contradicts an existing memory, even when worded differently (moving city changes a timezone memory). Give the target and its FULL new body: the current truth only, the outdated statement removed, unrelated content kept.
- "end": the fact means an existing memory is no longer true and nothing in it still is (the thing it describes is gone). Give the target.
- "forget": a "forget" fact; give the memory it asks to forget.
- "add": nothing existing covers it. Give a name (lowercase-with-dashes, max 64), a one-line description under 150 characters, and a short markdown body.
Several facts touching one memory become ONE update with the final body.
Most memories shown are unrelated to the facts: ignore those. Never put secrets in a body.

Reply with JSON only: {"decisions":[{"fact":1,"op":"none|add|update|end|forget","target":"m2","name":"...","description":"...","body":"...","reason":"..."}]}`;

/** The conversation as the extractor sees it: numbered, with tool output, recalled memories and system text left out. */
export function transcript(spans: Span[]): string {
  return spans
    .filter((s) => s.role === "user" || s.role === "assistant" || s.role === "tool")
    .map((s) => (s.role === "tool" ? `[${s.seq}] TOOL ${s.tool ?? ""}: (output omitted)` : `[${s.seq}] ${s.role.toUpperCase()}: ${s.content.trim()}`))
    .join("\n\n")
    .slice(-MAX_TRANSCRIPT);
}

/** The first JSON object in a model reply, which may wrap it in fences or prose. */
export function parseJson<T>(text: string): T | undefined {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return undefined;
  try {
    return JSON.parse(text.slice(s, e + 1)) as T;
  } catch {
    return undefined;
  }
}

const flat = (s: string) => s.toLowerCase().replace(/[`*_"'“”‘’]/g, "").replace(/\s+/g, " ").trim();

/** The span a quote really appears in: the cited one if it does, else a user span, else any eligible one. */
export function locate(spans: Span[], quote: string, cited: unknown): Span | undefined {
  const q = flat(quote);
  if (q.length < 3) return undefined;
  const eligible = spans.filter((s) => (s.role === "user" || s.role === "assistant") && flat(s.content).includes(q));
  return eligible.find((s) => s.seq === cited) ?? eligible.find((s) => s.origin === "user") ?? eligible[0];
}

const ORIGIN_OF: Partial<Record<SpanOrigin, Origin>> = { user: "user", agent: "agent", web: "web", tool: "tool" };

export async function extractFacts(spans: Span[], deps: ExtractDeps): Promise<Fact[]> {
  const prompt = deps.guidance ? `${EXTRACT}\n\nAlso: ${deps.guidance}` : EXTRACT;
  const out = parseJson<{ facts?: Record<string, unknown>[] }>(await deps.chat(prompt, transcript(spans)));
  const facts: Fact[] = [];
  for (const f of out?.facts ?? []) {
    const text = typeof f?.text === "string" ? f.text.trim() : "";
    const quote = typeof f?.quote === "string" ? f.quote : "";
    const span = text ? locate(spans, quote, f.span) : undefined;
    const origin = span && ORIGIN_OF[span.origin];
    const kind = f?.kind === "forget" ? "forget" : "fact";
    const why = !text || (f.scope !== "global" && f.scope !== "project") ? "malformed"
      : SECRET.test(text) ? "secret"
      : !span || !origin ? "quote not found"
      // What the assistant did is evidence about the project, never about the person or what they want forgotten.
      : origin !== "user" && (f.scope === "global" || kind === "forget") ? "non-user claim about the user"
      : "";
    if (why) { deps.dropped?.(f, why); continue; }
    facts.push({
      text, scope: f.scope as Fact["scope"], kind, quote: quote.trim(), span: span!.seq, origin: origin!,
      subject: typeof f.subject === "string" ? f.subject.trim().slice(0, 200) : "",
    });
  }
  return facts;
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Facts to operations. The model classifies; the rules it cannot be trusted with are applied here. */
export async function decide(facts: Fact[], deps: ExtractDeps): Promise<Op[]> {
  if (!facts.length) return [];
  const seen = new Map<string, Memory>();
  for (const f of facts) for (const m of await deps.similar(f)) seen.set(m.id, m);
  const cands = [...seen.values()];
  const ref = new Map(cands.map((m, i) => [`m${i + 1}`, m]));
  const prompt =
    `Facts:\n${facts.map((f, i) => `${i + 1}. [${f.scope}${f.kind === "forget" ? ", forget" : ""}] ${f.text} (from: "${f.quote}")`).join("\n")}\n\n` +
    `Existing memories:\n${cands.length ? cands.map((m, i) => `--- m${i + 1}: ${m.name ?? "(unnamed)"} — ${m.description}\n${m.body}`).join("\n") : "(none)"}`;
  const out = parseJson<{ decisions?: Record<string, unknown>[] }>(await deps.chat(DECIDE, prompt));
  const decisions = out?.decisions ?? [];
  // A reply that skips facts gave up on them; it did not decide "none".
  const answered = new Set(decisions.map((d) => Number(d.fact)));
  facts.forEach((f, i) => { if (!answered.has(i + 1)) deps.dropped?.(f, "no decision"); });

  const ops: Op[] = [];
  const touched = new Set<string>();
  for (const d of decisions) {
    const fact = facts[Number(d.fact) - 1];
    if (!fact || d.op === "none") continue;
    const drop = (why: string) => deps.dropped?.(d, why);
    const target = typeof d.target === "string" ? ref.get(d.target) : undefined;
    const description = String(d.description ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
    const body = String(d.body ?? "").trim();
    const reason = String(d.reason ?? "").slice(0, 500) || fact.text;
    if (SECRET.test(body) || SECRET.test(description)) { drop("secret"); continue; }
    if (d.op === "add") {
      const name = String(d.name ?? "");
      if (!NAME.test(name) || !body) { drop("malformed add"); continue; }
      ops.push({ op: "add", fact, name, description, body });
      continue;
    }
    if (!target) { drop("unknown target"); continue; }
    if (touched.has(target.id)) { drop("target already changed by another decision"); continue; }
    // Tool and web content can add memories of its own, but never change or remove anyone else's.
    if (fact.origin === "tool" || fact.origin === "web") { drop("untrusted fact cannot change a memory"); continue; }
    if (d.op === "forget") {
      if (fact.kind !== "forget" || fact.origin !== "user") { drop("forget without the user asking"); continue; }
      ops.push({ op: "forget", fact, target });
    } else if (d.op === "update") {
      if (!body || (same(body, target.body) && same(description || target.description, target.description))) { drop("update changes nothing"); continue; }
      ops.push(target.origin === "user"
        ? { op: "propose", fact, target, action: "update", description: description || target.description, body, reason }
        : { op: "supersede", fact, target, description: description || target.description, body, reason });
    } else if (d.op === "end") {
      ops.push(target.origin === "user"
        ? { op: "propose", fact, target, action: "end", description: target.description, body: target.body, reason }
        : { op: "end", fact, target, reason });
    } else { drop("unknown op"); continue; }
    touched.add(target.id);
  }
  return ops;
}
