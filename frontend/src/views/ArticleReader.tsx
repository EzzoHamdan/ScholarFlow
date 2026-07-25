import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconBack, IconDoc } from '../components/Icons';
import { ArticleBlock } from './ArticleBlock';
import { AskComposer, type ComposerTarget } from './AskComposer';
import { NoteCardView, PendingNoteCard, type NoteGroup, type PendingNote } from './NoteCard';
import { captureSelection, clearAnchors, paintAnchors } from '../lib/highlight';
import { createPacer } from '../lib/pacer';
import {
  askNoteStream,
  deleteNote as deleteNoteApi,
  getFullDocument,
  listModels,
  listNotes,
  moveNote as moveNoteApi,
  type DocBlock,
  type FullDocument,
  type MarginSide,
  type ModelCatalog,
  type PaperNote,
} from '../api';

/**
 * The paper reading experience: a centred article with a note margin either side.
 *
 * Reading is scrolling. Nothing is revealed, gated, or paced — the whole paper
 * arrives in one request and renders at once.
 *
 * Asking is anchoring. Highlight a passage (or pick a figure or equation) and a
 * composer opens in the margin; the answer streams back into a card beside the
 * thing it is about. There is no chat pane, so a question with no selection
 * anchors to whatever block is at the top of the viewport.
 *
 * ⚠ The article column never moves. It is centred by a symmetric grid
 * (gutter | article | gutter) whose side columns are always present, so adding
 * a note cannot shift the text you are reading — the single most disruptive
 * thing a margin can do to a reader.
 */

/** Vertical breathing room between stacked note cards. */
const NOTE_GAP = 16;
/** Below this, neither margin fits: notes fall back to inline cards. */
const GUTTER_MIN_WIDTH = 1180;
/** Below this, only one margin fits, so every card goes right. */
const BOTH_GUTTERS_MIN_WIDTH = 1560;

type Layout = 'inline' | 'right-only' | 'both';

function layoutFor(width: number): Layout {
  if (width >= BOTH_GUTTERS_MIN_WIDTH) return 'both';
  if (width >= GUTTER_MIN_WIDTH) return 'right-only';
  return 'inline';
}

let clientIdSeq = 0;

interface Props {
  paperId: string;
  fallbackTitle: string;
  onBack: () => void;
}

