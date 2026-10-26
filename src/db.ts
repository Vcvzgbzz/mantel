import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Applied in order; `PRAGMA user_version` records how many have run. Never edit a shipped entry. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tenants (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE api_keys (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    hash         TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL DEFAULT '',
    scopes       TEXT NOT NULL,
    user_pin     TEXT,
    project_pin  TEXT,
    audience     TEXT NOT NULL CHECK (audience IN ('local','remote')),
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );

  -- seq is the FTS rowid: an explicit INTEGER PRIMARY KEY survives VACUUM.
  CREATE TABLE memories (
    seq           INTEGER PRIMARY KEY,
    id            TEXT NOT NULL UNIQUE,
    tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL DEFAULT '',
    project       TEXT NOT NULL DEFAULT '',
    subject       TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'note',
    name          TEXT,
    description   TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL,
    origin        TEXT NOT NULL CHECK (origin IN ('user','agent','tool','web','import')),
    sensitivity   TEXT NOT NULL CHECK (sensitivity IN ('normal','private')),
    status        TEXT NOT NULL CHECK (status IN ('active','superseded','retracted')),
    version       INTEGER NOT NULL,
    valid_from    INTEGER,
    valid_to      INTEGER,
    superseded_by TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    used_at       INTEGER NOT NULL
  );
  CREATE INDEX memories_scope ON memories (tenant_id, user_id, project, status);
  CREATE UNIQUE INDEX memories_name ON memories (tenant_id, user_id, project, name)
    WHERE name IS NOT NULL AND status = 'active';

  -- Every version of a memory, the current one included.
  CREATE TABLE revisions (
    memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    description TEXT NOT NULL,
    body        TEXT NOT NULL,
    origin      TEXT NOT NULL,
    status      TEXT NOT NULL,
    valid_from  INTEGER,
    valid_to    INTEGER,
    actor       TEXT NOT NULL,
    reason      TEXT,
    at          INTEGER NOT NULL,
    PRIMARY KEY (memory_id, version)
  );

  CREATE TABLE evidence (
    id        INTEGER PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    quote     TEXT NOT NULL,
    line      TEXT,
    tone      TEXT CHECK (tone IN ('sincere','joking','unsure')),
    source    TEXT NOT NULL DEFAULT '',
    context   TEXT NOT NULL DEFAULT '[]',
    at        INTEGER NOT NULL
  );
  CREATE INDEX evidence_memory ON evidence (memory_id);

  CREATE TABLE vectors (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    model     TEXT NOT NULL,
    hash      TEXT NOT NULL,
    piece     INTEGER NOT NULL,
    vec       BLOB NOT NULL,
    PRIMARY KEY (memory_id, model, piece)
  );

  -- What was erased, by whom and when; never what it said.
  CREATE TABLE erasures (
    memory_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor     TEXT NOT NULL,
    at        INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    name, description, body, content='memories', content_rowid='seq', tokenize='porter unicode61'
  );
  CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, name, description, body) VALUES (new.seq, new.name, new.description, new.body);
  END;
  CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, name, description, body) VALUES ('delete', old.seq, old.name, old.description, old.body);
  END;
  CREATE TRIGGER memories_fts_au AFTER UPDATE OF name, description, body ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, name, description, body) VALUES ('delete', old.seq, old.name, old.description, old.body);
    INSERT INTO memories_fts (rowid, name, description, body) VALUES (new.seq, new.name, new.description, new.body);
  END;
  `,
  `
  -- A chunk of conversation sent for extraction. Kept only until extracted, unless retention says otherwise.
  CREATE TABLE episodes (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL DEFAULT '',
    project     TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal','private')),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX episodes_tenant ON episodes (tenant_id, user_id, created_at);

  -- origin is derived at ingest: who the text came from, after taint from web output.
  CREATE TABLE spans (
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system','memory')),
    origin     TEXT NOT NULL CHECK (origin IN ('user','agent','tool','web','system','memory')),
    tool       TEXT,
    content    TEXT NOT NULL,
    at         INTEGER,
    PRIMARY KEY (episode_id, seq)
  );

  CREATE TABLE jobs (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL,
    episode_id      TEXT REFERENCES episodes(id) ON DELETE SET NULL,
    idempotency_key TEXT,
    status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    run_after       INTEGER NOT NULL,
    error           TEXT,
    result          TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX jobs_idempotency ON jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX jobs_queue ON jobs (status, run_after);

  -- A change extraction wants to make to a memory a person wrote; applied only if accepted.
  CREATE TABLE proposals (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    memory_version INTEGER NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('update','end')),
    description    TEXT NOT NULL,
    body           TEXT NOT NULL,
    reason         TEXT NOT NULL,
    quote          TEXT NOT NULL,
    job_id         TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX proposals_memory ON proposals (tenant_id, memory_id);
  `,
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // secure_delete zeroes freed pages, so an erased memory does not linger in the file.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;");
  const at = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = at; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

let depth = 0;

/** Runs `fn` atomically. Nests through savepoints. */
export function tx<T>(db: Db, fn: () => T): T {
  const sp = `sp${depth++}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  } finally {
    depth--;
  }
}
