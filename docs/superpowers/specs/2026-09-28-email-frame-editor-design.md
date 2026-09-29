# Email frame editor

**Date:** 2026-09-28
**Issue:** #957. Follows #953 (`2026-09-24-visual-email-editor-design.md`), which put one shared frame around every visual email at send time.

## Goal

The operator changes the frame every visual email is sent in (colors, a header line, a logo, the footer line) from admin web or admin Android, previews it, and the next email sent uses it. No PR needed.

## What is editable

The frame today is `FRAME_STYLE` plus `FOOTER` in `mytribe/functions/src/lib/emailFrame.ts`. Every value in it becomes a field. The default for each field is the value the frame uses today.

| Field | Default | Used for |
|---|---|---|
| `pageBackground` | `#fbfbf9` | `body` background |
| `cardBackground` | `#ffffff` | `.container` background |
| `textColor` | `#11131f` | `body` text |
| `headlineColor` | `#11131f` | `.header h2` |
| `accentColor` | `#df8431` | top border, `.button` background, callout left border |
| `buttonTextColor` | `#ffffff` | `.button` text |
| `calloutBackground` | `#fff5f5` | `blockquote` background |
| `footerBackground` | `#11131f` | `.footer` background and the container's bottom border |
| `footerTextColor` | `#fbfbf9` | `.footer` text |
| `headerText` | none | a short line above the headline, in the header |
| `logoUrl` | none | an image above the headline, 160 px wide |
| `footerText` | `Tribe Tails Pet Care. Your Kin's Favorite Auntie.` | the footer line |

Fonts, widths and paddings stay fixed. They are layout, not branding, and a wrong value there breaks the email on phones.

With nothing stored, the frame renders byte-identical to today's. `headerText` and `logoUrl` add markup only when set, with inline styles, so the default `<style>` block does not change.

The text part of an email is not changed by the frame. It was never framed: it is the headline and the content (`contentToText`), and it stays that way.

## Where it is stored

One document, `business_settings/email_frame`. Only the fields the operator set are stored. A missing document or a missing field means that field's default (D-DEFAULT-IS-HINT): the default is shown as a placeholder on both clients and is never written.

The document also carries `updatedAt` (ISO string) and `updatedBy` (uid).

Clients never read or write it directly. The Firestore rules deny it to every client, and the `business_settings/{docId}` wildcard excludes it, because in rules any matching `allow` grants access. All access is through the three callables below, which is where validation lives. This also keeps it off the main `business_settings/business_settings` document, which three clients write with changed-field patches that know nothing about the frame.

## Validation

Every field is validated on save by one zod schema (`lib/emailFrameConfig.ts`), shared by save, preview and the send-time read:

- **Colors:** `#rrggbb` only, stored lowercase. They go straight into a `<style>` block, so nothing else is accepted.
- **`headerText`:** at most 80 characters, one line.
- **`footerText`:** at most 300 characters, one line.
- **Text fields:** no `{{` or `}}`. The frame's output is handed to Handlebars as template text, so a brace pair would become a merge field. Braces are also escaped when the frame renders, and `&`, `<` and `>` are escaped, so text can never become markup.
- **`logoUrl`:** a Cloudinary image in the business folder, checked by `assertCloudinaryUrlInFolder(url, CLOUDINARY_CLOUD_NAME, 'tribetails/business/business_settings')`, the check the business logo already uses. Both admin clients upload business images to that folder through the existing signer. A logo is refused with `failed-precondition` when the server has no `CLOUDINARY_CLOUD_NAME`.
- **Blank:** a text field that is blank after trimming means "use the default" and is removed from the document.
- **Unknown fields** are refused.

## How the send path reads it

`loadEmailFrame()` (`lib/emailFrameStore.ts`) reads the document once and returns a complete frame, defaults filled in.

- Missing document: the default frame.
- Read fails: the default frame, and a `warn` log line `email.frame.read_failed`. An email is never held back because the frame could not be read.
- A stored value that fails validation (a hand edit in the console): that field falls back to its default, with a `warn` log line `email.frame.field_dropped` naming the field.

