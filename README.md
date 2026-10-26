# mantel

A self-hosted memory service for agents. Every memory records where it came from, edits keep their history, and nothing is overwritten or deleted unless someone asks for it.

- **Hybrid recall with an abstain gate.** Vector similarity and full-text search fused by reciprocal rank, then judged by a reranker. Below the threshold, recall returns nothing instead of the least-bad match.
- **Provenance.** Each memory has an `origin` (`user`, `agent`, `tool`, `web`, `import`). Tool- and web-sourced memories are stored and searchable but never recalled into a prompt automatically.
- **Non-destructive changes.** Edits need the version they were based on (`If-Match`) and every version is kept. A memory that stops being true is *superseded* by its replacement (with an end date) or *retracted*; both stay readable.
- **Real erasure.** `DELETE` removes a memory with its history, evidence, vectors and full-text entries, scrubs the file, and leaves only a record that something was erased.
- **Local-only data stays local.** Endpoints are declared `local` or `remote`. Private memories are never embedded, reranked or recalled through a remote model, and a local caller's query is never sent to one.
- **Extraction with provenance.** Send a conversation; a background job pulls out facts, each backed by a verbatim quote from one message, and each takes that message's origin. Assistant text that follows web output counts as web. Facts are judged against existing memories, and code (not the model) applies the result: supersede, end, add, or a *proposal* when the memory was written by a person.
- **Scoped keys.** Tenant → user → project. A key can be pinned to a user and/or project; a request can narrow inside a key's scope, never widen it.

Embedded SQLite (`node:sqlite`, FTS5), no native dependencies, any OpenAI-compatible embedding endpoint and any Cohere-style rerank endpoint.

## Quick start

Requires Node 22.13 or newer.

```sh
npm install -g @vcvzgbzz/mantel
mantel tenant create me          # prints an admin key, once
mantel serve
```

```sh
KEY=mk_...
curl -s localhost:7411/v1/memories -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"editor","description":"Editor preference","body":"Prefers helix.","origin":"user"}'

curl -s localhost:7411/v1/recall -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"which editor do I use?"}'
```

`recall` returns the kept memories and a `context` block ready to put in a prompt. The block quotes memories as data, and tells the model not to follow instructions inside them.

## Configuration

`mantel.yaml` in the working directory, or `-c path`:

```yaml
db: mantel.db
listen: 127.0.0.1:7411
defaultSensitivity: normal     # or private: every memory local-only unless marked otherwise

embed:
  url: http://localhost:11434/v1/embeddings
  model: nomic-embed-text
  trust: local                 # local | remote: may this endpoint see private memories?
  # queryPrefix: "Instruct: ...\nQuery:"   # for instruction-tuned embedders
  # apiKeyEnv: OPENAI_API_KEY
  # fallback: { url: ..., model: nomic-embed-text, trust: local }   # same model, another host

extract:                       # optional: turns conversations into memories
  url: http://localhost:11434/v1/chat/completions
  model: qwen3:14b
  trust: local
  retainDays: 0                # delete each conversation once extracted (default)
  # guidance: "Also remember the user's hardware."   # appended to the extraction prompt
  # extraBody: { chat_template_kwargs: { enable_thinking: false } }

rerank:
  url: http://localhost:8000/v1/rerank
  model: BAAI/bge-reranker-v2-m3
  trust: local
  threshold: 0.85              # model-specific; see below
  timeoutMs: 1000

limits: { memoriesPerUser: 5000, charsPerUser: 20000000 }   # per user, active memories only; 0 = none
retireUnusedDays: 60           # end project memories nobody has used in 60 days (kept as history); 0 = never

recall:
  k: 3
  candidates: 8
  gate: { sure: 0.7, maybe: 0.6 }   # used when no reranker answers
```

Without `embed`, search is full-text only and recall keeps nothing, since nothing can judge relevance. With `embed` but no `rerank`, the similarity gate decides.

