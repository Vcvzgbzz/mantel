/**
 * mantel as a hearth plugin: recall into a chat request after hearth has routed it, and send the finished
 * exchange to extraction. Where the request runs decides what may be recalled: a request going to a peer
 * only ever gets memories that may leave this machine.
 */
import { createHash } from "node:crypto";

import type { SpanInput } from "./extract.js";
import type { Mantel } from "./mantel.js";
import type { Requested } from "./scope.js";
import type { ApiKey } from "./store.js";

export interface HearthHookConfig {
  /** A header the caller sets naming the mantel user. */
  userHeader: string;
  /** A header naming the project; absent is project-wide memories only. */
  projectHeader: string;
  /** hearth callers (`key:<label>`, `local`) and the mantel user each one is. */
  callers: Record<string, string>;
  /** Tools whose output the assistant may build on; every other tool counts as the web. */
  localTools: string[];
  k: number;
  /** How many of the latest messages go to extraction with each reply. */
  contextMessages: number;
}

export const HEARTH_DEFAULTS: HearthHookConfig = {
  userHeader: "x-mantel-user", projectHeader: "x-mantel-project", callers: {}, localTools: [], k: 3, contextMessages: 6,
};

/** What hearth reads at startup: the kinds and stages this plugin handles. */
export const MANIFEST = { apiVersion: 1, kinds: { chat: ["routed", "log"] } };

const OPEN = "<mantel-recall>";
const CLOSE = "</mantel-recall>";
const BLOCK = new RegExp(`^${OPEN}\\n[\\s\\S]*?\\n${CLOSE}\\n\\n`);

type Part = { type?: string; text?: string };
type Message = { role?: string; content?: string | Part[] | null; name?: string; tool_call_id?: string; tool_calls?: { id?: string; function?: { name?: string } }[] };

const textOf = (c: Message["content"]): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text!).join("\n") : "";

/** The memories block, put first in the last user message: late in the prompt, so the start of it stays cached. */
export function inject(messages: Message[], block: string): Message[] {
  const i = messages.map((m) => m.role).lastIndexOf("user");
  if (i < 0) return messages;
  const tagged = `${OPEN}\n${block}\n${CLOSE}\n\n`;
  const m = messages[i]!;
  const content = Array.isArray(m.content) ? [{ type: "text", text: tagged }, ...m.content] : tagged + (m.content ?? "");
  return messages.map((x, j) => (j === i ? { ...x, content } : x));
}

/** A user message split back into what mantel added and what the user wrote. */
export function split(content: Message["content"]): { memory: string | null; text: string } {
  const all = textOf(content);
  const hit = BLOCK.exec(all);
  return hit ? { memory: hit[0].slice(OPEN.length + 1, -(CLOSE.length + 3)), text: all.slice(hit[0].length) } : { memory: null, text: all };
}

/** Messages as extraction spans: what mantel recalled is a memory span, which extraction never learns from. */
export function spansOf(messages: Message[], reply: string | null, localTools: readonly string[]): SpanInput[] {
  const toolNames = new Map<string, string>();
  for (const m of messages) for (const c of m.tool_calls ?? []) if (c.id && c.function?.name) toolNames.set(c.id, c.function.name);
  const out: SpanInput[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const { memory, text } = split(m.content);
      if (memory !== null) out.push({ role: "memory", content: memory });
      if (text.trim()) out.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t.trim()) out.push({ role: "assistant", content: t });
    } else if (m.role === "tool") {
      const tool = m.name ?? (m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined) ?? "";
      out.push({ role: "tool", content: textOf(m.content), ...(tool ? { tool } : {}), origin: localTools.includes(tool) ? "tool" : "web" });
    } else if (m.role === "system") {
      out.push({ role: "system", content: textOf(m.content) });
    }
  }
  if (reply?.trim()) out.push({ role: "assistant", content: reply });
  return out;
}

interface HookBody {
  hook?: string;
  kind?: string;
  request?: { id?: string; target?: string; caller?: string; headers?: Record<string, string>; body?: { messages?: Message[] } };
  exchange?: { id?: string; caller?: string; status?: number; headers?: Record<string, string>; body?: { messages?: Message[] }; reply?: string | null };
}

/** Who the request is for. Nobody named means no memory at all, rather than a shared one. */
function whom(key: ApiKey, cfg: HearthHookConfig, headers: Record<string, string>, caller: string | undefined): Requested | null {
  const project = headers[cfg.projectHeader];
  const base: Requested = project ? { project } : {};
  if (key.user !== null) return base;
  const user = headers[cfg.userHeader] ?? (caller ? cfg.callers[caller] : undefined);
  return user ? { ...base, user } : null;
}

/** One hook call from hearth. Answers `{decision}` for `routed`; `log` returns at once and works in the background. */
export async function hearthHook(mantel: Mantel, key: ApiKey, cfg: HearthHookConfig, b: HookBody): Promise<Record<string, unknown>> {
  if (b.kind !== "chat") return {};
  if (b.hook === "routed" && b.request) {
    const r = b.request;
    const messages = r.body?.messages;
    if (!Array.isArray(messages)) return {};
    const who = whom(key, cfg, r.headers ?? {}, r.caller);
    const last = [...messages].reverse().find((m) => m.role === "user");
    const q = last ? split(last.content).text : "";
    if (!who || !q.trim()) return {};
    // A request leaving for a peer gets only memories that may leave this machine.
    const audience = r.target === "peer" ? "remote" : "local";
    const out = await mantel.recall(key, { ...who, audience }, q, { k: cfg.k });
    if (!out.hits.length) return {};
    return { decision: { body: { ...r.body, messages: inject(messages, out.context) } } };
  }
  if (b.hook === "log" && b.exchange) {
    const x = b.exchange;
    const messages = x.body?.messages;
    if (!Array.isArray(messages) || (x.status ?? 200) >= 400) return {};
    const who = whom(key, cfg, x.headers ?? {}, x.caller);
    if (!who) return {};
    const spans = spansOf(messages.slice(-cfg.contextMessages), x.reply ?? null, cfg.localTools);
    if (!spans.some((s) => s.role === "user")) return {};
    // One episode per request: hearth may retry a hook, and the same request is never extracted twice.
    const idem = `hearth:${x.id ?? createHash("sha256").update(JSON.stringify(spans)).digest("hex").slice(0, 32)}`;
    mantel.ingest(key, who, { spans, source: "hearth" }, idem);
    return {};
  }
  return {};
}
