# Frontend

> **What this is:** the React SPA — routing, state, views, and how it talks to the API.
>
> **Owns:** client-side state and view behavior.
> **Does not own:** endpoint contracts ([api.md](../03-reference/api.md)).
>
> **Status:** current · **Last verified:** 2026-07-25 against
> [`frontend/src/App.tsx`](../../frontend/src/App.tsx) and
> [`views/ArticleReader.tsx`](../../frontend/src/views/ArticleReader.tsx) (`main`, 9b75500)
> **Verify with:** `cd frontend && npm run build` (runs `tsc` first)

Vite + React + Tailwind, no router library — a tiny state machine in
[App.tsx](../../frontend/src/App.tsx) toggles between four views.

## Two readers, chosen by `doc_kind`

[`ReadingView.tsx`](../../frontend/src/views/ReadingView.tsx) is now a dispatcher, not a view. It
fetches the paper's metadata and mounts one of:

| `doc_kind` | Component | Experience |
| --- | --- | --- |
| `paper` | [`ArticleReader.tsx`](../../frontend/src/views/ArticleReader.tsx) | The whole document at once, as continuous prose, with margin notes. |
| `book` | [`BookReadingView.tsx`](../../frontend/src/views/BookReadingView.tsx) | The original chapter-by-chapter reveal reader, with `<ChatPane>`. Preserved verbatim. |

⚠ It holds the frame for one round-trip rather than flashing the wrong reader and swapping it out.
Nothing on the paper path mounts `ChatPane`.

## Top-level state ([App.tsx](../../frontend/src/App.tsx))

```ts
type Route = 'library' | 'processing' | 'reading' | 'pdf-viewer';
```

Held in `useState<Route>`:

- **`library`** → `<LibraryView>`.
- **`processing`** → `<LibraryView>` underneath + `<ProcessingOverlay>` on top.
- **`reading`** → `<ReadingView>` (dispatches to `<ArticleReader>` or `<BookReadingView>`).
- **`pdf-viewer`** → reserved for an in-browser PDF viewer.

`App.tsx` also owns:
- `activePaper` — the `Paper` currently open in `ReadingView`.
- `activePaperId` — the backend UUID.
- `uploadingFile` — UX data for the processing overlay.
- `pollRef` — the `setInterval` ref for status polling.

## The fetch client ([api.ts](../../frontend/src/api.ts))

All calls go through `/api/v1` and are proxied by Vite to `http://localhost:8000`.

| Function                | Method/Path                                         |
| ----------------------- | --------------------------------------------------- |
| `listPapers()`          | `GET /papers` → `PaperMeta[]`                       |
| `uploadPaper(file)`     | `POST /papers/upload` (multipart)                   |
| `getPaperProgress(id)`  | `GET /papers/{id}/progress`                         |
| `getChunk(id, seq)`     | `GET /papers/{id}/chunks/{seq}` → `ChunkData` (book reader) |
| `getFullDocument(id)`   | `GET /papers/{id}/document` → `FullDocument` (article reader) |
| `listNotes(id)`         | `GET /papers/{id}/notes` → `PaperNote[]`            |
| `askNoteStream(...)`    | `POST /papers/{id}/notes/stream` (SSE)              |
| `moveNote(id, noteId, side)` | `PATCH /papers/{id}/notes/{noteId}/margin`     |
| `deleteNote(id, noteId)`| `DELETE /papers/{id}/notes/{noteId}`                |
| `listModels()`          | `GET /models` → `ModelCatalog`                      |
| `askPaper(id, q, seq, conv)` | `POST /papers/{id}/ask` → `AskResponse` (book reader) |
| `checkHealth()`         | `GET /health`                                       |
| `getRawPdfUrl(id)`      | `/api/v1/papers/{id}/raw`                           |
| `getStaticPdfUrl(id)`   | `/static/assets/{id}.pdf`                           |

All functions throw on non-`2xx`.

## LibraryView ([views/LibraryView.tsx](../../frontend/src/views/LibraryView.tsx))

Renders a paper grid/list. On mount, calls `listPapers()`. Features:
- Drag-and-drop and click-to-upload dropzone.
- Local search (substring match over title and authors).
- Local sort cycle: `recent → title → pages`.
- Two layouts: grid (cards) and list (rows).

## Upload + processing ([App.tsx](../../frontend/src/App.tsx))

`handleFileUpload(file)`:

1. Sets `uploadingFile`, switches to `route='processing'`.
2. Calls `uploadPaper(file)`. Gets back `{id, status:'processing'}`.
3. Starts `setInterval` every 1000 ms polling `/progress`.
4. On `status === 'complete'`: switch to `route='reading'`.
5. On `status === 'failed'`: go back to `library`.
6. Clear interval on cancel/unmount.

## ArticleReader ([views/ArticleReader.tsx](../../frontend/src/views/ArticleReader.tsx))

Reading is scrolling. One `getFullDocument()` call returns every block; nothing is revealed,
gated, or paced. Asking is anchoring: highlight something and the answer arrives as a card beside
it.

### Layout — three columns, always

```text
 ┌── margin ──┐ ┌────── article ──────┐ ┌── margin ──┐
 │            │ │                     │ │  ┌───────┐ │
 │            │ │  Recently, end-to-  │ │  │ note  │ │
 │  ┌──────┐  │ │  end OCR models…    │ │  │ card  │ │
 │  │ note │◄─┼─┼─ highlighted quote  │ │  └───────┘ │
 │  └──────┘  │ │                     │ │            │
 └────────────┘ └─────────────────────┘ └────────────┘
     360px              680px               360px
```

