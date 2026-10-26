import assert from "node:assert/strict";
import { after, test } from "node:test";

import { MantelError } from "../src/errors.js";
import { deriveOrigins } from "../src/extract.js";
import { fakeChat, open, tenantKey, type Fake } from "./helpers.js";

const fakes: Fake[] = [];
after(() => Promise.all(fakes.map((f) => f.close())));

type Chat = Awaited<ReturnType<typeof fakeChat>>;

/** Scripts the extractor: these facts, then decisions built from the shown memories' refs (by name). */
function script(chat: Chat, facts: unknown[], decisions: (ref: (name: string) => string | undefined) => unknown[] = () => []) {
  chat.reply = (system, user) => {
    if (system.startsWith("You pick out")) return JSON.stringify({ facts });
    const refs = new Map([...user.matchAll(/^--- (m\d+): (\S+)/gm)].map((m) => [m[2]!, m[1]!]));
    return "Sure:\n```json\n" + JSON.stringify({ decisions: decisions((n) => refs.get(n)) }) + "\n```";
  };
}

async function setup(o: { chatTrust?: "local" | "remote"; retainDays?: number } = {}) {
  const chat = await fakeChat();
  fakes.push(chat);
  const m = open({ chat, ...o });
  const key = tenantKey(m);
  return { m, key, chat };
}

test("tool output is web unless marked local, and taints assistant text until the next user turn", () => {
  const s = deriveOrigins([
    { role: "user", content: "q" },
    { role: "tool", content: "page", tool: "fetch" },
    { role: "assistant", content: "it says x" },
    { role: "user", content: "ok" },
    { role: "tool", content: "PASS", tool: "shell", origin: "tool" },
    { role: "assistant", content: "tests pass" },
    { role: "memory", content: "recalled" },
  ]);
  assert.deepEqual(s.map((x) => x.origin), ["user", "web", "web", "user", "tool", "agent", "memory"]);
});

test("a fact restated from a web page is stored as web and never recalled or allowed to change a memory", async () => {
  const { m, key, chat } = await setup();
  const mine = m.create(key, {}, { name: "node-lts", body: "Uses Node 20.", origin: "agent" });
  script(chat,
    [{ text: "The current Node LTS codename is Jod.", scope: "project", kind: "fact", span: 2, quote: "The current LTS codename is Jod" }],
    (ref) => [{ fact: 1, op: "update", target: ref("node-lts"), body: "Uses Node 22 (Jod)." }]);
  m.ingest(key, {}, { spans: [
    { role: "user", content: "what's the node LTS codename?" },
    { role: "tool", content: "Node.js 22 'Jod' is the active LTS", tool: "web_fetch" },
    { role: "assistant", content: "The current LTS codename is Jod." },
  ] });
  await m.worker.settle();
  assert.equal(m.get(key, mine.id).body, "Uses Node 20.", "the update from a web-derived fact was refused");
  assert.equal(m.get(key, mine.id).status, "active");

  script(chat, [{ text: "The current Node LTS codename is Jod.", scope: "project", kind: "fact", span: 2, quote: "The current LTS codename is Jod" }],
    () => [{ fact: 1, op: "add", name: "node-lts-codename", description: "Node LTS codename", body: "Jod." }]);
  m.ingest(key, {}, { spans: [
    { role: "user", content: "and again?" },
    { role: "tool", content: "Jod", tool: "web_fetch" },
    { role: "assistant", content: "The current LTS codename is Jod." },
  ] });
  await m.worker.settle();
  const added = m.list(key, {}, { name: "node-lts-codename" }).memories[0]!;
  assert.equal(added.origin, "web");
  assert.ok(!(await m.search(key, {}, "codename Jod")).some((c) => c.memory.id === added.id));
});

test("facts need a quote that is really in the conversation, and only the user speaks for the user", async () => {
  const { m, key, chat } = await setup();
  script(chat, [
    { text: "Likes tea.", scope: "global", kind: "fact", span: 0, quote: "something nobody said" },
    { text: "The user is an expert.", scope: "global", kind: "fact", span: 1, quote: "you are clearly an expert" },
    { text: "Prefers dark mode.", scope: "global", kind: "fact", span: 0, quote: "i prefer DARK mode" },
  ], () => [{ fact: 1, op: "add", name: "dark-mode", description: "Theme", body: "Prefers dark mode." }]);
  const { job } = m.ingest(key, {}, { spans: [
    { role: "user", content: "I prefer dark mode, always." },
    { role: "assistant", content: "Noted, you are clearly an expert." },
  ] });
  await m.worker.settle();
  const done = m.job(key, job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result?.dropped, { "quote not found": 1, "non-user claim about the user": 1 });
  const dm = m.list(key, {}, { name: "dark-mode" }).memories[0]!;
  assert.equal(dm.origin, "user");
  const ev = m.evidence(key, dm.id);
  assert.equal(ev[0]!.quote, "i prefer DARK mode");
  assert.ok(ev[0]!.context.some((c) => c.cited && c.text.startsWith("I prefer dark mode")));
});

