import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { resolveBillingRecipientUid } from '../lib/resolveBillingRecipientUid';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { getNotificationDef } from '../notifications/catalog';
import {
  loadBusinessOverride,
  loadUserPrefs,
  notificationDisabledFor,
  resolveChannels,
  streamForRecipient,
} from '../notifications/prefs';
import { loadHouseholdSendGate } from '../notifications/householdSendGate';

/**
 * #1609: WHO A SEND WILL REACH, AND HOW, asked before the operator confirms it.
 *
 * The walk's Send reminder and Review and send confirms said "the household on
 * file" and nothing else, so the operator pressed a button that emails a real
 * person without being told which person or by which channel. This answers that
 * from the same pieces the dispatcher uses for the real send, read-only:
 *
 *   - the recipient: `resolveBillingRecipientUid`, the uid both
 *     `sendInvoiceReminder` and `reviewAndSendDraftInvoice` address;
 *   - the channels: `resolveChannels` over that recipient's prefs and the
 *     operator's override for the notification key, exactly as
 *     `enqueueNotificationDetailed` resolves them;
 *   - whether the notification is off for them (`notificationDisabledFor`);
 *   - the pre-launch household gate, which holds every household copy back
 *     while it is not live (household-send-gate memory).
 *
 * The address on file is returned with each channel (the email and SMS senders
 * read `clients/{uid}.email` and `.phone`), so a channel that is on but has no
 * address says so instead of claiming a send.
 *
 * Nothing is written, and nothing is sent.
 */
export const Args = z
  .object({
    invoiceId: z.string().min(1).max(200),
    /** Which send is being confirmed. */
    action: z.enum(['reminder', 'reviewSend']),
  })
  .strict();

export const Result = z
  .object({
    ok: z.literal(true),
    /** The notification key the send would enqueue. */
    key: z.string(),
    /** False when no billing recipient could be found for the household. */
    hasRecipient: z.boolean(),
    /** The person, as the household account names them, or the invoice's household name. */
    recipientName: z.string(),
    email: z.object({ on: z.boolean(), address: z.string() }),
    sms: z.object({ on: z.boolean(), address: z.string() }),
    push: z.object({ on: z.boolean() }),
    /** 'operator' or 'marketing' when the notification itself is off for them, else null. */
    disabled: z.enum(['operator', 'marketing']).nullable(),
    /** The pre-launch household gate. False means nothing reaches the household yet. */
    householdGateLive: z.boolean(),
  })
  .strict();

type ResultShape = z.infer<typeof Result>;

const KEY_FOR: Record<z.infer<typeof Args>['action'], string> = {
  reminder: 'invoice.reminder',
  reviewSend: 'invoice.new',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export async function previewInvoiceNoticeHandler(req: CallableRequest<unknown>): Promise<ResultShape> {
  initSentry();
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'previewInvoiceNotice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  const actor = resolveInvoiceWriteActor(req, 'previewInvoiceNotice');

  const snap = await db().collection('invoices').doc(args.invoiceId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  const invoice = (snap.data() ?? {}) as Record<string, unknown>;
  const kinfolkId = str(invoice['kinfolkId']);
  if (!testOwnsDoc(actor.testMode, kinfolkId)) {
    throw new HttpsError('permission-denied', 'This invoice is outside your test sandbox.');
  }

  const key = KEY_FOR[args.action];
  const def = getNotificationDef(key);
  const gate = await loadHouseholdSendGate(db());
  const fallbackName = str(invoice['kinfolkName']) || str(invoice['client']);

  const recipientUid = kinfolkId === '' ? null : await resolveBillingRecipientUid(kinfolkId);
  if (recipientUid === null) {
    return validateResponse('previewInvoiceNotice', Result, {
      ok: true,
      key,
      hasRecipient: false,
      recipientName: fallbackName,
      email: { on: false, address: '' },
      sms: { on: false, address: '' },
      push: { on: false },
      disabled: null,
      householdGateLive: gate.live,
    });
  }

  const [clientSnap, userPrefs, businessOverride] = await Promise.all([
    db().collection('clients').doc(recipientUid).get(),
    loadUserPrefs(recipientUid, 'clients'),
    loadBusinessOverride(key),
  ]);
  const client = (clientSnap.data() ?? {}) as Record<string, unknown>;
  const stream = streamForRecipient(def, 'clients');
  const disabled = notificationDisabledFor(def, userPrefs, businessOverride, stream);
  const channels = resolveChannels(def, userPrefs, businessOverride, stream);
  const named =
    str(client['displayName']) || [str(client['firstName']), str(client['lastName'])].filter(Boolean).join(' ');

  return validateResponse('previewInvoiceNotice', Result, {
    ok: true,
    key,
    hasRecipient: true,
    recipientName: named || fallbackName,
    email: { on: disabled === null && channels.email, address: str(client['email']) },
    sms: { on: disabled === null && channels.sms, address: str(client['phone']) },
    push: { on: disabled === null && channels.push },
    disabled,
    householdGateLive: gate.live,
  });
}

export const previewInvoiceNotice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('previewInvoiceNotice', previewInvoiceNoticeHandler),
);
