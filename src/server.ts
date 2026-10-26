import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { invalid, MantelError } from "./errors.js";
import type { SpanInput } from "./extract.js";
import type { Job, JobStatus } from "./jobs.js";
import { hearthHook, MANIFEST } from "./hearth.js";
import type { Mantel } from "./mantel.js";
import type { Candidate } from "./recall.js";
import { need } from "./scope.js";
import type { ApiKey, ImportedMemory, KeyScope, MemoryPatch, NewMemory } from "./store.js";
import type { Audience, Evidence, Memory, Revision, Status } from "./types.js";

const MAX_BODY = 1_000_000;

type Json = Record<string, unknown>;
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export function memoryJson(m: Memory): Json {
  return {
    id: m.id, user: m.user, project: m.project, subject: m.subject, kind: m.kind, name: m.name, description: m.description, body: m.body,
    origin: m.origin, sensitivity: m.sensitivity, status: m.status, version: m.version,
    validFrom: iso(m.validFrom), validTo: iso(m.validTo), supersededBy: m.supersededBy,
    createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt), usedAt: iso(m.usedAt),
  };
}

const candidateJson = (c: Candidate): Json => ({ memory: memoryJson(c.memory), similarity: c.similarity, textMatch: c.textMatch, relevance: c.relevance, kept: c.kept });
const revisionJson = (r: Revision): Json => ({ ...r, validFrom: iso(r.validFrom), validTo: iso(r.validTo), at: iso(r.at) });
const evidenceJson = (e: Evidence): Json => ({ ...e, at: iso(e.at) });
const jobJson = (j: Job): Json => ({ id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, error: j.error, result: j.result, createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt) });

/** Accepts an ISO date or epoch milliseconds; null clears. */
function time(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(t)) throw invalid(`${field} must be an ISO date or epoch milliseconds`);
  return t;
}

const str = (v: unknown, field: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`${field} must be a string`);
  return v;
};

function memoryInput(b: Json): MemoryPatch & Pick<NewMemory, "origin"> {
  const out: MemoryPatch & Pick<NewMemory, "origin"> = {};
  for (const f of ["description", "body", "subject", "kind"] as const) {
    const v = str(b[f], f);
    if (v !== undefined) out[f] = v;
  }
  if (b.name !== undefined) out.name = b.name === null ? null : str(b.name, "name")!;
  if (b.origin !== undefined) out.origin = str(b.origin, "origin") as NewMemory["origin"];
  if (b.sensitivity !== undefined) out.sensitivity = str(b.sensitivity, "sensitivity") as NewMemory["sensitivity"];
  const from = time(b.validFrom, "validFrom"), to = time(b.validTo, "validTo");
  if (from !== undefined) out.validFrom = from;
  if (to !== undefined) out.validTo = to;
  if (b.replaceEvidence === true) out.replaceEvidence = true;
  if (b.evidence !== undefined) {
    if (!Array.isArray(b.evidence)) throw invalid("evidence must be a list");
    out.evidence = b.evidence as NewMemory["evidence"];
  }
  return out;
}

function requested(src: Json | URLSearchParams): { user?: string; project?: string; audience?: Audience } {
  const get = (k: string) => (src instanceof URLSearchParams ? (src.get(k) ?? undefined) : str(src[k], k));
  const out: { user?: string; project?: string; audience?: Audience } = {};
  const user = get("user"), project = get("project"), audience = get("audience");
  if (user !== undefined) out.user = user;
  if (project !== undefined) out.project = project;
  if (audience !== undefined) out.audience = audience as Audience;
  return out;
}

/** `If-Match: "3"` → 3. Weak validators and lists are not accepted: an edit names exactly one version. */
function ifMatch(req: IncomingMessage): number | undefined {
  const h = req.headers["if-match"];
  if (h === undefined) return undefined;
  const m = /^\s*"?(\d+)"?\s*$/.exec(String(h));
  if (!m) throw invalid('If-Match must be the version, e.g. "3"');
  return Number(m[1]);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new MantelError("too_large", "request body is over 1 MB");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("request body is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("request body must be a JSON object");
  return v as Json;
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers });
  res.end(body !== undefined ? JSON.stringify(body) : undefined);
}

