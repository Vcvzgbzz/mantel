import { randomUUID } from "node:crypto";

import { tx, type Db } from "./db.js";
import { invalid, MantelError } from "./errors.js";
import { decide, deriveOrigins, extractFacts, type ExtractDeps, type Op, type Span, type SpanInput } from "./extract.js";
import type { Chat } from "./models.js";
import { search, type RecallDeps } from "./recall.js";
import type { Store } from "./store.js";
import type { EvidenceInput, Memory, Sensitivity, WriteScope } from "./types.js";

export const EPISODE_LIMITS = { spans: 2_000, content: 100_000 };
const MAX_ATTEMPTS = 3;

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  tenant: string;
  user: string;
  kind: "extract";
  episodeId: string | null;
  status: JobStatus;
  attempts: number;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface Proposal {
  id: string;
  memoryId: string;
  memoryVersion: number;
  action: "update" | "end";
  description: string;
  body: string;
  reason: string;
  quote: string;
  createdAt: number;
}

interface JobRow {
  id: string; tenant_id: string; user_id: string; kind: "extract"; episode_id: string | null; status: JobStatus; attempts: number;
  error: string | null; result: string | null; created_at: number; updated_at: number;
}
const toJob = (r: JobRow): Job => ({
  id: r.id, tenant: r.tenant_id, user: r.user_id, kind: r.kind, episodeId: r.episode_id, status: r.status, attempts: r.attempts,
  error: r.error, result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null, createdAt: r.created_at, updatedAt: r.updated_at,
});

interface ProposalRow {
  id: string; memory_id: string; memory_version: number; action: "update" | "end"; description: string; body: string;
  reason: string; quote: string; created_at: number;
}
const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id, memoryId: r.memory_id, memoryVersion: r.memory_version, action: r.action, description: r.description, body: r.body,
  reason: r.reason, quote: r.quote, createdAt: r.created_at,
});

export interface ExtractConfig {
  /** Keep episodes this long after extraction; 0 deletes them as soon as they are extracted. */
  retainDays: number;
  /** Appended to the extraction prompt. */
  guidance?: string;
}

export class Jobs {
  constructor(private db: Db) {}

