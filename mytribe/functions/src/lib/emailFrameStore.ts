import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import {
  DEFAULT_EMAIL_FRAME,
  EMAIL_FRAME_DOC_PATH,
  parseStoredFrame,
  resolveEmailFrame,
  type StoredEmailFrame,
} from './emailFrameConfig';
import { BUSINESS_SETTINGS_SOURCE_DOC, buildBusinessPublicCard } from './businessPublicCard';
import type { EmailFooterFacts } from './emailFooter';
import type { RenderableEmailFrame } from './emailFrame';

/**
 * #957: reads the operator's email frame (`business_settings/email_frame`).
 * Kept out of `emailFrame.ts` so that module stays pure and synchronous
 * (`sendPartsFor` is called synchronously by every send route, and its
 * cold-start import graph is pinned).
 *
 * #1399: also reads the business facts the footer is composed from, through
 * the public card projection (`buildBusinessPublicCard`), the one place the
 * public field list is spelled. The settings document itself is read, not the
 * `business_public/card` mirror: the mirror follows the settings by trigger
 * and may lag or be missing after a deploy, and an email must say what the
 * settings say now.
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
 * The business facts the footer shows (#1399), projected from the settings
 * document exactly as the sign-in screen's public card is.
 *
 * FAIL-SAFE, like the frame read: a failed read gives the card of a business
 * that has set nothing, so every composed line is omitted and the email still
 * goes out, with a warn line saying so. A missing document reads the same way,
 * silently: a business that has not written settings yet has nothing to show.
 */
export async function loadEmailFooterFacts(caller: string): Promise<EmailFooterFacts> {
  try {
    const snap = await db().doc(BUSINESS_SETTINGS_SOURCE_DOC).get();
    return buildBusinessPublicCard(snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined);
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: caller,
      event: 'email.footer.settings_read_failed',
      errorMessage: (err as Error)?.message ?? 'unknown',
      extra: { action: 'sent with no business facts in the footer' },
    });
    return buildBusinessPublicCard(undefined);
  }
}

/**
 * The frame a send renders: stored fields over the defaults, plus the business
 * facts for the footer. Read once per invocation by the send route and passed
 * to `sendPartsFor`. The two documents are read in parallel.
 *
 * FAIL-SAFE. If the frame read fails, the email still goes out in the default
 * frame and a warn line says so. An email held back because its colors could
 * not be read would be a far worse outcome than one sent in the old colors.
 */
export async function loadEmailFrame(caller: string): Promise<RenderableEmailFrame> {
  const [frame, business] = await Promise.all([
    readStoredEmailFrame(caller)
      .then(({ stored }) => resolveEmailFrame(stored))
      .catch((err: unknown) => {
        logEvent({
          severity: 'warn',
          function: caller,
          event: 'email.frame.read_failed',
          errorMessage: (err as Error)?.message ?? 'unknown',
          extra: { action: 'sent in the default frame' },
        });
        return { ...DEFAULT_EMAIL_FRAME };
      }),
    loadEmailFooterFacts(caller),
  ]);
  return { ...frame, business };
}
