import { forbidden, invalid } from "./errors.js";
import type { ApiKey, KeyScope } from "./store.js";
import type { Audience, Memory, ReadScope, WriteScope } from "./types.js";

/** What a request asks for. A key's pins and audience fix the ceiling; a request can only narrow inside it. */
export interface Requested { user?: string; project?: string; audience?: Audience }

const ID = /^[^\s*][^\s]{0,199}$/;

export function need(key: ApiKey, s: KeyScope): void {
  if (!key.scopes.includes(s) && !key.scopes.includes("admin")) throw forbidden(`this key lacks the ${s} scope`);
}

function pick(name: "user" | "project", pin: string | null, asked: string | undefined): string {
  if (asked !== undefined && asked !== "" && !ID.test(asked)) throw invalid(`${name} must be a non-empty identifier without spaces`);
  if (pin === null) return asked ?? "";
  if (asked === undefined || asked === pin) return pin;
  // A project-pinned key may still use project-wide ("") memories, the way a user's global notes apply everywhere.
  if (name === "project" && asked === "") return "";
  throw forbidden(`this key is pinned to ${name} ${pin}`);
}

export function writeScope(key: ApiKey, r: Requested): WriteScope {
  return { tenant: key.tenant, user: pick("user", key.user, r.user), project: pick("project", key.project, r.project) };
}

export function readScope(key: ApiKey, r: Requested): ReadScope {
  const audience = r.audience ?? key.audience;
  if (audience !== "local" && audience !== "remote") throw invalid("audience must be local or remote");
  if (key.audience === "remote" && audience === "local") throw forbidden("this key may only recall for remote models");
  const user = pick("user", key.user, r.user);
  if (r.project === "*") {
    if (key.project !== null) throw forbidden(`this key is pinned to project ${key.project}`);
    return { tenant: key.tenant, user, projects: "*", audience };
  }
  const project = pick("project", key.project, r.project);
  return { tenant: key.tenant, user, projects: project ? [project] : [], audience };
}

/** Whether a key may see a memory it addresses by id. An unpinned key sees every user and project in its tenant. */
export function canRead(key: ApiKey, m: Memory, audience: Audience = key.audience): boolean {
  return m.tenant === key.tenant
    && (key.user === null || m.user === "" || m.user === key.user)
    && (key.project === null || m.project === "" || m.project === key.project)
    && (audience === "local" || m.sensitivity === "normal");
}

/** A user-pinned key cannot change shared memories. */
export function canWrite(key: ApiKey, m: Memory): boolean {
  return m.tenant === key.tenant
    && (key.user === null || m.user === key.user)
    && (key.project === null || m.project === "" || m.project === key.project);
}
