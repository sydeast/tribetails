import { str } from './coerce';
import { kinfolkDisplayName, type Kinfolk } from '../api/directory';
import type { GenerateCommunicationType, GenerateDraftArgs } from '../api/communicateGenerate';

/**
 * The Auntie voice generator's composer logic, kept whole and free of React so
 * every rule below is testable on its own.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * "Auntie voice generator" is the archived Compose app's PERSONALIZE composer
 * (`web/composeApp/.../screens/communicate/CommunicateScreen.kt`, the
 * `ComposeMode.Personalize` branch). It generates brand-voice COPY through
 * `generateAuntieCopy`. It is not text to speech, and never was.
 *
 * ── MESSAGE TYPE IS A COPY FORMAT, NOT A DELIVERY CHANNEL ───────────────────
 * This is the axis that caused the most confusion, so it is worth being blunt:
 * every entry in the table below describes HOW THE TEXT IS WRITTEN, not how it
 * travels. `push` asks for a notification-shelf line and delivers nothing.
 * `email` asks for a warm opener and a closing, and happens also to be
 * deliverable from this screen. The two facts are tracked separately, on
 * `key` and on `deliverable`.
 *
 * The archive surfaced only four of these (Visit report / Text / Email / Blog)
 * while declaring `social_post` and `general` with no way to reach them, so two
 * of the server's supported formats were unreachable for the whole life of that
 * app and a third, `push`, was never supported at all. The full seven are here
 * now, in the operator's order, and the bidirectional drift guard in
 * `web/functions/test/generate.test.js` is what stops any of them going quietly
 * missing again.
 *
 * KinTale is one of these formats, never a broadcast channel. `broadcastMessage`
 * accepts inapp/email/sms/push and has no KinTale delivery leg, so a KinTale
 * broadcast chip would be a button that cannot deliver. That ruling is unchanged
 * and its test still stands.
 *
 * Labels are the operator's words; wire values are the server's. `visit_report`
 * shows as "KinTale" and stays `visit_report` on the wire, because that value is
 * what `generate.js` switches its prompt framing and its `training_documents`
 * lookup on. Renaming it would quietly change the voice.
 */

/** A message-type chip: what it says, whether it needs a household, whether approving it delivers, and whether a title is worth paying for. */
export interface PersonalizeMessageType {
  key: GenerateCommunicationType;
  label: string;
  /**
   * A Blog post and a Social post address nobody. Everything else is written FOR
   * a household, and the dossier/Kin/411 context the generator reads is keyed off
   * that household, so without one the copy is generic.
   */
  needsRecipient: boolean;
  /**
   * The channel approving this type actually sends over, or `false` when
   * approving only promotes the draft and writes the audit entry.
   *
   * Only email and sms are ever true, because `sendExternalMessage` speaks those
   * two and nothing else. `push` in this table is a COPY FORMAT, not a delivery
   * route: there is no 1:1 push callable, so a push draft is written here and
   * carried elsewhere. A KinTale goes out through the KinTale flow, and a Blog,
   * Social or General post has no single destination at all.
   */
  deliverable: false | 'email' | 'sms';
  /**
   * Whether to spend the second model call on a title.
   *
   * Opt-in per type, on the merits, because the call is not free and a title
   * nothing can hold is waste. True only where a real title slot exists: an
   * email subject line, a blog headline, and a KinTale title. That last one is
   * the strongest case of the three and was previously the one NOT asking:
   * `TITLE_INSTRUCTION` in generate.js is literally "write a title for the
   * pet-visit tale below", and `aiBackfillTaleTitles` exists to backfill exactly
   * these.
   *
   * False for sms and push, which have no title field and, in push's case, a
   * budget better spent on the one line it gets. False for a social post,
   * whose first line IS the hook, so a separate headline has nowhere to live.
   * False for `general`, a catch-all with no known slot.
   */
  wantsTitle: boolean;
}


