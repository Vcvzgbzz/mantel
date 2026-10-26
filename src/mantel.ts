import { toConfig, type MantelConfig } from "./config.js";
import { openDb } from "./db.js";
import { forbidden, invalid, MantelError, notFound } from "./errors.js";
import type { SpanInput } from "./extract.js";
import { Jobs, Worker, type Job, type JobStatus, type Proposal } from "./jobs.js";
import { Chat, Embedder, Reranker } from "./models.js";
import { formatRecall, recall, search, VectorIndex, type Candidate, type RecallDeps, type RecallResult } from "./recall.js";
import { canRead, canWrite, need, readScope, writeScope, type Requested } from "./scope.js";
import { Store, type ApiKey, type ImportedMemory, type MemoryPatch, type NewMemory } from "./store.js";
import type { Audience, Evidence, Memory, Revision, Status } from "./types.js";

const actorOf = (key: ApiKey) => `key:${key.id}`;

/** The memory service: every operation is checked against the calling key's scopes and pins. */
export class Mantel {
  readonly store: Store;
  readonly index: VectorIndex | null;
  readonly jobs: Jobs;
  readonly worker: Worker;
  private deps: RecallDeps;

  constructor(readonly config: MantelConfig) {
    this.store = new Store(openDb(config.db), { sensitivity: config.defaultSensitivity }, config.limits);
    this.index = config.embed ? new VectorIndex(this.store, new Embedder(config.embed)) : null;
    this.deps = { store: this.store, index: this.index, reranker: config.rerank ? new Reranker(config.rerank) : null, config: config.recall };
    this.jobs = new Jobs(this.store.db);
    this.worker = new Worker({
      store: this.store,
      jobs: this.jobs,
      chat: config.extract ? new Chat(config.extract) : null,
      recall: this.deps,
      config: { retainDays: config.extract?.retainDays ?? 0, retireUnusedDays: config.retireUnusedDays, ...(config.extract?.guidance ? { guidance: config.extract.guidance } : {}) },
      changed: (tenant) => {
        // Extraction may have erased memories; their cached vectors go with them.
        this.index?.dropTenant(tenant);
        this.changed(tenant);
      },
      log: (event, data) => console.log(JSON.stringify({ event, ...data })),
    });
  }

  static open(raw: Partial<MantelConfig> & Record<string, unknown> = {}): Mantel {
    return new Mantel(toConfig(raw));
  }

  close(): void {
    this.worker.stop();
    this.store.db.close();
  }

