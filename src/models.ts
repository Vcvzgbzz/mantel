import type { Audience } from "./types.js";

/** An OpenAI-shaped endpoint. `trust` is the operator's word on where the data goes: `local` may see private memories. */
export interface Endpoint {
  /** Full URL, e.g. http://localhost:11434/v1/embeddings. */
  url: string;
  model: string;
  trust: Audience;
  /** Name of the environment variable holding a bearer token, if the endpoint needs one. */
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface EmbedConfig extends Endpoint {
  /** Prepended to queries, never to stored text (instruction-tuned embedders want one). */
  queryPrefix?: string;
  /** Same model behind another URL; tried when the first fails. Vectors must be interchangeable. */
  fallback?: Endpoint;
}

export interface RerankConfig extends Endpoint {
  /** A candidate needs at least this relevance to be recalled. Model-specific: calibrate it. */
  threshold: number;
}

const headers = (e: Endpoint): Record<string, string> => {
  const key = e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined;
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
};

async function post(e: Endpoint, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(e.url, { method: "POST", headers: headers(e), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${e.url}: HTTP ${res.status}`);
  return res.json();
}

const BATCH = 16;

export class Embedder {
  constructor(readonly cfg: EmbedConfig) {}

  get model(): string { return this.cfg.model; }

  /** Whether some configured endpoint may see private text. */
  get local(): boolean { return this.endpoints("local").length > 0; }

  /** Vectors for stored text. `audience: "local"` restricts the call to local endpoints. */
  async documents(texts: string[], audience: Audience = "remote", timeoutMs?: number): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) out.push(...(await this.call(texts.slice(i, i + BATCH), audience, timeoutMs ?? 30_000)));
    return out;
  }

  /** A query is the caller's own text, so it goes wherever the caller's model may send it. */
  async query(text: string, audience: Audience, timeoutMs?: number): Promise<number[]> {
    const [v] = await this.call([(this.cfg.queryPrefix ?? "") + text], audience, timeoutMs ?? this.cfg.timeoutMs ?? 2_000);
    return v!;
  }

  private endpoints(audience: Audience): Endpoint[] {
    return [this.cfg, ...(this.cfg.fallback ? [this.cfg.fallback] : [])].filter((e) => audience === "remote" || e.trust === "local");
  }

  private async call(input: string[], audience: Audience, timeoutMs: number): Promise<number[][]> {
    const eps = this.endpoints(audience);
    if (!eps.length) throw new Error("no embedding endpoint may see this text");
    let last: unknown;
    for (const e of eps) {
      try {
        const res = (await post(e, { model: e.model, input }, e.timeoutMs ?? timeoutMs)) as { data?: { index: number; embedding: number[] }[] };
        const data = res.data ?? [];
        if (data.length !== input.length) throw new Error(`${e.url}: ${data.length} vectors for ${input.length} inputs`);
        return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}

export interface ChatConfig extends Endpoint {
  maxTokens?: number;
  /** Extra request fields the server needs, e.g. `{chat_template_kwargs: {enable_thinking: false}}`. */
  extraBody?: Record<string, unknown>;
}

/** An OpenAI-shaped /v1/chat/completions endpoint, used for extraction. */
export class Chat {
  constructor(readonly cfg: ChatConfig) {}

  async complete(system: string, user: string): Promise<string> {
    const res = (await post(this.cfg, {
      model: this.cfg.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: this.cfg.maxTokens ?? 4_000,
      stream: false,
      ...this.cfg.extraBody,
    }, this.cfg.timeoutMs ?? 180_000)) as { choices?: { message?: { content?: string | null } }[] };
    return res.choices?.[0]?.message?.content ?? "";
  }
}

export class Reranker {
  constructor(readonly cfg: RerankConfig) {}

  /** Relevance per document, in order; null when the reranker is down, slow, or answers in an unknown shape. */
  async score(query: string, documents: string[]): Promise<number[] | null> {
    try {
      const res = (await post(this.cfg, { model: this.cfg.model, query, documents, top_n: documents.length }, this.cfg.timeoutMs ?? 1_000)) as {
        results?: { index: number; relevance_score: number }[];
        scores?: unknown[];
      };
      // Cohere/Jina/vLLM shape: results[{index, relevance_score}]. Also accepted: a bare scores[] in document order.
      if (Array.isArray(res.results)) {
        const out: number[] = new Array(documents.length).fill(Number.NaN);
        for (const r of res.results) if (r.index >= 0 && r.index < documents.length) out[r.index] = r.relevance_score;
        return out.every((s) => Number.isFinite(s)) ? out : null;
      }
      const s = res.scores;
      return Array.isArray(s) && s.length === documents.length && s.every((x) => typeof x === "number") ? (s as number[]) : null;
    } catch {
      return null;
    }
  }
}
