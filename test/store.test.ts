import assert from "node:assert/strict";
import { test } from "node:test";

import { MantelError } from "../src/errors.js";
import { open, tenantKey } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof MantelError && e.code === c;

test("an edit needs the version it read, and every version is kept", () => {
  const m = open();
  const key = tenantKey(m);
  const a = m.create(key, {}, { name: "editor", description: "Preferred editor", body: "Uses vim." });
  assert.equal(a.version, 1);
  const b = m.update(key, a.id, 1, { body: "Uses helix." }, "switched");
  assert.equal(b.version, 2);
  assert.throws(() => m.update(key, a.id, 1, { body: "Uses emacs." }), code("precondition_failed"));
  const revs = m.revisions(key, a.id);
  assert.deepEqual(revs.map((r) => [r.version, r.body, r.reason]), [[2, "Uses helix.", "switched"], [1, "Uses vim.", null]]);
});

test("an edit that changes nothing makes no new version", () => {
  const m = open();
  const key = tenantKey(m);
  const a = m.create(key, {}, { body: "Same." });
  assert.equal(m.update(key, a.id, 1, { body: "Same." }).version, 1);
});

test("superseding keeps the old memory as history with an end date", () => {
  const m = open();
  const key = tenantKey(m);
  const old = m.create(key, { project: "web" }, { name: "deploy", body: "Deploys with rsync.", validFrom: 1_000 });
  const neu = m.create(key, {}, { name: "deploy", body: "Deploys with a container image.", validFrom: 5_000 }, { supersedes: { id: old.id, version: 1 } });
  assert.equal(neu.project, "web", "the replacement lands where the old memory was");
  const was = m.get(key, old.id);
  assert.equal(was.status, "superseded");
  assert.equal(was.supersededBy, neu.id);
  assert.equal(was.validTo, 5_000);
  assert.equal(was.body, "Deploys with rsync.");
  assert.throws(() => m.create(key, {}, { body: "x" }, { supersedes: { id: old.id } }), code("conflict"));
  assert.deepEqual(m.list(key, { project: "web" }).memories.map((x) => x.id), [neu.id]);
});

test("names are unique among active memories in one user and project", () => {
  const m = open();
  const key = tenantKey(m);
  m.create(key, { project: "a" }, { name: "build", body: "make" });
  assert.throws(() => m.create(key, { project: "a" }, { name: "build", body: "ninja" }), code("conflict"));
  m.create(key, { project: "b" }, { name: "build", body: "ninja" });
});

test("a retracted memory stays readable but is no longer active", () => {
  const m = open();
  const key = tenantKey(m);
  const a = m.create(key, {}, { body: "Lives in Paris." });
  assert.throws(() => m.retract(key, a.id, undefined, " "), code("invalid"));
  const r = m.retract(key, a.id, 1, "never true");
  assert.equal(r.status, "retracted");
  assert.equal(m.list(key, {}).memories.length, 0);
  assert.equal(m.list(key, {}, { status: "all" }).memories.length, 1);
  assert.throws(() => m.update(key, a.id, 2, { body: "x" }), code("conflict"));
});

test("evidence must point at a line of the body, and goes when the line does", () => {
  const m = open();
  const key = tenantKey(m);
  assert.throws(() => m.create(key, {}, { body: "- likes tea", evidence: [{ quote: "q", line: "likes coffee" }] }), code("invalid"));
  const a = m.create(key, {}, {
    body: "- likes tea\n- has a dog",
    evidence: [{ quote: "I love tea", line: "- likes tea", tone: "sincere", source: "chat:1" }, { quote: "my dog Rex", line: "has a dog" }],
  });
  assert.equal(m.evidence(key, a.id).length, 2);
  m.update(key, a.id, 1, { body: "- likes tea" });
  assert.deepEqual(m.evidence(key, a.id).map((e) => e.line), ["likes tea"]);
});

test("input is validated", () => {
  const m = open();
  const key = tenantKey(m);
  assert.throws(() => m.create(key, {}, { body: "  " }), code("invalid"));
  assert.throws(() => m.create(key, {}, { body: "x", name: "Not A Slug" }), code("invalid"));
  assert.throws(() => m.create(key, {}, { body: "x", validFrom: 10, validTo: 5 }), code("invalid"));
  assert.throws(() => m.create(key, {}, { body: "x".repeat(20_000) }), code("too_large"));
});