  healthy(): boolean {
    try {
      this.store.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  authenticate(secret: string): ApiKey | undefined {
    return this.store.keyFor(secret);
  }

  /** Writes in the background never block a request; a failed embed is retried on the next refresh. */
  private changed(tenant: string): void {
    if (this.index) void this.index.refresh(tenant).catch(() => {});
  }

  private readable(key: ApiKey, id: string, audience?: Audience): Memory {
    const m = this.store.get(key.tenant, id);
    if (!m || !canRead(key, m, audience)) throw notFound();
    return m;
  }

  private writable(key: ApiKey, id: string): Memory {
    need(key, "write");
    const m = this.readable(key, id, "local");
    if (!canWrite(key, m)) throw forbidden("this key cannot change that memory");
    return m;
  }

  get(key: ApiKey, id: string, audience?: Audience): Memory {
    need(key, "read");
    return this.readable(key, id, audience);
  }

  list(key: ApiKey, r: Requested, f: { status?: Status | "all"; subject?: string; kind?: string; name?: string; limit?: number; cursor?: number } = {}) {
    need(key, "read");
    return this.store.list(readScope(key, r), f);
  }

  /** Creates a memory. With `supersedes`, it replaces that memory, which is kept as history with an end date. */
  create(key: ApiKey, r: Requested, input: NewMemory, o: { supersedes?: { id: string; version?: number }; reason?: string } = {}): Memory {
    need(key, "write");
    let defaults: Requested = {};
    if (o.supersedes) {
      const old = this.writable(key, o.supersedes.id);
      defaults = { user: old.user, project: old.project };
    }
    const scope = writeScope(key, { user: r.user ?? defaults.user, project: r.project ?? defaults.project });
    const m = this.store.create(scope, input, actorOf(key), o.supersedes, o.reason);
    if (o.supersedes) this.index?.forget(key.tenant, o.supersedes.id);
    this.changed(key.tenant);
    return m;
  }

  update(key: ApiKey, id: string, expect: number, patch: MemoryPatch, reason?: string): Memory {
    this.writable(key, id);
    const m = this.store.update(key.tenant, id, expect, patch, actorOf(key), reason);
    this.changed(key.tenant);
    return m;
  }

  retract(key: ApiKey, id: string, expect: number | undefined, reason: string): Memory {
    this.writable(key, id);
    if (!reason?.trim()) throw invalid("a retraction needs a reason");
    const m = this.store.retract(key.tenant, id, expect, actorOf(key), reason);
    this.index?.forget(key.tenant, id);
    return m;
  }

  /** Records that a memory stopped being true, without a replacement. */
  end(key: ApiKey, id: string, expect: number | undefined, reason: string, at?: number): Memory {
    this.writable(key, id);
    if (!reason?.trim()) throw invalid("ending a memory needs a reason");
    const m = this.store.end(key.tenant, id, expect, actorOf(key), reason, at);
    this.index?.forget(key.tenant, id);
    return m;
  }

  /** Permanently removes a memory with its history, evidence and vectors. */
  erase(key: ApiKey, id: string): void {
    this.writable(key, id);
    this.store.erase(key.tenant, id, actorOf(key));
    this.index?.forget(key.tenant, id);
    this.store.scrub();
  }

  /** Erases everything of a user or about a subject (a data-subject request). Admin only. */
  eraseWhere(key: ApiKey, f: { user?: string; subject?: string }): number {
    need(key, "admin");
    const n = this.store.eraseWhere(key.tenant, f, actorOf(key));
    if (f.user !== undefined) this.jobs.purge(0, { tenant: key.tenant, user: f.user });
    // Cached vectors for erased memories go too; the next query reloads from the database.
    this.index?.dropTenant(key.tenant);
    this.store.scrub();
    return n;
  }

  revisions(key: ApiKey, id: string): Revision[] {
    need(key, "read");
    this.readable(key, id);
    return this.store.revisions(key.tenant, id);
  }

  evidence(key: ApiKey, id: string): Evidence[] {
    need(key, "read");
    this.readable(key, id);
    return this.store.evidence(key.tenant, id);
  }

  async search(key: ApiKey, r: Requested, query: string, o: { limit?: number; untrusted?: boolean } = {}): Promise<Candidate[]> {
    need(key, "read");
    return search(this.deps, readScope(key, r), query, o);
  }

  /** What to put in front of the caller's model for this query, and the prompt block for it. */
  async recall(key: ApiKey, r: Requested, query: string, o: { k?: number; threshold?: number } = {}): Promise<RecallResult & { context: string }> {
    need(key, "read");
    const res = await recall(this.deps, readScope(key, r), query, o);
    this.store.touch(res.hits.map((h) => h.memory.id));
    return { ...res, context: formatRecall(res.hits) };
  }

  /** Queues a conversation for extraction. Repeating an idempotency key returns the first job. */
  ingest(key: ApiKey, r: Requested, input: { spans: SpanInput[]; source?: string; sensitivity?: "normal" | "private" }, idempotencyKey?: string): { job: Job; created: boolean } {
    need(key, "write");
    const out = this.jobs.ingest(writeScope(key, r), { ...input, sensitivity: input.sensitivity ?? this.config.defaultSensitivity }, idempotencyKey);
    if (out.created) this.worker.kick();
    return out;
  }

  job(key: ApiKey, id: string): Job {
    need(key, "read");
    const j = this.jobs.job(key.tenant, id);
    if (!j || (key.user !== null && j.user !== key.user)) throw notFound("no such job");
    return j;
  }

  listJobs(key: ApiKey, f: { status?: JobStatus; limit?: number } = {}): Job[] {
    need(key, "read");
    return this.jobs.list(key.tenant, { ...f, ...(key.user !== null ? { user: key.user } : {}) });
  }

  /** Open proposals for memories this key may change. */
  /** Open proposals for memories this key may change; `user` narrows an unpinned key to one user's. */
  proposals(key: ApiKey, user?: string): Proposal[] {
    need(key, "read");
    return this.jobs.proposals(key.tenant).filter((p) => {
      const m = this.store.get(key.tenant, p.memoryId);
      return m && canRead(key, m) && canWrite(key, m) && (user === undefined || m.user === user);
    });
  }

  /** Records a use without reading: a memory someone chose to keep stops ageing toward retirement. */
  touch(key: ApiKey, id: string): void {
    need(key, "write");
    this.readable(key, id, "local");
    this.store.touch([id]);
  }

  /** Applies a proposal as the key's own change, or throws it away. */
  resolveProposal(key: ApiKey, id: string, accept: boolean): Memory | null {
    const p = this.jobs.proposal(key.tenant, id);
    if (!p) throw notFound("no such proposal");
    const target = this.writable(key, p.memoryId);
    this.jobs.dropProposal(key.tenant, id);
    if (!accept) return null;
    if (target.version !== p.memoryVersion) throw new MantelError("precondition_failed", "the memory changed after this was proposed");
    const m = p.action === "end"
      ? this.end(key, target.id, p.memoryVersion, p.reason)
      : this.create(key, {}, { name: target.name, kind: target.kind, subject: target.subject, description: p.description, body: p.body, origin: "user", sensitivity: target.sensitivity },
        { supersedes: { id: target.id, version: p.memoryVersion }, reason: `accepted: ${p.reason}` });
    return m;
  }

  /** Carries memories over from another system, keeping timestamps and earlier versions. Admin only; each item succeeds or fails alone. */
  importMemories(key: ApiKey, r: Requested, items: ImportedMemory[]): ({ id: string } | { error: string })[] {
    need(key, "admin");
    const scope = writeScope(key, r);
    const out = items.map((rec) => {
      try {
        return { id: this.store.importMemory(scope, rec, actorOf(key)).id };
      } catch (e) {
        if (e instanceof MantelError) return { error: e.message };
        throw e;
      }
    });
    this.changed(key.tenant);
    return out;
  }

  evidenceSummary(key: ApiKey, r: Requested) {
    need(key, "read");
    return this.store.evidenceSummary(readScope(key, r));
  }

  /** Each readable memory's mean embedding, for clients that draw similarity maps. Missing ids are not yet embedded or not visible. */
  vectors(key: ApiKey, ids: string[]): { model: string | null; vectors: Map<string, Float32Array> } {
    need(key, "read");
    if (!this.index) return { model: null, vectors: new Map() };
    const ms = ids.slice(0, 10_000).map((id) => this.store.get(key.tenant, id)).filter((m): m is Memory => !!m && m.status === "active" && canRead(key, m));
    return { model: this.index.embedder.model, vectors: this.index.means(key.tenant, ms) };
  }
}
