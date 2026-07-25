import { str } from './coerce';

/**
 * The recipient context panel's logic: what Auntie reads about a household
 * before drafting, and where things last left off with them.
 *
 * Ports `screens/communicate/RecipientContext.kt` and
 * `CommunicationHelpers.kt` from the archive. Free of React so every rule is
 * testable on its own.
 *
 * ── THE HONESTY RULE THIS MODULE EXISTS FOR ─────────────────────────────────
 * The AI recap is gated behind `auntieos.communicate.commsRecap`, which is OFF
 * by default. When the flag is OFF, the panel shows the raw latest message and
 * says nothing about a recap, because none was promised. When the flag is ON and
 * the recap comes back blank, the panel STILL shows the raw latest message but
 * discloses that it is doing so. Those two cases look identical on screen unless
 * something says otherwise, and an operator who turned the recap on deserves to
 * know they are not looking at one. `commsBoxState` is what keeps them distinct.
 */

/** The reconciler writes this literal into fields it has no data for. It is not context. */
const NOT_DOCUMENTED = 'Not yet documented.';

/** Longest snippet the box renders before truncating (archive: 140). */
export const SNIPPET_MAX = 140;

/**
 * The one line to show for a dossier or a 411: the reconciler's own `tldr` when
 * it wrote one, else the longer `rawSummary`, truncated.
 *
 * `tldr` first because it is the summary a model already made for exactly this
 * purpose; falling back to `rawSummary` means showing the unsummarized source
 * rather than showing nothing.
 */
export function summaryLine(tldr: string, rawSummary: string, max: number): string {
  const pick = str(tldr).trim() !== '' ? str(tldr).trim() : str(rawSummary).trim();
  if (pick === '') return '';
  if (pick.length <= max) return pick;
  return `${pick.slice(0, max).trimEnd()}…`;
}

/**
 * Whether a context field is worth rendering.
 *
 * Blank is obvious. The `NOT_DOCUMENTED` placeholder is the interesting one: it
 * is a real stored string, so a naive blank check renders a row that reads like
 * content and carries none. Hiding it lets the empty state below be truthful
 * about a household having nothing on file.
 */
export function contextFieldShown(value: string): boolean {
  const v = str(value).trim();
  return v !== '' && v !== NOT_DOCUMENTED;
}

/** "Dog · Border Collie", dropping either half that is missing rather than leaving a dangling separator. */
export function kinMetaLine(species: string, breed: string): string {
  return [str(species).trim(), str(breed).trim()].filter((p) => p !== '').join(' · ');
}

export type CommsChannel = 'sms' | 'email' | 'call' | 'voicemail';

/**
 * One row from any of the four comms collections, narrowed to the fields the
 * box reads. A cast over Firestore data, so every field is optional and read
 * through `str`.
 */
export interface CommsRow {
  _id: string;
  channel: CommsChannel;
  /** ISO-8601 UTC. Compared lexicographically, which is valid for this format. */
  timestamp?: string | undefined;
  body?: string | undefined;
  subject?: string | undefined;
  transcript?: string | undefined;
  status?: string | undefined;
}

/**
 * The text to show for one comms row, per channel, truncated.
 *
 * The fallbacks are the archive's and each one is doing real work: an email
 * whose subject is blank still has a body worth showing, and a call with no
 * transcript still has a status ("no-answer"), which is itself the news.
 */
export function commsSnippet(row: CommsRow): string {
  let text = '';
  switch (row.channel) {
    case 'sms':
      text = str(row.body);
      break;
    case 'email':
      text = str(row.subject).trim() !== '' ? str(row.subject) : str(row.body);
      break;
    case 'call':
      text = str(row.transcript).trim() !== '' ? str(row.transcript) : str(row.status);
      break;
    case 'voicemail':
      text = str(row.transcript);
      break;
  }
  const trimmed = text.trim();
  if (trimmed.length <= SNIPPET_MAX) return trimmed;
  return `${trimmed.slice(0, SNIPPET_MAX).trimEnd()}…`;
}

export interface LatestComm {
  channel: CommsChannel;
  timestamp: string;
  snippet: string;
}

/**
 * The single most recent communication across every channel, or null.
 *
 * Undated rows are DROPPED, not sorted. An empty timestamp sorts below every
 * real ISO string, so including them is harmless for the max, but a set
 * containing only undated rows would otherwise yield a "latest message" with no
 * date, which is worse than saying nothing.
 */
export function latestCommunication(rows: CommsRow[]): LatestComm | null {
  let best: LatestComm | null = null;
  for (const row of rows) {
    const ts = str(row.timestamp).trim();
    if (ts === '') continue;
    if (best === null || ts > best.timestamp) {
      best = { channel: row.channel, timestamp: ts, snippet: commsSnippet(row) };
    }
  }
  return best;
}

export type CommsBoxState =
  | { kind: 'recap'; recap: string }
  | { kind: 'latest'; latest: LatestComm; disclosedFallback: boolean }
  | { kind: 'empty' };

/**
 * What the "where things last left off" box should render.
 *
 * `disclosedFallback` is the whole point of this function. It is true only when
 * the operator ASKED for an AI recap (flag on) and did not get one, which is the
 * one case where showing the raw latest message silently would be a small lie.
 * With the flag off, the raw message is simply the feature, so there is nothing
 * to disclose.
 */
export function commsBoxState(flagOn: boolean, recap: string, latest: LatestComm | null): CommsBoxState {
  if (flagOn && str(recap).trim() !== '') return { kind: 'recap', recap: str(recap).trim() };
  if (latest !== null) return { kind: 'latest', latest, disclosedFallback: flagOn };
  return { kind: 'empty' };
}
