import type { HouseholdNoticeKey } from '../lib/householdNoticeWords';
import { call } from '../lib/fns';

/** What `previewVisitNotification` answers for one household. */
export interface VisitNoticePreviewAnswer {
  willNotify: boolean;
  /** `household_has_no_portal_account`, `household_notices_off`, or null when a notice can go out. */
  reason: string | null;
}

/**
 * #1840: ask the server whether a visit notice can reach this household, with
 * the same two checks the dispatch makes: a member login to send to, and the
 * household-notices switch. Read-only.
 *
 * Throws when the call fails or the answer has no `willNotify` (a server from
 * before this callable existed answers not-found). The confirm then says
 * nothing about the household, which is true, instead of a guess.
 */
export async function previewVisitNotification(familyId: string): Promise<VisitNoticePreviewAnswer> {
  const res = await call<{ familyId: string }, { willNotify?: unknown; reason?: unknown }>(
    'previewVisitNotification',
    { familyId },
  );
  if (typeof res?.willNotify !== 'boolean') throw new Error('previewVisitNotification: no answer');
  const reason = typeof res.reason === 'string' && res.reason.trim() !== '' ? res.reason : null;
  return { willNotify: res.willNotify, reason };
}
/**
 * #1816, #1838, #2027, #1841: ask the server who a household notice for one
 * admin action would reach, and how. The same callable with a notification
 * `key`: the dispatcher's own dry run answers with the person and channels.
 *
 * Throws when the call fails, or when a server from before the key answers
 * without `name`/`channels`: the confirm then says nothing about the household
 * rather than guess.
 */
export async function previewHouseholdNotice(
  familyId: string,
  key: HouseholdNoticeKey,
  /** #1838/#2027: the visit a cancel or move is about, so the visit's own checks run too. */
  sessionId?: string,
): Promise<{ willNotify: boolean; reason: string | null; name: string | null; channels: string[] }> {
  const res = await call<
    { familyId: string; key: HouseholdNoticeKey; sessionId?: string },
    { willNotify?: unknown; reason?: unknown; name?: unknown; channels?: unknown }
  >('previewVisitNotification', { familyId, key, ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}) });
  if (typeof res?.willNotify !== 'boolean' || !Array.isArray(res.channels)) {
    throw new Error('previewVisitNotification: no answer for this notice');
  }
  return {
    willNotify: res.willNotify,
    reason: typeof res.reason === 'string' && res.reason.trim() !== '' ? res.reason : null,
    name: typeof res.name === 'string' && res.name.trim() !== '' ? res.name : null,
    channels: res.channels.filter((c): c is string => typeof c === 'string'),
  };
}
