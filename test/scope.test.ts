import assert from "node:assert/strict";
import { test } from "node:test";

import { MantelError } from "../src/errors.js";
import { open, tenantKey } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof MantelError && e.code === c;

test("a pinned key cannot widen its user or project", () => {
  const m = open();
  const key = tenantKey(m, { user: "alice", project: "web" });
  assert.throws(() => m.create(key, { user: "bob" }, { body: "x" }), code("forbidden"));
  assert.throws(() => m.create(key, { project: "api" }, { body: "x" }), code("forbidden"));
  assert.throws(() => m.list(key, { project: "*" }), code("forbidden"));
  const a = m.create(key, {}, { body: "in web" });
  assert.deepEqual([a.user, a.project], ["alice", "web"]);
  const g = m.create(key, { project: "" }, { body: "everywhere" });
  assert.equal(g.project, "");
});

test("users see their own memories and shared ones, never each other's", () => {
  const m = open();
  const app = tenantKey(m);
  const alice = tenantKey(m, { user: "alice" });
  const bob = tenantKey(m, { user: "bob" });
  const mine = m.create(alice, {}, { body: "alice's" });
  const shared = m.create(app, {}, { body: "for everyone" });
  assert.deepEqual(m.list(bob, {}).memories.map((x) => x.id), [shared.id]);
  assert.throws(() => m.get(bob, mine.id), code("not_found"));
  assert.equal(m.get(app, mine.id).id, mine.id, "an unpinned key sees the whole tenant by id");
});

test("a user-pinned key cannot change shared memories", () => {
  const m = open();
  const app = tenantKey(m);
  const alice = tenantKey(m, { user: "alice" });
  const shared = m.create(app, {}, { body: "house rules" });
  assert.throws(() => m.update(alice, shared.id, 1, { body: "no rules" }), code("forbidden"));
  assert.throws(() => m.erase(alice, shared.id), code("forbidden"));
});

test("tenants are isolated", () => {
  const m = open();
  const a = tenantKey(m, { tenant: "a" });
  const b = tenantKey(m, { tenant: "b" });
  const x = m.create(a, {}, { body: "tenant a" });
  assert.throws(() => m.get(b, x.id), code("not_found"));
  assert.equal(m.list(b, {}).memories.length, 0);
});

test("a remote-audience key never reads private memories and cannot ask for local", () => {
  const m = open();
  const local = tenantKey(m, { audience: "local" });
  const remote = tenantKey(m, { audience: "remote" });
  const p = m.create(local, {}, { body: "private thing", sensitivity: "private" });
  assert.throws(() => m.get(remote, p.id), code("not_found"));
  assert.equal(m.list(remote, {}).memories.length, 0);
  assert.throws(() => m.list(remote, { audience: "local" }), code("forbidden"));
  assert.equal(m.list(local, { audience: "remote" }).memories.length, 0, "a local key can narrow to remote");
});

test("scopes gate operations", () => {
  const m = open();
  const reader = tenantKey(m, { scopes: ["read"] });
  const writer = tenantKey(m);
  assert.throws(() => m.create(reader, {}, { body: "x" }), code("forbidden"));
  assert.throws(() => m.eraseWhere(writer, { user: "alice" }), code("forbidden"));
});
