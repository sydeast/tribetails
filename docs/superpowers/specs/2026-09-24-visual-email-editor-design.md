# Visual email template editor

**Date:** 2026-09-24
**Issue:** #953 (editor), follows #905 / #952 (we send the password reset email ourselves)
**Status:** design approved in conversation, awaiting spec review

## Goal

The operator writes formatted emails (bold, italic, links, buttons, lists, headings, images) without touching HTML, starting with the password reset email. Every email keeps the Tribe Tails look. No device can damage a template another device saved.

Success looks like this:
- The operator opens any email template on admin web and edits it like a document.
- The preview shows exactly the email that will be sent.
- The 52 existing templates are converted.
- A save from Android never wipes formatting.

## Operator rulings in this design (2026-09-24)

1. **One shared frame.** The header bar, styles and footer are applied to every email at send time. Templates store only their own content.
2. **Formatting:** bold, italic, links, buttons, bulleted and numbered lists, headings, images.
3. **Where editing happens:**
   - **Admin web:** the full visual editor.
   - **Admin desktop:** the same editor once desktop work resumes. Until then, preview only.
   - **Admin Android:** preview plus simple body edits. You can change words, but formatting can't be added or removed on the phone.
4. **Frame editor:** wanted, but backlogged. Live-critical work comes first.
5. **SMS and push templates** are unchanged.

## Part 1: storage and sending

### Template document

`emailTemplates/{id}` gains a new-format shape:

| Field | Meaning |
|---|---|
| `subject` | Unchanged. Handlebars, plain text. |
| `headline` | New. Plain text shown in the frame's header bar. Handlebars allowed. |
| `content` | New. A sanitized HTML fragment written by the editor. The only copy of the body. |
| `format` | New. `'visual'` for this shape. Missing means the old format. |

A `'visual'` template stores no `body` and no `html`. Old-format documents (`subject`, `body`, `html?`) are left alone and send exactly as they do today until they are converted.

### Rendering at send time

One server module (`mytribe/functions/src/lib/emailFrame.ts`, new) renders a visual template in three steps:

1. **HTML part:** the shared frame wraps the content. The frame is the header bar with the headline, the Tribe Tails styles taken from the most common existing seed variant, the content box, and the footer line. It lives in one file. A change to it is a PR and reaches every email.
2. **Text part:** generated from the content.
   - Paragraphs and headings become lines.
   - List items become `- item`.
   - A button becomes `Label: <href>`.
   - A link becomes `text (<href>)`, unless the text already is the address.
   - An image becomes nothing.
