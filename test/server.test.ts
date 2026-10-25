import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Server } from "node:http";

import { serve } from "../src/server.js";
import { open } from "./helpers.js";

const m = open();
let server: Server;
let base = "";
let admin = "";

before(async () => {
  const tenant = m.store.createTenant("acme");
  admin = m.store.createKey(tenant, { scopes: ["admin"], audience: "local" }).secret;
  server = await serve(m, "127.0.0.1:0");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((ok) => server.close(() => ok())));

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = admin) =>
  fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test("requests need a valid key", async () => {
  assert.equal((await call("GET", "/v1/memories", undefined, {}, "mk_nope")).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("create, edit with If-Match, read history", async () => {
  const created = await call("POST", "/v1/memories", { name: "tz", body: "Timezone is UTC.", validFrom: "2026-01-01T00:00:00Z" });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("etag"), '"1"');
  const m = (await created.json()) as { id: string; validFrom: string };
  assert.equal(m.validFrom, "2026-01-01T00:00:00.000Z");

  assert.equal((await call("PATCH", `/v1/memories/${m.id}`, { body: "Timezone is CET." })).status, 412, "If-Match is required");
  const ok = await call("PATCH", `/v1/memories/${m.id}`, { body: "Timezone is CET." }, { "if-match": '"1"' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("etag"), '"2"');
  assert.equal((await call("PATCH", `/v1/memories/${m.id}`, { body: "Timezone is PST." }, { "if-match": '"1"' })).status, 412);

  const revs = (await (await call("GET", `/v1/memories/${m.id}/revisions`)).json()) as { revisions: { version: number }[] };
  assert.deepEqual(revs.revisions.map((r) => r.version), [2, 1]);
});

test("keys minted over the API are scoped", async () => {
  const res = await call("POST", "/v1/keys", { scopes: ["read"], user: "alice", label: "alice reader" });
  assert.equal(res.status, 201);
  const { secret } = (await res.json()) as { secret: string };
  assert.equal((await call("POST", "/v1/memories", { body: "x" }, {}, secret)).status, 403);
  assert.equal((await call("GET", "/v1/memories?user=bob", undefined, {}, secret)).status, 403);
  assert.equal((await call("GET", "/v1/keys", undefined, {}, secret)).status, 403);
});

test("recall and search answer over HTTP", async () => {
  await call("POST", "/v1/memories", { name: "lang", body: "Writes TypeScript daily." });
  const s = (await (await call("POST", "/v1/search", { query: "typescript" })).json()) as { results: { memory: { name: string } }[] };
  assert.ok(s.results.some((r) => r.memory.name === "lang"));
  const r = (await (await call("POST", "/v1/recall", { query: "typescript" })).json()) as { mode: string; memories: unknown[] };
  assert.equal(r.mode, "none", "no models configured");
  assert.equal((await call("POST", "/v1/recall", {})).status, 400);
});

test("erase is a DELETE and leaves nothing to read", async () => {
  const m1 = (await (await call("POST", "/v1/memories", { body: "temporary" })).json()) as { id: string };
  assert.equal((await call("DELETE", `/v1/memories/${m1.id}`)).status, 204);
  assert.equal((await call("GET", `/v1/memories/${m1.id}`)).status, 404);
});

test("unknown routes and wrong methods are told apart", async () => {
  assert.equal((await call("GET", "/v1/nope")).status, 404);
  assert.equal((await call("PUT", "/v1/memories")).status, 405);
});