test("a change supersedes the agent's memory; a person's memory only gets a proposal", async () => {
  const { m, key, chat } = await setup();
  const deploy = m.create(key, { project: "web" }, { name: "deploy", body: "Deploys with rsync.", origin: "agent" });
  const tz = m.create(key, {}, { name: "timezone", body: "Timezone is UTC.", origin: "user" });
  script(chat, [
    { text: "The web app now deploys as a container image.", scope: "project", kind: "fact", span: 0, quote: "we deploy a container image now" },
    { text: "The user moved to Berlin, so their timezone changed.", scope: "global", kind: "fact", span: 0, quote: "I moved to Berlin" },
  ], (ref) => [
    { fact: 1, op: "update", target: ref("deploy"), body: "Deploys as a container image.", reason: "switched" },
    { fact: 2, op: "update", target: ref("timezone"), body: "Timezone is Europe/Berlin.", reason: "moved" },
  ]);
  m.ingest(key, { project: "web" }, { spans: [{ role: "user", content: "FYI we deploy a container image now, and I moved to Berlin." }] });
  await m.worker.settle();

  assert.equal(m.get(key, deploy.id).status, "superseded");
  const next = m.list(key, { project: "web" }, { name: "deploy" }).memories[0]!;
  assert.equal(next.body, "Deploys as a container image.");
  assert.equal(m.get(key, deploy.id).supersededBy, next.id);

  assert.equal(m.get(key, tz.id).body, "Timezone is UTC.", "a person's memory is never rewritten automatically");
  const [p] = m.proposals(key);
  assert.equal(p!.memoryId, tz.id);
  const accepted = m.resolveProposal(key, p!.id, true)!;
  assert.equal(accepted.body, "Timezone is Europe/Berlin.");
  assert.equal(accepted.origin, "user");
  assert.equal(m.get(key, tz.id).status, "superseded");
  assert.equal(m.proposals(key).length, 0);
});

test("a proposal for a memory edited since is refused", async () => {
  const { m, key, chat } = await setup();
  const tz = m.create(key, {}, { name: "timezone", body: "Timezone is UTC.", origin: "user" });
  script(chat, [{ text: "Timezone changed: moved to Berlin.", scope: "global", kind: "fact", span: 0, quote: "moved to Berlin" }],
    (ref) => [{ fact: 1, op: "update", target: ref("timezone"), body: "Timezone is Europe/Berlin." }]);
  m.ingest(key, {}, { spans: [{ role: "user", content: "I moved to Berlin" }] });
  await m.worker.settle();
  m.update(key, tz.id, 1, { body: "Timezone is Asia/Tokyo." });
  const [p] = m.proposals(key);
  assert.throws(() => m.resolveProposal(key, p!.id, true), (e: unknown) => e instanceof MantelError && e.code === "precondition_failed");
});

test("end marks a memory no longer true; forget erases it, but only when the user asks", async () => {
  const { m, key, chat } = await setup();
  const car = m.create(key, {}, { name: "car", body: "Drives a 2012 Civic.", origin: "agent" });
  const pet = m.create(key, {}, { name: "pet", body: "Has a cat.", origin: "agent" });
  script(chat, [
    { text: "Sold the car.", scope: "global", kind: "fact", span: 0, quote: "sold the civic" },
    { text: "Forget the cat.", scope: "global", kind: "forget", span: 0, quote: "forget about my cat" },
  ], (ref) => [{ fact: 1, op: "end", target: ref("car") }, { fact: 2, op: "forget", target: ref("pet") }]);
  m.ingest(key, {}, { spans: [{ role: "user", content: "I sold the Civic. Also forget about my cat." }] });
  await m.worker.settle();
  const ended = m.get(key, car.id);
  assert.equal(ended.status, "superseded");
  assert.ok(ended.validTo !== null && ended.supersededBy === null);
  assert.throws(() => m.get(key, pet.id));
});

test("idempotency keys, visible failure, and private episodes stay off remote models", async () => {
  const { m, key, chat } = await setup({ chatTrust: "remote" });
  const a = m.ingest(key, {}, { spans: [{ role: "user", content: "hi" }] }, "session-1:0");
  const b = m.ingest(key, {}, { spans: [{ role: "user", content: "hi" }] }, "session-1:0");
  assert.equal(a.job.id, b.job.id);
  assert.equal(b.created, false);

  const p = m.ingest(key, {}, { spans: [{ role: "user", content: "my diagnosis is X" }], sensitivity: "private" });
  chat.seen.length = 0;
  await m.worker.settle();
  assert.equal(m.job(key, p.job.id).result?.skipped, "private episode and the extraction model is remote");
  assert.ok(!JSON.stringify(chat.seen).includes("diagnosis"));

  chat.down = true;
  const f = m.ingest(key, {}, { spans: [{ role: "user", content: "remember this" }] });
  await m.worker.settle();
  const j = m.job(key, f.job.id);
  assert.equal(j.status, "queued", "a failure is retried later");
  assert.match(j.error ?? "", /HTTP 503/);
});

test("episodes are deleted once extracted unless retention keeps them", async () => {
  for (const [retainDays, kept] of [[0, 0], [7, 1]] as const) {
    const { m, key, chat } = await setup({ retainDays });
    script(chat, []);
    m.ingest(key, {}, { spans: [{ role: "user", content: "nothing much" }] });
    await m.worker.settle();
    assert.equal((m.store.db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n, kept);
  }
});
