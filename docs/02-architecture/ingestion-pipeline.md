# Ingestion pipeline

> **What this is:** the path a PDF takes from upload to readable, chunk by chunk.
>
> **Owns:** extraction, chunking, asset handling, embedding, and summarization order.
> **Does not own:** how chunks are retrieved at question time ([chat-and-ask.md](chat-and-ask.md)),
> where files land on disk ([storage.md](../03-reference/storage.md)).
>
> **Companions:** [overview.md](overview.md) — system context ·
> [ai-backend.md](ai-backend.md) — which model embeds and summarizes ·
> [operations.md](../01-orientation/operations.md) — repairing a stuck ingestion.
>
> **Status:** current · **Last verified:** 2026-07-25 against
> [`extraction/pipeline_sync.py`](../../backend/app/extraction/pipeline_sync.py) and
> [`workers/tasks.py`](../../backend/app/workers/tasks.py)
> **Verify with:** `pytest tests/test_ingestion_pipeline.py -v`

This is the path a PDF takes from "the user dragged it onto the library"
to "I can read it chunk-by-chunk and ask grounded questions about it."

## End-to-end timeline

```
[Client]                  [API]                      [Celery worker]
─────────                 ─────                      ────────────────
drag/drop PDF
   │
   ▼
POST /papers/upload ──►  write to documents/<uuid>.pdf
                         write to assets/<doc_id>.pdf (for /raw download)
                         INSERT documents      (status='queued')
                         INSERT ingestion_jobs (status='queued')
                         process_ingestion.delay(doc_id, job_id, filename)
                         ◄── 201 {id, status:'processing'}
   │
   ▼
poll /papers/{id}/progress every 1s
                                                    run_pipeline_sync()
                                                      │
                                                      ▼
                                                    UPDATE ingestion_jobs → 'extracting'
                                                    mineru -p ... -o extracted/<doc_id>
                                                      → writes extracted/<doc_id>/*.md + images
                                                      │
                                                      ▼
                                                    UPDATE ingestion_jobs → 'chunking'
                                                    parse content_list.json into structural chunks
                                                    INSERT chunks (one row per chunk)
                                                      │
                                                      ▼
                                                    move images to images/<doc_id>/
                                                    INSERT chunk_assets (link via markdown ref)
                                                      │
                                                      ▼
                                                    _should_skip_embeddings()
                                                    UPDATE documents → embedding_mode
                                                      │
                                          ┌───────────┴───────────┐
                                     embedded                 skipped
                                          │                       │
                                  job → 'embedding'       job → 'summarizing'
                                  embed_document.delay()          │
                                          │                       │
                                    UPDATE documents → 'processing', page_count
   │                                      │                       │
   ▼                                      ▼                       │
poll continues                   embed_document_chunks_sync()     │
                                   → batches of 20 chunks         │
                                   → INSERT chunk_embeddings      │
                                          │                       │
                                          └───────────┬───────────┘
                                                      ▼
                                          generate_section_summaries
                                            → hierarchical summaries → section_summaries
                                            → VLM figure descriptions → figure_descriptions
                                            → _mark_document_and_job_complete()
   │                                                  │
   ▼                                                  ▼
status == 'complete'  ◄───────────────────────  documents + job → 'complete'
   │
   ▼
switch to ReadingView
```

⚠ `status='complete'` is set **once, at the very end**, by `generate_section_summaries` — not when
embeddings are dispatched. Both the embedded and skipped branches converge there.

## Step 1 — Upload

```http
POST /api/v1/papers/upload
Content-Type: multipart/form-data
file: <PDF bytes>
```

Server:

1. Generates a fresh storage filename: `<uuid4().hex>.pdf`.
2. Reads the file body into memory.
3. Writes it to `<storage_root>/documents/<uuid>.pdf` — this is what MinerU consumes.
4. Inserts a row into `documents` with `status='queued'`.
5. Writes a second copy to `<storage_root>/assets/<doc_id>.pdf`.
6. Inserts a row into `ingestion_jobs` with `status='queued'`.
7. Dispatches `process_ingestion.delay(doc_id, job_id, filename)` to Celery.
8. Returns `201` immediately.

The frontend starts a 1-second poll against `/progress`, showing the `ProcessingOverlay`.

## Step 2 — MinerU extraction

`process_ingestion` calls `run_pipeline_sync`:

1. `UPDATE ingestion_jobs SET status='extracting'`.
2. `mineru -p documents/<uuid>.pdf -o extracted/<doc_id> -m auto`.
3. MinerU writes one or more `.md` files and asset images.
4. `find_markdown_output` picks the largest `.md` file.
5. `find_images` recursively collects every image file.

If `mineru` exits non-zero, the pipeline raises `MinerUError`, the job
+ document are marked `failed`, and the polling frontend exits to the
library.

## Step 3 — Chunking

The chunker is **structural**: a chunk is one heading, one paragraph, one
math block, one table, or one figure.

Implementation:

1. Parse MinerU's `content_list.json` for structure. Fall back to regex
   markdown chunking if that's unavailable.
2. For each section:
   - Assign a monotonically increasing `sequence_id` (1-based).
   - Detect the chunk type: `heading > math ($$…$$) > table (|…|…|) > figure (![…](…)) > text`.
   - Maintain `current_heading_path` — a breadcrumb of H1→H6 titles.
   - Extract any `![alt](src)` image filenames into `image_refs`.
   - Extract `table_json` for table chunks.
   - Normalize markdown and extract plain text for embedding.
3. Returns a list of dicts ready for persistence.

## Step 4 — Persisting chunks + images

