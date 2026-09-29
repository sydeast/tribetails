import { call } from '../lib/fns';

/**
 * #957: the shared email frame, through its three owner-only callables
 * (`mytribe/functions/src/admin/emailFrameSettings.ts`). The frame document is
 * denied to every client in the rules, so there is no direct Firestore path.
 * Spec: docs/superpowers/specs/2026-09-28-email-frame-editor-design.md
 */

export const EMAIL_FRAME_COLOR_FIELDS = [
  'accentColor',
  'headlineColor',
  'textColor',
  'buttonTextColor',
  'pageBackground',
  'cardBackground',
  'calloutBackground',
  'footerBackground',
  'footerTextColor',
] as const;

export const EMAIL_FRAME_FIELDS = [...EMAIL_FRAME_COLOR_FIELDS, 'headerText', 'footerText', 'logoUrl'] as const;

export type EmailFrameColorField = (typeof EMAIL_FRAME_COLOR_FIELDS)[number];
export type EmailFrameField = (typeof EMAIL_FRAME_FIELDS)[number];

/** Server limits, restated so the field can stop typing where the server would refuse. */
export const HEADER_TEXT_MAX = 80;
export const FOOTER_TEXT_MAX = 300;

export type StoredEmailFrame = Partial<Record<EmailFrameField, string>>;

export interface EmailFrameState {
  /** Only the fields the operator set. */
  stored: StoredEmailFrame;
  /** Every field's default: a placeholder, never a saved value. */
  defaults: Record<EmailFrameField, string>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface EmailFramePreview {
  subject: string;
  html: string;
  text: string;
}

export async function getEmailFrame(): Promise<EmailFrameState> {
  return await call<Record<string, never>, EmailFrameState>('getEmailFrame', {}, { idempotent: true });
}

/** A value sets a field, `null` resets it to its default, a missing key is untouched. */
export type EmailFrameChanges = Partial<Record<EmailFrameField, string | null>>;

export async function saveEmailFrame(changes: EmailFrameChanges): Promise<EmailFrameState> {
  return await call<{ changes: EmailFrameChanges }, EmailFrameState>('saveEmailFrame', { changes });
}

export async function resetEmailFrame(): Promise<EmailFrameState> {
  return await call<{ resetAll: true }, EmailFrameState>('saveEmailFrame', { resetAll: true });
}

export async function previewEmailFrame(frame: StoredEmailFrame): Promise<EmailFramePreview> {
  return await call<{ frame: StoredEmailFrame }, EmailFramePreview>('previewEmailFrame', { frame }, { idempotent: true });
}