`frameHtml` and `sendPartsFor` stay synchronous and pure. They take the frame as an optional argument that defaults to the default frame, so the cold-start import graph does not change.

Every send route reads the frame once per invocation and passes it in:

- `notifications/senders/emailChannel.ts`
- `lib/sendFromTemplate.ts` (invites, recovery). `lib/inviteEmails.ts` sends up to three emails in one invocation, so it reads the frame once and hands it to each send.
- `auth/requestPasswordReset.ts`, inside its existing `try`, so a frame read never turns into a failed reset.
- `admin/previewEmailTemplate.ts`, so the template editor's preview shows the stored frame too.

## Callables

All three are admin callables and owner-only. They are not in `AUNTIE_ALLOWED_CALLABLES`: editing business configuration is owner work (D-2026-09-22-AUNTIE-ROLE).

- **`getEmailFrame()`** returns `{ stored, defaults, updatedAt, updatedBy }`. `stored` has only the fields that are set, `defaults` has every field. Clients show `stored` as values and `defaults` as placeholders.
- **`saveEmailFrame({ changes?, resetAll? })`**
  - `changes` is a patch: a value sets a field, `null` resets that field. A field left out is untouched, so a client that does not know a field can never wipe it.
  - `resetAll: true` removes every frame field.
  - It writes, audits and returns the same shape as `getEmailFrame`. A refused save throws, and nothing is written (D-SAVE-OR-FAIL-VISIBLY).
- **`previewEmailFrame({ frame })`** takes the draft's set fields, validates them with the same schema, and renders fixed sample content (headline, paragraph, list, button and callout) through the real `sendPartsFor` and `renderEmailParts`. It returns `{ subject, html, text }`. The preview therefore runs the same code as a real send.

## Audit

Every save writes `EMAIL_FRAME_UPDATED` through `writeAuditEntry`, with the actor, `resetAll`, and the changed fields and their new values (`null` for a reset). The values are colors, short text and an image URL, with nothing private in them.

## Clients

**Admin web:** a new Settings section, **Email frame**. It holds a color input per color, the header line, the footer line, a logo picker (upload through `uploadEmailImage`, or remove), and a live preview beside the fields.
- The preview refreshes through `previewEmailFrame` on a debounce, with a loading cue while it waits.
- Save sends only the fields that changed and shows a moving cue until the server answers.
- **Reset to default** asks first, then calls `saveEmailFrame({ resetAll: true })`.
- There is no subtitle text (D-2026-09-11-SUBTITLES-ARE-TOOLTIPS).

**Admin Android:** the same section in Settings (`SettingsSection.EmailFrame`). It has the same fields, with hex text fields and a swatch for colors, and a logo from the existing business upload. The preview is in a WebView, with a loading cue. Save sends the diff between the loaded and edited values, never a rebuilt whole, so a field with no control is never touched.

**Admin desktop:** no editor (D-DESKTOP-PARITY-PAUSED). Desktop sends no email itself. Its template preview calls `previewEmailTemplate`, which now shows the stored frame.

## Release

Nothing is seeded. After release the frame renders its default until the operator saves one.

## Tests

- **Server (vitest):**
  - the schema refuses each bad value;
  - Auntie and kinfolk callers are refused;
  - a save writes the patch, deletes reset fields and audits;
  - `loadEmailFrame` falls back when the document is missing, when the read throws, and field by field when a stored value is bad;
  - each send route and `previewEmailTemplate` render the stored frame;
  - with nothing stored, the default frame is byte-identical to today's.
- **Rules (emulator, run by the orchestrator):** clients cannot read or write `business_settings/email_frame`, and the owner can still write `business_settings/business_settings`.
- **Admin web (vitest):** the section loads stored values and default placeholders, Save sends only the changes, Reset asks and then resets, and the preview shows a loading cue.
- **Android (JVM unit):** the repository encodes and decodes the callables, and the save diff sends only changed fields.
