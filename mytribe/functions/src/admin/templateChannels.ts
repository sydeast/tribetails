import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TEMPLATE_ID_MAX_LENGTH, TEMPLATE_ID_PATTERN, TEMPLATE_ID_RULE } from '../lib/templateValidation';
import type { ChannelSupport, WordingErrors } from '../lib/templateChannelWording';

/**
 * The rules module, loaded inside the handler rather than at file scope. This
 * file is a FUNCTIONS entry, so everything it imports eagerly is charged to
 * every function's cold start (`test/coldStartImportGraph.test.ts`); the rules
 * pull in the whole notification catalog and the field table, which only these
 * two callables need here. Same split `saveBusinessSettings` makes.
 */
type Wording = typeof import('../lib/templateChannelWording');
const loadWording = (): Promise<Wording> => import('../lib/templateChannelWording.js');

/**
 * #1935: read and save what a template says by text message and by push.
 *
 * `smsTemplates` and `pushTemplates` are closed to every client in
 * `firestore.rules` and stay closed. Before these two callables the only
 * writer was the importer, so the wording was stored and sent but no screen
 * could show it. Owner-only: neither name is in `AUNTIE_ALLOWED_CALLABLES`.
 *
 * Which documents a template's wording lives in is decided by
 * `lib/templateChannelWording.ts#channelSupportFor`, from the catalog row the
 * senders read, or, for a template the operator made, from the one live
 * Template Routing override that sends it (`supportThroughRouting`). A channel
 * the notification does not send comes back
 * `supported: false` and a save to it is refused, so nothing here can store
 * words that are never sent.
 *
 * THE IMPORTER. A save writes exactly the content fields the importer
 * compares (`text`; `title` and `body`), trimmed the way it trims them. So an
 * edit made here reads as "differs" on the next Template Import and is skipped
 * unless the operator ticks that template to replace it
 * (`notifications/importPlanner.ts`, `overwriteIds`); an untouched copy keeps
 * reading "unchanged". A push document's `dataRoute` is never written, so the
 * tap target survives every save.
 */

const templateId = z
  .string()
  .min(1)
  .max(TEMPLATE_ID_MAX_LENGTH)
  .regex(TEMPLATE_ID_PATTERN, { message: TEMPLATE_ID_RULE });

const GetArgs = z.object({ templateId });

// Lengths are checked by hand below so an over-long field gets its own
// sentence beside its own box. These caps only keep an absurd payload out.
const SaveArgs = z.object({
  templateId,
  sms: z.object({ text: z.string().max(20000) }).optional(),
  push: z.object({ title: z.string().max(20000), body: z.string().max(20000) }).optional(),
});

/** The machine-readable half of a wording refusal, on `HttpsError.details`. */
export const WORDING_REFUSAL = 'template-wording-refused';

export interface WordingRefusalDetails {
  reason: typeof WORDING_REFUSAL;
  /** One sentence per refused field: `smsText`, `pushTitle`, `pushBody`. */
  fieldErrors: WordingErrors;
}

export interface TemplateChannelsResult {
  templateId: string;
  /** The notification that sends this template, in words, or null when none does. */
  notificationLabel: string | null;
  /** The `{{field}}` names the notification fills in. Empty when none sends it. */
  fields: string[];
  sms: {
    /** True when the notification really sends a text message. */
    supported: boolean;
    /** True when wording is stored. False with `supported` means "not set, can be added". */
    set: boolean;
    text: string;
    maxLength: number;
  };
  push: {
    supported: boolean;
    set: boolean;
    title: string;
    body: string;
    titleMaxLength: number;
    bodyMaxLength: number;
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Stored {
  support: ChannelSupport;
  sms: Record<string, unknown> | null;
  push: Record<string, unknown> | null;
}

/**
 * The notification a template the operator made is sent for, through a
 * Template Routing override, when exactly one live override points at it.
 * Two or more would leave no single text or push to show, so that template
 * reads as sending neither, the same as one no override points at.
 *
 * `readTemplateBindings` is THE reading of that collection (an override that
 * is switched off falls back to the catalog's own email, so it does not
 * count), loaded here like the rules module so this entry stays small.
 */
async function supportThroughRouting(wording: Wording, id: string): Promise<ChannelSupport | null> {
  const { readTemplateBindings } = await import('../lib/sendFromTemplate.js');
  const { activeBindings } = await readTemplateBindings();
  const keys = [...activeBindings].filter(([, templateId]) => templateId === id).map(([key]) => key);
  return keys.length === 1 ? wording.channelSupportForKey(keys[0]!) : null;
}

/** Reads the stored wording, or refuses when the template is nowhere to be found. */
async function readStored(wording: Wording, id: string): Promise<Stored> {
  let support = wording.channelSupportFor(id);
  if (!support.def) {
    // A template the operator made, an invite or a recovery email. It has to
    // exist to be read at all.
    const email = await db().doc(`emailTemplates/${id}`).get();
    if (!email.exists) {
      throw new HttpsError(
        'not-found',
        'That template is no longer in the Template Bank. Go back and open it again.',
      );
    }
    // Template Routing can make it the email of a catalog notification, and
    // then it has that notification's text and push. Otherwise it has neither.
    const routed = await supportThroughRouting(wording, id);
    if (!routed?.def) return { support, sms: null, push: null };
    support = routed;
  }
  const [sms, push] = await Promise.all([
    support.smsId ? db().doc(`smsTemplates/${support.smsId}`).get() : null,
    support.pushId ? db().doc(`pushTemplates/${support.pushId}`).get() : null,
  ]);
  return {
    support,
    sms: sms?.exists ? ((sms.data() as Record<string, unknown>) ?? {}) : null,
    push: push?.exists ? ((push.data() as Record<string, unknown>) ?? {}) : null,
  };
}

function toResult(wording: Wording, id: string, stored: Stored): TemplateChannelsResult {
  const { support } = stored;
  const text = str(stored.sms?.['text']);
  const title = str(stored.push?.['title']);
  const body = str(stored.push?.['body']);
  return {
    templateId: id,
    notificationLabel: support.def?.label ?? null,
    fields: support.fields,
    sms: {
      supported: support.smsId !== null,
      set: text.trim().length > 0,
      text,
      maxLength: wording.SMS_TEXT_MAX,
    },
    push: {
      supported: support.pushId !== null,
      // Either half blank and the sender falls back to generic wording, so it
      // is not "set" until both are written.
      set: title.trim().length > 0 && body.trim().length > 0,
      title,
      body,
      titleMaxLength: wording.PUSH_TITLE_MAX,
      bodyMaxLength: wording.PUSH_BODY_MAX,
    },
  };
}

function parseOrRefuse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => i.message).join(' '));
  }
  return parsed.data;
}

