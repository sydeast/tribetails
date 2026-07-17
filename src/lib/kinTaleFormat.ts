import type { Timestamp } from 'firebase/firestore';
import { dayKey, formatWhen, type FsTime } from './time';

/**
 * Pure KinTales ("the recap that goes home to a Kinfolk after care") list
 * classification + display helpers, kept out of the screen so the mapping
 * logic has direct vitest coverage (the sessionFormat.ts / invoiceFormat.ts
 * convention).
 *
 * SOURCE CONFIRMED against three independent places, not assumed from the
 * Kotlin model alone:
 *  - `firestore.rules:181` — `match /kin_care_reports/{reportId}` — a flat
 *    top-level collection, same shape as SESSIONS_QUERY/INVOICES_QUERY.
 *  - `FirestoreClient.kt:1998` (`data class KinCareReport`) — the wasm's own
 *    field shapes.
 *  - `FirestoreInterop.wasmJs.kt#platformCreateKinTaleReport` /
 *    `#platformUpdateKinTaleReport` — the REAL writers. Both stamp
 *    `createdAt`/`updatedAt` via a client-computed `nowIsoUtc()` STRING, never
 *    `FieldValue.serverTimestamp()`. `visitDate`/`arrivedAt`/`sentAt` are the
 *    same free-text ISO shape (mirrors `kin_care_sessions.startTime` in
 *    `sessionFormat.ts`) — every date field on this collection is opaque text,
 *    not a Firestore Timestamp.
 *
 * ── THE AO-18 FIX, non-negotiable per the port brief ───────────────────────
 * The wasm's `KinTaleLogsScreen.kt#shortDateTime` formats a report's timestamp
 * by SLICING the raw ISO string directly (`iso.substring(5, 7)` for the month,
 * `iso.substring(11, 16)` for the clock) — the exact AO-18 bug already fixed in
 * `sessionFormat.ts`: those substrings are UTC, so an evening visit reads as
 * the wrong calendar day and a wall-clock hour that never happened locally.
 * `kinTaleTimeOf` below is the same fix sessionFormat.ts applies: wrap the ISO
 * string as a fake Firestore `Timestamp` so it flows through `lib/time.ts`'s
 * LOCAL (`getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes`) helpers
 * instead of ever slicing the raw text.
 */

// ── ISO-string → local time (the AO-18 fix) ─────────────────────────────────

/**
 * Wraps a `kin_care_reports` free-text ISO timestamp field as a fake Firestore
 * `Timestamp` so it can flow through `lib/time.ts`'s LOCAL `dayKey`/`formatWhen`
 * unchanged. `null` for blank/unparseable input — same "degrade honestly,
 * never fabricate a date" contract `sessionFormat.ts#sessionTimeOf` uses.
 */
