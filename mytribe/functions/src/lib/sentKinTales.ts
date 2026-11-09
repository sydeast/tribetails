/**
 * The household's SENT KinTales, newest first, paged without skipping or
 * repeating a tale (#1775). Shared by `getMyKinTales` and `getMyKinPhotos`,
 * which page the same `kin_care_reports` rows with the same cursor.
 *
 * THE DEFECT. `kin_care_reports.sentAt` holds two shapes of text. Tales sent
 * since the May 2026 migration hold an ISO instant. The rows
 * `auntieos-admin/migrate_visit_logs_to_kin_care_reports.py` wrote hold the
 * source's free text ("September 3, 2025 2:02pm"), on purpose, and the reload
 * keeps writing it. Firestore orders strings by byte, so every letter sorts
 * above every digit: `orderBy('sentAt', 'desc')` put every migrated tale first,
 * alphabetical by month name, and the ISO `before` cursor sat below all of them,
 * so paging past page one skipped or repeated them. The admin list had the same
 * leak (#1767, PR #1770); this is the portal half.
 *
 * THE SHAPE OF THE FIX, the same three moves as the admin side:
 *   1. The pager reads ISO rows only (`sentAt < 'A'`).
 *   2. The free-text rows come from their own bounded read (`sentAt >= 'A'`,
 *      capped at {@link LEGACY_READ_CAP}) and are parsed here.
 *   3. Both sources merge by parsed instant. Every free-text row older than the
 *      cursor is already in memory, so a page is exact: the merged top `limit`
 *      cannot be missing an ISO row, because the ISO read is `limit + 1` deep.
 *
 * THE CURSOR stays what the clients already send, `before` = the last tale's
 * `sentAtMs`, strictly older than it. It stays correct across both sources
 * because it is a parsed instant, not a string. A tie (two tales at the same
 * millisecond, which free text with minute resolution makes possible) would
 * strand the second one behind a strict cursor, so a page never ends inside a
 * tie: it takes the whole tie group, and may run a row or two over `limit`.
 *
 * ROWS NO DATE CAN BE READ FROM sort last, are returned only on the page that
 * exhausts the dated rows (all of them, after the dated ones), and that page
 * says `hasMore: false`. Clients stop paging when the last tale has no
 * `sentAtMs`, so a tail spread over several pages would be unreachable; one
 * page cannot be. Their stored text rides along as `sentAtText` so a client
 * shows what was stored instead of a blank.
 *
 * Nothing is written. Migrated rows keep their original text.
 */
import { logEvent } from './logger';

/** The legacy text records no zone; the business runs on America/Chicago (ruling 2026-08-11). */
export const LEGACY_SENT_AT_ZONE = 'America/Chicago';

/** Free-text rows read per call. A household has dozens at most; reaching this is logged. */
export const LEGACY_READ_CAP = 500;

/** ISO rows read beyond `limit + 1`, so a page that ends in a tie can take the whole tie group. */
const TIE_SLACK = 25;

/** Everything that sorts below this letter is an ISO row (digits and punctuation); everything at or above is text. */
const ISO_UPPER_BOUND = 'A';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const LEGACY_PATTERN =
  /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})(?:,? (\d{1,2})(?::(\d{2}))? ?([ap])\.?m\.?)?$/i;

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Offset of `zone` from UTC at the instant `utcMs`, in ms (negative west of Greenwich). */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant a wall clock reads in `zone`. Two passes settle the offset across a DST change. */
function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive - zoneOffsetMs(naive, zone);
  guess = naive - zoneOffsetMs(guess, zone);
  return guess;
}

/**
 * Epoch ms for the migration's free text ("September 3, 2025 2:02pm"), read as
 * America/Chicago wall time. `null` for anything else, including an impossible
 * date (February 30) or hour (13pm). A date with no time reads as midnight.
 */
export function parseLegacySentAt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = LEGACY_PATTERN.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
  if (month === 0) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  let hour = 0;
  let minute = 0;
  if (m[4] !== undefined) {
    const h12 = Number(m[4]);
    minute = m[5] === undefined ? 0 : Number(m[5]);
    if (h12 < 1 || h12 > 12 || minute > 59) return null;
    hour = (h12 % 12) + (m[6]!.toLowerCase() === 'p' ? 12 : 0);
  }
  return zonedWallToUtc(year, month, day, hour, minute, LEGACY_SENT_AT_ZONE);
}

