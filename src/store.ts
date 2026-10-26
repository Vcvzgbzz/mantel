import { createHash, randomBytes, randomUUID } from "node:crypto";

import { tx, type Db } from "./db.js";
import { invalid, MantelError, notFound } from "./errors.js";
import {
  ORIGINS,
  type Audience,
  type Evidence,
  type EvidenceInput,
  type Memory,
  type Origin,
  type ReadScope,
  type Revision,
  type Sensitivity,
  type Status,
  type WriteScope,
} from "./types.js";

export const LIMITS = { body: 16_384, description: 300, subject: 200, evidence: 50, quote: 2_000, context: 32, contextText: 2_000, list: 500 };
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND = /^[a-z][a-z0-9_-]{0,39}$/;

export type KeyScope = "read" | "write" | "admin";

export interface ApiKey {
  id: string;
  tenant: string;
  label: string;
  scopes: KeyScope[];
  /** A pinned key acts only as this user / in this project; null = the request chooses. */
  user: string | null;
  project: string | null;
  /** The most a key's recalls may contain: `remote` never sees private memories. */
  audience: Audience;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface NewMemory {
  name?: string | null;
  description?: string;
  body: string;
  subject?: string;
  kind?: string;
  origin?: Origin;
  sensitivity?: Sensitivity;
  validFrom?: number | null;
  validTo?: number | null;
  evidence?: EvidenceInput[];
}

export type MemoryPatch = Partial<Omit<NewMemory, "origin">>;

interface MemoryRow {
  id: string; tenant_id: string; user_id: string; project: string; subject: string; kind: string; name: string | null;
  description: string; body: string; origin: Origin; sensitivity: Sensitivity; status: Status; version: number;
  valid_from: number | null; valid_to: number | null; superseded_by: string | null;
  created_at: number; updated_at: number; used_at: number;
}

const COLS = `id, tenant_id, user_id, project, subject, kind, name, description, body, origin, sensitivity, status, version,
  valid_from, valid_to, superseded_by, created_at, updated_at, used_at`;

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id, tenant: r.tenant_id, user: r.user_id, project: r.project, subject: r.subject, kind: r.kind, name: r.name,
  description: r.description, body: r.body, origin: r.origin, sensitivity: r.sensitivity, status: r.status, version: r.version,
  validFrom: r.valid_from, validTo: r.valid_to, supersededBy: r.superseded_by,
  createdAt: r.created_at, updatedAt: r.updated_at, usedAt: r.used_at,
});

const hashKey = (secret: string) => createHash("sha256").update(secret).digest("hex");
/** A body line's identity for evidence: its text without a list bullet. */
export const lineKey = (line: string) => line.replace(/^\s*[-*]\s*/, "").trim();
const bodyLines = (body: string) => new Set(body.split("\n").map(lineKey).filter(Boolean));

function check(m: Required<Omit<NewMemory, "evidence">> & { evidence?: EvidenceInput[] }): void {
  if (!m.body.trim()) throw invalid("body is empty");
  if (m.body.length > LIMITS.body) throw new MantelError("too_large", `body is over ${LIMITS.body} characters`);
  if (m.description.length > LIMITS.description) throw invalid(`description is over ${LIMITS.description} characters`);
  if (m.name !== null && !NAME.test(m.name)) throw invalid("name must be lowercase-with-dashes, up to 64 characters");
  if (!KIND.test(m.kind)) throw invalid("kind must be a lowercase word, up to 40 characters");
  if (m.subject.length > LIMITS.subject) throw invalid(`subject is over ${LIMITS.subject} characters`);
  if (!ORIGINS.includes(m.origin)) throw invalid(`origin must be one of ${ORIGINS.join(", ")}`);
  if (m.sensitivity !== "normal" && m.sensitivity !== "private") throw invalid("sensitivity must be normal or private");
  for (const t of [m.validFrom, m.validTo]) if (t !== null && !Number.isFinite(t)) throw invalid("validFrom/validTo must be timestamps");
  if (m.validFrom !== null && m.validTo !== null && m.validTo < m.validFrom) throw invalid("validTo is before validFrom");
  const ev = m.evidence ?? [];
  if (ev.length > LIMITS.evidence) throw invalid(`at most ${LIMITS.evidence} evidence items`);
  const lines = bodyLines(m.body);
  for (const e of ev) {
    if (typeof e?.quote !== "string" || !e.quote.trim() || e.quote.length > LIMITS.quote) throw invalid("each evidence item needs a quote");
    if (e.line !== undefined && !lines.has(lineKey(e.line))) throw invalid("evidence line is not a line of the body");
    if (e.tone !== undefined && !["sincere", "joking", "unsure"].includes(e.tone)) throw invalid("tone must be sincere, joking or unsure");
    if ((e.context?.length ?? 0) > LIMITS.context || e.context?.some((c) => typeof c?.text !== "string" || c.text.length > LIMITS.contextText)) {
      throw invalid("evidence context is too long");
    }
  }
}

