import { rec, str } from './coerce';
import { type ActivityLogEntry } from '../api/activityLog';

/**
 * What an Activity Log row shows when it is OPENED.
 *
 * Operator ruling R5, on the Activity Log itself: "the Activity Log is seriously
 * lacking, cant see shit or what the fuck actually happened."
 *
 * That is not a data problem, which is the surprising part. `writeAuditEntry`
 * has sealed `severity`, `actorRole`, `familyId`, `payload`, `requestId`, `ip`
 * and `userAgent` into every entry since 2026-05-19, and its docstring says
 * outright that they are "retained for forensic value ... surfaced in detail
 * views". No detail view was ever built. So the screen rendered four of the
 * eleven fields it had, and `payload` (the field that actually says what happened)
 * was never rendered anywhere, and page-spec 22 item 1 has carried "rows aren't
 * clickable / no detail view" as the core complaint since 2026-05-27.
 *
 * PURE, so the decisions get tested without a renderer. Nothing here fetches,
 * resolves or reformats: the audit trail is EVIDENCE, and a detail view that
 * prettied its contents would be editing the record on the way to the reader.
 * The one transformation applied is flattening nested payload maps to dotted
 * paths, which is presentation of structure, not of content.
 */

/** One labelled line in an opened entry. */
export interface ActivityDetailRow {
  label: string;
  value: string;
}

/**
 * The identity + provenance fields, in a fixed order, absent ones dropped.
 *
 * The full ISO `timestamp` leads, not the `HH:mm` slice the collapsed row shows:
 * the whole point of opening an entry is to see the parts the row truncates, and
 * "which second" is routinely the question when reconciling an audit trail
 * against a provider's logs.
 */
export function activityDetailRows(entry: ActivityLogEntry): ActivityDetailRow[] {
  const rows: ActivityDetailRow[] = [];
  const push = (label: string, value: string): void => {
    if (value.trim() !== '') rows.push({ label, value });
  };

  push('When', str(entry.timestamp));
  push('Action', str(entry.actionType));
  push('Status', str(entry.status));
  push('Severity', str(entry.severity));
  push('Actor', str(entry.actorId));
  push('Actor role', str(entry.actorRole));
  push('Household', str(entry.familyId));
  // A path, not a link. Where a route exists the screen offers one separately;
  // where none does, the path is still the most useful thing that can honestly
  // be shown (page-spec 22 item 1: "render the path read-only, do not fabricate
  // a link").
  const target = str(entry.targetId);
  if (target !== '') push('Target', `${str(entry.targetCollection) || 'target'}/${target}`);
  push('Request', str(entry.requestId));
  push('Client request', str(entry.clientRequestId));
  push('IP', str(entry.ip));
  push('User agent', str(entry.userAgent));
  return rows;
}

/**
 * The chain seal, or an empty array for a legacy pre-chain entry.
 *
 * Kept apart from the fields above because it answers a different question: not
 * "what happened" but "can this record be trusted". The screen renders it under
 * its own heading for the same reason.
 *
 * The FULL hashes, never a `.slice(0, 8)` prefix. The collapsed row abbreviates
 * because it has one line; an opened entry is where someone verifies a hash by
 * eye against `verifyActivityLogChain`, and a truncated hash cannot be verified
 * against anything.
 */
export function activityChainRows(entry: ActivityLogEntry): ActivityDetailRow[] {
  if (entry.seq === undefined) return [];
  const rows: ActivityDetailRow[] = [{ label: 'Sequence', value: `#${String(entry.seq)}` }];
  const entryHash = str(entry.entryHash);
  const prevHash = str(entry.prevHash);
  if (entryHash !== '') rows.push({ label: 'Entry hash', value: entryHash });
  if (prevHash !== '') rows.push({ label: 'Previous hash', value: prevHash });
  return rows;
}

/**
 * The `payload` map, flattened to dotted paths and sorted.
 *
 * THIS IS THE FIELD THAT ANSWERS "what the fuck actually happened", and it was
 * rendered nowhere. A NOTIFICATION_RECEIVED entry's description reads
 * "Notification kincare.booking.confirm delivered via email"; its payload
 * carries the notification id, the recipient uid and the provider's message id.
 * A BOOKING_SUBMITTED entry's payload carries the household, the batch and the
 * visit count. Same for every other event type: each one puts the specifics
 * here, because `writeAuditEntry` gives it nowhere else to put them.
 *
 * FLATTENED, not JSON-dumped. `sortDeep` in writeAuditEntry already sorts these
 * keys at write time (it has to: the hash is computed over the canonical form),
 * so a nested map arrives in a stable order and a dotted path is a stable label.
 * A pretty-printed JSON blob would be shorter to write and much worse to read.
 *
 * Sorted so two entries of the same type list their fields in the same order,
 * which is what makes them comparable by eye.
 */
export function activityPayloadRows(entry: ActivityLogEntry): ActivityDetailRow[] {
  const out: ActivityDetailRow[] = [];

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      // Arrays render as one line: an audit payload's arrays are short lists
      // (channel names, ids), and exploding them into `channels.0` / `channels.1`
      // buries the fact that they are one field.
      out.push({ label: path, value: value.map((v) => renderScalar(v)).join(', ') });
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const map = value as Record<string, unknown>;
      const keys = Object.keys(map).sort();
      // An empty nested map is reported rather than dropped: "this field is here
      // and it is empty" is a different fact from "this field is absent", and in
      // an audit trail the difference can matter.
      if (keys.length === 0) {
        out.push({ label: path, value: '{}' });
        return;
      }
      for (const k of keys) walk(map[k], path === '' ? k : `${path}.${k}`);
      return;
    }
    out.push({ label: path, value: renderScalar(value) });
  };

  const payload = rec(entry.payload);
  for (const k of Object.keys(payload).sort()) walk(payload[k], k);
  return out;
}

/**
 * A leaf value as text. `null` prints as "null" rather than blank, because a
 * recorded null is a decision the writer made and blanking it would hide that.
 */
function renderScalar(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // A Firestore Timestamp or anything else exotic. Never `String(obj)`, which
  // yields "[object Object]" and tells a reader nothing.
  return JSON.stringify(v);
}

/**
 * Free-text search over an entry, for the screen's filter box.
 *
 * Searches the payload too, which is the part that makes it useful: "find the
 * entry mentioning this booking id" is the actual question an operator has, and
 * the id is almost always in the payload rather than in the description.
 */
export function activityMatchesQuery(entry: ActivityLogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const haystack = [
    str(entry.actionType),
    str(entry.description),
    str(entry.actorId),
    str(entry.actorRole),
    str(entry.targetId),
    str(entry.targetCollection),
    str(entry.status),
    str(entry.severity),
    ...activityPayloadRows(entry).map((r) => `${r.label} ${r.value}`),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * The status buckets the filter chips offer.
 *
 * 'problems' folds FAILURE and ERROR together because an operator scanning for
 * trouble does not care which spelling a given writer used, and both are in the
 * data (writeAuditEntry only emits SUCCESS/FAILURE/PENDING, but pre-2026-05-19
 * rows carry ERROR).
 */
export type ActivityStatusFilter = 'all' | 'problems' | 'success' | 'pending';

export function activityMatchesStatus(
  entry: ActivityLogEntry,
  filter: ActivityStatusFilter,
): boolean {
  if (filter === 'all') return true;
  const s = str(entry.status).trim().toUpperCase();
  if (filter === 'problems') return s === 'FAILURE' || s === 'ERROR';
  if (filter === 'success') return s === 'SUCCESS';
  return s === 'PENDING';
}