**Thresholds depend on the models.** A reranker score or a cosine similarity means different things for different models. The defaults were calibrated for Qwen3-Embedding-0.6B and gte-reranker-modernbert-base. For other models, check what scores your relevant and unrelated queries get (`"explain": true` on `/v1/recall` returns every candidate's scores) and set the threshold between them.

## API

All endpoints take `Authorization: Bearer <key>`. Times are ISO 8601 (epoch milliseconds are accepted on input). Requests may pass `user`, `project` and `audience` (`local` | `remote`) within the key's limits.

| Method | Path | |
|---|---|---|
| `POST` | `/v1/memories` | Create. `supersedes: {id, version?}` replaces an active memory, keeping it as history. |
| `GET` | `/v1/memories` | List. Filters: `status` (`active`, `superseded`, `retracted`, `all`), `subject`, `kind`, `name`, `project` (`*` = all), `limit`, `cursor`. |
| `GET` | `/v1/memories/:id` | Read. `ETag` is the version. |
| `PATCH` | `/v1/memories/:id` | Edit in place. Requires `If-Match`. |
| `POST` | `/v1/memories/:id/retract` | Mark as wrong, with a `reason`. |
| `POST` | `/v1/memories/:id/end` | Mark as no longer true (`reason`, optional `at`), with no replacement. |
| `DELETE` | `/v1/memories/:id` | Erase permanently. |
| `GET` | `/v1/memories/:id/revisions` | Every version, newest first. |
| `GET` | `/v1/memories/:id/evidence` | Quotes and context the memory was learned from. |
| `POST` | `/v1/recall` | `{query, k?, threshold?, explain?}`: what to put in front of a model. |
| `POST` | `/v1/search` | `{query, limit?, includeUntrusted?}`: ranked matches, no gate. |
| `POST` | `/v1/episodes` | Queue a conversation for extraction. See below. |
| `GET` | `/v1/jobs`, `/v1/jobs/:id` | Extraction status, results and errors. |
| `GET` | `/v1/proposals` | Changes extraction wants to make to memories a person wrote. |
| `POST` | `/v1/proposals/:id/accept`, `/dismiss` | Apply one, or throw it away. |
| `POST` | `/v1/import` | Carry memories over from another system with timestamps, earlier versions and status. Admin. |
| `GET` | `/v1/evidence/summary` | Evidence and joking counts per memory. |
| `POST` | `/v1/vectors` | `{ids}`: each memory's mean embedding (base64 float32), for similarity maps. |
| `POST` | `/v1/erase` | `{user}` or `{subject}`: erase everything of a user or about a subject. Admin. |
| `GET` `POST` `DELETE` | `/v1/keys` | Manage keys. Admin. |

A memory:

```json
{
  "id": "…", "user": "", "project": "", "subject": "", "kind": "note",
  "name": "editor", "description": "Editor preference", "body": "Prefers helix.",
  "origin": "user", "sensitivity": "normal", "status": "active", "version": 1,
  "validFrom": null, "validTo": null, "supersededBy": null,
  "createdAt": "…", "updatedAt": "…", "usedAt": "…"
}
```

`user: ""` is shared by the tenant's users. `project: ""` applies in every project. `subject` says who or what the memory is about (`person:alex`). `validFrom`/`validTo` are when it was true in the world. Revisions record when it was written.

### Extraction

```json
POST /v1/episodes
Idempotency-Key: session-42:turn-17
{
  "project": "my-repo",
  "source": "session-42",
  "spans": [
    { "role": "user", "content": "We moved deploys to container images." },
    { "role": "tool", "tool": "web_fetch", "content": "…page text…" },
    { "role": "tool", "tool": "shell", "origin": "tool", "content": "PASS 42 tests" },
    { "role": "assistant", "content": "Tests pass with npm test." },
    { "role": "memory", "content": "…memories recalled into this turn…" }
  ]
}
```

Returns `202` with a job. The same `Idempotency-Key` returns the same job, so a client can resend safely.

- Roles: `user`, `assistant`, `tool`, `system`, `memory`. System text and recalled memories are never extracted from, so a recalled memory cannot be saved again as new evidence.
- **Tool output is untrusted unless marked.** A tool span is `web` unless it has `"origin": "tool"`, meaning a local tool whose output the assistant may build on (a shell, a test run). Assistant text after web output, until the next user message, counts as web as well.
- Facts from web or tool content are stored with that origin. They are never recalled automatically, and they can never change or remove another memory.
- Facts about the user come only from the user's own messages.
- A memory a person wrote (`origin: user`) is never changed automatically. The change becomes a proposal.
- Asking to forget something erases the memory, when the user asked.
- Each memory written by extraction gets evidence: the quote and a snapshot of the messages around it.
- `private` episodes are only sent to a `local` extraction model, and the memories they produce are private.
- A failed job is retried with backoff, then marked `failed` with its error.

### Keys

```sh
mantel key create --tenant me --scopes read,write --project my-repo --audience local --label "coding agent"
mantel key create --tenant me --scopes read --user alice      # an end user's key: alice's memories plus shared ones
```

`audience` caps what a key's results may contain. A `remote` key (the default) never sees private memories, for callers whose model runs elsewhere. A user-pinned key cannot write shared memories.

## Docker

```sh
docker run -v $PWD/mantel.yaml:/etc/mantel/mantel.yaml -v mantel-data:/data -p 7411:7411 ghcr.io/vcvzgbzz/mantel:main
```

In a container, set `listen: 0.0.0.0:7411` and `db: /data/mantel.db`. Create the first tenant with
`docker exec <container> node dist/cli.js -c /etc/mantel/mantel.yaml tenant create me`.

## Library

```ts
import { Mantel, serve } from "@vcvzgbzz/mantel";

const mantel = Mantel.open({ db: "mantel.db", embed: { url: "…", model: "…", trust: "local" } });
const key = mantel.authenticate(process.env.MANTEL_KEY!)!;
mantel.create(key, { project: "web" }, { body: "Deploys via container image.", origin: "user" });
const { hits, context } = await mantel.recall(key, { project: "web" }, "how do we deploy?");
```

## Not built yet

- An MCP server over the same API.
- A calibration command for thresholds.
- A Postgres backend for multi-replica deployments.

## License

MIT
