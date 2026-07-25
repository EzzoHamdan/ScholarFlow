# API reference

> **What this is:** every HTTP endpoint, its payload, and its errors. Look-up only — no narrative.
>
> **Owns:** endpoint paths, request/response shapes, status codes.
> **Does not own:** why a route behaves as it does ([chat-and-ask.md](../02-architecture/chat-and-ask.md)).
>
> **Status:** current · **Last verified:** 2026-07-25 against
> [`api/v1/router.py`](../../backend/app/api/v1/router.py) (`main`, 9b75500)
> **Verify with:** `http://localhost:8000/docs` (live OpenAPI, always authoritative)

All endpoints live under the prefix **`/api/v1`** and are registered in
[api/v1/router.py](../../backend/app/api/v1/router.py).

```
GET    /health
POST   /papers/upload
GET    /papers
GET    /papers/{paper_id}
GET    /papers/{paper_id}/progress
GET    /papers/{paper_id}/raw
DELETE /papers/{paper_id}
POST   /papers/{paper_id}/rechunk
POST   /papers/{paper_id}/reextract
POST   /papers/{paper_id}/regenerate-summaries
POST   /papers/{paper_id}/reconstruct-reading-order
GET    /papers/{paper_id}/document
GET    /papers/{paper_id}/chunks
GET    /papers/{paper_id}/chunks/{sequence_order}
GET    /papers/{paper_id}/chunks/after/{sequence_order}
GET    /papers/{paper_id}/chapters
GET    /papers/{paper_id}/figure-descriptions
GET    /papers/{paper_id}/notes
POST   /papers/{paper_id}/notes/stream
PATCH  /papers/{paper_id}/notes/{note_id}/margin
DELETE /papers/{paper_id}/notes/{note_id}
POST   /papers/{paper_id}/ask
POST   /papers/{paper_id}/ask/stream
GET    /papers/{paper_id}/chat
GET    /papers/{paper_id}/conversations
GET    /models
GET    /search/vector
GET    /search/web
```

Static (not under `/api/v1`):

```
GET /static/images/<doc_id>/<file>           — extracted chunk images
GET /static/extracted/<doc_id>/...           — raw MinerU output
GET /static/assets/<doc_id>.pdf              — original PDF, direct served
GET /static/images/research/<conv_id>/<file> — research-agent-saved images
```

## Health

### `GET /health`

Source: [endpoints/health.py](../../backend/app/api/v1/endpoints/health.py).

```json
{
  "status": "ok" | "degraded",
  "database": "ok" | "unavailable",
  "ollama":   "ok" | "unavailable",
  "searxng":  "ok" | "unavailable"
}
```

Probes the DB, Ollama (`/api/tags`), and SearXNG. Overall `status` is
`degraded` if the database is unavailable.

---

## Papers

### `POST /papers/upload`

Source: [endpoints/documents.py](../../backend/app/api/v1/endpoints/documents.py).

Multipart upload of a single PDF.

Request: `multipart/form-data` with `file=<binary>`.

Response: `201 Created`

```json
{
  "id":       "<uuid>",
  "filename": "<uuid>.pdf",
  "status":   "processing",
  "message":  "Document uploaded and queued for processing"
}
```

Side effects:

- Writes `documents/<uuid>.pdf` (used by MinerU).
- Writes `assets/<doc_id>.pdf` (used by `/raw` and `/static/assets/...`).
- Inserts a `documents` row (`status='queued'`).
- Inserts an `ingestion_jobs` row (`status='queued'`).
- Dispatches `process_ingestion.delay(doc_id, job_id, filename)` to Celery.
  If Celery dispatch fails, the document is marked `failed` with a
  descriptive message.

### `GET /papers`

List papers, newest first.

Query: `?limit=50&offset=0`.

Response:

```json
{
  "documents": [DocumentResponse, ...],
  "total":     <int>
}
```

`DocumentResponse` ([schemas/documents.py](../../backend/app/schemas/documents.py)):