  /** Stores an episode and queues its extraction. The same idempotency key returns the first job instead. */
  ingest(scope: WriteScope, input: { spans: SpanInput[]; source?: string; sensitivity: Sensitivity }, key?: string): { job: Job; created: boolean } {
    if (key !== undefined && (!key || key.length > 200)) throw invalid("Idempotency-Key must be 1-200 characters");
    if (key) {
      const prior = this.db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND idempotency_key = ?").get(scope.tenant, key) as JobRow | undefined;
      if (prior) return { job: toJob(prior), created: false };
    }
    const spans = input.spans;
    if (!Array.isArray(spans) || !spans.length) throw invalid("spans must be a non-empty list");
    if (spans.length > EPISODE_LIMITS.spans) throw new MantelError("too_large", `at most ${EPISODE_LIMITS.spans} spans`);
    for (const s of spans) {
      if (!["user", "assistant", "tool", "system", "memory"].includes(s?.role)) throw invalid("span role must be user, assistant, tool, system or memory");
      if (typeof s.content !== "string" || s.content.length > EPISODE_LIMITS.content) throw invalid(`span content must be a string under ${EPISODE_LIMITS.content} characters`);
      if (s.origin !== undefined && s.origin !== "tool" && s.origin !== "web") throw invalid("a tool span's origin is tool or web");
    }
    const now = Date.now(), episode = randomUUID(), id = randomUUID();
    tx(this.db, () => {
      this.db.prepare("INSERT INTO episodes (id, tenant_id, user_id, project, source, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(episode, scope.tenant, scope.user, scope.project, (input.source ?? "").slice(0, 200), input.sensitivity, now);
      const put = this.db.prepare("INSERT INTO spans (episode_id, seq, role, origin, tool, content, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const s of deriveOrigins(spans)) put.run(episode, s.seq, s.role, s.origin, s.tool, s.content, s.at);
      this.db.prepare(
        `INSERT INTO jobs (id, tenant_id, user_id, kind, episode_id, idempotency_key, status, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'extract', ?, ?, 'queued', ?, ?, ?)`,
      ).run(id, scope.tenant, scope.user, episode, key ?? null, now, now, now);
    });
    return { job: this.job(scope.tenant, id)!, created: true };
  }

  job(tenant: string, id: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND id = ?").get(tenant, id) as JobRow | undefined;
    return r && toJob(r);
  }

  list(tenant: string, f: { user?: string; status?: JobStatus; limit?: number } = {}): Job[] {
    const conds = ["tenant_id = ?"], args: (string | number)[] = [tenant];
    if (f.user !== undefined) { conds.push("user_id = ?"); args.push(f.user); }
    if (f.status) { conds.push("status = ?"); args.push(f.status); }
    return (this.db.prepare(`SELECT * FROM jobs WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, Math.min(f.limit ?? 50, 500)) as unknown as JobRow[]).map(toJob);
  }

  /** Takes the next due job, or undefined. */
  claim(): Job | undefined {
    const now = Date.now();
    const r = this.db.prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at LIMIT 1) RETURNING *`,
    ).get(now, now) as JobRow | undefined;
    return r && toJob(r);
  }

  /** Jobs a crashed process left running go back in the queue. */
  requeueRunning(): number {
    return Number(this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(Date.now()).changes);
  }

  finish(id: string, result: Record<string, unknown>): void {
    this.db.prepare("UPDATE jobs SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), id);
  }

  /** Retries with backoff, then gives up visibly. */
  fail(job: Job, error: string): void {
    const now = Date.now();
    if (job.attempts >= MAX_ATTEMPTS) {
      this.db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 2_000), now, job.id);
    } else {
      this.db.prepare("UPDATE jobs SET status = 'queued', error = ?, run_after = ?, updated_at = ? WHERE id = ?")
        .run(error.slice(0, 2_000), now + 30_000 * 4 ** (job.attempts - 1), now, job.id);
    }
  }

  episode(id: string): { tenant: string; user: string; project: string; source: string; sensitivity: Sensitivity; spans: Span[] } | undefined {
    const e = this.db.prepare("SELECT tenant_id, user_id, project, source, sensitivity FROM episodes WHERE id = ?").get(id) as
      { tenant_id: string; user_id: string; project: string; source: string; sensitivity: Sensitivity } | undefined;
    if (!e) return undefined;
    const spans = this.db.prepare("SELECT seq, role, origin, tool, content, at FROM spans WHERE episode_id = ? ORDER BY seq").all(id) as unknown as Span[];
    return { tenant: e.tenant_id, user: e.user_id, project: e.project, source: e.source, sensitivity: e.sensitivity, spans };
  }

  dropEpisode(id: string): void {
    this.db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
  }

  /** Deletes extracted episodes older than the retention window, and every episode of erased users. */
  purge(retainDays: number, where?: { tenant: string; user: string }): number {
    if (where) return Number(this.db.prepare("DELETE FROM episodes WHERE tenant_id = ? AND user_id = ?").run(where.tenant, where.user).changes);
    return Number(this.db.prepare(
      `DELETE FROM episodes WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.episode_id = episodes.id AND j.status IN ('queued','running'))`,
    ).run(Date.now() - retainDays * 86_400_000).changes);
  }

  propose(tenant: string, p: Omit<Proposal, "id" | "createdAt">, jobId: string): void {
    // One open proposal per memory: a newer one replaces it.
    this.db.prepare("DELETE FROM proposals WHERE tenant_id = ? AND memory_id = ?").run(tenant, p.memoryId);
    this.db.prepare(
      `INSERT INTO proposals (id, tenant_id, memory_id, memory_version, action, description, body, reason, quote, job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), tenant, p.memoryId, p.memoryVersion, p.action, p.description, p.body, p.reason, p.quote, jobId, Date.now());
  }

  proposals(tenant: string): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant) as unknown as ProposalRow[]).map(toProposal);
  }

  proposal(tenant: string, id: string): Proposal | undefined {
    const r = this.db.prepare("SELECT * FROM proposals WHERE tenant_id = ? AND id = ?").get(tenant, id) as ProposalRow | undefined;
    return r && toProposal(r);
  }

  dropProposal(tenant: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM proposals WHERE tenant_id = ? AND id = ?").run(tenant, id).changes) > 0;
  }
}

/** Snapshot of the spans around a quote, so evidence outlives the episode. */
function evidenceFor(spans: Span[], seq: number, quote: string, source: string): EvidenceInput {
  const near = spans.filter((s) => (s.role === "user" || s.role === "assistant") && s.seq >= seq - 2 && s.seq <= seq);
  return {
    quote,
    source: source ? `${source}#${seq}` : `#${seq}`,
    context: near.map((s) => ({
      ...(s.at ? { at: new Date(s.at).toISOString() } : {}), author: s.role, text: s.content.slice(0, 1_000), cited: s.seq === seq,
    })),
  };
}

export interface WorkerDeps {
  store: Store;
  jobs: Jobs;
  chat: Chat | null;
  recall: RecallDeps;
  config: ExtractConfig;
  /** Called after memories change, so the caller can refresh its index. */
  changed(tenant: string): void;
  log?(event: string, data: Record<string, unknown>): void;
}

/** Runs queued extraction jobs one at a time. */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastPurge = 0;

  constructor(private deps: WorkerDeps, private pollMs = 2_000) {}

  start(): void {
    this.deps.jobs.requeueRunning();
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts a pass unless one is running. */
  kick(): void {
    this.running ??= this.drain().finally(() => (this.running = null));
  }

  /** Waits for a running pass, then runs whatever is still due. */
  async settle(): Promise<void> {
    await this.running;
    await this.drain();
  }

  /** Runs every due job; resolves when none is left. */
  async drain(): Promise<void> {
    for (let job = this.deps.jobs.claim(); job; job = this.deps.jobs.claim()) {
      try {
        this.deps.jobs.finish(job.id, await this.run(job));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.jobs.fail(job, msg);
        this.deps.log?.("extract.failed", { job: job.id, attempts: job.attempts, error: msg });
      }
    }
    if (Date.now() - this.lastPurge > 3_600_000) {
      this.lastPurge = Date.now();
      this.deps.jobs.purge(this.deps.config.retainDays);
    }
  }

  private async run(job: Job): Promise<Record<string, unknown>> {
    const { store, jobs, chat, config } = this.deps;
    const ep = job.episodeId ? jobs.episode(job.episodeId) : undefined;
    if (!ep) return { skipped: "episode no longer exists" };
    if (!chat) throw new Error("no extraction model is configured");
    if (ep.sensitivity === "private" && chat.cfg.trust !== "local") return { skipped: "private episode and the extraction model is remote" };

    const dropped: Record<string, number> = {};
    const rs = { tenant: ep.tenant, user: ep.user, projects: ep.project ? [ep.project] : [], audience: chat.cfg.trust };
    const deps: ExtractDeps = {
      chat: (s, u) => chat.complete(s, u),
      // Candidates come from the episode's own scope, never another user's.
      similar: async (f) => (await search(this.deps.recall, rs, f.text, { limit: 6 })).map((c) => c.memory),
      dropped: (_w, why) => { dropped[why] = (dropped[why] ?? 0) + 1; },
      ...(config.guidance ? { guidance: config.guidance } : {}),
    };
    const facts = await extractFacts(ep.spans, deps);
    const ops = await decide(facts, deps);
    const done = { add: 0, supersede: 0, end: 0, forget: 0, propose: 0, skipped: 0 };
    const actor = `extract:${job.id}`;
    tx(store.db, () => {
      for (const o of ops) {
        try {
          apply(o, ep, actor, job.id);
          done[o.op]++;
        } catch (e) {
          // A memory edited since it was read, or a name now taken: that decision is stale, the rest still apply.
          if (!(e instanceof MantelError)) throw e;
          done.skipped++;
          dropped[e.code] = (dropped[e.code] ?? 0) + 1;
        }
      }
      if (config.retainDays === 0 && job.episodeId) jobs.dropEpisode(job.episodeId);
    });
    if (done.forget) store.scrub();
    if (ops.length) this.deps.changed(ep.tenant);
    const result = { facts: facts.length, ...done, dropped };
    this.deps.log?.("extract.done", { job: job.id, ...result });
    return result;

    function apply(o: Op, e: NonNullable<typeof ep>, actorId: string, jobId: string): void {
      const scope: WriteScope = { tenant: e.tenant, user: e.user, project: o.fact.scope === "global" ? "" : e.project };
      const evidence = [evidenceFor(e.spans, o.fact.span, o.fact.quote, e.source)];
      const base = { origin: o.fact.origin, sensitivity: e.sensitivity, subject: o.fact.subject, evidence };
      if (o.op === "add") {
        // A taken name gets a suffix rather than losing the fact.
        for (let i = 1; ; i++) {
          const name = i === 1 ? o.name : `${o.name.slice(0, 60)}-${i}`;
          if (store.byName(scope, name) && i < 5) continue;
          store.create(scope, { ...base, name, description: o.description, body: o.body }, actorId, undefined, o.fact.text);
          return;
        }
      }
      const t: Memory = o.target;
      if (o.op === "supersede") {
        store.create({ tenant: t.tenant, user: t.user, project: t.project },
          { ...base, name: t.name, kind: t.kind, subject: o.fact.subject || t.subject, description: o.description, body: o.body,
            sensitivity: t.sensitivity === "private" ? "private" : e.sensitivity },
          actorId, { id: t.id, version: t.version }, o.reason);
      } else if (o.op === "end") {
        store.end(t.tenant, t.id, t.version, actorId, o.reason);
      } else if (o.op === "forget") {
        store.erase(t.tenant, t.id, actorId);
      } else {
        jobs.propose(t.tenant, { memoryId: t.id, memoryVersion: t.version, action: o.action, description: o.description, body: o.body, reason: o.reason, quote: o.fact.quote }, jobId);
      }
    }
  }
}

