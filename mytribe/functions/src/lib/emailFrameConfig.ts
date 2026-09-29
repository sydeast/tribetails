import { z } from 'zod';

/**
 * #957: the editable values of the shared email frame (`emailFrame.ts`), their
 * defaults, and the one schema every reader and writer validates them with.
 * Spec: docs/superpowers/specs/2026-09-28-email-frame-editor-design.md
 *
 * Pure: no Firestore, no secrets. `emailFrame.ts` imports this at module scope
 * for every send route, so anything heavier here would land on every cold start
 * (`coldStartImportGraph.test.ts`). `zod` is already on that list.
 *
 * The defaults are the values the frame used before it was editable, so a
 * business that never saves a frame sends byte-identical email.
 */

export const EMAIL_FRAME_COLOR_FIELDS = [
  'pageBackground',
  'cardBackground',
  'textColor',
  'headlineColor',
  'accentColor',
  'buttonTextColor',
  'calloutBackground',
  'footerBackground',
  'footerTextColor',
] as const;

export const EMAIL_FRAME_TEXT_FIELDS = ['headerText', 'footerText'] as const;

export const EMAIL_FRAME_FIELDS = [...EMAIL_FRAME_COLOR_FIELDS, ...EMAIL_FRAME_TEXT_FIELDS, 'logoUrl'] as const;

export type EmailFrameField = (typeof EMAIL_FRAME_FIELDS)[number];

/** A complete frame: every field resolved. `headerText` and `logoUrl` are '' when unset. */
export type EmailFrame = Record<EmailFrameField, string>;

/** Only the fields the operator set. What `business_settings/email_frame` holds. */
export type StoredEmailFrame = Partial<Record<EmailFrameField, string>>;

export const DEFAULT_FOOTER_TEXT = "Tribe Tails Pet Care. Your Kin's Favorite Auntie.";

export const DEFAULT_EMAIL_FRAME: Readonly<EmailFrame> = Object.freeze({
  pageBackground: '#fbfbf9',
  cardBackground: '#ffffff',
  textColor: '#11131f',
  headlineColor: '#11131f',
  accentColor: '#df8431',
  buttonTextColor: '#ffffff',
  calloutBackground: '#fff5f5',
  footerBackground: '#11131f',
  footerTextColor: '#fbfbf9',
  headerText: '',
  footerText: DEFAULT_FOOTER_TEXT,
  logoUrl: '',
});

/** Where the stored frame lives. Server-only: the rules deny it to every client. */
export const EMAIL_FRAME_DOC_PATH = 'business_settings/email_frame';

/** The business-upload folder both admin clients' images land in (see `brandAsset.ts`). */
export const EMAIL_FRAME_LOGO_FOLDER = 'tribetails/business/business_settings';

export const HEADER_TEXT_MAX = 80;
export const FOOTER_TEXT_MAX = 300;
export const LOGO_URL_MAX = 2000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const color = z
  .string()
  .regex(HEX_COLOR, 'A color must be written as #rrggbb.')
  .transform((s) => s.toLowerCase());

/**
 * One line of plain text. The frame's HTML is handed to Handlebars as template
 * text, so a `{{` here would become a merge field; it is refused here and the
 * braces are escaped again when the frame renders. Control characters (a
 * newline included) are refused: the footer and header are single lines.
 */
function textField(label: string, max: number) {
  return z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .max(max, `${label} can be at most ${max} characters.`)
        // eslint-disable-next-line no-control-regex
        .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), `${label} must be one line.`)
        .refine((s) => !s.includes('{{') && !s.includes('}}'), `${label} cannot hold merge fields ({{ }}).`),
    );
}

/**
 * The structural half of the logo check, which needs no secret. The save path
 * adds the account-and-folder check (`assertCloudinaryUrlInFolder`) on top;
 * the send-time read, which runs in functions that do not bind the Cloudinary
 * secret, relies on this half to keep a hand-edited value out of the markup.
 */
const logoUrl = z
  .string()
  .trim()
  .max(LOGO_URL_MAX, 'The logo address is too long.')
  .refine(
    (s) => s === '' || (/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(s) && !/[\s"'<>{}\\]/.test(s)),
    'The logo must be an image uploaded to the business library.',
  );

export const EMAIL_FRAME_FIELD_SCHEMAS = {
  pageBackground: color,
  cardBackground: color,
  textColor: color,
  headlineColor: color,
  accentColor: color,
  buttonTextColor: color,
  calloutBackground: color,
  footerBackground: color,
  footerTextColor: color,
  headerText: textField('The header line', HEADER_TEXT_MAX),
  footerText: textField('The footer line', FOOTER_TEXT_MAX),
  logoUrl,
} satisfies Record<EmailFrameField, z.ZodType<string>>;

function isField(key: string): key is EmailFrameField {
  return (EMAIL_FRAME_FIELDS as readonly string[]).includes(key);
}

/**
 * A stored document's frame fields, validated one by one. A value that fails
 * (a hand edit in the console) is dropped, so that field renders its default,
 * and named in `dropped` for the caller to log. An empty string is dropped
 * silently: it is how a blank means "the default". Non-frame keys
 * (`updatedAt`, `updatedBy`) are ignored.
 */
export function parseStoredFrame(raw: unknown): { stored: StoredEmailFrame; dropped: EmailFrameField[] } {
  const stored: StoredEmailFrame = {};
  const dropped: EmailFrameField[] = [];
  if (!raw || typeof raw !== 'object') return { stored, dropped };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isField(key)) continue;
    const parsed = EMAIL_FRAME_FIELD_SCHEMAS[key].safeParse(value);
    if (!parsed.success) {
      dropped.push(key);
      continue;
    }
    if (parsed.data !== '') stored[key] = parsed.data;
  }
  return { stored, dropped };
}

/** Stored fields over the defaults: the frame a send renders. */
export function resolveEmailFrame(stored: StoredEmailFrame): EmailFrame {
  return { ...DEFAULT_EMAIL_FRAME, ...stored };
}