3. **Merge fields:** filled as today through `renderEmailParts`. The HTML part keeps escaping, and safe https URLs pass through as-is (#892). Unresolved tokens are stripped.

Every sending route uses this renderer whenever `format === 'visual'`:
- the notification email channel (`senders/emailChannel.ts`)
- `sendFromTemplate` (invites and recovery)
- the password reset trigger (`auth/requestPasswordReset.ts`, from #952)

The generic fallback in `notifications/fallbackTemplate.ts` is not affected.

### Save check (server)

`saveTemplate` sanitizes `content` with an allowlist before it writes:
- **Allowed elements:** `p`, `br`, `strong`, `em`, `h2`, `h3`, `ul`, `ol`, `li`, `a`, `img`.
- **`a`:** keeps only `href`, and `class="button"` for a button. The `href` must be https, `mailto:`, or exactly one merge token such as `{{link}}`.
- **`img`:** keeps only `src` and `alt`. The `src` must be on the business's Cloudinary delivery host.
- **Stripped:** everything else, including `style`, `class` (except `button`), scripts and event handlers.
- **Merge tokens:** allowed only in text and in `href`. They must be `{{name}}` form. The existing refusals of triple-stash and unquoted attributes (`saveTemplate.ts:55-69`) still apply.
- **Required:** `headline` must not be empty, and `content` must hold at least one text block.

Web, Android and desktop all save through this same check.

### Preview

New callable: `previewEmailTemplate({ subject, headline, content, catalogKey? })`. It returns `{ subject, html, text }`, rendered by the same module as a real send, with sample values for the key's merge fields. Access uses the same gate as `saveTemplate`. Both editors show this output, so the preview and the sent email cannot differ.

## Part 2: editors

### Admin web (`auntieos-admin/src/screens/TemplateEditor.tsx`)

- **Fields:** Subject, Headline, Content.
- **Removed for visual templates:** the raw HTML textarea and the separate plain-text body.
- **Editor:** TipTap, the same library as `mytribe/web` Messages. It is added to the admin's dependencies. Extensions: StarterKit (paragraph, headings 2 and 3, lists, bold, italic), Link, Image, plus two custom nodes:
  - **Button:** a label plus a target, which is either an https address or a merge field. It shows as a button.
  - **Merge field:** an atomic inline chip, so it can't be half-deleted.
- **Insert field** lists only the key's own fields, from `TEMPLATE_FIELDS` (already projected to admin as `mergeFields`).
- **Image** uploads through the existing Cloudinary path (`src/api/mediaUpload.ts`).
- **Preview** sits beside the editor and is refreshed through `previewEmailTemplate`, debounced. A loading cue shows while it waits.
- **Old-format template:**
  - Shows an **"Old format"** badge in the Templates list.
  - In the editor, it offers **Convert**, which shows the old email next to the converted one. Nothing is saved until Save.
  - If the converter can't read the old HTML, the editor opens with the old plain-text body as content, for the operator to format.

### Admin Android (`TemplateBankScreen.kt` editor)

- **Subject and Headline:** native text fields.
- **Body:** parsed into a list of blocks: paragraph, heading, list item, button, image.
  - **Text blocks** are edited in a rich text field with no formatting toolbar. Existing bold, italic and links are kept. The operator can change words and cannot add or remove formatting. Uses the Compose rich-text library (`com.mohamedrejeb.richeditor`), a new dependency.
  - **Button blocks:** the label is editable, and the target is locked.
  - **Image blocks:** shown and locked.
  - Blocks cannot be added, removed or reordered on the phone.
- **Preview:** the same `previewEmailTemplate` output, in a WebView, with a loading cue.
- **Save:** rebuilds `content` from the blocks and saves through `saveTemplate`. `markdownToHtml` is no longer used for any template.
- **Old-format template on Android:** preview plus subject only, with a note to convert it on web.

### Admin desktop (paused)

Preview only, plus the line "Edit this template on the web admin." It never writes `html` or `content`. It gets the web editor when desktop work resumes.

## Part 3: conversion

### The 52 repo templates

A converter (`mytribe/functions/src/notifications/convertLegacyTemplate.ts`, new, pure) turns an old template into the new shape:
- **`headline`:** the text of the header `h2`.
- **`content`:** the inner HTML of the `.content` box, passed through the save check. The old `class='button'` links become buttons.
- **`subject`:** kept.
- If the old HTML doesn't have the frame shape, the converter returns "unreadable" and never guesses.

The seed files under `mytribe/seeds/notificationTemplates/*/` gain a visual form: `headline.txt` and `content.html`. The seed corpus generator and the importer carry the new fields. Any seed the converter can't do cleanly is fixed by hand in the same PR and listed in the PR body.

### Stored templates in Firestore

- **Templates the operator never edited** match the old repo copy. Template Import shows them as changed in the repo. The operator ticks them (`overwriteIds`) and imports, and they're replaced in one pass. This follows the standing rule that templates arrive by the importer, never by a seed script.
- **Templates the operator did edit** are never overwritten by Import. They carry the "Old format" badge until converted in the web editor.
- Nothing has to be converted by any date. Old-format templates keep sending.

## Build order

Five PRs, each merged to main on its own (no stacked PRs):

1. **Stop the overwrite.** Android and desktop editors never replace `html` they didn't author. Old-format templates on those devices become subject-only plus preview. This protects the reset template as soon as it is imported.
2. **Server: new format.** Fields, `emailFrame.ts` (frame, text generation, render), the `saveTemplate` sanitizer, `previewEmailTemplate`, and new-format support in all three sending routes. Old format unchanged.
3. **Convert the 52.** The converter, the seed files, and the corpus and importer changes.
4. **Web editor.** TipTap editor, Button and merge-field nodes, image upload, preview, Convert, the "Old format" badge.
5. **Android simple edits.** Block view, word edits, preview.

**Operator steps:**
- After 2 and 3 are released: Template Import, tick the untouched templates.
- After 4: edit on web, and convert any customised templates.

## Testing

**Server (vitest)**
- The sanitizer keeps each allowed element and attribute, and strips `style`, scripts, event handlers, non-Cloudinary images, and tokens outside text or `href`.
- Text generation for paragraphs, headings, lists, buttons, links and images.
- A real render through `renderEmailParts` keeps an Admin SDK-shaped link verbatim in both parts.
- `previewEmailTemplate` and a real send produce identical output from one template.
- Each of the three sending routes sends both formats.

**Conversion**
For every one of the 52 seeds:
- it converts;
- its headline is not empty;
- its content passes the save check;
- its set of merge tokens equals the old template's set;
- its buttons and links (label and href) match the old ones.

**Admin web (vitest and Cypress)**
- Each toolbar tool.
- Merge-field chips insert and delete as a unit.
- Convert shows the side-by-side view and saves only on Save.
- A Cypress spec edits, previews and saves, with UI-only assertions and callables stubbed with `cy.intercept`.

**Android**
- Parsing content into blocks, and rebuilding it, is lossless.
- A word edit keeps bold, italic, links, buttons and images.
- Blocks can't be added or removed.
- The old-format path is subject-only.

**Not provable in tests:** how the email looks in real inboxes. The frame is today's frame. After release, the operator sends themselves a reset and checks it.

## Backlog (not in this work)

- A frame editor screen, so header, colors and footer can be edited without a PR.
- A "send me a test email" button.
- Visual editing on admin desktop, when desktop work resumes.
