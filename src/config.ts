import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parse } from "yaml";

import type { ExtractConfig } from "./jobs.js";
import type { ChatConfig, EmbedConfig, Endpoint, RerankConfig } from "./models.js";
import { RECALL_DEFAULTS, type RecallConfig } from "./recall.js";
import { HEARTH_DEFAULTS, type HearthHookConfig } from "./hearth.js";
import type { Limits } from "./store.js";
import type { Sensitivity } from "./types.js";

export interface MantelConfig {
  /** SQLite file; relative paths resolve against the config file. */
  db: string;
  /** host:port for `mantel serve`. */
  listen: string;
  /** Sensitivity of memories written without one. */
  defaultSensitivity: Sensitivity;
  embed?: EmbedConfig;
  rerank?: RerankConfig;
  /** The chat model that turns conversations into memories. */
  extract?: ChatConfig & Partial<ExtractConfig>;
  recall: RecallConfig;
  /** Caps on each user's active memories; 0 = none. */
  limits: Limits;
  /** End project memories unused for this many days (0 = never). Memories with evidence are kept. */
  retireUnusedDays: number;
  /** Serve /hooks/hearth: mantel as a hearth plugin. Absent, the hook answers 404. */
  hearth?: HearthHookConfig;
}

export const DEFAULTS: MantelConfig = {
  db: "mantel.db",
  listen: "127.0.0.1:7411",
  defaultSensitivity: "normal",
  recall: RECALL_DEFAULTS,
  limits: { memoriesPerUser: 0, charsPerUser: 0 },
  retireUnusedDays: 0,
};

function endpoint(raw: unknown, where: string): Endpoint {
  const e = raw as Partial<Endpoint> | undefined;
  if (!e || typeof e.url !== "string" || typeof e.model !== "string") throw new Error(`${where}: url and model are required`);
  if (e.trust !== "local" && e.trust !== "remote") throw new Error(`${where}: trust must be local or remote`);
  return e as Endpoint;
}

/** Builds a config from a parsed object, applying defaults and rejecting what would silently misbehave. */
export function toConfig(raw: Record<string, unknown>, base = process.cwd()): MantelConfig {
  const cfg: MantelConfig = {
    ...DEFAULTS,
    ...(raw as Partial<MantelConfig>),
    limits: { ...DEFAULTS.limits, ...(raw.limits as Partial<Limits>) },
    recall: { ...RECALL_DEFAULTS, ...(raw.recall as Partial<RecallConfig>), gate: { ...RECALL_DEFAULTS.gate, ...(raw.recall as Partial<RecallConfig>)?.gate } },
  };
  cfg.db = cfg.db === ":memory:" ? cfg.db : resolve(base, cfg.db);
  for (const [k, v] of Object.entries({ ...cfg.limits, retireUnusedDays: cfg.retireUnusedDays })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a whole number, 0 or more`);
  }
  if (cfg.defaultSensitivity !== "normal" && cfg.defaultSensitivity !== "private") throw new Error("defaultSensitivity must be normal or private");
  if (raw.embed) {
    const e = endpoint(raw.embed, "embed") as EmbedConfig;
    if (e.fallback) endpoint(e.fallback, "embed.fallback");
    cfg.embed = e;
  }
  if (raw.rerank) {
    const r = endpoint(raw.rerank, "rerank") as RerankConfig;
    if (typeof r.threshold !== "number") throw new Error("rerank: threshold is required (it depends on the model; see the README)");
    cfg.rerank = r;
  }
  if (raw.extract) {
    const x = endpoint(raw.extract, "extract") as ChatConfig & Partial<ExtractConfig>;
    if (x.retainDays !== undefined && !(Number.isFinite(x.retainDays) && x.retainDays >= 0)) throw new Error("extract.retainDays must be 0 or more");
    cfg.extract = x;
  }
  if (raw.hearth) {
    const h = { ...HEARTH_DEFAULTS, ...(raw.hearth as Partial<HearthHookConfig>) };
    if (!Number.isInteger(h.k) || h.k < 1 || !Number.isInteger(h.contextMessages) || h.contextMessages < 1) throw new Error("hearth: k and contextMessages are whole numbers, 1 or more");
    if (!Array.isArray(h.localTools) || typeof h.callers !== "object") throw new Error("hearth: localTools is a list and callers a map");
    h.userHeader = h.userHeader.toLowerCase();
    h.projectHeader = h.projectHeader.toLowerCase();
    cfg.hearth = h;
  }
  return cfg;
}

export function loadConfig(path: string): MantelConfig {
  if (!existsSync(path)) return toConfig({}, dirname(resolve(path)));
  return toConfig((parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>, dirname(resolve(path)));
}
