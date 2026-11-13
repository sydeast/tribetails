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
