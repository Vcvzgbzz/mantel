import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Mantel } from "../src/mantel.js";
import type { ApiKey, KeyScope } from "../src/store.js";
import type { Audience } from "../src/types.js";

const DIM = 64;
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Bag-of-words hashed into DIM buckets: texts sharing words point the same way. */
export function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of words(text)) v[createHash("md5").update(w).digest()[0]! % DIM]! += 1;
  return v;
}

export interface Fake { url: string; seen: unknown[]; down: boolean; close(): Promise<void> }

async function fake(answer: (body: Record<string, unknown>) => unknown): Promise<Fake> {
  const f: Fake = { url: "", seen: [], down: false, close: () => new Promise((ok) => server.close(() => ok())) };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as Record<string, unknown>;
    f.seen.push(body);
    if (f.down) return void res.writeHead(503).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer(body)));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return f;
}

export const fakeEmbedder = () =>
  fake((b) => ({ data: (b.input as string[]).map((t, index) => ({ index, embedding: fakeVector(t) })) }));

/** Relevance = share of the query's words found in the document. Cohere response shape. */
export const fakeReranker = () =>
  fake((b) => {
    const q = new Set(words(b.query as string));
    return {
      results: (b.documents as string[]).map((d, index) => {
        const dw = new Set(words(d));
        return { index, relevance_score: q.size ? [...q].filter((w) => dw.has(w)).length / q.size : 0 };
      }),
    };
  });

export function open(o: { embed?: Fake; embedTrust?: Audience; rerank?: Fake; rerankTrust?: Audience; db?: string } = {}): Mantel {
  return Mantel.open({
    db: o.db ?? ":memory:",
    ...(o.embed ? { embed: { url: o.embed.url, model: "fake-embed", trust: o.embedTrust ?? "local" } } : {}),
    ...(o.rerank ? { rerank: { url: o.rerank.url, model: "fake-rerank", trust: o.rerankTrust ?? "local", threshold: 0.6 } } : {}),
  });
}

export function tenantKey(m: Mantel, o: { scopes?: KeyScope[]; user?: string; project?: string; audience?: Audience; tenant?: string } = {}): ApiKey {
  const name = o.tenant ?? "acme";
  const tenant = m.store.tenantId(name) ?? m.store.createTenant(name);
  return m.store.createKey(tenant, { scopes: o.scopes ?? ["read", "write"], user: o.user ?? null, project: o.project ?? null, audience: o.audience ?? "local" }).key;
}