```ts
{
  id: UUID,
  filename: string,                   // storage-side uuid
  original_filename: string,
  file_size_bytes: number | null,
  page_count: number | null,
  status: "queued" | "extracting" | "chunking" | "embedding" | "complete" | "failed",
  error_message: string | null,
  extractor: "mineru" | "pymupdf_fallback" | null,
  created_at: string,
  updated_at: string | null
}
```

### `GET /papers/{paper_id}`

Single paper. Returns `DocumentResponse` or `404 DocumentNotFound`.

### `GET /papers/{paper_id}/progress`

The frontend's polling endpoint during ingestion.

```json
{
  "paper_id": "<uuid>",
  "status": "queued|complete|failed",
  "job_status": "queued|extracting|chunking|embedding|summarizing|complete|failed",
  "page_count": <int|null>,
  "error_message": <string|null>,
  "extractor": "mineru|pymupdf_fallback|null"
}
```

### `GET /papers/{paper_id}/raw`

Streams the original uploaded PDF as `application/pdf`, with
`Content-Disposition` honoring the original filename. Falls back from
`assets/<id>.pdf` to `documents/<filename>` if needed.

### `DELETE /papers/{paper_id}`

`204 No Content`. Deletes the `documents` row (cascades to chunks,
embeddings, assets, summaries, ingestion jobs, figure descriptions, and
asset file paths on disk). Conversation turns survive with `document_id`
nullified.

### `POST /papers/{paper_id}/rechunk`

Re-runs the chunker on cached MinerU output. Wipes chunks/embeddings/assets,
re-inserts, re-queues embedding. `409` if no cached extraction.

### `POST /papers/{paper_id}/reextract`

Wipes cached extraction + DB side-effects and re-runs the full pipeline
(MinerU + chunker + embedding).

### `POST /papers/{paper_id}/regenerate-summaries`

Dispatches `generate_section_summaries` — re-runs hierarchical section
summarization and VLM figure descriptions. Returns `202 Accepted`.

### `POST /papers/{paper_id}/reconstruct-reading-order`

Dispatches `reconstruct_reading_order`. Sends chunks + bounding boxes to
the LLM to fix reading order for two-column / complex layouts.

---

## Chunks

Source: [endpoints/chunks.py](../../backend/app/api/v1/endpoints/chunks.py).

### `GET /papers/{paper_id}/document`

**The article reader's only load.** Returns every block of the paper plus its heading spine, in
one response — chunks and their image assets are fetched in two queries and joined in memory.

⚠ Deliberately unpaginated. The reader renders the whole paper at once; the previous approach
walked `/chunks/after/{seq}` once per chunk, costing 105 sequential round-trips on a 14-page
paper before a single word appeared.

```json
{
  "paper_id": "<uuid>",
  "title": "<original filename without extension>",
  "doc_kind": "paper" | "book",
  "status": "<document status>",
  "page_count": <int|null>,
  "extractor": "mineru" | "pymupdf_fallback" | null,
  "blocks": [
    {
      "id": "<uuid>", "sequence_order": <int>,
      "structural_type": "text|heading|math|table|figure|code|footnote",
      "content_markdown": "...", "plain_text": "...",
      "heading_path": ["..."] | null,
      "page_start": <int|null>, "page_end": <int|null>,
      "table_json": {"headers": [...], "rows": [[...]]} | null,
      "image_url": "/static/images/<doc_id>/<file>" | null
    }
  ],
  "outline": [{"sequence_order": <int>, "text": "...", "level": <int>}],
  "total": <int>
}
```

⚠ `image_url` is populated for `figure` **and** `math` blocks — MinerU crops a bitmap of every
equation alongside its LaTeX, and the reader hands that crop to the model when a question is
anchored to a formula.

### `GET /papers/{paper_id}/chunks`

List all chunks in sequence order.

Query: `?limit=100&offset=0`.

Response:

```json
{
  "chunks": [<raw chunk dict>, ...],
  "paper_id": "<uuid>",
  "total": <int>
}
```

### `GET /papers/{paper_id}/chunks/{sequence_order}`

The reading view's primary endpoint. Returns one chunk shaped for the
client:

