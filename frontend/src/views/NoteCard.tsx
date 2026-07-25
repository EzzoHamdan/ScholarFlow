import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_REMARK, MARKDOWN_REHYPE } from '../lib/markdown';
import { maskIncompleteMath } from '../lib/pacer';
import type { PaperNote } from '../api';

/**
 * A margin note: one question, its answer, and any follow-ups, rendered as a
 * card in the gutter beside the passage it is about.
 */

/** A note being generated right now — not yet a complete row. */
export interface PendingNote {
  clientId: string;
  noteId: string | null;
  anchorSequenceId: number;
  anchorKind: string;
  quote: string | null;
  question: string;
  answer: string;
  status: string | null;
  error: string | null;
  parentNoteId: string | null;
  marginSide: 'left' | 'right';
  /** The model this note was asked with, shown while it streams. */
  model: string | null;
}

export interface NoteGroup {
  /** The root note; follow-ups chain beneath it in one card. */
  root: PaperNote;
  replies: PaperNote[];
}

/**
 * Which model produced this answer.
 *
 * Shown on every answer, not just when several models are in play: the whole
 * point of the picker is comparing two notes asking the same thing, and that
 * comparison is only readable if each card says who spoke.
 */
function ModelTag({ name }: { name: string | null }) {
  if (!name) return null;
  return <div className="note-model" title={`Answered by ${name}`}>{name}</div>;
}

function Answer({ text }: { text: string }) {
  return (
    <div className="note-answer">
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK} rehypePlugins={MARKDOWN_REHYPE}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Rewrite the agent's [[42]] block markers into clickable links.
 *
 * Done as a text transform before markdown rather than as a rehype plugin: the
 * markers are the model's own convention, not markdown, and keeping the
 * rewrite here means the markdown pipeline stays shared with the reader.
 *
 * ⚠ Matches a whole bracket blob, not a single number. Models group references
 * as "[[16], [42]]" often enough that a strict single-number pattern leaves
 * raw brackets sitting in the rendered answer.
 */
function withCitationLinks(text: string): string {
  return text.replace(/\[\[([0-9,;\s[\]]+?)\]\]/g, (whole, inner: string) => {
    const seqs = inner.match(/\d+/g);
    if (!seqs) return whole;
    return seqs.map((seq) => `[¶${seq}](#blk-${seq})`).join(' ');
  });
}

function CitationChips({
  cited,
  onJump,
}: {
  cited: number[];
  onJump: (seq: number) => void;
}) {
  if (!cited.length) return null;
  return (
    <div className="note-cites">
      {cited.map((seq) => (
        <button key={seq} type="button" onClick={() => onJump(seq)} className="note-cite">
          ¶{seq}
        </button>
      ))}
    </div>
  );
}

function Quote({ kind, quote }: { kind: string; quote: string | null }) {
  if (kind === 'figure') {
    return <div className="note-quote note-quote-figure">On this figure</div>;
  }
  if (kind === 'equation') {
    return <div className="note-quote note-quote-figure">On this equation</div>;
  }
  if (!quote) {
    return <div className="note-quote note-quote-figure">On this passage</div>;
  }
  return <div className="note-quote">“{quote}”</div>;
}

export function PendingNoteCard({
  note,
  onRetry,
  onDismiss,
}: {
  note: PendingNote;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="note-card is-pending">
      <Quote kind={note.anchorKind} quote={note.quote} />
      <div className="note-question">{note.question}</div>
      <ModelTag name={note.model} />
      {note.error ? (
        <>
          <div className="note-error">{note.error}</div>
          <div className="note-actions">
            <button type="button" onClick={onRetry}>Retry</button>
            <button type="button" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      ) : note.answer ? (
        // Still streaming: withhold a half-written LaTeX span so the reader
        // doesn't watch raw markup type itself out and then snap into a symbol.
        <Answer text={withCitationLinks(maskIncompleteMath(note.answer))} />
      ) : (
        <div className="note-status">
          <span className="note-dot" />
          {note.status || 'Thinking…'}
        </div>
      )}
    </article>
  );
}

export function NoteCardView({
  group,
  active,
  onFocus,
  onJump,
  onDelete,
  onFollowUp,
  onFlip,
}: {
  group: NoteGroup;
  active: boolean;
  onFocus: () => void;
  onJump: (seq: number) => void;
  onDelete: (noteId: string) => void;
  onFollowUp: (parentNoteId: string, question: string) => void;
  /** Move this card to the other margin; null when only one margin fits. */
  onFlip: (() => void) | null;
}) {
  const [followUp, setFollowUp] = useState('');
  const [composing, setComposing] = useState(false);
  const followUpRef = useRef<HTMLTextAreaElement>(null);
  const last = group.replies.length ? group.replies[group.replies.length - 1] : group.root;

  // Focus without scrolling — see the note in AskComposer: an autoFocus here
  // yanks the article away from the passage the note is about.
  useEffect(() => {
    if (composing) followUpRef.current?.focus({ preventScroll: true });
  }, [composing]);

  const send = () => {
    const q = followUp.trim();
    if (!q) return;
    onFollowUp(last.id, q);
    setFollowUp('');
    setComposing(false);
  };

  return (
    <article
      className={`note-card ${active ? 'is-active' : ''}`}
      onMouseEnter={onFocus}
    >
      <Quote kind={group.root.anchor_kind} quote={group.root.anchor_quote} />

      <div className="note-question">{group.root.question}</div>
      <ModelTag name={group.root.model || group.root.requested_model} />
      <Answer text={withCitationLinks(group.root.answer)} />
      <CitationChips cited={group.root.cited_sequence_ids} onJump={onJump} />

      {group.replies.map((reply) => (
        <div key={reply.id} className="note-reply">
          <div className="note-question">{reply.question}</div>
          <ModelTag name={reply.model || reply.requested_model} />
          <Answer text={withCitationLinks(reply.answer)} />
          <CitationChips cited={reply.cited_sequence_ids} onJump={onJump} />
        </div>
      ))}

      <div className="note-footer">
        {composing ? (
          <div className="note-followup">
            <textarea
              ref={followUpRef}
              rows={2}
              value={followUp}
              placeholder="Follow up…"
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === 'Escape') setComposing(false);
              }}
            />
            <div className="note-actions">
              <button type="button" onClick={send} disabled={!followUp.trim()}>Ask</button>
              <button type="button" onClick={() => setComposing(false)}>Cancel</button>
              <span className="note-hint">
                stays on {group.root.requested_model || group.root.model || 'this model'}
              </span>
            </div>
          </div>
        ) : (
          <div className="note-actions note-actions-quiet">
            <button type="button" onClick={() => setComposing(true)}>Follow up</button>
            <button type="button" onClick={() => onDelete(group.root.id)}>Delete</button>
            {onFlip && (
              <button
                type="button"
                className="note-flip"
                onClick={onFlip}
                title={`Move to the ${group.root.margin_side === 'right' ? 'left' : 'right'} margin`}
              >
                {group.root.margin_side === 'right' ? '←' : '→'}
              </button>
            )}
            {group.root.retrieval_mode === 'agent' && (
              <span className="note-mode" title="This paper was too large to read at once, so the model searched it.">
                searched
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
