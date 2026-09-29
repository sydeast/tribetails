import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import {
  DEFAULT_EMAIL_FRAME,
  EMAIL_FRAME_DOC_PATH,
  parseStoredFrame,
  resolveEmailFrame,
  type EmailFrame,
  type StoredEmailFrame,
} from './emailFrameConfig';

/**
 * #957: reads the operator's email frame (`business_settings/email_frame`).
 * Kept out of `emailFrame.ts` so that module stays pure and synchronous
 * (`sendPartsFor` is called synchronously by every send route, and its
 * cold-start import graph is pinned).
 */

export interface StoredFrameRead {
  stored: StoredEmailFrame;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The stored fields, validated field by field. Throws when the read fails, so
 * the callables can report a failure; the send path uses `loadEmailFrame`,
 * which never throws.
 */
export async function readStoredEmailFrame(caller: string): Promise<StoredFrameRead> {
  const snap = await db().doc(EMAIL_FRAME_DOC_PATH).get();
  if (!snap.exists) return { stored: {}, updatedAt: null, updatedBy: null };
  const raw = snap.data() ?? {};
  const { stored, dropped } = parseStoredFrame(raw);
  if (dropped.length > 0) {
    // A value that fails the schema can only come from a hand edit in the
    // console (the save callable refuses it). It is dropped so the field
    // renders its default, never injected into the email's <style> block.
    logEvent({
      severity: 'warn',
      function: caller,
      event: 'email.frame.field_dropped',
      extra: { fields: dropped, action: 'sent the default for these fields; re-save the email frame in Settings' },
    });
  }
  return {
    stored,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
    updatedBy: typeof raw['updatedBy'] === 'string' ? raw['updatedBy'] : null,
  };
}

/**
 * The frame a send renders: stored fields over the defaults. Read once per
 * invocation by the send route and passed to `sendPartsFor`.
 *
 * FAIL-SAFE. If the read fails, the email still goes out in the default frame
 * and a warn line says so. An email held back because its colors could not be
 * read would be a far worse outcome than one sent in the old colors.
 */
export async function loadEmailFrame(caller: string): Promise<EmailFrame> {
  try {
    const { stored } = await readStoredEmailFrame(caller);
    return resolveEmailFrame(stored);
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: caller,
      event: 'email.frame.read_failed',
      errorMessage: (err as Error)?.message ?? 'unknown',
      extra: { action: 'sent in the default frame' },
    });
    return { ...DEFAULT_EMAIL_FRAME };
  }
}
