import { call } from '../lib/fns';

/**
 * #1935: what a template says by text message and by push.
 *
 * The wording lives in two collections no client may read or write directly
 * (`firestore.rules`), so these two admin callables are the only way in. The
 * shapes mirror `MyTribe/functions/src/admin/templateChannels.ts` field for
 * field; see `CALLABLE_CONTRACT.md` for the rules behind `supported`.
 */
export interface TemplateSmsChannel {
  /** True when the notification that sends this template also sends a text message. */
  supported: boolean;
  /** True when wording is stored. False with `supported` means it can be added. */
  set: boolean;
  text: string;
  maxLength: number;
}

export interface TemplatePushChannel {
  supported: boolean;
  set: boolean;
  title: string;
  body: string;
  titleMaxLength: number;
  bodyMaxLength: number;
}

export interface TemplateChannels {
  templateId: string;
  /** The notification that sends this template, in words, or null when none does. */
  notificationLabel: string | null;
  /** The `{{field}}` names that notification fills in. */
  fields: string[];
  sms: TemplateSmsChannel;
  push: TemplatePushChannel;
}

/** The fields a save can be refused on, as the server names them. */
export type WordingField = 'smsText' | 'pushTitle' | 'pushBody';
export type WordingErrors = Partial<Record<WordingField, string>>;

export interface SaveTemplateChannelsArgs {
  templateId: string;
  /** Sent only when the text message is what changed. */
  sms?: { text: string };
  /** Sent only when the push notification is what changed. */
  push?: { title: string; body: string };
}

export async function getTemplateChannels(templateId: string): Promise<TemplateChannels> {
  const result = await call<{ templateId: string }, TemplateChannels>('getTemplateChannels', { templateId });
  return result;
}

export async function saveTemplateChannels(args: SaveTemplateChannelsArgs): Promise<TemplateChannels> {
  const result = await call<SaveTemplateChannelsArgs, TemplateChannels>('saveTemplateChannels', args);
  return result;
}

/**
 * The per-field sentences off a refused save, or null when the failure was
 * something else (signed out, offline, the template gone). Read from the
 * machine-readable `details`, never from the message. Duck-typed like
 * `isTemplateKeyTakenError`, so a plain rejected object in a test takes the
 * same branch the SDK's error does.
 */
export function wordingErrorsFrom(err: unknown): WordingErrors | null {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  if (typeof details !== 'object' || details === null) return null;
  const { reason, fieldErrors } = details as { reason?: unknown; fieldErrors?: unknown };
  if (reason !== 'template-wording-refused' || typeof fieldErrors !== 'object' || fieldErrors === null) {
    return null;
  }
  const out: WordingErrors = {};
  for (const field of ['smsText', 'pushTitle', 'pushBody'] as const) {
    const sentence = (fieldErrors as Record<string, unknown>)[field];
    if (typeof sentence === 'string' && sentence.trim() !== '') out[field] = sentence;
  }
  return out;
}