/**
 * The operator's required set, in the operator's order.
 *
 * These are COPY FORMATS the Auntie voice generator writes in, which is a
 * different axis from how a message is delivered. `push` here asks for a
 * notification-shelf line; it has nothing to do with the broadcast push channel
 * that sends one, and there is still deliberately no KinTale BROADCAST channel,
 * because the dispatcher has no KinTale leg.
 *
 * Every wire value below is the one `generate.js` already switches its prompt
 * framing and its `training_documents` lookup on. The labels are the operator's
 * words; the values are the server's, and they are not the same thing.
 */
export const PERSONALIZE_MESSAGE_TYPES: readonly PersonalizeMessageType[] = [
  { key: 'email', label: 'Email', needsRecipient: true, deliverable: 'email', wantsTitle: true },
  { key: 'sms', label: 'SMS', needsRecipient: true, deliverable: 'sms', wantsTitle: false },
  { key: 'push', label: 'Push', needsRecipient: true, deliverable: false, wantsTitle: false },
  { key: 'social_post', label: 'Social', needsRecipient: false, deliverable: false, wantsTitle: false },
  { key: 'blog_post', label: 'Blog', needsRecipient: false, deliverable: false, wantsTitle: true },
  { key: 'general', label: 'General', needsRecipient: true, deliverable: false, wantsTitle: false },
  { key: 'visit_report', label: 'KinTale', needsRecipient: true, deliverable: false, wantsTitle: true },
];

/** Archive `Tone` enum, wire keys verbatim (they reach the model as `tone_hint`). */
export const PERSONALIZE_TONES: readonly { key: string; label: string }[] = [
  { key: 'warm', label: 'Warm' },
  { key: 'cheerful', label: 'Cheerful' },
  { key: 'professional', label: 'Professional' },
  { key: 'playful', label: 'Playful' },
];

/** Archive `Length` enum, wire keys verbatim (they reach the model as `max_length`). */
export const PERSONALIZE_LENGTHS: readonly { key: string; label: string }[] = [
  { key: 'short', label: 'Short' },
  { key: 'medium', label: 'Medium' },
  { key: 'long', label: 'Long' },
];

export const DEFAULT_MESSAGE_TYPE: GenerateCommunicationType = 'visit_report';
/**
 * The chip an unknown key degrades to. Derived from the table rather than held
 * as a separate literal: the drift guard in web/functions/test/generate.test.js
 * reads this file as TEXT and matches wire values between the array's markers,
 * so an entry parked in a const outside the array is invisible to it. That is
 * not hypothetical, it is how `visit_report` briefly went missing from the
 * guard's view while being perfectly present in the app.
 *
 * Non-null: DEFAULT_MESSAGE_TYPE is one of the keys literally above.
 */
const FALLBACK_TYPE: PersonalizeMessageType = PERSONALIZE_MESSAGE_TYPES.find(
  (t) => t.key === DEFAULT_MESSAGE_TYPE,
)!;
export const DEFAULT_TONE = 'warm';
export const DEFAULT_LENGTH = 'medium';

/** How many recipients the typeahead renders at once (archive: `.take(40)`). */
export const RECIPIENT_LIMIT = 40;

/**
 * Looks up a chip definition. An unknown key resolves to the default type
 * rather than throwing: the value can only come from persisted or restored
 * state, and a stale one should degrade to the default chip, not blank the
 * screen through the error boundary.
 */
export function messageTypeDef(key: string): PersonalizeMessageType {
  return PERSONALIZE_MESSAGE_TYPES.find((t) => t.key === key) ?? FALLBACK_TYPE;
}

/** Everything the composer's rules read. The screen holds this as component state. */
export interface PersonalizeFormState {
  messageType: string;
  tone: string;
  length: string;
  subject: string;
  notes: string;
  /** The REAL `kinfolk` doc id the typeahead resolved, never a typed name. */
  recipientId: string;
}

/**
 * The typeahead's result list: never archived, matched on name or email
 * case-insensitively, sorted by display name, capped.
 *
 * Ports the archive's `RecipientPicker` filter chain verbatim. The match is a
 * plain substring rather than a prefix rank because the roster is a single
 * small business's households and "@example.com" is a real thing operators
 * type when they remember the domain and not the person.
 */