```json
{
  "id":               "<uuid>",
  "paper_id":         "<uuid>",
  "sequence_order":   1,
  "content_markdown": "## Introduction\n...",
  "structural_type":  "heading" | "text" | "math" | "table" | "figure" | "footnote",
  "plain_text":       "Introduction ...",
  "page_start":       <int|null>,
  "page_end":         <int|null>,
  "heading_path":     ["Section 1", "1.1 Setup"] | null,
  "image_url":        "/static/images/<doc_id>/<uuid>.png" | null,
  "image_refs":       ["<original_name>", ...]
}
```

`image_url` is populated only when there's a row in `chunk_assets` for
this chunk with `asset_type='image'`.

`404 ChunkNotFound` when there's no chunk at that sequence — the
frontend uses this as the "end of paper" signal.

---

## Figure Descriptions

### `GET /papers/{paper_id}/figure-descriptions`

Returns VLM-generated technical descriptions for every figure in the paper.

```json
{
  "descriptions": [{
    "chunk_id": "<uuid>",
    "description_markdown": "This figure shows ...",
    "image_path": "<doc_id>/<uuid>.png",
    "model": "gemma4:31b-cloud"
  }, ...]
}
```

---

## Notes

Source: [endpoints/notes.py](../../backend/app/api/v1/endpoints/notes.py). Behaviour:
[chat-and-ask.md](../02-architecture/chat-and-ask.md).

A **note** is one question anchored to a place in a paper, plus its answer, rendered as a card in
the reader's margin. Notes live in `paper_notes` — not in `conversation_turns` — because they are
a different artifact: anchored, one Q+A per row, and untouched by routing, compaction, or
sub-threads.

### `GET /papers/{paper_id}/notes`

Every note on the paper, ordered by `anchor_sequence_id` then `created_at` — the same order the
margin lays them out in.

```json
{"notes": [
  {
    "id": "<uuid>",
    "anchor_sequence_id": <int>, "anchor_chunk_id": "<uuid>|null",
    "anchor_kind": "text|figure|equation|block",
    "anchor_quote": "<the highlighted passage>|null",
    "anchor_image_path": "<doc_id>/<file>|null",
    "question": "...", "answer": "...",
    "cited_sequence_ids": [<int>],
    "retrieval_mode": "whole" | "agent" | null,
    "model": "<what the provider reported>|null",
    "requested_model": "<what the reader picked>|null",
    "margin_side": "left" | "right",
    "parent_note_id": "<uuid>|null",
    "created_at": "<iso8601>"
  }
]}
```

### `POST /papers/{paper_id}/notes/stream`

Create a note and stream its answer as Server-Sent Events.

```json
{
  "question": "why is tau so small here?",
  "anchor": {
    "kind": "text|figure|equation|block",
    "sequence_id": <int>,
    "chunk_id": "<uuid>|null",
    "quote": "<selected text, or a figure caption / equation LaTeX>|null",
    "image_url": "/static/images/...|null"
  },
  "parent_note_id": "<uuid>|null",
  "margin_side": "left" | "right" | null,
  "model": "<model name>|null"
}
```

Event types, one JSON object per `data:` line:

| Event | Payload | Meaning |
| --- | --- | --- |
| `created` | `note_id` | The row exists — render the card now. |
| `status` | `message` | What the agent is doing (`Searching: …`, `Reading blocks 40–52`). |
| `token` | `text` | Answer text as it generates. |
| `done` | `note_id`, `answer`, `model`, `retrieval_mode`, `cited_sequence_ids` | Final state. |
| `error` | `detail` | Generation failed; the row survives with an empty answer. |

⚠ Three fields in the request are **advisory and can be overridden by the server**:

- `anchor.chunk_id` is always re-resolved from `sequence_id`. Re-chunking recreates every row with
  fresh UUIDs, so a tab opened before a re-chunk holds ids that no longer exist — inserting one
  violates the foreign key and 500s the request.
- `model` is **ignored entirely when `parent_note_id` is set**. A follow-up always uses the
  parent's `requested_model`. A thread that switched models halfway would destroy the comparison
  the picker exists for.
- `margin_side` defaults to whichever margin is less crowded near the anchor; a follow-up inherits
  its parent's side.