⚠ **The article column never moves.** Both margins are real grid columns whether or not they hold
a card, so a note appearing cannot shift the text under the reader's eye — the most disruptive
thing a margin can do. The cost is empty space on a paper with no notes.

Three tiers by viewport width: `both` (≥1560px), `right-only` (≥1180px, left column present but
empty so centring holds), `inline` (below that, cards fall into normal flow under the article).

### Anchoring

| Anchor kind | How the reader creates it |
| --- | --- |
| `text` | Drag-select inside a block → an "Ask" pill appears at the selection. |
| `figure` | Hover a figure → "Ask about this figure". |
| `equation` | Hover a formula → "Ask about this equation". |
| `block` | Press `A` or the Ask button with nothing selected → anchors to the block at the top of the viewport. |

Figures and equations need an explicit affordance because neither can be drag-selected — one is an
image, the other a tree of KaTeX spans that selects into gibberish.

⚠ Every block carries `data-seq` and `data-chunk-id`. That is how a selection is traced back to a
chunk and how a card finds the element to sit beside. Do not remove them.

### Quote highlights ([lib/highlight.ts](../../frontend/src/lib/highlight.ts))

Anchors are repainted with the **CSS Custom Highlight API**, not `<mark>` wrapping. Wrapping means
mutating DOM React owns: the next re-render discards the marks, and node-splitting inside a KaTeX
subtree corrupts the equation. Highlight ranges live outside the DOM tree entirely.

Matching is whitespace-insensitive, with a fallback ladder. A quote that can no longer be located
(after a re-chunk, say) degrades to a subtle tint on the whole block rather than vanishing.

### Streaming ([lib/pacer.ts](../../frontend/src/lib/pacer.ts))

⚠ Display is **decoupled from arrival**, deliberately adding a fraction of a second of latency.

Measured from `gemma4:31b-cloud`: 77 token events for one answer, median 5 characters, 19% of them
a single character, inter-event gaps of 79 ms at the median but 474 ms at p90 and 751 ms at worst.
Painting each event on arrival reproduces that stutter exactly.

The pacer buffers incoming text and reveals it on an animation frame at a steady rate, holding a
small **reserve** back so it can keep painting through a stall. Measured after: p50 59 ms, p90
62 ms, worst 141 ms, zero stalls over 300 ms.

It also withholds a half-written LaTeX span until its delimiter arrives, so the reader never
watches `$\mathcal{P` type itself out and then snap into a symbol.

### Block renderer ([views/ArticleBlock.tsx](../../frontend/src/views/ArticleBlock.tsx))

| Type | Rendering |
| --- | --- |
| `heading` | `article-h1/2/3` by `heading_path` depth. |
| `figure` | Centred image + caption, with a hover ask button. |
| `math` | Centred KaTeX, horizontally scrollable, with a hover ask button. |
| `table` | Real `<table>` from `table_json`, falling back to markdown. |
| `code` | Fenced monospace block. |
| `footnote` | Quiet side note with a rule. |
| default | Serif prose at 20px/1.72. |

Memoised — without it every keystroke in the composer would re-render the entire paper.

## ChatPane ([views/ChatPane.tsx](../../frontend/src/views/ChatPane.tsx))

⚠ `[historical]` for papers — reached only from `BookReadingView`.

Local state:
- `messages: ChatMessage[]` — turn log.
- `input: string` — textarea value.
- `thinking: boolean` — while a request is in flight.
- `conversationId: string | null` — persisted across turns.

`send()`:

1. Optimistically appends the user turn.
2. Calls `askPaper(paperId, q, currentSequenceOrder, conversationId)`.
3. On success: stores the returned `conversation_id`, appends the assistant
   turn with citation chips (text snippet, source, or `§<sequence_id>`).
4. On failure: appends a polite error message.

Submit key bindings: **Enter** sends, **Shift+Enter** inserts a newline.

## Sub-threads

The chat pane supports nested sub-threads. A sub-threaded turn has a
`parentTurnId`. The main view renders threads indented, and sub-threads
show only the subtree of messages.

## Inline paper figures

When the model responds with `![caption](url)` markdown, a `SafeWebImage`
component renders it directly in the chat. This is used for inline paper
figures in LOCAL and GLOBAL responses.

## Other components

- [`views/NoteCard.tsx`](../../frontend/src/views/NoteCard.tsx) — a margin note: quote, question,
  answer, model tag, citation chips, follow-up box, margin-flip control.
- [`views/AskComposer.tsx`](../../frontend/src/views/AskComposer.tsx) — the composer that opens on
  an anchor. Owns the model picker; never touches the network.
- [`components/Icons.tsx`](../../frontend/src/components/Icons.tsx) — inline SVG icons.
- [`components/LogoMark.tsx`](../../frontend/src/components/LogoMark.tsx) — the 9XAIPal wordmark.

## Styling

Tailwind utility classes with CSS variables (`--bg`, `--bg-2`, `--bg-3`,
`--fg`, `--muted`, `--accent`, `--ok`, `--border`) in
[src/index.css](../../frontend/src/index.css). Dark, low-contrast canvas with
serif headlines and mono labels.