export function ArticleReader({ paperId, fallbackTitle, onBack }: Props) {
  const [doc, setDoc] = useState<FullDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<PaperNote[]>([]);
  const [pending, setPending] = useState<PendingNote[]>([]);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [tintedBlocks, setTintedBlocks] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [layout, setLayout] = useState<Layout>(() => layoutFor(window.innerWidth));
  const wideEnough = layout !== 'inline';

  // Model choice. Remembered across sessions so the reader does not re-pick it
  // on every question, but re-validated against the catalog on load — a model
  // can be removed from Ollama between sessions.
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState<string>(
    () => { try { return localStorage.getItem('pal:model') || ''; } catch { return ''; } },
  );
  const chooseModel = useCallback((name: string) => {
    setModel(name);
    try { localStorage.setItem('pal:model', name); } catch { /* storage blocked */ }
  }, []);

  // Floating "Ask" pill shown at the end of a fresh selection.
  const [pill, setPill] = useState<{ top: number; left: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  // Note: the gutters need no refs. Cards are positioned against the ARTICLE's
  // top edge, and both gutters are grid items in the same row as the article,
  // so their origins already coincide.
  const blockRefs = useRef<Map<number, HTMLElement>>(new Map());
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  const registerBlockRef = useCallback((seq: number, el: HTMLElement | null) => {
    if (el) blockRefs.current.set(seq, el);
    else blockRefs.current.delete(seq);
  }, []);

  const blockFor = useCallback(
    (seq: number) => blockRefs.current.get(seq) ?? null,
    [],
  );

  // ── Load the paper and its notes ────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setLoadError(null);
    blockRefs.current.clear();

    getFullDocument(paperId)
      .then((d) => { if (alive) setDoc(d); })
      .catch((e: Error) => { if (alive) setLoadError(e.message); });

    listNotes(paperId)
      .then((n) => { if (alive) setNotes(n); })
      .catch(() => { /* notes are additive — a failure must not block reading */ });

    return () => { alive = false; };
  }, [paperId]);

  // A paper still being extracted has no blocks yet. Poll until it does,
  // rather than making the reader a dead end.
  useEffect(() => {
    if (!doc || doc.blocks.length > 0 || doc.status === 'failed') return;
    const id = setInterval(() => {
      getFullDocument(paperId).then(setDoc).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [doc, paperId]);

  useEffect(() => {
    let alive = true;
    listModels()
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        setModel((current) =>
          current && c.models.some((m) => m.name === current) ? current : c.default,
        );
      })
      .catch(() => { /* picker just stays hidden; the default model still answers */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => clearAnchors(), []);

  useEffect(() => {
    const onResize = () => setLayout(layoutFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Notes grouped into threads: a root plus its follow-ups ──────────────
  const groups = useMemo<NoteGroup[]>(() => {
    const byId = new Map(notes.map((n) => [n.id, n]));
    const rootOf = (n: PaperNote): PaperNote => {
      let cur = n;
      const guard = new Set<string>();
      while (cur.parent_note_id && byId.has(cur.parent_note_id) && !guard.has(cur.id)) {
        guard.add(cur.id);
        cur = byId.get(cur.parent_note_id)!;
      }
      return cur;
    };
    const map = new Map<string, NoteGroup>();
    for (const n of notes) {
      if (n.parent_note_id) continue;
      map.set(n.id, { root: n, replies: [] });
    }
    for (const n of notes) {
      if (!n.parent_note_id) continue;
      const group = map.get(rootOf(n).id);
      if (group) group.replies.push(n);
    }
    return [...map.values()].sort(
      (a, b) =>
        a.root.anchor_sequence_id - b.root.anchor_sequence_id ||
        (a.root.created_at || '').localeCompare(b.root.created_at || ''),
    );
  }, [notes]);

  // ── Paint the quote highlights inside the article ───────────────────────
  useEffect(() => {
    if (!doc) return;
    const anchors = groups.map((g) => ({
      noteId: g.root.id,
      sequenceId: g.root.anchor_sequence_id,
      quote: g.root.anchor_quote,
    }));
    // The article has to be laid out before ranges can be found in it.
    const raf = requestAnimationFrame(() => {
      const unmatched = paintAnchors(blockFor, anchors, activeNoteId);
      setTintedBlocks(new Set(unmatched));
    });
    return () => cancelAnimationFrame(raf);
  }, [doc, groups, activeNoteId, blockFor]);

  /** Which margin a card belongs in, honouring what the layout can show. */
  const sideOf = useCallback(
    (side: MarginSide | undefined): MarginSide =>
      layout === 'both' && side === 'left' ? 'left' : 'right',
    [layout],
  );

  // ── Margin layout: park each card beside its anchor, stacking downward ──
  const layoutNotes = useCallback(() => {
    const article = articleRef.current;
    if (!article) return;

    // Narrow window: cards stack under the article in normal flow, so any
    // leftover transform would push them off their own container.
    if (!wideEnough) {
      for (const el of cardRefs.current.values()) el.style.transform = '';
      return;
    }

    const articleTop = article.getBoundingClientRect().top;

    // Each margin is laid out independently — a card on the left must not be
    // pushed down by one on the right.
    const bySide: Record<MarginSide, Array<{ key: string; seq: number }>> = {
      left: [],
      right: [],
    };
    for (const g of groups) {
      bySide[sideOf(g.root.margin_side)].push({
        key: g.root.id,
        seq: g.root.anchor_sequence_id,
      });
    }
    for (const p of pending) {
      bySide[sideOf(p.marginSide)].push({ key: p.clientId, seq: p.anchorSequenceId });
    }
    if (composer) {
      bySide[sideOf(composer.marginSide)].push({
        key: 'composer',
        seq: composer.sequenceId,
      });
    }

    for (const side of ['left', 'right'] as MarginSide[]) {
      const entries = bySide[side].sort((a, b) => a.seq - b.seq);
      let cursor = -Infinity;
      for (const entry of entries) {
        const el = cardRefs.current.get(entry.key);
        const block = blockRefs.current.get(entry.seq);
        if (!el || !block) continue;
        const desired = block.getBoundingClientRect().top - articleTop;
        const top = Math.max(desired, cursor);
        el.style.transform = `translateY(${top}px)`;
        cursor = top + el.offsetHeight + NOTE_GAP;
      }
    }
  }, [groups, pending, composer, wideEnough, sideOf]);

  /**
   * Coalesced re-layout.
   *
   * ⚠ layoutNotes measures with getBoundingClientRect, which forces a
   * synchronous reflow. A streaming answer triggers it from three directions at
   * once — the React update, the ResizeObserver watching the growing card, and
   * the observer watching the article — so calling it directly meant several
   * forced reflows per repaint. Funnelling every request through one animation
   * frame collapses those into a single measure-and-place pass.
   */
  const layoutFrame = useRef(0);
  const requestLayout = useCallback(() => {
    if (layoutFrame.current) return;
    layoutFrame.current = requestAnimationFrame(() => {
      layoutFrame.current = 0;
      layoutNotes();
    });
  }, [layoutNotes]);

  useLayoutEffect(() => {
    // The first placement of a newly mounted card must land before paint,
    // otherwise it flashes at the top of the margin on its way to its anchor.
    layoutNotes();
    return () => {
      if (layoutFrame.current) cancelAnimationFrame(layoutFrame.current);
      layoutFrame.current = 0;
    };
  });

  // Cards grow as answers stream in, and the article reflows as KaTeX and
  // images settle. Re-measure on both rather than guessing at heights.
  useEffect(() => {
    if (!wideEnough) return;
    const ro = new ResizeObserver(requestLayout);
    if (articleRef.current) ro.observe(articleRef.current);
    for (const el of cardRefs.current.values()) ro.observe(el);
    window.addEventListener('resize', requestLayout);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', requestLayout);
    };
  }, [requestLayout, wideEnough, groups.length, pending.length, composer]);

  // ── Reading progress ────────────────────────────────────────────────────
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
    setPill(null);
  }, []);

  // ── Selection → the "Ask" pill ──────────────────────────────────────────
  useEffect(() => {
    const article = articleRef.current;
    const scroller = scrollRef.current;
    if (!article || !scroller) return;

    const onUp = () => {
      // Let the browser finish committing the selection first.
      setTimeout(() => {
        const cap = captureSelection(article);
        if (!cap) {
          setPill(null);
          return;
        }
        const bounds = scroller.getBoundingClientRect();
        setPill({
          top: cap.rect.bottom - bounds.top + scroller.scrollTop + 8,
          left: cap.rect.left - bounds.left + cap.rect.width / 2,
        });
      }, 10);
    };
    article.addEventListener('mouseup', onUp);
    return () => article.removeEventListener('mouseup', onUp);
  }, [doc]);

  /**
   * Mirror the server's placement rule so the composer opens where the note
   * will end up. Picking the side only at save time would make the card jump
   * across the page the moment you pressed Ask.
   */
  const suggestSide = useCallback(
    (seq: number): MarginSide => {
      if (layout !== 'both') return 'right';
      const near = groups.filter(
        (g) => Math.abs(g.root.anchor_sequence_id - seq) <= 6,
      );
      const right = near.filter((g) => (g.root.margin_side || 'right') === 'right').length;
      return right > near.length - right ? 'left' : 'right';
    },
    [groups, layout],
  );

  const openComposerFromSelection = useCallback(() => {
    const article = articleRef.current;
    if (!article) return;
    const cap = captureSelection(article);
    setPill(null);
    if (!cap) return;
    setComposer({
      sequenceId: cap.sequenceId,
      chunkId: cap.chunkId,
      kind: 'text',
      quote: cap.quote,
      imageUrl: null,
      marginSide: suggestSide(cap.sequenceId),
    });
    window.getSelection()?.removeAllRanges();
  }, [suggestSide]);

  const openComposerForBlock = useCallback(
    (block: DocBlock, kind: 'figure' | 'equation') => {
      setComposer({
        sequenceId: block.sequence_order,
        chunkId: block.id,
        kind,
        // For an equation the "quote" is its LaTeX, which the agent is told to
        // treat as a fallible transcription of the attached crop.
        quote: kind === 'equation'
          ? block.content_markdown || null
          : block.plain_text || null,
        imageUrl: block.image_url,
        marginSide: suggestSide(block.sequence_order),
      });
    },
    [suggestSide],
  );

  /** Anchor to whatever block is nearest the top of the viewport. */
  const openComposerAtViewport = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !doc) return;
    const top = scroller.getBoundingClientRect().top + 80;
    let best: { seq: number; id: string; delta: number } | null = null;
    for (const block of doc.blocks) {
      const el = blockRefs.current.get(block.sequence_order);
      if (!el) continue;
      const delta = Math.abs(el.getBoundingClientRect().top - top);
      if (!best || delta < best.delta) {
        best = { seq: block.sequence_order, id: block.id, delta };
      }
    }
    if (!best) return;
    setComposer({
      sequenceId: best.seq,
      chunkId: best.id,
      kind: 'block',
      quote: null,
      imageUrl: null,
      marginSide: suggestSide(best.seq),
    });
  }, [doc, suggestSide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable);
      if (typing) return;

      if (e.key === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const cap = articleRef.current ? captureSelection(articleRef.current) : null;
        if (cap) openComposerFromSelection();
        else openComposerAtViewport();
      }
      if (e.key === 'Escape') {
        setComposer(null);
        setPill(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openComposerFromSelection, openComposerAtViewport]);

  // ── Asking ──────────────────────────────────────────────────────────────
  const runNote = useCallback(
    async (draft: PendingNote, anchor: {
      kind: 'text' | 'figure' | 'equation' | 'block';
      sequence_id: number;
      chunk_id: string | null;
      quote: string | null;
      image_url: string | null;
    }) => {
      setPending((prev) => [...prev.filter((p) => p.clientId !== draft.clientId), draft]);
      const patch = (fn: (p: PendingNote) => PendingNote) =>
        setPending((prev) => prev.map((p) => (p.clientId === draft.clientId ? fn(p) : p)));

      // Tokens arrive in uneven bursts (see lib/pacer.ts). Feed them to the
      // pacer rather than to React, so the card paints at a readable rate
      // instead of mirroring the model's stutter.
      const pacer = createPacer((revealed) =>
        patch((p) => ({ ...p, answer: revealed, status: null })),
      );

      try {
        await askNoteStream(
          paperId,
          draft.question,
          anchor,
          draft.parentNoteId,
          {
            onCreated: (noteId) => patch((p) => ({ ...p, noteId })),
            onStatus: (message) => patch((p) => ({ ...p, status: message })),
            onToken: (text) => pacer.push(text),
          },
          undefined,
          draft.marginSide,
          // Only meaningful for a new note. The server ignores this on
          // follow-ups and uses the parent's model instead.
          draft.model,
        );
        // Let the pacer finish painting before the card is swapped for the
        // saved one — otherwise the last few words would be skipped over.
        await pacer.finish();
        // Refetch rather than splicing the response in: the server is the
        // authority on the note's final shape (citations, retrieval mode, and
        // the ordering the gutter lays out by).
        const fresh = await listNotes(paperId);
        setNotes(fresh);
        setPending((prev) => prev.filter((p) => p.clientId !== draft.clientId));
      } catch (e) {
        pacer.cancel();
        patch((p) => ({ ...p, error: (e as Error).message || 'Could not answer that.' }));
      }
    },
    [paperId],
  );

  const submitComposer = useCallback(
    (question: string) => {
      if (!composer) return;
      const draft: PendingNote = {
        clientId: `pending-${++clientIdSeq}`,
        noteId: null,
        anchorSequenceId: composer.sequenceId,
        anchorKind: composer.kind,
        quote: composer.quote,
        question,
        answer: '',
        status: null,
        error: null,
        parentNoteId: null,
        marginSide: composer.marginSide,
        model: model || null,
      };
      const anchor = {
        kind: composer.kind,
        sequence_id: composer.sequenceId,
        chunk_id: composer.chunkId,
        quote: composer.quote,
        image_url: composer.imageUrl,
      };
      setComposer(null);
      void runNote(draft, anchor);
    },
    [composer, model, runNote],
  );

  const submitFollowUp = useCallback(
    (parentNoteId: string, question: string) => {
      const parent = notes.find((n) => n.id === parentNoteId);
      if (!parent) return;
      const draft: PendingNote = {
        clientId: `pending-${++clientIdSeq}`,
        noteId: null,
        anchorSequenceId: parent.anchor_sequence_id,
        anchorKind: parent.anchor_kind,
        quote: parent.anchor_quote,
        question,
        answer: '',
        status: null,
        error: null,
        parentNoteId,
        // A follow-up joins its parent's card, so it must share its margin.
        marginSide: parent.margin_side || 'right',
        // Shown while it streams. The server independently enforces this from
        // the stored note, so a stale client cannot switch models mid-thread.
        model: parent.requested_model || parent.model,
      };
      void runNote(draft, {
        kind: parent.anchor_kind,
        sequence_id: parent.anchor_sequence_id,
        chunk_id: parent.anchor_chunk_id,
        quote: parent.anchor_quote,
        image_url: parent.anchor_image_path
          ? `/static/images/${parent.anchor_image_path}`
          : null,
      });
    },
    [notes, runNote],
  );

  const removeNote = useCallback(
    async (noteId: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== noteId && n.parent_note_id !== noteId));
      try {
        await deleteNoteApi(paperId, noteId);
      } catch {
        setNotes(await listNotes(paperId).catch(() => notes));
      }
    },
    [paperId, notes],
  );

  /** Move a saved note to the other margin, optimistically. */
  const flipNote = useCallback(
    async (noteId: string) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      const next: MarginSide = note.margin_side === 'right' ? 'left' : 'right';
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, margin_side: next } : n)),
      );
      try {
        await moveNoteApi(paperId, noteId, next);
      } catch {
        setNotes((prev) =>
          prev.map((n) => (n.id === noteId ? { ...n, margin_side: note.margin_side } : n)),
        );
      }
    },
    [notes, paperId],
  );

  const jumpTo = useCallback((seq: number) => {
    const el = blockRefs.current.get(seq);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1200);
  }, []);

  // Clicking a [[42]] citation link inside a note scrolls the article.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.('a[href^="#blk-"]');
      if (!anchor) return;
      e.preventDefault();
      jumpTo(Number(anchor.getAttribute('href')!.replace('#blk-', '')));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [jumpTo]);

  const registerCardRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) cardRefs.current.set(key, el);
    else cardRefs.current.delete(key);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  const title = doc?.title || fallbackTitle;
  const noteCount = groups.length;

  // Cards are rendered into whichever margin they belong to. Below the
  // two-gutter breakpoint sideOf() collapses everything to the right, so a
  // note saved on the left is still reachable on a narrow window.
  const canFlip = layout === 'both';

  const cardsFor = (side: MarginSide) => (
    <>
      {groups
        .filter((g) => sideOf(g.root.margin_side) === side)
        .map((group) => (
          <div
            key={group.root.id}
            className="note-slot"
            ref={(el) => registerCardRef(group.root.id, el)}
          >
            <NoteCardView
              group={group}
              active={activeNoteId === group.root.id}
              onFocus={() => setActiveNoteId(group.root.id)}
              onJump={jumpTo}
              onDelete={removeNote}
              onFollowUp={submitFollowUp}
              onFlip={canFlip ? () => void flipNote(group.root.id) : null}
            />
          </div>
        ))}

      {pending
        .filter((p) => sideOf(p.marginSide) === side)
        .map((p) => (
          <div
            key={p.clientId}
            className="note-slot"
            ref={(el) => registerCardRef(p.clientId, el)}
          >
            <PendingNoteCard
              note={p}
              onRetry={() => {
                const retry = { ...p, error: null, answer: '', status: null };
                void runNote(retry, {
                  kind: p.anchorKind as 'text' | 'figure' | 'equation' | 'block',
                  sequence_id: p.anchorSequenceId,
                  chunk_id: null,
                  quote: p.quote,
                  image_url: null,
                });
              }}
              onDismiss={() =>
                setPending((prev) => prev.filter((x) => x.clientId !== p.clientId))
              }
            />
          </div>
        ))}

      {composer && sideOf(composer.marginSide) === side && (
        <div className="note-slot" ref={(el) => registerCardRef('composer', el)}>
          <AskComposer
            target={composer}
            onSubmit={submitComposer}
            onCancel={() => setComposer(null)}
            catalog={catalog}
            model={model}
            onModelChange={chooseModel}
            onFlip={
              canFlip
                ? () =>
                    setComposer((c) =>
                      c
                        ? { ...c, marginSide: c.marginSide === 'right' ? 'left' : 'right' }
                        : c,
                    )
                : null
            }
          />
        </div>
      )}
    </>
  );

  return (
    <div className="reader-root">
      <header className="reader-bar">
        <button onClick={onBack} className="reader-back">
          <IconBack className="w-3.5 h-3.5" />
          <span>Library</span>
        </button>
        <span className="reader-sep" />
        <IconDoc className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--muted)' }} />
        <span className="reader-title">{title}</span>

        <div className="reader-bar-right">
          {noteCount > 0 && (
            <span className="reader-meta">{noteCount} note{noteCount === 1 ? '' : 's'}</span>
          )}
          {doc && doc.outline.length > 0 && (
            <button
              className="reader-chip"
              onClick={() => setOutlineOpen((v) => !v)}
            >
              Contents
            </button>
          )}
          <span className="reader-meta">{Math.round(progress * 100)}%</span>
        </div>
        <div className="reader-progress" style={{ width: `${progress * 100}%` }} />
      </header>

      {outlineOpen && doc && (
        <nav className="reader-outline" onClick={() => setOutlineOpen(false)}>
          <div className="reader-outline-inner" onClick={(e) => e.stopPropagation()}>
            {doc.outline.map((entry) => (
              <button
                key={entry.sequence_order}
                className={`outline-item outline-l${Math.min(entry.level, 3)}`}
                onClick={() => { jumpTo(entry.sequence_order); setOutlineOpen(false); }}
              >
                {entry.text}
              </button>
            ))}
          </div>
        </nav>
      )}

      <div className="reader-scroll thin-scroll" ref={scrollRef} onScroll={onScroll}>
        {loadError && <div className="reader-notice is-error">{loadError}</div>}

        {doc && doc.blocks.length === 0 && !loadError && (
          <div className="reader-notice">
            {doc.status === 'failed'
              ? 'Extraction failed for this paper.'
              : 'Extracting this paper… the text appears here as soon as it is ready.'}
          </div>
        )}

        <div className={`reader-layout layout-${layout}`}>
          {/* Rendered in both wide tiers. In 'right-only' it holds no cards
              but still occupies its grid column, which is what keeps the
              article centred instead of pushed left by the right margin. */}
          {layout !== 'inline' && (
            <aside className="reader-gutter gutter-left">
              {layout === 'both' ? cardsFor('left') : null}
            </aside>
          )}

          <article className="reader-article" ref={articleRef}>
            {doc && <h1 className="article-title">{doc.title}</h1>}
            {doc && (
              <div className="article-dek">
                {doc.page_count ? `${doc.page_count} pages` : ''}
                {doc.page_count && doc.blocks.length ? ' · ' : ''}
                {doc.blocks.length ? `${doc.blocks.length} blocks` : ''}
              </div>
            )}
            {doc?.blocks.map((block) => (
              <ArticleBlock
                key={block.id}
                block={block}
                blockTinted={tintedBlocks.has(block.sequence_order)}
                active={
                  activeNoteId != null &&
                  groups.some(
                    (g) =>
                      g.root.id === activeNoteId &&
                      g.root.anchor_sequence_id === block.sequence_order,
                  )
                }
                onAsk={openComposerForBlock}
                registerRef={registerBlockRef}
              />
            ))}
            {doc && doc.blocks.length > 0 && <div className="article-end">◆</div>}
          </article>

          <aside className="reader-gutter gutter-right">
            {cardsFor('right')}
          </aside>
        </div>

        {pill && (
          <button
            className="ask-pill"
            style={{ top: pill.top, left: pill.left }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openComposerFromSelection}
          >
            Ask
          </button>
        )}
      </div>

      {!composer && (
        <button className="ask-fab" onClick={openComposerAtViewport} title="Ask about what you're reading (A)">
          Ask
        </button>
      )}
    </div>
  );
}