export async function getTemplateChannelsHandler(
  req: CallableRequest<unknown>,
): Promise<TemplateChannelsResult> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseOrRefuse(GetArgs, req.data);
  const wording = await loadWording();
  return toResult(wording, args.templateId, await readStored(wording, args.templateId));
}

const CHANNEL_WORDS = { sms: 'text message', push: 'push notification' } as const;

export async function saveTemplateChannelsHandler(
  req: CallableRequest<unknown>,
): Promise<TemplateChannelsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseOrRefuse(SaveArgs, req.data);
  if (!args.sms && !args.push) {
    throw new HttpsError('invalid-argument', 'There is no wording to save.');
  }

  const wording = await loadWording();
  const stored = await readStored(wording, args.templateId);
  const { support } = stored;
  if (args.sms && !support.smsId) {
    throw new HttpsError(
      'failed-precondition',
      'This notification is not sent by text message, so there is no text message wording to save.',
    );
  }
  if (args.push && !support.pushId) {
    throw new HttpsError(
      'failed-precondition',
      'This notification is not sent as a push notification, so there is no push wording to save.',
    );
  }

  const fieldErrors: WordingErrors = {
    ...(args.sms ? wording.smsWordingErrors(args.sms.text, support.fields, str(stored.sms?.['text'])) : {}),
    ...(args.push
      ? wording.pushWordingErrors(args.push, support.fields, {
          title: str(stored.push?.['title']),
          body: str(stored.push?.['body']),
        })
      : {}),
  };
  if (Object.keys(fieldErrors).length > 0) {
    const details: WordingRefusalDetails = { reason: WORDING_REFUSAL, fieldErrors };
    throw new HttpsError('invalid-argument', Object.values(fieldErrors).join(' '), details);
  }

  // Trimmed the way the importer trims, so a save that changes nothing leaves
  // the stored copy reading "unchanged" on the next Template Import.
  const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
  const born = { createdAt: FieldValue.serverTimestamp(), createdBy: uid };
  const writes: Array<{ channel: 'sms' | 'push'; path: string; data: Record<string, unknown>; isCreate: boolean }> = [];
  if (args.sms) {
    const text = args.sms.text.trim();
    if (text !== str(stored.sms?.['text'])) {
      writes.push({
        channel: 'sms',
        path: `smsTemplates/${support.smsId}`,
        data: { text },
        isCreate: stored.sms === null,
      });
    }
  }
  if (args.push) {
    const title = args.push.title.trim();
    const body = args.push.body.trim();
    if (title !== str(stored.push?.['title']) || body !== str(stored.push?.['body'])) {
      writes.push({
        channel: 'push',
        path: `pushTemplates/${support.pushId}`,
        data: { title, body },
        isCreate: stored.push === null,
      });
    }
  }

  // Nothing differs from what is stored: no write, and no Activity Log line
  // claiming a change that did not happen.
  if (writes.length === 0) return toResult(wording, args.templateId, stored);

  const batch = db().batch();
  for (const w of writes) {
    // merge: the push document's `dataRoute` and anything else stored beside
    // the wording stays exactly as it was.
    batch.set(db().doc(w.path), { ...w.data, ...stamp, ...(w.isCreate ? born : {}) }, { merge: true });
  }
  await batch.commit();

  const channels = writes.map((w) => w.channel);
  const label = support.def?.label ?? args.templateId;
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.ADMIN_TEMPLATE_WORDING_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.templateId,
    targetCollection: 'emailTemplates',
    description: `Changed the ${channels.map((c) => CHANNEL_WORDS[c]).join(' and ')} wording for "${label}"`,
    // Which channels, never the wording: the log is read by people who should
    // not have to scroll past a message body to see who changed it.
    payload: {
      templateId: args.templateId,
      channels,
      added: writes.filter((w) => w.isCreate).map((w) => w.channel),
    },
  });
  logEvent({
    severity: 'info',
    function: 'saveTemplateChannels',
    event: 'admin.template.wording.updated',
    uid,
    extra: { templateId: args.templateId, channels },
  });

  return toResult(wording, args.templateId, {
    support,
    sms: writes.some((w) => w.channel === 'sms')
      ? { ...(stored.sms ?? {}), text: args.sms!.text.trim() }
      : stored.sms,
    push: writes.some((w) => w.channel === 'push')
      ? { ...(stored.push ?? {}), title: args.push!.title.trim(), body: args.push!.body.trim() }
      : stored.push,
  });
}

export const getTemplateChannels = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getTemplateChannels', getTemplateChannelsHandler),
);

export const saveTemplateChannels = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveTemplateChannels', saveTemplateChannelsHandler),
);
