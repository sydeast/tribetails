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
 * ── THE CHIP TABLES ARE THE ARCHIVE'S, WITH ONE RENAME ──────────────────────
 * The archive's `MessageType` enum is Visit report / Text / Email / Blog, over
 * `communication_type` values visit_report / sms / email / blog_post. The only
 * change here is the LABEL on the first one: this product calls a visit report
 * a KinTale, so the chip reads "KinTale report" while the wire value stays
 * `visit_report`. The wire value is what `generate.js` switches its prompt
 * framing and its `training_documents` lookup on, so renaming it would silently
 * change the voice.
 *
 * KinTale is a message TYPE here, never a broadcast channel. `broadcastMessage`
 * accepts inapp/email/sms/push and has no KinTale delivery leg, so a KinTale
 * broadcast chip would be a button that cannot deliver.
 *
 * The archive also declared `social_post` and `general` on its
 * `CommunicationType` enum with no `MessageType` mapping to them, i.e. they
 * were unreachable from the UI. They stay unreachable rather than being
 * surfaced as two chips nobody asked for.
 */

/** A message-type chip: what it says, whether it needs a household, and whether approving it can deliver. */
export interface PersonalizeMessageType {
  key: GenerateCommunicationType;
  label: string;
  /**
   * A Blog post addresses nobody. Everything else is written FOR a household,
   * and the dossier/Kin/411 context the generator reads is keyed off that
   * household, so without one the copy is generic.
   */
  needsRecipient: boolean;
  /**
   * The channel approving this type actually sends over, or `false` when
   * approving only promotes the draft. A KinTale report is written into the
   * KinTale flow rather than texted, and a Blog post has no recipient at all,
   * so neither delivers from this screen.
   */
  deliverable: false | 'email' | 'sms';
}

const KINTALE_REPORT_TYPE: PersonalizeMessageType = {
  key: 'visit_report',
  label: 'KinTale report',
  needsRecipient: true,
  deliverable: false,
};

export const PERSONALIZE_MESSAGE_TYPES: readonly PersonalizeMessageType[] = [
  KINTALE_REPORT_TYPE,
  { key: 'sms', label: 'Text', needsRecipient: true, deliverable: 'sms' },
  { key: 'email', label: 'Email', needsRecipient: true, deliverable: 'email' },
  { key: 'blog_post', label: 'Blog', needsRecipient: false, deliverable: false },
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
  return PERSONALIZE_MESSAGE_TYPES.find((t) => t.key === key) ?? KINTALE_REPORT_TYPE;
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
    // The second model call is only worth paying for when there is a subject
    // line to put the result in.
    ...(def.deliverable === 'email' ? { want_title: true } : {}),
  };
}

/** The archive's draft-callout subtitle: whatever the response actually told us, joined with the archive's separator. */
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
