import type { BlastAudience } from '../api/marketingBlasts';
import { businessWallClock, businessWallClockToMs } from './businessZoneTime';

/**
 * The Marketing blasts form's rules: when a blast can be scheduled, what the
 * date and time pickers resolve to, and how the merge-field rows become the
 * `data` record the callable takes.
 *
 * Pure, so the decisions are unit-tested rather than driven through a form. Every
 * rule mirrors `scheduleMarketingBlast`'s zod `Args`, and nothing here is
 * STRICTER than the server: a client-only rule blocks a schedule the server
 * would have accepted and gives the operator no way to find out why. That is the
 * same contract `lib/audienceSegmentEdit.ts` keeps for broadcasts.
 */

/** A single `data` entry as the form holds it, before it becomes a record. */
export interface MergeFieldRow {
  key: string;
  value: string;
}

/**
 * Splits a pasted uid list on commas, whitespace and newlines.
 *
 * Newlines because the realistic way an operator gets 200 uids into this box is
 * a paste out of a spreadsheet column, and a comma-only split turns that into
 * one enormous uid the server then rejects as a single unknown account.
 */
export function parseUidList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const uid = part.trim();
    if (uid === '' || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

/**
 * Resolves the date + time pickers to epoch millis, or null when either is
 * blank or the pair is not a real instant.
 *
 * #1158: read on the BUSINESS's clock (`business_settings.timeZone`), the same
 * clock every other operator-typed time is on. A 9:00 send means 9:00 where the
 * business is, not wherever the operator's laptop happens to be, and never UTC.
 */
export function fireAtMsFrom(date: string, time: string, businessZone: string): number | null {
  if (date.trim() === '' || time.trim() === '') return null;
  return businessWallClockToMs(date.trim(), time.trim(), businessZone);
}

/** "2026-06-03 09:00" for a send instant, on the business's clock. */
export function fireLabelInZone(ms: number, businessZone: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'no send time';
  const { dateIso, hhmm } = businessWallClock(ms, businessZone);
  return `${dateIso} ${hhmm}`;
}

/**
 * Turns the merge-field rows into the `data` record.
 *
 * A row with a blank key is dropped rather than written as `''`: an empty token
 * name matches no `{{token}}` in any template, so keeping it would put a field
 * in the audit payload that can never render. A later row with the same key
 * wins, which is what the last thing the operator typed should do.
 */
export function mergeFieldsToData(rows: readonly MergeFieldRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    out[key] = row.value;
  }
  return out;
}

/**
 * Why this blast cannot be scheduled yet, or null when it can. First blocking
 * reason wins, so the operator is told one thing to fix rather than four.
 *
 * `reachable` is the PREVIEW's count and is deliberately optional: a blast is
 * schedulable without previewing first (the server does the same resolve and
 * refuses `no_recipients` itself), but once a preview has come back saying it
 * reaches nobody, sending it anyway is a round trip whose only outcome is an
 * error. `undefined` means "not previewed", which is not the same as zero.
 */
/** #1593: the server's sentence too (`scheduleMarketingBlast`). */
export const SEND_TIME_PASSED = 'That send time has already passed.';
/**
 * #1593: the send time's own refusal, shown at the Date and Time fields
 * whatever else is still missing. The QA walk typed a 2020 date and saw no
 * warning, because `blastBlocker` names only the FIRST thing missing and
 * "Choose an audience first." came ahead of it. The server's window: anything
 * more than a minute in the past is refused.
 */
export function sendTimeError(fireAtMs: number | null, nowMs: number): string | null {
  if (fireAtMs === null) return null;
  return fireAtMs < nowMs - 60_000 ? SEND_TIME_PASSED : null;
}
export function blastBlocker(
  audience: BlastAudience | null,
  fireAtMs: number | null,
  nowMs: number,
  reachable: number | undefined,
  missingFields: readonly string[] = [],
): string | null {
  if (audience === null) return 'Choose an audience first.';
  if (fireAtMs === null) return 'Pick a date and a time to send.';
  // The server's own window: anything more than a minute in the past is refused.
  if (sendTimeError(fireAtMs, nowMs) !== null) return SEND_TIME_PASSED;
  if (reachable === 0) return 'This audience reaches nobody. Widen it, or check who has opted in.';
  // #1587: a field the template names and nothing fills renders as a gap in an
  // email to real households. Naming the fields is what lets the operator fix it.
  if (missingFields.length > 0) {
    return `Fill in ${missingFields.map(fieldLabel).join(', ')} before scheduling. The email would go out with a gap there.`;
  }
  return null;
}
/**
 * A merge field's name as the operator reads it: `firstName` -> "First name",
 * `nextVisit.date` -> "Next visit date". The raw token is the template author's
 * spelling; the operator filling it in is owed a label, not the spelling.
 */