### `PATCH /papers/{paper_id}/notes/{note_id}/margin`

Body `{"margin_side": "left" | "right"}` → `{"id", "margin_side"}`. 400 on any other value.

### `DELETE /papers/{paper_id}/notes/{note_id}`

`204`. Follow-ups cascade with the root.

---

## Models

Source: [endpoints/models.py](../../backend/app/api/v1/endpoints/models.py),
[llm/catalog.py](../../backend/app/llm/catalog.py).

### `GET /models`

Models that can answer a note, local first and cloud-hosted last.

```json
{
  "models": [{"name": "gemma4:26b", "is_cloud": false, "size_bytes": 18000000000}],
  "default": "<the resolver's current chat model>"
}
```

Read from Ollama's `/api/tags`. A model is `is_cloud` when its name ends in `cloud` **or** it
reports `size_bytes: 0` — a cloud entry carries no local weights. Embedding models are filtered
out; they appear in the same tag list but cannot hold a conversation. Falls back to the single
configured cloud model when Ollama is unreachable.

---

## Ask

Source: [endpoints/ask.py](../../backend/app/api/v1/endpoints/ask.py).

### `POST /papers/{paper_id}/ask`

Request body:

```json
{
  "query":                     "What does this figure show?",
  "current_sequence_order":    3,
  "conversation_id":           "<uuid>",
  "visible_sequence_orders":   [3, 4, 5],
  "focused_element":           "figure:7" | "table:3" | null,
  "images_b64":                ["<raw base64>", ...]
}
```

Server resolves `current_sequence_order` → `current_chunk_id`, then
delegates to `chat.orchestrator.handle_ask`.

Response:

```json
{
  "answer":              "...",
  "context_type":        "LOCAL" | "GLOBAL" | "OVERVIEW" | "EXTERNAL" | "OUT_OF_SCOPE",
  "router_reason":       "Query references visible content (matched: 'this figure')",
  "citations":           [Citation, ...],
  "model":               "gemma4:31b-cloud",
  "conversation_id":     "<uuid>",
  "research_performed":  true | false,
  "research_summary":    "Studied N sources across M iterations" | null
}
```

`Citation`:

```ts
{
  chunk_id?: UUID,
  sequence_id?: number,
  page?: number,
  text_snippet?: string,
  url?: string,
  source?: "document" | "<engine name>"
}
```

### `GET /papers/{paper_id}/chat?conversation_id=<uuid>`

Returns saved conversation turns (oldest first) for a paper, optionally
filtered to one conversation.

### `GET /papers/{paper_id}/conversations`

Returns every distinct conversation thread for a paper:

```json
{
  "conversations": [
    {
      "conversation_id": "<uuid>",
      "turn_count": 5,
      "started_at": "...",
      "last_at": "...",
      "first_user_message": "..."
    }, ...
  ]
}
```

---

## Search (debug endpoints)

Source: [endpoints/search.py](../../backend/app/api/v1/endpoints/search.py). Not
called by the standard UI but useful for testing retrieval directly.

### `GET /search/vector?q=...&document_id=<uuid>&limit=10`

Embeds the query and returns the top-K chunks by cosine similarity.
`document_id` is optional — when omitted, searches across all papers.

### `GET /search/web?q=...&limit=5`

Bypasses the chat router and hits SearXNG directly, with the same
ranking that EXTERNAL would apply.

---

## Errors

[`api/errors.py`](../../backend/app/api/errors.py) registers two
domain exceptions:

| Exception          | HTTP | Body                                        |
| ------------------ | ---- | ------------------------------------------- |
| `DocumentNotFound` | 404  | `{ "detail": "Document <id> not found" }`   |
| `ChunkNotFound`    | 404  | `{ "detail": "No chunk at sequence_order=N" }` |

Body too large causes `413` with description. Internal failures return
`500` with traceback in `detail`.

---

## Lifecycle headers

CORS ([main.py](../../backend/app/main.py)) allows the dev origins:
`localhost:5173`, `localhost:3000`, `127.0.0.1:5173`. Methods and
headers are wide-open (`*`).