export function filterRecipients(rows: Kinfolk[], query: string, limit: number = RECIPIENT_LIMIT): Kinfolk[] {
  const q = query.trim().toLowerCase();
  return rows
    .filter((k) => str(k.status) !== 'archived')
    .filter((k) => {
      if (q === '') return true;
      return kinfolkDisplayName(k).toLowerCase().includes(q) || str(k.email).toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const an = kinfolkDisplayName(a).toLowerCase();
      const bn = kinfolkDisplayName(b).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    })
    .slice(0, limit);
}

/**
 * Why this generate cannot run yet, or null. Order matters and matches the
 * archive: notes come first because they are what Auntie writes FROM, so
 * "pick a recipient" on an empty form would be the wrong first ask.
 */
export function generateBlocker(s: PersonalizeFormState): string | null {
  if (s.notes.trim() === '') return 'Add a few notes first so Auntie has something to write about.';
  if (messageTypeDef(s.messageType).needsRecipient && s.recipientId.trim() === '') {
    return 'Pick a recipient for this message type first.';
  }
  return null;
}

/**
 * Why this draft cannot be approved yet, or null.
 *
 * The contact-method and subject rules only apply to a type that actually
 * DELIVERS. Approving a KinTale report promotes the draft and writes an audit
 * entry; it sends nothing, so demanding a phone number for it would block a
 * legitimate action on a fact the action does not use.
 */
export function approveBlocker(
  s: PersonalizeFormState,
  kf: Kinfolk | undefined,
  draftId: string | null,
  draftText: string,
): string | null {
  if (draftId === null || draftId === '') {
    return 'This draft was not saved, so there is nothing to approve. Regenerate and try again.';
  }
  if (draftText.trim() === '') return 'The message is empty. Write something before approving.';

  const def = messageTypeDef(s.messageType);
  if (def.deliverable === false) return null;

  if (def.deliverable === 'email' && s.subject.trim() === '') return 'Email needs a subject.';

  const name = kf ? kinfolkDisplayName(kf) : 'This household';
  if (def.deliverable === 'email' && str(kf?.email).trim() === '') {
    return `${name} has no email address on file. Add one in Directory before sending.`;
  }
  if (def.deliverable === 'sms' && str(kf?.phoneNumber).trim() === '') {
    return `${name} has no phone number on file. Add one in Directory before sending.`;
  }
  return null;
}

/**
 * The `POST /api/generate` body.
 *
 * `kinfolk_id` is the point of the typeahead. The archive picked a real
 * `Kinfolk` object and then transmitted only its display NAME, leaving the
 * server to re-resolve it with `matchKinfolk`'s case-folded first/last/
 * startsWith scan. Two households named Dana, or one named "Dana M.", and the
 * wrong dossier fed the model. We send the id we already hold; `recipient`
 * rides along so the server's 404 message and the draft doc stay readable.
 */
export function buildGeneratePayload(
  s: PersonalizeFormState,
  kf: Kinfolk | undefined,
  avoidOpening: string | null,
): GenerateDraftArgs {
  const def = messageTypeDef(s.messageType);
  const wantsRecipient = def.needsRecipient && kf !== undefined;
  return {
    communication_type: def.key,
    recipient: wantsRecipient ? kinfolkDisplayName(kf) : '',
    raw_notes: s.notes.trim(),
    ...(wantsRecipient ? { kinfolk_id: kf._id } : {}),
    ...(s.tone.trim() !== '' ? { tone_hint: s.tone.trim() } : {}),
    ...(s.length.trim() !== '' ? { max_length: s.length.trim() } : {}),
    ...(avoidOpening !== null && avoidOpening.trim() !== '' ? { avoid_opening: avoidOpening.trim() } : {}),
    // Per-type, on the merits: see `wantsTitle` on the table above for why each
    // of the seven is or is not worth a second model call.
    ...(def.wantsTitle ? { want_title: true } : {}),
  };
}

/** The archive's draft-callout detail line: whatever the response actually told us, joined with the archive's separator. */
export function draftSubtitle(r: {
  kinfolk_name: string | null;
  communication_type: string;
  model: string | null;
  draft_id: string | null;
}): string {
  return [
    r.kinfolk_name ? `for ${r.kinfolk_name}` : null,
    r.communication_type,
    r.model,
    r.draft_id ? `draft #${r.draft_id}` : null,
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}
