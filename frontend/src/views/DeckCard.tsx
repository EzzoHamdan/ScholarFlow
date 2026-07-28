import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CardEyebrow,
  CardGrip,
  useCardDrag,
  type CardDrag,
} from './NoteChrome';
import type { DeckMemberKind, NoteDeck } from '../lib/personalNotes';

/**
 * A stack of margin cards occupying one card's worth of gutter.
 *
 * The gutter's scarce resource is vertical space: cards are placed at their
 * anchor and then pushed down past each other, so three tall notes on one
 * section drag the third one far below the paragraph it belongs to. A deck
 * trades simultaneous visibility for locality — you see one card at a time,
 * but every card in the stack stays beside the passage that produced it.
 *
 * Decks are built by dragging one card onto another and are stored locally,
 * because they are a reading-desk arrangement rather than a property of the
 * notes themselves: spreading a deck leaves every note exactly as it was.
 */

export interface DeckFace {
  id: string;
  kind: DeckMemberKind;
  /** One-line description, used by the pager tooltips. */
  title: string;
  /** The paragraph this member is anchored to. */
  seq: number;
}

export function DeckCard({
  deck,
  faces,
  renderFace,
  active,
  onFocus,
  onJump,
  onTopChange,
  onSpread,
  onTakeOut,
  onToggleStudy,
  onRename,
  onFlip,
  drag,
}: {
  deck: NoteDeck;
  /** Every member, in stacking order. */
  faces: DeckFace[];
  /**
   * Render the face-up member. `study` is non-null while the deck is in study
   * mode and the answer is still hidden.
   */
  renderFace: (face: DeckFace, study: { revealed: boolean; onReveal: () => void } | null) => ReactNode;
  active: boolean;
  onFocus: () => void;
  onJump: (seq: number) => void;
  onTopChange: (index: number) => void;
  onSpread: () => void;
  /** Pull the face-up card back out into its own slot. */
  onTakeOut: (memberId: string) => void;
  onToggleStudy: () => void;
  onRename: (label: string | null) => void;
  onFlip: (() => void) | null;
  drag: CardDrag | null;
}) {
  const { dragging, isDropTarget, zoneProps, gripProps } = useCardDrag(drag);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(deck.label ?? '');
  // Revealed is tracked per position, so flipping to the next card in study
  // mode always lands on its prompt rather than inheriting the last reveal.
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const count = faces.length;
  const top = Math.min(Math.max(deck.top, 0), Math.max(count - 1, 0));
  const face = faces[top];

  useEffect(() => {
    if (renaming) labelRef.current?.focus({ preventScroll: true });
  }, [renaming]);

  const go = (next: number) => {
    if (count === 0) return;
    onTopChange(((next % count) + count) % count);
    setRevealedAt(null);
  };

  if (!face) return null;

  const study = deck.study ? { revealed: revealedAt === top, onReveal: () => setRevealedAt(top) } : null;

  const commitRename = () => {
    const trimmed = draftLabel.trim();
    onRename(trimmed || null);
    setRenaming(false);
  };

  return (
    <div
      className={[
        'deck',
        dragging ? 'is-dragging' : '',
        isDropTarget ? 'is-drop-target' : '',
        deck.study ? 'is-study' : '',
      ].filter(Boolean).join(' ')}
      onMouseEnter={onFocus}
      {...zoneProps}
    >
      {/* The paper peeking out from under the face card. Clicking it advances,
          which is the gesture people already have for a physical stack. */}
      {count > 2 && (
        <button
          type="button"
          className="deck-edge deck-edge-2"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => go(top + 1)}
        />
      )}
      <button
        type="button"
        className="deck-edge deck-edge-1"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => go(top + 1)}
      />

      <article
        className={`note-card is-deck tone-${face.kind}${active ? ' is-active' : ''}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); go(top + 1); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); go(top - 1); }
          if (e.key === ' ' && study && !study.revealed) {
            e.preventDefault();
            study.onReveal();
          }
        }}
      >
        <CardEyebrow
          tone="deck"
          seq={face.seq}
          onJump={onJump}
          grip={<CardGrip {...gripProps} />}
          word={deck.label ?? 'Deck'}
          right={
            <span className="deck-pager">
              <button
                type="button"
                className="deck-step"
                onClick={() => go(top - 1)}
                title="Previous card (←)"
              >
                ‹
              </button>
              {count <= 6 ? (
                <span className="deck-dots">
                  {faces.map((f, i) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`deck-dot${i === top ? ' is-on' : ''} tone-${f.kind}`}
                      onClick={() => go(i)}
                      title={f.title}
                      aria-label={f.title}
                    />
                  ))}
                </span>
              ) : (
                <span className="deck-count">{top + 1}/{count}</span>
              )}
              <button
                type="button"
                className="deck-step"
                onClick={() => go(top + 1)}
                title="Next card (→)"
              >
                ›
              </button>
            </span>
          }
        />

        {renaming ? (
          <input
            ref={labelRef}
            className="deck-rename"
            value={draftLabel}
            placeholder="Name this deck…"
            onChange={(e) => setDraftLabel(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              if (e.key === 'Escape') { setDraftLabel(deck.label ?? ''); setRenaming(false); }
            }}
          />
        ) : null}

        {/* Keying on the position and the reveal restarts the turn-in
            animation, so changing card reads as the stack being flicked
            rather than the text silently swapping underneath you. */}
        <div className="deck-face" key={`${top}-${study?.revealed ? 'back' : 'front'}`}>
          {renderFace(face, study)}
        </div>

        <div className="deck-foot">
          <button type="button" onClick={() => onTakeOut(face.id)} title="Move this card out of the deck">
            Take out
          </button>
          <button type="button" onClick={onSpread} title="Break the deck up into separate cards">
            Spread
          </button>
          <button
            type="button"
            className={deck.study ? 'is-on' : ''}
            onClick={onToggleStudy}
            title="Hide each answer until you ask for it"
          >
            Study
          </button>
          <button type="button" onClick={() => { setDraftLabel(deck.label ?? ''); setRenaming(true); }}>
            Rename
          </button>
          {onFlip && (
            <button
              type="button"
              className="note-flip"
              onClick={onFlip}
              title={`Move to the ${deck.marginSide === 'right' ? 'left' : 'right'} margin`}
            >
              {deck.marginSide === 'right' ? '←' : '→'}
            </button>
          )}
        </div>
      </article>
    </div>
  );
}