/** Epoch ms for a stored `sentAt` of either shape, or `null` when no date can be read from it. */
export function parseSentAtMs(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (ISO_PATTERN.test(text)) {
    const ms = new Date(text).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return parseLegacySentAt(text);
}

export interface SentTale {
  doc: FirebaseFirestore.QueryDocumentSnapshot;
  /** Parsed send instant; `null` for a row whose text holds no readable date. */
  sentAtMs: number | null;
}

export interface SentTalePage {
  tales: SentTale[];
  hasMore: boolean;
}

function byNewest(a: { sentAtMs: number; doc: { id: string } }, b: { sentAtMs: number; doc: { id: string } }): number {
  if (a.sentAtMs !== b.sentAtMs) return b.sentAtMs - a.sentAtMs;
  return a.doc.id < b.doc.id ? 1 : a.doc.id > b.doc.id ? -1 : 0;
}

/**
 * One page of the household's sent tales, newest first. `before` is the
 * previous page's last `sentAtMs` (exclusive); `limit` is the page size.
 */
export async function readSentKinTales(
  firestore: FirebaseFirestore.Firestore,
  kinfolkId: string,
  opts: { limit: number; before?: number | undefined; event: string },
): Promise<SentTalePage> {
  const { limit, before } = opts;
  const reports = firestore.collection('kin_care_reports').where('kinfolkId', '==', kinfolkId);

  const isoFetch = limit + 1 + TIE_SLACK;
  let isoQuery = reports
    .where('sentAt', '>', '')
    .where('sentAt', '<', ISO_UPPER_BOUND)
    .orderBy('sentAt', 'desc');
  if (before !== undefined) isoQuery = isoQuery.startAfter(new Date(before).toISOString());
  const textQuery = reports
    .where('sentAt', '>=', ISO_UPPER_BOUND)
    .orderBy('sentAt', 'desc')
    .limit(LEGACY_READ_CAP);

  const [isoSnap, textSnap] = await Promise.all([isoQuery.limit(isoFetch).get(), textQuery.get()]);

  if (textSnap.docs.length >= LEGACY_READ_CAP) {
    logEvent({
      severity: 'warn',
      function: opts.event,
      event: 'portal.kintales.legacyCapReached',
      extra: { kinfolkId, cap: LEGACY_READ_CAP },
    });
  }

  const dated: { doc: FirebaseFirestore.QueryDocumentSnapshot; sentAtMs: number }[] = [];
  const undated: SentTale[] = [];
  let unreadableIso = 0;

  for (const doc of isoSnap.docs) {
    const ms = parseSentAtMs(doc.data()['sentAt']);
    if (ms === null) {
      unreadableIso += 1;
      continue;
    }
    if (before !== undefined && ms >= before) continue;
    dated.push({ doc, sentAtMs: ms });
  }
  for (const doc of textSnap.docs) {
    const ms = parseSentAtMs(doc.data()['sentAt']);
    if (ms === null) {
      undated.push({ doc, sentAtMs: null });
      continue;
    }
    if (before !== undefined && ms >= before) continue;
    dated.push({ doc, sentAtMs: ms });
  }
  if (unreadableIso > 0) {
    // An ISO-range value that no Date can read (e.g. "2026-02-30") cannot be
    // placed or cursored. No writer produces one; surfaced rather than silent.
    logEvent({
      severity: 'warn',
      function: opts.event,
      event: 'portal.kintales.unreadableIsoDate',
      extra: { kinfolkId, count: unreadableIso },
    });
  }

  dated.sort(byNewest);

  let end = Math.min(limit, dated.length);
  // Never end a page inside a tie group: a strict `before` would strand the rest.
  while (end > 0 && end < dated.length && dated[end]!.sentAtMs === dated[end - 1]!.sentAtMs) end += 1;

  const tales: SentTale[] = dated.slice(0, end);
  const isoMayHaveMore = isoSnap.docs.length >= isoFetch;
  const exhausted = end === dated.length && !isoMayHaveMore;
  if (exhausted) {
    undated.sort((a, b) => (a.doc.id < b.doc.id ? 1 : a.doc.id > b.doc.id ? -1 : 0));
    tales.push(...undated);
  }
  return { tales, hasMore: !exhausted };
}
