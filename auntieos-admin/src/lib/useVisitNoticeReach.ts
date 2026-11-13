import { useEffect, useState } from 'react';
import { previewVisitNotification } from '../api/visitNoticePreview';
import { type VisitNoticeReach } from './visitNotice';

/**
 * #1840: the server's answer to "can a visit notice reach this household?",
 * asked each time a clock confirm opens.
 *
 * ASKED FRESH EVERY TIME, never cached: a household can accept its invite, or
 * the operator can flip the switch, between two taps, and a remembered answer
 * would be the stale promise this exists to remove.
 *
 * @param familyId the household to ask about, or `null` when there is nothing
 *        to ask (no confirm open, an action that tells nobody, or a visit that
 *        cannot be routed to a household at all).
 * @returns `checking` until the answer lands, `unknown` when the call failed.
 */
export function useVisitNoticeReach(familyId: string | null): VisitNoticeReach {
  const [reach, setReach] = useState<VisitNoticeReach>({ status: 'checking' });

  useEffect(() => {
    if (familyId === null) {
      // Closed: the next confirm starts from "checking", never from this answer.
      setReach({ status: 'checking' });
      return;
    }
    let live = true;
    setReach({ status: 'checking' });
    previewVisitNotification(familyId).then(
      (answer) => {
        if (live) setReach({ status: 'ready', willNotify: answer.willNotify, reason: answer.reason });
      },
      (err: unknown) => {
        console.warn('[visitNotice] could not ask who will be told', err);
        if (live) setReach({ status: 'unknown' });
      },
    );
    return () => {
      live = false;
    };
  }, [familyId]);

  return familyId === null ? { status: 'checking' } : reach;
}
