import {
  EMAIL_FRAME_COLOR_FIELDS,
  EMAIL_FRAME_FIELDS,
  FOOTER_TEXT_MAX,
  HEADER_TEXT_MAX,
  type EmailFrameChanges,
  type EmailFrameField,
  type StoredEmailFrame,
} from '../api/emailFrame';

/**
 * #957: the Email frame section's draft, as pure functions.
 *
 * A draft holds one string per field, and '' means "the default". That is how
 * D-DEFAULT-IS-HINT is kept: a default is shown (as a placeholder, or as the
 * color a swatch displays) but never enters the draft, so it is never sent.
 *
 * A save sends only the fields whose draft differs from what was loaded (the
 * diff, never a rebuilt whole), so a field this client does not show can
 * never be wiped by it.
 */
export type EmailFrameDraft = Record<EmailFrameField, string>;

export function draftFrom(stored: StoredEmailFrame): EmailFrameDraft {
  const draft = {} as EmailFrameDraft;
  for (const f of EMAIL_FRAME_FIELDS) draft[f] = stored[f] ?? '';
  return draft;
}

function normalize(field: EmailFrameField, value: string): string {
  const trimmed = value.trim();
  return (EMAIL_FRAME_COLOR_FIELDS as readonly string[]).includes(field) ? trimmed.toLowerCase() : trimmed;
}

/** The fields to send: a new value, or `null` for "back to the default". Empty when nothing changed. */
export function frameChanges(draft: EmailFrameDraft, stored: StoredEmailFrame): EmailFrameChanges {
  const changes: EmailFrameChanges = {};
  for (const f of EMAIL_FRAME_FIELDS) {
    const next = normalize(f, draft[f]);
    const was = stored[f] ?? '';
    if (next === was) continue;
    changes[f] = next === '' ? null : next;
  }
  return changes;
}

/** The draft's set fields, for the preview. Blank fields are left out so the server renders their default. */
export function draftFrame(draft: EmailFrameDraft): StoredEmailFrame {
  const out: StoredEmailFrame = {};
  for (const f of EMAIL_FRAME_FIELDS) {
    const v = normalize(f, draft[f]);
    if (v !== '') out[f] = v;
  }
  return out;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * What is wrong with a field, as a sentence, or null. The same rules the
 * server applies (`emailFrameConfig.ts`), checked here so the operator sees
 * the problem beside the field before a round trip. The server still decides.
 */
export function fieldProblem(field: EmailFrameField, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if ((EMAIL_FRAME_COLOR_FIELDS as readonly string[]).includes(field)) {
    return HEX.test(v) ? null : 'Use a color like #df8431.';
  }
  if (field === 'headerText' || field === 'footerText') {
    const max = field === 'headerText' ? HEADER_TEXT_MAX : FOOTER_TEXT_MAX;
    if (v.length > max) return `Keep it to ${max} characters.`;
    if (v.includes('{{') || v.includes('}}')) return 'Merge fields like {{name}} do not work here.';
  }
  return null;
}

export function draftProblems(draft: EmailFrameDraft): Partial<Record<EmailFrameField, string>> {
  const out: Partial<Record<EmailFrameField, string>> = {};
  for (const f of EMAIL_FRAME_FIELDS) {
    const p = fieldProblem(f, draft[f]);
    if (p) out[f] = p;
  }
  return out;
}
