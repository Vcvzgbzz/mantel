import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { inject, spansOf, split } from "../src/hearth.js";
import { Mantel } from "../src/mantel.js";
import { serve } from "../src/server.js";
import { fakeEmbedder, fakeReranker, type Fake } from "./helpers.js";

const fakes: Fake[] = [];
const servers: Server[] = [];
after(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  for (const s of servers) s.close();
});

async function node(hearth: Record<string, unknown> | null) {
  const embed = await fakeEmbedder();
  const rerank = await fakeReranker();
  fakes.push(embed, rerank);
  const m = Mantel.open({
    db: ":memory:",
    embed: { url: embed.url, model: "fake-embed", trust: "local" },
    rerank: { url: rerank.url, model: "fake-rerank", trust: "local", threshold: 0.6 },
    ...(hearth ? { hearth } : {}),
  });
  const tenant = m.store.createTenant("t");
  const { secret } = m.store.createKey(tenant, { scopes: ["read", "write"], audience: "local" });
  const server = await serve(m, "127.0.0.1:0");
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const key = m.authenticate(secret)!;
  const call = (body: unknown, auth = secret) =>
    fetch(`${url}/hooks/hearth`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { m, key, url, secret, call };
}

const routed = (messages: unknown[], o: { target?: string; headers?: Record<string, string>; caller?: string } = {}) => ({
  apiVersion: 1, hook: "routed", kind: "chat",
  request: { id: "req_1", target: o.target ?? "local", caller: o.caller ?? "key:app", headers: o.headers ?? { "x-mantel-user": "u1" }, body: { model: "m", messages } },
});

test("the block mantel adds is found again, and only that block", () => {
  const msgs = inject([{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "which editor?" }], "Saved memories: helix");
  assert.equal(msgs[0]!.content, "earlier", "only the last user message gets memories");
  const s = split(msgs[2]!.content);
  assert.equal(s.memory, "Saved memories: helix");
  assert.equal(s.text, "which editor?");
  assert.deepEqual(split("<mantel-recall> typed by a user, not ours"), { memory: null, text: "<mantel-recall> typed by a user, not ours" });
});

test("the hook is off until configured, and needs a key", async () => {
  const off = await node(null);
  assert.equal((await fetch(`${off.url}/hooks/hearth/manifest`, { headers: { authorization: `Bearer ${off.secret}` } })).status, 404);
  const on = await node({});
  assert.equal((await fetch(`${on.url}/hooks/hearth/manifest`)).status, 401);
  const man = await fetch(`${on.url}/hooks/hearth/manifest`, { headers: { authorization: `Bearer ${on.secret}` } });
  assert.deepEqual(await man.json(), { apiVersion: 1, kinds: { chat: ["routed", "log"] } });
});

test("routed: memories go into the last user message, and a request leaving for a peer gets no private ones", async () => {
  const { m, key, call } = await node({});
  m.create(key, { user: "u1" }, { name: "editor", body: "The user prefers the helix editor.", sensitivity: "normal", origin: "user" });
  m.create(key, { user: "u1" }, { name: "health", body: "The user's editor of choice for medical notes is helix too.", sensitivity: "private", origin: "user" });
  m.create(key, { user: "u2" }, { name: "other", body: "Someone else prefers the helix editor as well.", origin: "user" });
  await m.index!.refresh(key.tenant);

  const local = (await (await call(routed([{ role: "user", content: "user helix editor" }]))).json()) as { decision?: { body: { messages: { content: string }[] } } };
  const text = local.decision!.body.messages.at(-1)!.content;
  assert.match(text, /^<mantel-recall>\n/);
  assert.match(text, /prefers the helix editor/);
  assert.doesNotMatch(text, /Someone else/, "never another user's memories");
  assert.match(text, /\n\nuser helix editor$/, "the question follows the block, unchanged");

  const peer = (await (await call(routed([{ role: "user", content: "user helix editor medical notes" }], { target: "peer" }))).json()) as { decision?: { body: { messages: { content: string }[] } } };
  assert.ok(peer.decision, "normal memories still go to a peer");
  assert.doesNotMatch(peer.decision!.body.messages.at(-1)!.content, /medical notes is helix/, "a private memory never leaves with a request bound for a peer");

  const body = routed([{ role: "user", content: "user helix editor medical notes" }]);
  const cloud = (await (await call({ ...body, request: { ...body.request, target: "local", leaves: true } })).json()) as { decision?: { body: { messages: { content: string }[] } } };
  assert.doesNotMatch(cloud.decision!.body.messages.at(-1)!.content, /medical notes is helix/, "nor with one bound for a cloud provider, which hearth calls local");
});

test("routed: nobody named, no memory; a caller can be mapped to a user", async () => {
  const { m, key, call } = await node({ callers: { "key:pi": "u1" } });
  m.create(key, { user: "u1" }, { name: "editor", body: "The user prefers the helix editor.", origin: "user" });
  await m.index!.refresh(key.tenant);
  const q = [{ role: "user", content: "user helix editor" }];
  assert.deepEqual(await (await call(routed(q, { headers: {} }))).json(), {}, "no header and no mapping: nothing recalled, nothing shared");
  const mapped = (await (await call(routed(q, { headers: {}, caller: "key:pi" }))).json()) as { decision?: unknown };
  assert.ok(mapped.decision, "the caller's mapping names the user");
});

test("log: an exchange becomes an episode once; recalled memories are never learned from again", async () => {
  const { m, key, call } = await node({ localTools: ["bash"] });
  const asked = inject([{ role: "user", content: "remember that I switched to zed" }], "Saved memories: prefers helix");
  const exchange = {
    apiVersion: 1, hook: "log", kind: "chat",
    exchange: {
      id: "req_9", caller: "key:app", status: 200, headers: { "x-mantel-user": "u1" }, reply: "Noted: zed.",
      body: { messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash" } }, { id: "c2", function: { name: "fetch" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "tool", tool_call_id: "c2", content: "page" },
        ...asked,
      ] },
    },
  };
  assert.deepEqual(await (await call(exchange)).json(), {});
  assert.deepEqual(await (await call(exchange)).json(), {}, "hearth may send it again");
  const jobs = m.listJobs(key);
  assert.equal(jobs.length, 1, "one request, one episode");
  const spans = m.store.db.prepare("SELECT role, origin, content FROM spans ORDER BY seq").all() as { role: string; origin: string; content: string }[];
  assert.deepEqual(spans.map((s) => `${s.role}/${s.origin}`), ["tool/tool", "tool/web", "memory/memory", "user/user", "assistant/agent"], "the reply follows a user turn, which clears the web taint");
  assert.equal(spans[2]!.content, "Saved memories: prefers helix");
  assert.equal(spans[3]!.content, "remember that I switched to zed");

  const failed = { ...exchange, exchange: { ...exchange.exchange, id: "req_10", status: 500 } };
  await call(failed);
  assert.equal(m.listJobs(key).length, 1, "a failed request is not learned from");
});

test("spans name a tool from the assistant's call when the tool message does not", () => {
  const s = spansOf([{ role: "assistant", content: "", tool_calls: [{ id: "x", function: { name: "bash" } }] }, { role: "tool", tool_call_id: "x", content: "done" }], null, ["bash"]);
  assert.deepEqual(s, [{ role: "tool", content: "done", tool: "bash", origin: "tool" }]);
});