const one = (res: ServerResponse, status: number, m: Memory) => send(res, status, memoryJson(m), { etag: `"${m.version}"` });

type Handler = (ctx: { key: ApiKey; req: IncomingMessage; res: ServerResponse; url: URL; params: string[] }) => Promise<void> | void;

export function handler(mantel: Mantel) {
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/v1\/memories$/, ({ key, res, url }) => {
      const q = url.searchParams;
      const limit = q.get("limit"), cursor = q.get("cursor");
      const out = mantel.list(key, requested(q), {
        ...(q.get("status") ? { status: q.get("status") as Status | "all" } : {}),
        ...(q.get("subject") !== null ? { subject: q.get("subject")! } : {}),
        ...(q.get("kind") ? { kind: q.get("kind")! } : {}),
        ...(q.get("name") ? { name: q.get("name")! } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
        ...(cursor ? { cursor: Number(cursor) } : {}),
      });
      send(res, 200, { memories: out.memories.map(memoryJson), cursor: out.cursor });
    }],
    ["POST", /^\/v1\/memories$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      const input = memoryInput(b);
      if (typeof input.body !== "string") throw invalid("body is required");
      const sup = b.supersedes as { id?: unknown; version?: unknown } | undefined;
      if (sup !== undefined && (typeof sup?.id !== "string" || (sup.version !== undefined && typeof sup.version !== "number"))) {
        throw invalid("supersedes must be {id, version?}");
      }
      const m = mantel.create(key, requested(b), input as NewMemory, {
        ...(sup ? { supersedes: { id: sup.id as string, ...(sup.version !== undefined ? { version: sup.version as number } : {}) } } : {}),
        ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
      });
      one(res, 201, m);
    }],
    ["GET", /^\/v1\/memories\/([^/]+)$/, ({ key, res, params, url }) => {
      one(res, 200, mantel.get(key, params[0]!, (url.searchParams.get("audience") ?? undefined) as Audience | undefined));
    }],
    ["PATCH", /^\/v1\/memories\/([^/]+)$/, async ({ key, req, res, params }) => {
      const expect = ifMatch(req);
      if (expect === undefined) throw new MantelError("precondition_failed", "an edit needs If-Match with the version it is based on");
      const b = await readJson(req);
      if (b.origin !== undefined) throw invalid("origin cannot change; supersede the memory instead");
      one(res, 200, mantel.update(key, params[0]!, expect, memoryInput(b), str(b.reason, "reason")));
    }],
    ["POST", /^\/v1\/memories\/([^/]+)\/retract$/, async ({ key, req, res, params }) => {
      const b = await readJson(req);
      one(res, 200, mantel.retract(key, params[0]!, ifMatch(req), str(b.reason, "reason") ?? ""));
    }],
    ["POST", /^\/v1\/memories\/([^/]+)\/end$/, async ({ key, req, res, params }) => {
      const b = await readJson(req);
      const at = time(b.at, "at");
      one(res, 200, mantel.end(key, params[0]!, ifMatch(req), str(b.reason, "reason") ?? "", at ?? undefined));
    }],
    ["POST", /^\/v1\/memories\/([^/]+)\/touch$/, ({ key, res, params }) => {
      mantel.touch(key, params[0]!);
      send(res, 204);
    }],
    ["DELETE", /^\/v1\/memories\/([^/]+)$/, ({ key, res, params }) => {
      mantel.erase(key, params[0]!);
      send(res, 204);
    }],
    ["GET", /^\/v1\/memories\/([^/]+)\/revisions$/, ({ key, res, params }) => {
      send(res, 200, { revisions: mantel.revisions(key, params[0]!).map(revisionJson) });
    }],
    ["GET", /^\/v1\/memories\/([^/]+)\/evidence$/, ({ key, res, params }) => {
      send(res, 200, { evidence: mantel.evidence(key, params[0]!).map(evidenceJson) });
    }],
    ["POST", /^\/v1\/recall$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      const query = str(b.query, "query");
      if (!query) throw invalid("query is required");
      const out = await mantel.recall(key, requested(b), query, {
        ...(typeof b.k === "number" ? { k: b.k } : {}),
        ...(typeof b.threshold === "number" ? { threshold: b.threshold } : {}),
      });
      send(res, 200, {
        mode: out.mode,
        memories: out.hits.map((h) => ({ ...memoryJson(h.memory), relevance: h.relevance, similarity: h.similarity })),
        context: out.context,
        ...(b.explain === true ? { candidates: out.candidates.map(candidateJson) } : {}),
      });
    }],
    ["POST", /^\/v1\/search$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      const query = str(b.query, "query");
      if (!query) throw invalid("query is required");
      const hits = await mantel.search(key, requested(b), query, {
        ...(typeof b.limit === "number" ? { limit: b.limit } : {}),
        untrusted: b.includeUntrusted === true,
      });
      send(res, 200, { results: hits.map(candidateJson) });
    }],
    ["POST", /^\/v1\/episodes$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      if (!Array.isArray(b.spans)) throw invalid("spans must be a list of {role, content, tool?, origin?, at?}");
      const spans = (b.spans as Json[]).map((x) => ({ ...x, ...(x?.at !== undefined ? { at: time(x.at, "at") ?? undefined } : {}) })) as unknown as SpanInput[];
      const idem = req.headers["idempotency-key"];
      const out = mantel.ingest(key, requested(b), {
        spans,
        ...(typeof b.source === "string" ? { source: b.source } : {}),
        ...(b.sensitivity !== undefined ? { sensitivity: str(b.sensitivity, "sensitivity") as "normal" | "private" } : {}),
      }, typeof idem === "string" ? idem : undefined);
      send(res, out.created ? 202 : 200, { job: jobJson(out.job) });
    }],
    ["GET", /^\/v1\/jobs$/, ({ key, res, url }) => {
      const status = url.searchParams.get("status") as JobStatus | null;
      send(res, 200, { jobs: mantel.listJobs(key, status ? { status } : {}).map(jobJson) });
    }],
    ["GET", /^\/v1\/jobs\/([^/]+)$/, ({ key, res, params }) => send(res, 200, jobJson(mantel.job(key, params[0]!)))],
    ["GET", /^\/v1\/proposals$/, ({ key, res, url }) => {
      send(res, 200, { proposals: mantel.proposals(key, url.searchParams.get("user") ?? undefined).map((p) => ({ ...p, createdAt: iso(p.createdAt) })) });
    }],
    ["POST", /^\/v1\/proposals\/([^/]+)\/(accept|dismiss)$/, ({ key, res, params }) => {
      const m = mantel.resolveProposal(key, params[0]!, params[1] === "accept");
      if (m) one(res, 200, m);
      else send(res, 204);
    }],
    ["POST", /^\/v1\/import$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      if (!Array.isArray(b.memories) || b.memories.length > 1_000) throw invalid("memories must be a list of at most 1000");
      const items = (b.memories as Json[]).map((x) => {
        const t = (k: string) => time(x[k], k) ?? undefined;
        const revisions = Array.isArray(x.revisions) ? (x.revisions as Json[]).map((r) => ({ ...r, at: time(r.at, "revision at") })) : undefined;
        return { ...memoryInput(x), ...(typeof x.status === "string" ? { status: x.status as Status } : {}),
          createdAt: t("createdAt"), updatedAt: t("updatedAt"), usedAt: t("usedAt"), ...(revisions ? { revisions } : {}) };
      }) as unknown as ImportedMemory[];
      for (const it of items) if (typeof it.body !== "string") throw invalid("each memory needs a body");
      send(res, 200, { results: mantel.importMemories(key, requested(b), items) });
    }],
    ["GET", /^\/v1\/evidence\/summary$/, ({ key, res, url }) => {
      send(res, 200, { memories: mantel.evidenceSummary(key, requested(url.searchParams)) });
    }],
    ["POST", /^\/v1\/vectors$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      if (!Array.isArray(b.ids) || b.ids.some((x) => typeof x !== "string")) throw invalid("ids must be a list of memory ids");
      const out = mantel.vectors(key, b.ids as string[]);
      // Little-endian float32, base64: a fifth the size of JSON numbers.
      send(res, 200, { model: out.model, vectors: Object.fromEntries([...out.vectors].map(([id, v]) => [id, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64")])) });
    }],
    ["GET", /^\/hooks\/hearth\/manifest$/, ({ res }) => {
      if (!mantel.config.hearth) throw new MantelError("not_found", "the hearth hook is off; set hearth: in the config");
      send(res, 200, MANIFEST);
    }],
    ["POST", /^\/hooks\/hearth$/, async ({ key, req, res }) => {
      if (!mantel.config.hearth) throw new MantelError("not_found", "the hearth hook is off; set hearth: in the config");
      send(res, 200, await hearthHook(mantel, key, mantel.config.hearth, await readJson(req)));
    }],
    ["POST", /^\/v1\/erase$/, async ({ key, req, res }) => {
      const b = await readJson(req);
      const f = { ...(b.user !== undefined ? { user: str(b.user, "user")! } : {}), ...(b.subject !== undefined ? { subject: str(b.subject, "subject")! } : {}) };
      send(res, 200, { erased: mantel.eraseWhere(key, f) });
    }],
    ["GET", /^\/v1\/keys$/, ({ key, res }) => {
      need(key, "admin");
      send(res, 200, { keys: mantel.store.keys(key.tenant) });
    }],
    ["POST", /^\/v1\/keys$/, async ({ key, req, res }) => {
      need(key, "admin");
      const b = await readJson(req);
      const scopes: KeyScope[] = Array.isArray(b.scopes) ? (b.scopes as KeyScope[]) : ["read"];
      const out = mantel.store.createKey(key.tenant, {
        scopes,
        ...(typeof b.label === "string" ? { label: b.label } : {}),
        user: str(b.user, "user") ?? null,
        project: str(b.project, "project") ?? null,
        ...(b.audience !== undefined ? { audience: str(b.audience, "audience") as Audience } : {}),
      });
      send(res, 201, { ...out.key, secret: out.secret });
    }],
    ["DELETE", /^\/v1\/keys\/([^/]+)$/, ({ key, res, params }) => {
      need(key, "admin");
      if (!mantel.store.revokeKey(key.tenant, params[0]!)) throw new MantelError("not_found", "no such key");
      send(res, 204);
    }],
  ];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://mantel");
      if (req.method === "GET" && url.pathname === "/healthz") {
        // Says only whether the database answers: it is unauthenticated.
        const ok = mantel.healthy();
        return send(res, ok ? 200 : 503, { ok });
      }
      const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
      const key = auth ? mantel.authenticate(auth[1]!) : undefined;
      if (!key) throw new MantelError("unauthorized", "a valid API key is required (Authorization: Bearer mk_...)");
      const matches = routes.filter(([, re]) => re.test(url.pathname));
      const route = matches.find(([method]) => method === req.method);
      if (!route) {
        if (matches.length) return send(res, 405, { error: { code: "method_not_allowed", message: `use ${matches.map(([m]) => m).join(" or ")}` } });
        throw new MantelError("not_found", "no such endpoint");
      }
      const params = route[1].exec(url.pathname)!.slice(1).map(decodeURIComponent);
      await route[2]({ key, req, res, url, params });
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof MantelError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      send(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  };
}

export function serve(mantel: Mantel, listen: string): Promise<Server> {
  const i = listen.lastIndexOf(":");
  const host = listen.slice(0, i) || "127.0.0.1", port = Number(listen.slice(i + 1));
  const server = createServer(handler(mantel));
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => ok(server));
  });
}