/** Caps on one user's active memories in a tenant; 0 = none. Superseded and retracted history does not count. */
export interface Limits { memoriesPerUser: number; charsPerUser: number }

/** A memory carried over from another system, with its timestamps and earlier versions. */
export interface ImportedMemory extends NewMemory {
  status?: Status;
  createdAt?: number;
  updatedAt?: number;
  usedAt?: number;
  /** Earlier versions, oldest first. */
  revisions?: { description: string; body: string; at: number; reason?: string }[];
}

export class Store {
  constructor(
    readonly db: Db,
    readonly defaults: { sensitivity: Sensitivity } = { sensitivity: "normal" },
    readonly limits: Limits = { memoriesPerUser: 0, charsPerUser: 0 },
  ) {}

  /** Refuses a write that would put a user over their caps. `adding` is the new active text; `replacing` is active text it removes. */
  private withinLimits(scope: { tenant: string; user: string }, adding: number, replacing = 0, newRows = 1): void {
    const { memoriesPerUser, charsPerUser } = this.limits;
    if (!memoriesPerUser && !charsPerUser) return;
    const u = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body) + LENGTH(description)), 0) AS chars FROM memories
       WHERE tenant_id = ? AND user_id = ? AND status = 'active'`,
    ).get(scope.tenant, scope.user) as { n: number; chars: number };
    if (memoriesPerUser && u.n + newRows > memoriesPerUser) throw new MantelError("too_large", `this user already has ${memoriesPerUser} active memories`);
    if (charsPerUser && u.chars - replacing + adding > charsPerUser) throw new MantelError("too_large", `this user's memories would exceed ${charsPerUser} characters`);
  }

  /* ------------------------------------------------------------ tenants and keys */

  createTenant(name: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw invalid("tenant name must be lowercase, up to 64 characters");
    if (this.tenantId(name)) throw new MantelError("conflict", `tenant ${name} exists`);
    const id = randomUUID();
    this.db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(id, name, Date.now());
    return id;
  }

  tenantId(name: string): string | undefined {
    return (this.db.prepare("SELECT id FROM tenants WHERE name = ?").get(name) as { id: string } | undefined)?.id;
  }

  /** Returns the secret once; only its hash is stored. */
  createKey(tenant: string, o: { label?: string; scopes: KeyScope[]; user?: string | null; project?: string | null; audience?: Audience }): { key: ApiKey; secret: string } {
    if (!o.scopes.length || o.scopes.some((s) => !["read", "write", "admin"].includes(s))) throw invalid("scopes must be read, write and/or admin");
    const id = randomUUID();
    const secret = `mk_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO api_keys (id, tenant_id, hash, label, scopes, user_pin, project_pin, audience, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tenant, hashKey(secret), o.label ?? "", o.scopes.join(","), o.user ?? null, o.project ?? null, o.audience ?? "remote", now);
    return { key: this.keys(tenant).find((k) => k.id === id)!, secret };
  }

  keyFor(secret: string): ApiKey | undefined {
    const r = this.db.prepare(`SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL`).get(hashKey(secret)) as KeyRow | undefined;
    if (!r) return undefined;
    // Coarse on purpose: one write a minute per key, not one per request.
    if ((r.last_used_at ?? 0) < Date.now() - 60_000) this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), r.id);
    return toKey(r);
  }

  keys(tenant: string): ApiKey[] {
    return (this.db.prepare(`SELECT * FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY created_at`).all(tenant) as unknown as KeyRow[]).map(toKey);
  }

  revokeKey(tenant: string, id: string): boolean {
    return Number(this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").run(Date.now(), tenant, id).changes) > 0;
  }

  /* ------------------------------------------------------------ memories */

  get(tenant: string, id: string): Memory | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM memories WHERE tenant_id = ? AND id = ?`).get(tenant, id) as MemoryRow | undefined;
    return r && toMemory(r);
  }

  /** The active memory with this name in exactly this user and project. */
  byName(scope: WriteScope, name: string): Memory | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM memories WHERE tenant_id = ? AND user_id = ? AND project = ? AND name = ? AND status = 'active'`)
      .get(scope.tenant, scope.user, scope.project, name) as MemoryRow | undefined;
    return r && toMemory(r);
  }

  list(rs: ReadScope, f: { status?: Status | "all"; subject?: string; kind?: string; name?: string; limit?: number; cursor?: number } = {}): { memories: Memory[]; cursor: number | null } {
    const [where, args] = readWhere(rs);
    const status = f.status ?? "active";
    const conds = [where];
    if (status !== "all") { conds.push("status = ?"); args.push(status); }
    if (f.subject !== undefined) { conds.push("subject = ?"); args.push(f.subject); }
    if (f.kind !== undefined) { conds.push("kind = ?"); args.push(f.kind); }
    if (f.name !== undefined) { conds.push("name = ?"); args.push(f.name); }
    if (f.cursor !== undefined) { conds.push("seq < ?"); args.push(f.cursor); }
    const limit = Math.min(Math.max(1, f.limit ?? 100), LIMITS.list);
    const rows = this.db.prepare(`SELECT seq, ${COLS} FROM memories WHERE ${conds.join(" AND ")} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit) as unknown as (MemoryRow & { seq: number })[];
    return { memories: rows.map(toMemory), cursor: rows.length === limit ? rows.at(-1)!.seq : null };
  }

  /** Full-text matches in a read scope, best first. Active memories only. */
  textSearch(rs: ReadScope, query: string, limit = 20): { id: string; score: number }[] {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);
    if (!terms.length) return [];
    const [where, args] = readWhere(rs, "m.");
    const rows = this.db.prepare(
      `SELECT m.id AS id, bm25(memories_fts) AS score FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.status = 'active' AND ${where} ORDER BY score LIMIT ?`,
    ).all(terms.map((t) => `"${t}"`).join(" OR "), ...args, limit) as { id: string; score: number }[];
    // bm25() is lower-is-better; callers want higher-is-better.
    return rows.map((r) => ({ id: r.id, score: -r.score }));
  }

  /** Every active memory in a read scope. */
  active(rs: ReadScope): Memory[] {
    const [where, args] = readWhere(rs);
    return (this.db.prepare(`SELECT ${COLS} FROM memories WHERE status = 'active' AND ${where}`).all(...args) as unknown as MemoryRow[]).map(toMemory);
  }

  /** Every active memory in a tenant, across users and projects. For indexing, never for a caller. */
  tenantActive(tenant: string): Memory[] {
    return (this.db.prepare(`SELECT ${COLS} FROM memories WHERE tenant_id = ? AND status = 'active'`).all(tenant) as unknown as MemoryRow[]).map(toMemory);
  }

  /** Creates a memory; with `supersedes`, the named memory becomes its predecessor instead of being changed. */
  create(scope: WriteScope, input: NewMemory, actor: string, supersedes?: { id: string; version?: number }, reason?: string): Memory {
    const now = Date.now();
    const m = {
      name: input.name ?? null,
      description: (input.description ?? "").replace(/\s+/g, " ").trim(),
      body: input.body ?? "",
      subject: input.subject ?? "",
      kind: input.kind ?? "note",
      origin: input.origin ?? "agent",
      sensitivity: input.sensitivity ?? this.defaults.sensitivity,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      evidence: input.evidence,
    };
    check(m);
    const id = randomUUID();
    return tx(this.db, () => {
      if (supersedes) {
        const old = this.get(scope.tenant, supersedes.id);
        if (!old) throw notFound("the memory to supersede does not exist");
        if (old.status !== "active") throw new MantelError("conflict", `that memory is already ${old.status}`);
        if (supersedes.version !== undefined && supersedes.version !== old.version) throw stale(old);
        this.db.prepare(
          `UPDATE memories SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?), version = version + 1, updated_at = ?
           WHERE id = ?`,
        ).run(id, m.validFrom ?? now, now, old.id);
        this.revise(old.id, actor, reason ?? "superseded");
      }
      if (m.name !== null && this.byName(scope, m.name)) throw new MantelError("conflict", `an active memory named ${m.name} exists`);
      this.withinLimits(scope, m.body.length + m.description.length);
      this.db.prepare(
        `INSERT INTO memories (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL, ?, ?, ?)`,
      ).run(id, scope.tenant, scope.user, scope.project, m.subject, m.kind, m.name, m.description, m.body, m.origin, m.sensitivity,
        m.validFrom, m.validTo, now, now, now);
      this.revise(id, actor, reason ?? null);
      this.addEvidence(id, m.evidence ?? []);
      return this.get(scope.tenant, id)!;
    });
  }

  /** Edits an active memory in place. `expect` is the version the writer read. */
  update(tenant: string, id: string, expect: number, patch: MemoryPatch, actor: string, reason?: string): Memory {
    return tx(this.db, () => {
      const cur = this.get(tenant, id);
      if (!cur) throw notFound();
      if (cur.version !== expect) throw stale(cur);
      if (cur.status !== "active") throw new MantelError("conflict", `a ${cur.status} memory is history; supersede it instead`);
      const next = {
        name: patch.name !== undefined ? patch.name : cur.name,
        description: patch.description !== undefined ? patch.description.replace(/\s+/g, " ").trim() : cur.description,
        body: patch.body ?? cur.body,
        subject: patch.subject ?? cur.subject,
        kind: patch.kind ?? cur.kind,
        origin: cur.origin,
        sensitivity: patch.sensitivity ?? cur.sensitivity,
        validFrom: patch.validFrom !== undefined ? patch.validFrom : cur.validFrom,
        validTo: patch.validTo !== undefined ? patch.validTo : cur.validTo,
        evidence: patch.evidence,
      };
      check(next);
      if (next.name !== null && next.name !== cur.name && this.byName({ tenant, user: cur.user, project: cur.project }, next.name)) {
        throw new MantelError("conflict", `an active memory named ${next.name} exists`);
      }
      const same = next.name === cur.name && next.description === cur.description && next.body === cur.body && next.subject === cur.subject
        && next.kind === cur.kind && next.sensitivity === cur.sensitivity && next.validFrom === cur.validFrom && next.validTo === cur.validTo;
      if (same && !patch.evidence?.length) return cur;
      if (!same) {
        this.withinLimits({ tenant, user: cur.user }, next.body.length + next.description.length, cur.body.length + cur.description.length, 0);
        this.db.prepare(
          `UPDATE memories SET name = ?, description = ?, body = ?, subject = ?, kind = ?, sensitivity = ?, valid_from = ?, valid_to = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
        ).run(next.name, next.description, next.body, next.subject, next.kind, next.sensitivity, next.validFrom, next.validTo, Date.now(), id);
        this.revise(id, actor, reason ?? null);
      }
      // Evidence for a line the new body no longer has goes with the line.
      const lines = bodyLines(next.body);
      for (const e of this.evidence(tenant, id)) {
        if (e.line !== null && !lines.has(e.line)) this.db.prepare("DELETE FROM evidence WHERE memory_id = ? AND line = ?").run(id, e.line);
      }
      this.addEvidence(id, patch.evidence ?? []);
      return this.get(tenant, id)!;
    });
  }

  /** Marks an active memory as wrong. It stays readable, with its history, but is never recalled. */
  retract(tenant: string, id: string, expect: number | undefined, actor: string, reason: string): Memory {
    return tx(this.db, () => {
      const cur = this.get(tenant, id);
      if (!cur) throw notFound();
      if (expect !== undefined && cur.version !== expect) throw stale(cur);
      if (cur.status !== "active") throw new MantelError("conflict", `that memory is already ${cur.status}`);
      this.db.prepare(`UPDATE memories SET status = 'retracted', version = version + 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);
      this.revise(id, actor, reason);
      return this.get(tenant, id)!;
    });
  }

  /** Writes a memory exactly as given, with its earlier versions as revisions. For moving data in, not for clients. */
  importMemory(scope: WriteScope, rec: ImportedMemory, actor: string): Memory {
    const now = Date.now();
    const m = {
      name: rec.name ?? null, description: (rec.description ?? "").replace(/\s+/g, " ").trim(), body: rec.body ?? "",
      subject: rec.subject ?? "", kind: rec.kind ?? "note", origin: rec.origin ?? "import", sensitivity: rec.sensitivity ?? this.defaults.sensitivity,
      validFrom: rec.validFrom ?? null, validTo: rec.validTo ?? null, evidence: rec.evidence,
    };
    check(m);
    const status = rec.status ?? "active";
    if (!["active", "superseded", "retracted"].includes(status)) throw invalid("status must be active, superseded or retracted");
    const revs = rec.revisions ?? [];
    for (const r of revs) {
      if (typeof r?.body !== "string" || typeof r.description !== "string" || !Number.isFinite(r.at)) throw invalid("each revision needs description, body and at");
    }
    const id = randomUUID();
    const created = rec.createdAt ?? now, updated = rec.updatedAt ?? created;
    return tx(this.db, () => {
      if (status === "active" && m.name !== null && this.byName(scope, m.name)) throw new MantelError("conflict", `an active memory named ${m.name} exists`);
      if (status === "active") this.withinLimits(scope, m.body.length + m.description.length);
      this.db.prepare(`INSERT INTO memories (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
        id, scope.tenant, scope.user, scope.project, m.subject, m.kind, m.name, m.description, m.body, m.origin, m.sensitivity,
        status, revs.length + 1, m.validFrom, m.validTo, created, updated, rec.usedAt ?? updated);
      const put = this.db.prepare(
        `INSERT INTO revisions (memory_id, version, description, body, origin, status, valid_from, valid_to, actor, reason, at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`,
      );
      revs.forEach((r, i) => put.run(id, i + 1, r.description, r.body, m.origin, actor, r.reason ?? null, r.at));
      this.revise(id, actor, "imported");
      this.db.prepare("UPDATE revisions SET at = ? WHERE memory_id = ? AND version = ?").run(updated, id, revs.length + 1);
      this.addEvidence(id, m.evidence ?? []);
      return this.get(scope.tenant, id)!;
    });
  }

  /** How many evidence items each memory in a read scope has, and how many were said in jest. */
  evidenceSummary(rs: ReadScope): { memoryId: string; n: number; joking: number }[] {
    const [where, args] = readWhere(rs, "m.");
    return (this.db.prepare(
      `SELECT e.memory_id AS memoryId, COUNT(*) AS n, SUM(e.tone = 'joking') AS joking FROM evidence e JOIN memories m ON m.id = e.memory_id
       WHERE m.status = 'active' AND ${where} GROUP BY e.memory_id`,
    ).all(...args) as { memoryId: string; n: number; joking: number }[]).map((r) => ({ memoryId: r.memoryId, n: r.n, joking: r.joking }));
  }

  /** Ends project memories nobody has recalled or read for `days`. Memories with evidence are observations, not working notes, and stay. */
  retireUnused(days: number, actor: string): number {
    const ids = this.db.prepare(
      `SELECT tenant_id AS tenant, id FROM memories m WHERE status = 'active' AND project != '' AND used_at < ?
       AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.memory_id = m.id)`,
    ).all(Date.now() - days * 86_400_000) as { tenant: string; id: string }[];
    for (const r of ids) this.end(r.tenant, r.id, undefined, actor, `unused for ${days} days`);
    return ids.length;
  }

  /** Records that an active memory stopped being true at `at`, with no replacement. It stays readable as history. */
  end(tenant: string, id: string, expect: number | undefined, actor: string, reason: string, at = Date.now()): Memory {
    return tx(this.db, () => {
      const cur = this.get(tenant, id);
      if (!cur) throw notFound();
      if (expect !== undefined && cur.version !== expect) throw stale(cur);
      if (cur.status !== "active") throw new MantelError("conflict", `that memory is already ${cur.status}`);
      if (cur.validFrom !== null && at < cur.validFrom) throw invalid("a memory cannot end before it began");
      this.db.prepare(`UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(at, Date.now(), id);
      this.revise(id, actor, reason);
      return this.get(tenant, id)!;
    });
  }

  /** Removes a memory and everything derived from it, leaving only an erasure record. Call `scrub()` after a batch. */
  erase(tenant: string, id: string, actor: string): boolean {
    return tx(this.db, () => {
      const gone = Number(this.db.prepare("DELETE FROM memories WHERE tenant_id = ? AND id = ?").run(tenant, id).changes) > 0;
      if (gone) this.db.prepare("INSERT OR REPLACE INTO erasures (memory_id, tenant_id, actor, at) VALUES (?, ?, ?, ?)").run(id, tenant, actor, Date.now());
      return gone;
    });
  }

  /** Erases every memory of a user, or about a subject, in any status. */
  eraseWhere(tenant: string, f: { user?: string; subject?: string }, actor: string): number {
    if (f.user === undefined && f.subject === undefined) throw invalid("erase needs a user or a subject");
    const conds = ["tenant_id = ?"];
    const args: string[] = [tenant];
    if (f.user !== undefined) { conds.push("user_id = ?"); args.push(f.user); }
    if (f.subject !== undefined) { conds.push("subject = ?"); args.push(f.subject); }
    const ids = (this.db.prepare(`SELECT id FROM memories WHERE ${conds.join(" AND ")}`).all(...args) as { id: string }[]).map((r) => r.id);
    return tx(this.db, () => ids.filter((id) => this.erase(tenant, id, actor)).length);
  }

  /** Rewrites the full-text index and truncates the WAL, so erased text is gone from disk as well as from queries. */
  scrub(): void {
    this.db.exec("INSERT INTO memories_fts (memories_fts) VALUES ('optimize'); PRAGMA wal_checkpoint(TRUNCATE);");
  }

  revisions(tenant: string, id: string): Revision[] {
    if (!this.get(tenant, id)) throw notFound();
    return (this.db.prepare(`SELECT * FROM revisions WHERE memory_id = ? ORDER BY version DESC`).all(id) as unknown as RevisionRow[]).map((r) => ({
      version: r.version, description: r.description, body: r.body, origin: r.origin, status: r.status,
      validFrom: r.valid_from, validTo: r.valid_to, actor: r.actor, reason: r.reason, at: r.at,
    }));
  }

  evidence(tenant: string, id: string): Evidence[] {
    if (!this.get(tenant, id)) throw notFound();
    return (this.db.prepare(`SELECT quote, line, tone, source, context, at FROM evidence WHERE memory_id = ? ORDER BY id`).all(id) as unknown as EvidenceRow[])
      .map((r) => ({ quote: r.quote, line: r.line, tone: r.tone, source: r.source, context: JSON.parse(r.context) as Evidence["context"], at: r.at }));
  }

  /** Records that memories were recalled. */
  touch(ids: string[]): void {
    const now = Date.now();
    const st = this.db.prepare("UPDATE memories SET used_at = ? WHERE id = ?");
    for (const id of ids) st.run(now, id);
  }

  private revise(id: string, actor: string, reason: string | null): void {
    this.db.prepare(
      `INSERT INTO revisions (memory_id, version, description, body, origin, status, valid_from, valid_to, actor, reason, at)
       SELECT id, version, description, body, origin, status, valid_from, valid_to, ?, ?, ? FROM memories WHERE id = ?`,
    ).run(actor, reason, Date.now(), id);
  }

  private addEvidence(id: string, items: EvidenceInput[]): void {
    const st = this.db.prepare(`INSERT INTO evidence (memory_id, quote, line, tone, source, context, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const e of items) {
      st.run(id, e.quote.trim(), e.line !== undefined ? lineKey(e.line) : null, e.tone ?? null, e.source ?? "", JSON.stringify(e.context ?? []), Date.now());
    }
  }
}

/** Whether a read scope covers a memory. */
export function visible(m: Memory, rs: ReadScope): boolean {
  return m.tenant === rs.tenant && (m.user === "" || m.user === rs.user)
    && (rs.projects === "*" || m.project === "" || rs.projects.includes(m.project))
    && (rs.audience === "local" || m.sensitivity === "normal");
}

function readWhere(rs: ReadScope, p = ""): [string, (string | number)[]] {
  const conds = [`${p}tenant_id = ?`, `(${p}user_id = '' OR ${p}user_id = ?)`];
  const args: (string | number)[] = [rs.tenant, rs.user];
  if (rs.projects !== "*") {
    const ps = [...new Set(["", ...rs.projects])];
    conds.push(`${p}project IN (${ps.map(() => "?").join(",")})`);
    args.push(...ps);
  }
  if (rs.audience === "remote") conds.push(`${p}sensitivity = 'normal'`);
  return [conds.join(" AND "), args];
}

const stale = (cur: Memory) => new MantelError("precondition_failed", `the memory is at version ${cur.version}; read it again and reapply the change`);

interface KeyRow {
  id: string; tenant_id: string; label: string; scopes: string; user_pin: string | null; project_pin: string | null;
  audience: Audience; created_at: number; last_used_at: number | null;
}
const toKey = (r: KeyRow): ApiKey => ({
  id: r.id, tenant: r.tenant_id, label: r.label, scopes: r.scopes.split(",") as KeyScope[], user: r.user_pin, project: r.project_pin,
  audience: r.audience, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

interface RevisionRow {
  version: number; description: string; body: string; origin: Origin; status: Status; valid_from: number | null; valid_to: number | null;
  actor: string; reason: string | null; at: number;
}
interface EvidenceRow { quote: string; line: string | null; tone: Evidence["tone"]; source: string; context: string; at: number }
