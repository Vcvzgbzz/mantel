import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fakeEmbedder, open, tenantKey, type Fake } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "mantel-erase-"));
const fakes: Fake[] = [];
after(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  rmSync(dir, { recursive: true, force: true });
});

const onDisk = (db: string, needle: string) =>
  [db, `${db}-wal`].filter(existsSync).some((f) => readFileSync(f).includes(Buffer.from(needle)));

test("erase removes the memory, its history, evidence, vectors and index entries from the file", async () => {
  const embed = await fakeEmbedder();
  fakes.push(embed);
  const db = join(dir, "erase.db");
  const m = open({ db, embed });
  const key = tenantKey(m);
  const SECRET = "zebrafinch7781";
  const a = m.create(key, {}, { body: `Code word ${SECRET}.`, evidence: [{ quote: `said ${SECRET}` }] });
  m.update(key, a.id, 1, { body: `Code word ${SECRET}, still.` });
  await m.index!.refresh(key.tenant);
  m.store.scrub();
  assert.ok(onDisk(db, SECRET), "the test needs the text on disk before the erase");

  m.erase(key, a.id);
  assert.equal(m.store.textSearch({ tenant: key.tenant, user: "", projects: "*", audience: "local" }, SECRET).length, 0);
  const left = m.store.db.prepare("SELECT (SELECT COUNT(*) FROM revisions) + (SELECT COUNT(*) FROM evidence) + (SELECT COUNT(*) FROM vectors) AS n").get() as { n: number };
  assert.equal(left.n, 0);
  assert.ok(!onDisk(db, SECRET), "erased text is not left in the database file or WAL");
  const tomb = m.store.db.prepare("SELECT memory_id FROM erasures").all() as { memory_id: string }[];
  assert.deepEqual(tomb.map((t) => t.memory_id), [a.id]);
  m.close();
});

test("eraseWhere removes every memory of a user in any status", () => {
  const m = open();
  const admin = tenantKey(m, { scopes: ["admin"] });
  const a = m.create(admin, { user: "alice" }, { body: "one" });
  m.create(admin, { user: "alice" }, { body: "two" }, { supersedes: { id: a.id } });
  m.create(admin, { user: "bob" }, { body: "bob's" });
  assert.equal(m.eraseWhere(admin, { user: "alice" }), 2);
  assert.equal(m.list(admin, { user: "bob" }).memories.length, 1);
});
