import { toConfig, type MantelConfig } from "./config.js";
import { openDb } from "./db.js";
import { forbidden, invalid, notFound } from "./errors.js";
import { Embedder, Reranker } from "./models.js";
import { formatRecall, recall, search, VectorIndex, type Candidate, type RecallDeps, type RecallResult } from "./recall.js";
import { canRead, canWrite, need, readScope, writeScope, type Requested } from "./scope.js";
import { Store, type ApiKey, type MemoryPatch, type NewMemory } from "./store.js";
import type { Audience, Evidence, Memory, Revision, Status } from "./types.js";

const actorOf = (key: ApiKey) => `key:${key.id}`;

/** The memory service: every operation is checked against the calling key's scopes and pins. */
export class Mantel {
  readonly store: Store;
  readonly index: VectorIndex | null;
  private deps: RecallDeps;

  constructor(readonly config: MantelConfig) {
    this.store = new Store(openDb(config.db), { sensitivity: config.defaultSensitivity });
    this.index = config.embed ? new VectorIndex(this.store, new Embedder(config.embed)) : null;
    this.deps = { store: this.store, index: this.index, reranker: config.rerank ? new Reranker(config.rerank) : null, config: config.recall };
  }

  static open(raw: Partial<MantelConfig> & Record<string, unknown> = {}): Mantel {
    return new Mantel(toConfig(raw));
  }

  close(): void {
    this.store.db.close();
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
}