export function fieldLabel(name: string): string {
  const spaced = name
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced === '' ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
/**
 * The `data` record for the blast: the values typed for the fields the template
 * names, and nothing else. A blank value is left out so the field reads as
 * missing, not as an intentional empty string, and a value for a field the
 * template no longer names (the operator switched campaigns) is not sent.
 */
export function fieldValuesToData(
  values: Readonly<Record<string, string>>,
  fieldNames: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of fieldNames) {
    const v = (values[name] ?? '').trim();
    if (v !== '') out[name] = v;
  }
  return out;
}
/** An account the Pick accounts list offers: a household with a linked MyTribe login, by name. */
export interface PickableAccount {
  uid: string;
  name: string;
  email: string;
}
/**
 * The households an operator can pick as accounts, by name.
 *
 * A blast addresses a MyTribe account (`uid`), not a household, so a household
 * with no linked login cannot receive one. It is listed separately so the
 * operator can see who is missing and why, instead of the household silently
 * not being there. Archived households are neither.
 */
export function pickableAccounts(
  kinfolk: ReadonlyArray<{ firstName?: string | undefined; lastName?: string | undefined; email?: string | undefined; uid?: string | undefined; status?: string | undefined }>,
): { accounts: PickableAccount[]; withoutAccount: string[] } {
  const accounts: PickableAccount[] = [];
  const withoutAccount: string[] = [];
  for (const k of kinfolk) {
    if ((k.status ?? '').toLowerCase() === 'archived') continue;
    const name = `${(k.firstName ?? '').trim()} ${(k.lastName ?? '').trim()}`.trim() || (k.email ?? '').trim() || 'Unnamed household';
    const uid = (k.uid ?? '').trim();
    if (uid === '') withoutAccount.push(name);
    else accounts.push({ uid, name, email: (k.email ?? '').trim() });
  }
  const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  accounts.sort((a, b) => byName(a.name, b.name));
  withoutAccount.sort(byName);
  return { accounts, withoutAccount };
}
/**
 * What the operator is told after pressing Schedule (#814, extended by #823).
 *
 * Four outcomes, and they are four different facts:
 *
 *   a fresh blast    the counts, as before.
 *   a deduped reply  this press landed on a blast an earlier attempt already
 *                    made. Saying "Scheduled" again would tell the operator
 *                    they had just sent a second campaign, which is precisely
 *                    what the key prevented.
 *   still queueing   the first attempt is mid fan-out, so the stored counts are
 *                    a snapshot. Reporting them as a total would be a confident
 *                    wrong number, so the counts are left out and the campaign
 *                    list is where the final ones show up.
 *   handed off       #823, and this is now the ORDINARY outcome for any audience
 *                    past about sixty households. The fan-out left this request
 *                    unfinished and a cron sweep is carrying it. "Scheduled. 61
 *                    queued." would be true of this second and wrong of the
 *                    next, so this says where it reached, out of how many, and
 *                    that it is still going.
 */
export function scheduleNotice(
  res: {
    dispatched: number;
    suppressed: number;
    failed: number;
    deduped: boolean;
    pending: boolean;
    queued: number;
    audienceSize: number;
  },
  whenLabel: string,
): string {
  const counts =
    `${res.dispatched} queued, ${res.suppressed} suppressed` +
    (res.failed > 0 ? `, ${res.failed} failed` : '') +
    '.';
  if (res.deduped && res.pending) {
    return `You already scheduled this campaign for ${whenLabel}, and it is still queueing. Nothing went out twice. The campaign list has the counts once it finishes.`;
  }
  if (res.deduped) {
    return `You already scheduled this campaign for ${whenLabel}. Nothing went out twice. ${counts}`;
  }
  if (res.pending) {
    return `Scheduled for ${whenLabel}. Still queueing: ${res.queued} of ${res.audienceSize} so far. It carries on in the background.`;
  }
  return `Scheduled for ${whenLabel}. ${counts}`;
}

/**
 * The progress line on a campaign that is still being queued: the mock's "256
 * of 410 dispatched", drawn from numbers the row can back.
 *
 * A STALLED fan-out is named rather than dressed up as a slow one. Its lease has
 * been gone for two sweep ticks with nothing moving, and an operator told "still
 * sending" about a campaign that stopped twenty minutes ago has been misled by a
 * progress bar.
 */
export function sendingLabel(queued: number, audienceSize: number, stalled: boolean): string {
  const of = audienceSize > 0 ? `${queued} of ${audienceSize}` : `${queued}`;
  return stalled ? `Stopped at ${of} queued. It picks up again within a minute.` : `${of} queued`;
}

/**
 * What a cancel actually achieved, in the operator's terms.
 *
 * A cancel that lands MID fan-out cannot prove the worker stopped (see
 * `cancelMarketingBlastHandler`), so it does not claim to have. The campaign
 * reads Cancelling until the sweep confirms it, and this sentence says the same
 * thing rather than announcing a finality the server refused to write down.
 */
export function cancelNotice(res: { cancelled: number; stopped: boolean; neverQueued: number }): string {
  const removed = `${res.cancelled} queued ${res.cancelled === 1 ? 'notification' : 'notifications'} removed`;
  if (res.stopped) return `Cancelled. ${removed}.`;
  return `Stopping. ${removed}, and ${res.neverQueued} were never queued. It finishes stopping within a minute.`;
}
