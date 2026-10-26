#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig } from "./config.js";
import { Mantel } from "./mantel.js";
import { serve } from "./server.js";
import type { KeyScope } from "./store.js";
import type { Audience } from "./types.js";

const USAGE = `mantel — a memory service for agents

  mantel serve                         run the HTTP API
  mantel tenant create <name>          create a tenant and print its first admin key
  mantel key create --tenant <name> [--scopes read,write] [--user u] [--project p] [--audience local|remote] [--label text]
  mantel key list --tenant <name>
  mantel key revoke --tenant <name> <key-id>

  -c, --config <file>   config file (default ./mantel.yaml)`;

const { values: o, positionals: [cmd, sub, arg] } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c", default: "mantel.yaml" },
    tenant: { type: "string" },
    scopes: { type: "string", default: "read,write" },
    user: { type: "string" },
    project: { type: "string" },
    audience: { type: "string", default: "remote" },
    label: { type: "string", default: "" },
    help: { type: "boolean", short: "h" },
  },
});

if (o.help || !cmd) {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

const config = loadConfig(o.config!);
const mantel = new Mantel(config);

function tenant(): string {
  if (!o.tenant) throw new Error("--tenant is required");
  const id = mantel.store.tenantId(o.tenant);
  if (!id) throw new Error(`no tenant named ${o.tenant}`);
  return id;
}

try {
  if (cmd === "serve") {
    await serve(mantel, config.listen);
    mantel.worker.start();
    const models = [config.embed && `embed ${config.embed.model} (${config.embed.trust})`, config.rerank && `rerank ${config.rerank.model} (${config.rerank.trust})`,
      config.extract && `extract ${config.extract.model} (${config.extract.trust})`];
    console.log(`mantel listening on http://${config.listen} — ${models.filter(Boolean).join(", ") || "no models: full-text search only, recall keeps nothing"}`);
  } else if (cmd === "tenant" && sub === "create" && arg) {
    const id = mantel.store.createTenant(arg);
    const { secret } = mantel.store.createKey(id, { scopes: ["admin"], label: "first admin key", audience: "local" });
    console.log(`tenant ${arg} created. Admin key (shown once):\n${secret}`);
  } else if (cmd === "key" && sub === "create") {
    const { key, secret } = mantel.store.createKey(tenant(), {
      scopes: o.scopes!.split(",").map((s) => s.trim()) as KeyScope[],
      user: o.user ?? null,
      project: o.project ?? null,
      audience: o.audience as Audience,
      label: o.label!,
    });
    console.log(`key ${key.id} (shown once):\n${secret}`);
  } else if (cmd === "key" && sub === "list") {
    for (const k of mantel.store.keys(tenant())) {
      console.log([k.id, k.scopes.join(","), `user=${k.user ?? "*"}`, `project=${k.project ?? "*"}`, k.audience, k.label].join("\t"));
    }
  } else if (cmd === "key" && sub === "revoke" && arg) {
    console.log(mantel.store.revokeKey(tenant(), arg) ? "revoked" : "no such key");
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`mantel: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
if (cmd !== "serve") mantel.close();
