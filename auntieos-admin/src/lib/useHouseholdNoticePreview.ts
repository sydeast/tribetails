import { useEffect, useState } from 'react';
import { previewHouseholdNotice } from '../api/visitNoticePreview';
import { type HouseholdNoticeKey, type HouseholdNoticePreview } from './householdNoticeWords';

/**
 * #1816, #1838, #2027, #1841: the server's answer to "who will this action's
 * notice reach, and how?", asked each time a confirm opens.
 *
 * Asked fresh every time, never cached: a household can accept its invite, or
 * the owner can flip the switch, between two confirms (the #1840 rule).
 *
 * @param familyId the household, or `null` when there is nothing to ask (no
 *        confirm open, or a visit with no household).
 * @returns `checking` until the answer lands, `unknown` when the call failed.
 */
export function useHouseholdNoticePreview(
  familyId: string | null,
  key: HouseholdNoticeKey,
  /** #1838/#2027: the visit a cancel or move is about; the server then runs the visit's own checks too. */
  sessionId?: string,
): HouseholdNoticePreview {
  const [preview, setPreview] = useState<HouseholdNoticePreview>({ status: 'checking' });

  useEffect(() => {
    if (familyId === null || familyId.trim() === '') {
      setPreview({ status: 'checking' });
      return;
    }
    let live = true;
    setPreview({ status: 'checking' });
    (sessionId === undefined ? previewHouseholdNotice(familyId, key) : previewHouseholdNotice(familyId, key, sessionId)).then(
      (answer) => {
        if (live) setPreview({ status: 'ready', ...answer });
      },
      (err: unknown) => {
        console.warn('[householdNotice] could not ask who will be told', err);
        if (live) setPreview({ status: 'unknown' });
      },
    );
    return () => {
      live = false;
    };
  }, [familyId, key, sessionId]);

  return familyId === null ? { status: 'checking' } : preview;
}
