import assert from "node:assert/strict";
import { after, test } from "node:test";

import { MantelError } from "../src/errors.js";
import { Mantel } from "../src/mantel.js";
import { fakeEmbedder, open, tenantKey, type Fake } from "./helpers.js";

const fakes: Fake[] = [];
after(() => Promise.all(fakes.map((f) => f.close())));
const code = (c: string) => (e: unknown) => e instanceof MantelError && e.code === c;

test("per-user limits count active memories only", () => {
  const m = Mantel.open({ db: ":memory:", limits: { memoriesPerUser: 2, charsPerUser: 30 } });
  const key = tenantKey(m);
  const a = m.create(key, { user: "u" }, { body: "one" });
  m.create(key, { user: "u" }, { body: "two" });
  assert.throws(() => m.create(key, { user: "u" }, { body: "three" }), code("too_large"));
  m.create(key, { user: "v" }, { body: "other user" });
  m.create(key, { user: "u" }, { body: "one, again" }, { supersedes: { id: a.id } });
  const b = m.list(key, { user: "u" }).memories.find((x) => x.body === "two")!;
  assert.throws(() => m.update(key, b.id, 1, { body: "x".repeat(40) }), code("too_large"));
});

test("import keeps timestamps, earlier versions and status, and reports each item", () => {
  const m = open();
  const admin = tenantKey(m, { scopes: ["admin"] });
  const writer = tenantKey(m);
  assert.throws(() => m.importMemories(writer, {}, []), code("forbidden"));
  const res = m.importMemories(admin, { user: "u", project: "p" }, [
    { name: "tz", body: "Timezone is CET.", origin: "user", createdAt: 1_000, updatedAt: 5_000, usedAt: 6_000,
      revisions: [{ description: "", body: "Timezone is UTC.", at: 1_000 }, { description: "", body: "Timezone is GMT.", at: 3_000, reason: "edit" }] },
    { name: "tz", body: "duplicate name" },
    { name: "old", body: "Was true once.", status: "superseded", origin: "agent" },
  ]);
  assert.ok("id" in res[0]! && "error" in res[1]! && "id" in res[2]!);
  const tz = m.get(admin, (res[0] as { id: string }).id);
  assert.deepEqual([tz.createdAt, tz.updatedAt, tz.usedAt, tz.version, tz.user, tz.project], [1_000, 5_000, 6_000, 3, "u", "p"]);
  assert.deepEqual(m.revisions(admin, tz.id).map((r) => [r.version, r.body, r.at]),
    [[3, "Timezone is CET.", 5_000], [2, "Timezone is GMT.", 3_000], [1, "Timezone is UTC.", 1_000]]);
  assert.equal(m.get(admin, (res[2] as { id: string }).id).status, "superseded");
});

test("evidence summary counts evidence and jokes per memory", () => {
  const m = open();
  const key = tenantKey(m);
  const a = m.create(key, {}, { body: "- likes tea\n- has a dog", evidence: [{ quote: "tea!", line: "likes tea", tone: "joking" }, { quote: "my dog", line: "has a dog" }] });
  m.create(key, {}, { body: "no evidence" });
  assert.deepEqual(m.evidenceSummary(key, {}), [{ memoryId: a.id, n: 2, joking: 1 }]);
});

test("vectors are each memory's mean embedding, only for what the key may read", async () => {
  const embed = await fakeEmbedder();
  fakes.push(embed);
  const m = open({ embed });
  const local = tenantKey(m, { audience: "local" });
  const remote = tenantKey(m, { audience: "remote" });
  const a = m.create(local, {}, { name: "pets", description: "Pets", body: "Has a dog.\n\nAnd a cat." });
  const p = m.create(local, {}, { body: "private", sensitivity: "private" });
  await m.index!.refresh(local.tenant);
  const v = m.vectors(local, [a.id, p.id, "nope"]);
  assert.equal(v.model, "fake-embed");
  assert.deepEqual([...v.vectors.keys()].sort(), [a.id, p.id].sort());
  assert.ok(Math.abs(Math.hypot(...v.vectors.get(a.id)!) - 1) < 1e-5);
  assert.deepEqual([...m.vectors(remote, [a.id, p.id]).vectors.keys()], [a.id]);
});

test("unused project memories retire to history; global and evidenced ones stay", () => {
  const m = open();
  const key = tenantKey(m);
  const stale = m.create(key, { project: "p" }, { body: "old working note" });
  const global = m.create(key, {}, { body: "about the user" });
  const seen = m.create(key, { project: "p" }, { body: "- observed", evidence: [{ quote: "q", line: "observed" }] });
  const fresh = m.create(key, { project: "p" }, { body: "recently used" });
  m.store.db.prepare("UPDATE memories SET used_at = 0 WHERE id IN (?, ?, ?)").run(stale.id, global.id, seen.id);
  assert.equal(m.store.retireUnused(60, "retire"), 1);
  assert.equal(m.get(key, stale.id).status, "superseded");
  assert.match(m.revisions(key, stale.id)[0]!.reason ?? "", /unused for 60 days/);
  for (const x of [global, seen, fresh]) assert.equal(m.get(key, x.id).status, "active");
});

test("health reflects whether the database answers", () => {
  const m = open();
  assert.equal(m.healthy(), true);
  m.close();
  assert.equal(m.healthy(), false);
});
