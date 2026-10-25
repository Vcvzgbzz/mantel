/** Who wrote a memory's content. `tool` and `web` content is stored but never recalled automatically. */
export type Origin = "user" | "agent" | "tool" | "web" | "import";
/** `private` memories are never sent to, or recalled for, a model the operator has not marked local. */
export type Sensitivity = "normal" | "private";
/** Superseded and retracted memories stay readable with their history; only erase removes anything. */
export type Status = "active" | "superseded" | "retracted";
export type Audience = "local" | "remote";
export type Tone = "sincere" | "joking" | "unsure";

export const ORIGINS: readonly Origin[] = ["user", "agent", "tool", "web", "import"];
export const UNTRUSTED: ReadonlySet<Origin> = new Set(["tool", "web"]);

export interface Memory {
  id: string;
  tenant: string;
  /** "" = shared by every user of the tenant. */
  user: string;
  /** "" = not tied to a project. */
  project: string;
  /** Who or what the memory is about, e.g. "person:alex"; free-form. */
  subject: string;
  kind: string;
  name: string | null;
  description: string;
  body: string;
  origin: Origin;
  sensitivity: Sensitivity;
  status: Status;
  version: number;
  /** When the memory was true in the world, in ms; null = unknown. */
  validFrom: number | null;
  validTo: number | null;
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
  usedAt: number;
}

export interface EvidenceInput {
  quote: string;
  /** The line of the body this supports; omitted = the whole memory. */
  line?: string;
  tone?: Tone;
  /** Where it came from: a session id, a channel, a URL. */
  source?: string;
  /** Surrounding messages at the time, kept as a snapshot. */
  context?: { at?: string; author?: string; text: string; cited?: boolean }[];
}

export interface Evidence extends Required<Omit<EvidenceInput, "line" | "tone">> {
  line: string | null;
  tone: Tone | null;
  at: number;
}

export interface Revision {
  version: number;
  description: string;
  body: string;
  origin: Origin;
  status: Status;
  validFrom: number | null;
  validTo: number | null;
  actor: string;
  reason: string | null;
  at: number;
}

/** One place a write lands. */
export interface WriteScope { tenant: string; user: string; project: string }

/** What a caller may read: its own memories plus shared ones, in the listed projects ("" always included). */
export interface ReadScope { tenant: string; user: string; projects: string[] | "*"; audience: Audience }