export function kinTaleTimeOf(iso: string): FsTime {
  const trimmed = iso.trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/** LOCAL `YYYY-MM-DD` day key for one of this collection's ISO fields, or `'Undated'`. Exposed for any caller that needs day-level grouping later; the list screen itself only needs the row-level `kinTaleWhen`. */
export function kinTaleDayKey(iso: string): string {
  return dayKey(kinTaleTimeOf(iso));
}

/** Fields `kinTaleWhen` reads, in the precedence order it reads them. A `Pick` rather than the full entry so the pure helper doesn't need the api module's full shape. */
export interface KinTaleWhenInput {
  visitDate: string;
  arrivedAt: string;
  sentAt: string;
  createdAt: string;
}

/**
 * "Jul 16 14:32", LOCAL, ported from the wasm's `visitTimestamp` precedence
 * (visitDate, then arrivedAt, then sentAt, then createdAt — the first
 * non-blank field wins) but re-derived through `lib/time.ts`'s LOCAL
 * `formatWhen` instead of `shortDateTime`'s raw UTC-string slicing (AO-18).
 * `'Date TBD'` only when every field is blank or unparseable — matches the
 * wasm's own fallback text.
 */
export function kinTaleWhen(entry: KinTaleWhenInput): string {
  const raw = [entry.visitDate, entry.arrivedAt, entry.sentAt, entry.createdAt].find(
    (v) => v.trim() !== '',
  );
  if (raw === undefined) return 'Date TBD';
  const formatted = formatWhen(kinTaleTimeOf(raw));
  return formatted === '(no time)' ? 'Date TBD' : formatted;
}

// ── household display ────────────────────────────────────────────────────

/** "Unnamed Kinfolk" fallback, matching `sessionFormat.ts#sessionHousehold` / `directory.ts#kinfolkDisplayName`'s convention — a report can be blank here (the orphan-migration rows `KinTaleLogsScreen.kt`'s `OrphanRow` triages are the extreme case, but any ad-hoc write can leave it blank). */
export function kinTaleHousehold(kinfolkName: string): string {
  const name = kinfolkName.trim();
  return name === '' ? 'Unnamed Kinfolk' : name;
}

// ── body / headline ──────────────────────────────────────────────────────

/**
 * Trims a report body to ~80 chars for a list-row preview, collapsing
 * whitespace so a multi-line draft doesn't blow out the row height. Ported
 * near-verbatim from `KinTaleLogsScreen.kt#bodyPreview`. `'(empty body)'` is
 * an honest label, not a blank space a screen reader would skip past.
 */
export function bodyPreview(body: string): string {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return '(empty body)';
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 80)}…`;
}

/**
 * The row's secondary content line: the auntie-authored `title` when one was
 * set, else a preview of the body. Neither field is rendered by the wasm's
 * own `ReportRow` (it shows only the Kinfolk name + submeta), but the port
 * brief calls for showing what a KinTale actually carries, so this surfaces
 * it — always from real doc text, never a fabricated summary.
 */
export function kinTaleHeadline(title: string, body: string): string {
  const trimmedTitle = title.trim();
  return trimmedTitle !== '' ? trimmedTitle : bodyPreview(body);
}

// ── send-channel label ───────────────────────────────────────────────────

/**
 * Friendly send-channel label. Ported verbatim from
 * `KinTaleLogsScreen.kt#prettySentVia`: internal backfill provenance markers
 * ("legacy_visit_logs", "legacy_orphan") are migration bookkeeping, not real
 * delivery channels, so they collapse to "imported" instead of leaking the
 * raw collection name into the operator UI. Real channels (email/sms) pass
 * through lower-cased.
 */
export function sentViaLabel(sentVia: string): string {
  const trimmed = sentVia.trim();
  if (trimmed === '') return 'imported';
  if (trimmed.startsWith('legacy_')) return 'imported';
  return trimmed.toLowerCase();
}

// ── status classification (positive enumeration, no negation) ──────────────

/**
 * Every state this module will ever return. `KinCareReport.status` defaults
 * to `"DRAFT"` (`FirestoreClient.kt:2017`) and flips to `"SENT"` once
 * `platformMarkKinTaleReportSent` commits (see
 * `JvmFirestoreRest.kt#markReportSentAtomic`). `"FAILED"` is a status the
 * wasm's own `KinTaleLogsScreen.kt` already renders an icon/bucket for
 * (`bucketFor`/`statusTone`), even though no writer in this codebase sets it
 * today — the same "no writer produces this code, but give it an honest
 * bucket rather than silently folding it into Drafts" reasoning
 * `sessionFormat.ts#SessionState`'s `'unknown'` documents. `'unknown'` here
 * plays that exact role: any status text that is none of the three known
 * codes gets its own bucket instead of a fabricated Draft/Sent/Failed guess
 * (the AO-12 lesson — every branch below is a positive match against the
 * literal text, never "not one of the others, so must be Y").
 */
export type KinTaleState = 'draft' | 'sent' | 'failed' | 'unknown';

/** Classifies one report's free-text `status`, case-insensitively (mirrors the wasm's own `.uppercase()` compares in `bucketFor`/`statusTone`). */
export function kinTaleState(status: string): KinTaleState {
  switch (status.trim().toUpperCase()) {
    case 'DRAFT':
      return 'draft';
    case 'SENT':
      return 'sent';
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}

export interface KinTaleStateInfo {
  label: string;
  chipLabel: string;
  cssClass: string;
}

/** Friendly label + chip class per state. Pure 1:1 map, no fallback branch. */
export function kinTaleStateInfo(state: KinTaleState): KinTaleStateInfo {
  switch (state) {
    case 'draft':
      return { label: 'Draft', chipLabel: 'DRAFT', cssClass: 'draft' };
    case 'sent':
      return { label: 'Sent', chipLabel: 'SENT', cssClass: 'sent' };
    case 'failed':
      return { label: 'Needs another look', chipLabel: 'FAILED', cssClass: 'failed' };
    case 'unknown':
      return { label: 'Unknown', chipLabel: 'UNKNOWN', cssClass: 'unknown' };
  }
}
