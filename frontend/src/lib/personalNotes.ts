/**
 * Client-side persistence for personal reading state.
 *
 * Bookmarks and user-authored notes are stored in localStorage per paper so
 * they survive refreshes and reopening the same document. They intentionally
 * live only on this machine and are not sent to the backend.
 */

export interface PersonalNote {
  id: string;
  anchorSequenceId: number;
  anchorChunkId: string | null;
  quote: string | null;
  body: string;
  marginSide: 'left' | 'right';
  createdAt: number;
  updatedAt: number;
}

/**
 * What the user sees when offered to resume.
 *
 * `snippet` and `kind` were added later; older localStorage entries may not
 * have them. Loaders tolerate their absence and the Resume UI falls back to
 * "at block N".
 */
export interface PersonalBookmark {
  sequenceId: number;
  progress: number;
  updatedAt: number;
  /** First ~70 chars of the bookmarked block, trimmed for display. */
  snippet?: string;
  /** Block kind at the bookmark — lets us label it "on figure" / "on equation". */
  kind?: 'text' | 'figure' | 'equation' | 'block';
  /** Page number where the bookmark lives, when known. */
  page?: number | null;
}

const notesKey = (paperId: string) => `pal:personal:${paperId}:notes`;
const bookmarkKey = (paperId: string) => `pal:personal:${paperId}:bookmark`;

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadPersonalNotes(paperId: string): PersonalNote[] {
  try {
    const raw = localStorage.getItem(notesKey(paperId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersonalNote[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePersonalNotes(paperId: string, notes: PersonalNote[]): void {
  try {
    localStorage.setItem(notesKey(paperId), JSON.stringify(notes));
  } catch {
    /* storage blocked or full */
  }
}

export function createPersonalNote(
  paperId: string,
  anchorSequenceId: number,
  anchorChunkId: string | null,
  quote: string | null,
  body: string,
  marginSide: 'left' | 'right',
): PersonalNote {
  const now = Date.now();
  const note: PersonalNote = {
    id: makeId(),
    anchorSequenceId,
    anchorChunkId,
    quote,
    body,
    marginSide,
    createdAt: now,
    updatedAt: now,
  };
  const notes = loadPersonalNotes(paperId);
  notes.push(note);
  savePersonalNotes(paperId, notes);
  return note;
}

export function updatePersonalNote(paperId: string, id: string, body: string): boolean {
  try {
    const notes = loadPersonalNotes(paperId);
    const idx = notes.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    notes[idx] = { ...notes[idx], body, updatedAt: Date.now() };
    savePersonalNotes(paperId, notes);
    return true;
  } catch {
    return false;
  }
}

export function deletePersonalNote(paperId: string, id: string): boolean {
  try {
    const notes = loadPersonalNotes(paperId).filter((n) => n.id !== id);
    savePersonalNotes(paperId, notes);
    return true;
  } catch {
    return false;
  }
}

export function movePersonalNote(paperId: string, id: string, side: 'left' | 'right'): boolean {
  try {
    const notes = loadPersonalNotes(paperId);
    const idx = notes.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    notes[idx] = { ...notes[idx], marginSide: side };
    savePersonalNotes(paperId, notes);
    return true;
  } catch {
    return false;
  }
}

export function loadBookmark(paperId: string): PersonalBookmark | null {
  try {
    const raw = localStorage.getItem(bookmarkKey(paperId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersonalBookmark>;
    if (typeof parsed.sequenceId !== 'number') return null;
    return {
      sequenceId: parsed.sequenceId,
      progress: typeof parsed.progress === 'number' ? parsed.progress : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      snippet: typeof parsed.snippet === 'string' ? parsed.snippet : undefined,
      kind: parsed.kind,
      page: typeof parsed.page === 'number' ? parsed.page : null,
    };
  } catch {
    return null;
  }
}

export function saveBookmark(paperId: string, bookmark: PersonalBookmark): void {
  try {
    localStorage.setItem(bookmarkKey(paperId), JSON.stringify(bookmark));
  } catch {
    /* no-op */
  }
}

export function clearBookmark(paperId: string): void {
  try {
    localStorage.removeItem(bookmarkKey(paperId));
  } catch {
    /* no-op */
  }
}