1. `UPDATE ingestion_jobs SET status='chunking'`.
2. `store_chunks` inserts one row per chunk into `chunks`.
3. For every image found in MinerU's output, call `move_asset_to_storage`.
   Copies the file to `images/<doc_id>/<uuid>.<ext>` and returns metadata.
4. Build an `original_name → asset_meta` map.
5. For each persisted chunk, look up its `image_refs` against the map.
   Each hit becomes an `INSERT INTO chunk_assets`.

## Step 5 — Embedding (conditional)

The pipeline decides here whether this document needs embeddings at all, then dispatches the
matching downstream task.

1. `_should_skip_embeddings()` — see [paper-only mode](#paper-only-mode-conditional-dispatch).
2. `UPDATE documents SET embedding_mode, embedding_skip_reason` — recorded once, never re-derived.
3. Branch:
   - **embedded** (default): `UPDATE ingestion_jobs SET status='embedding'`, then
     `embed_document.delay(document_id)`.
   - **skipped**: `UPDATE ingestion_jobs SET status='summarizing'`, then
     `generate_section_summaries.delay(document_id)` — the chain is re-attached here.
4. `UPDATE documents SET status='processing', page_count=<pypdf count>`.

⚠ **The pipeline does NOT mark the document complete.** Completion is set only by
`_mark_document_and_job_complete` at the end of `generate_section_summaries`
([`workers/tasks.py`](../../backend/app/workers/tasks.py)) — the single normal exit from the whole
pipeline. Marking it complete here was the bug that made the UI report "done" while the worker was
still embedding and describing figures.

### Paper-only mode: conditional dispatch

```text
                     chunks persisted
                            │
                            ▼
                  _should_skip_embeddings()
              (PAPER_ONLY_MODE? · doc_kind != book?
               · SUM(token_count) <= PAPER_ONLY_MAX_TOKENS?)
                            │
              ┌─────────────┴─────────────┐
         embedded                      skipped
              │                            │
    job → 'embedding'             job → 'summarizing'
    embed_document.delay()                 │
              │                            │
              ▼                            │
    embed_document_chunks_sync()           │
    → chunk_embeddings                     │
              │                            │
              └──────────┬─────────────────┘
                         ▼
          generate_section_summaries.delay()
                         │
                         ▼
          _mark_document_and_job_complete()   ← the ONLY normal exit
```

```mermaid
%%{init: {'themeVariables': {'fontFamily': 'ui-monospace, SFMono-Regular, Menlo, monospace', 'lineColor': '#8b949e'}}}%%
flowchart TD
    C[chunks persisted] --> G{{"_should_skip_embeddings()"}}
    G -->|embedded| E1[job → embedding]
    E1 --> E2[embed_document.delay]
    E2 --> E3[(chunk_embeddings)]
    E3 --> S
    G -->|skipped| K1[job → summarizing]
    K1 --> S[generate_section_summaries.delay]
    S --> M[["_mark_document_and_job_complete()<br/>the ONLY normal exit"]]

    classDef owned stroke:#3b82f6,stroke-width:2px
    classDef term stroke:#10b981,stroke-width:2px
    class G,E1,E2,K1,S owned
    class M term
```

> ⚠ The **dispatcher** is conditional; the **chain** is not. Both branches must terminate at
> `_mark_document_and_job_complete`. A skip path that simply dropped `embed_document` would leave
> the document at `processing` forever — the frontend polls `/progress` every second and would
> spin indefinitely with no error raised anywhere. Verified by
> `tests/test_paper_only_mode.py::test_skipped_document_still_reaches_complete`.

The gate is **measured token count**, not `doc_kind`. `doc_kind == 'book'` disqualifies a document,
but it is a guard only: it defaults to `'paper'`, so every document predating the book/paper
chooser already carries that label. Full rationale:
[paper-only-embedding-skip.md](../plans/paper-only-embedding-skip.md).

When embeddings run, the Celery worker:

1. Opens its own DB session.
2. Calls `embed_document_chunks_sync(session, document_id, batch_size=20)`.
3. Loops fetching chunks with no `chunk_embeddings` row.
4. Sends `plain_text` in batches to Ollama's embedding API.
5. Inserts each result into `chunk_embeddings` (`vector(VECTOR_DIMENSION)`, default 1024) along with the resolved `embedding_model` name.
6. Commits after each batch.

## Step 6 — Summarization (background)

Reached from either branch of Step 5 — after embeddings when they run, directly from the pipeline
when they are skipped. `generate_section_summaries`:

1. Hierarchical section summarization (level 0 = paper, level 1 = H1, level 2 = H2).
2. VLM figure descriptions for every `chunk_type='figure'` chunk.
3. Results stored in `section_summaries` and `figure_descriptions` tables.

This step is slow (minutes per paper) but doesn't block the user — they
can start reading and asking questions as soon as `status='complete'`.

## Status taxonomy

| Job status                    | Doc status   | Frontend behavior |
| ----------------------------- | ------------ | ----------------- |
| `queued`                      | `queued`     | overlay: queued   |
| `extracting`                  | `queued`     | overlay: extracting |
| `chunking`                    | `queued`     | overlay: chunking |
| `embedding`                   | `queued`     | overlay: embedding · skipped entirely in paper-only mode |
| `summarizing`                 | `complete`   | overlay closes    |
| `complete`                    | `complete`   | flip to ReadingView |
| `failed`                      | `failed`     | back to LibraryView |

## Deletion

`DELETE /papers/{id}` removes:
- DB cascade: chunks, chunk_embeddings, chunk_assets, ingestion_jobs,
  section_summaries, figure_descriptions.
- Disk cleanup (best effort): `documents/<filename>`, `assets/<id>.pdf`,
  `extracted/<id>/`, `images/<id>/`.
- Conversation turns survive with `document_id` set to null.