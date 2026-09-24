# Visual Email Editor, PR 4: Admin Web Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator edits any email template on admin web like a document (bold, italic, links, headings, lists, callouts, buttons, images, merge fields), sees the exact email the server will send beside it, saves in the visual format, and converts old-format templates without anything being saved until Save.

**Architecture:** A TipTap editor (`components/emailEditor/`) with three custom nodes (merge-field chip, button, Cloudinary image) edits a document; two pure functions in `lib/emailContent.ts` translate between that document and the stored `content` fragment, so nothing else in the admin knows the stored shape. `TemplateEditor.tsx` branches on the template's `format`: visual templates get Subject, Headline and the editor, with a debounced `previewEmailTemplate` pane; old-format templates keep today's textareas plus a Convert action that shows the old email beside the converted one. `listTemplates` starts returning `format`, `headline` and `content` so the list can badge old templates and the editor can tell the two apart.

**Tech Stack:** React 19, TypeScript 7 (`exactOptionalPropertyTypes` on), TipTap 3.31.3 (`@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`; the same versions `mytribe/web` pins, already in the root lockfile), vitest 5 + React Testing Library + jsdom 30, Cypress 16. Server side: Firebase Functions v2 (one field projection in `listTemplates`).

**Spec:** `docs/superpowers/specs/2026-09-24-visual-email-editor-design.md` (Part 2 "Admin web", Part 3 "Stored templates", Testing)

**Depends on:** PR 2 and PR 3 merged. PR 2 provides `saveTemplate`'s visual shape and the `previewEmailTemplate` callable. PR 3 provides the `convertTemplateToVisual` callable and converted seed content. Branch from `main` after both merges.

## Global Constraints

- Stored visual template: `{ subject, headline, content, format: 'visual' }`. A visual save sends no `body` key and no `html` key at all.
- `saveTemplate` visual args, exactly: `{ templateId, subject, format: 'visual', headline, content, title?, description?, tags?, category?, usageInstructions?, sectionDefinitions?, expectNew? }`.
- `previewEmailTemplate({ subject, headline, content, catalogKey? })` returns `{ subject, html, text, issues }`.
- `convertTemplateToVisual({ templateId })` returns `{ ok: true; subject: string; headline: string; content: string } | { ok: false; reason: 'unreadable'; subject: string; body: string }`. It never writes.
- Allowed content elements: `p`, `br`, `strong`, `em`, `h2`, `h3`, `ul`, `ol`, `li`, `a` (`href`, plus `class="button"` for a button), `img` (`src` under `https://res.cloudinary.com/<cloud>/image/upload/`, `alt`), `blockquote` (the Callout block).
- Merge tokens are `{{name}}`, name matching `[A-Za-z_][A-Za-z0-9_.]*`, and appear only in text or as a whole `href`.
- Link targets: `https://…`, `mailto:…`, or one merge token. Button targets: `https://…` or one merge token.
- The editor is TipTap, set up the way `mytribe/web/src/screens/Messages.tsx` does it (`useEditor`, `useEditorState`, `StarterKit.configure({... link: false })`, then `Link.configure`).
- "Insert field" lists the fields of the notification that sends this template (`mergeFields` from `getNotificationMatrix()`), matched by `entry.templates.email === templateId`.
- Old-format templates keep today's editing (Body, HTML, merge chips, `MergePreview`) until converted. Nothing is written by Convert; only Save writes.
- UI copy is plain and written from the operator's side. No explanatory subtitle lines under panel titles (operator ruling 2026-09-11): a tooltip at most. Every wait shows a visible indicator (`LoadingRow`, a busy button, or `aria-busy`).
- Tests: vitest + React Testing Library per component, jsdom per file (`// @vitest-environment jsdom`). jsdom has no layout, so `toBeVisible()` says nothing about a closed `<details>`: assert the state carrier (the `open` attribute, `aria-busy`, `srcdoc`), never visibility. Never `it.fails`, never loosen an existing assertion to get green. TipTap is never mocked in the tests that pin editor behaviour.
- Cypress: UI-only assertions; callables stubbed with `cy.intercept` (operator ruling 2026-09-01).
- Dependencies install from the repo root only (`auntieos-admin`'s `preinstall` refuses member installs): `npm install -w auntieos-admin <pkg>`, and the root `package-lock.json` is committed.
- Every commit: message written with the Write tool to a file in the session scratchpad (never inside the repo), `git commit -F <file>`, last line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Run admin tests from `auntieos-admin`: `npx vitest run <file>`. Run functions tests from `mytribe/functions`.

## Review Focus

1. **Pasting from Gmail or Word.** Styled spans, nested divs, `<b>`, `<o:p>`, tables, `http://` links and Gmail-hosted images must land as clean paragraphs with bold and https links kept, and nothing else. Pinned in Task 3 (headless editor paste tests) and Task 12 (a real paste event in Cypress).
2. **Deleting a merge chip with Backspace or Delete.** The whole `{{name}}` goes in one keystroke; half a token (`{{displayNa`) can never reach the saved content. Pinned in Task 3.
3. **Uploading a non-image or a huge image.** A PDF or a 12 MB photo is refused before any upload starts, with a sentence saying why; a failed upload says so and leaves the editor untouched; an upload in progress shows its stage. Pinned in Tasks 4 and 7.
4. **Converting an old-format template, then leaving without saving.** `saveTemplate` is never called, the operator is asked before the converted version is thrown away, and "Keep the old format" returns to the untouched old fields. Pinned in Task 10.
5. **A slow or failing preview.** While the preview is on its way the pane says so and is `aria-busy`; a failure shows the error with a Try again button; a late answer to an old request never overwrites a newer one. Pinned in Task 6.

---

## Interfaces this PR defines (later tasks depend on these exact names)

```ts
// auntieos-admin/src/api/templates.ts (extended)
export interface TemplateSummary {
  /* ...existing fields... */
  format?: 'visual';
  headline?: string;
  content?: string;
}

// auntieos-admin/src/lib/emailContent.ts (new)
export const MERGE_TOKEN_SOURCE: string;
export const CLOUDINARY_IMAGE: RegExp;
export function fieldNameOf(href: string): string | null;
export function isLinkTarget(href: string): boolean;
export function normalizeWebTarget(raw: string, allowMailto: boolean): string | null;
export function escapeText(s: string): string;
export function fromEmailContent(content: string): string;   // stored content -> editor HTML
export function toEmailContent(editorHtml: string): string;  // editor HTML -> stored content
export function bodyToContent(body: string): string;         // old plain-text body -> content
export function hasTextBlock(content: string): boolean;
export function tokensIn(...parts: string[]): string[];

// auntieos-admin/src/components/emailEditor/extensions.ts (new)
export const MergeField: Node;      // name 'mergeField', attrs { name }
export const EmailButton: Node;     // name 'emailButton', attrs { label, href }
export const EmailImage: Node;      // name 'emailImage', attrs { src, alt }
export function emailEditorExtensions(): Extensions;
// commands: insertMergeField(name), insertEmailButton({label, href}),
//           updateEmailButton({label, href}), insertEmailImage({src, alt})

// auntieos-admin/src/api/templatesWrite.ts (extended)
export interface PreviewEmailTemplateRequest { subject: string; headline: string; content: string; catalogKey?: string }
export interface PreviewEmailTemplateResult { subject: string; html: string; text: string; issues: string[] }
export function previewEmailTemplate(req: PreviewEmailTemplateRequest): Promise<PreviewEmailTemplateResult>;
export type ConvertTemplateResult =
  | { ok: true; subject: string; headline: string; content: string }
  | { ok: false; reason: 'unreadable'; subject: string; body: string };
export function convertTemplateToVisual(templateId: string): Promise<ConvertTemplateResult>;
export function saveTemplate(payload: SaveTemplatePayload | SaveVisualTemplatePayload): Promise<{ templateId: string }>;

// auntieos-admin/src/api/emailImageUpload.ts (new)
export const EMAIL_IMAGE_MAX_BYTES: number; // 5 MB
export function emailImageFileError(file: { type: string; size: number }): string | null;
export function uploadEmailImage(file: File, onStage?: (stage: UploadStage) => void): Promise<string>;

// auntieos-admin/src/lib/templateFormat.ts (extended)
export interface TemplateFormFields { /* existing */ headline: string; content: string }
export interface SaveVisualTemplatePayload { templateId; subject; format: 'visual'; headline; content; title?; description?; tags; category?; usageInstructions; sectionDefinitions; expectNew? }
export function isOldFormat(tpl: Pick<TemplateSummary, 'format'>): boolean;
export function visualFormError(fields: Pick<TemplateFormFields, 'templateId' | 'subject' | 'headline' | 'content'>, opts: { isCreate: boolean }): string | null;
export function buildVisualSavePayload(fields: TemplateFormFields, opts?: { isCreate?: boolean }): SaveVisualTemplatePayload;
export interface TemplateFieldSet { catalogKey: string | null; fields: string[]; source: 'catalog' | 'template' }
export function fieldsForTemplate(catalog: ReadonlyArray<Pick<NotificationCatalogEntry, 'key' | 'templates' | 'mergeFields'>>, templateId: string, alreadyUsed: readonly string[]): TemplateFieldSet;

// auntieos-admin/src/lib/useEmailPreview.ts (new)
export const PREVIEW_DEBOUNCE_MS = 500;
export type EmailPreviewState = ...;
export function useEmailPreview(req: PreviewEmailTemplateRequest | null): { state: EmailPreviewState; retry: () => void };
```

## File Structure

| File | Responsibility |
|---|---|
| `mytribe/functions/src/admin/listTemplates.ts` (modify) | Return `format`, `headline`, `content` for visual docs. |
| `mytribe/functions/test/listTemplates.test.ts` (modify) | Pin that projection. |
| `mytribe/functions/CALLABLE_CONTRACT.md` (modify) | Document the three new response fields. |
| `auntieos-admin/package.json`, root `package-lock.json` (modify) | Add the four `@tiptap/*` packages to the admin. |
| `auntieos-admin/test-setup.ts` (modify) | Range layout stubs so ProseMirror mounts in jsdom. |
| `auntieos-admin/src/api/templates.ts` (modify) | `TemplateSummary` gains the three optional fields. |
| `auntieos-admin/src/lib/emailContent.ts` (+ test) | Stored content <-> editor HTML, targets, tokens, body seeding. |
| `auntieos-admin/src/components/emailEditor/extensions.ts` (+ test) | TipTap extension list and the three custom nodes. |
| `auntieos-admin/src/api/templatesWrite.ts` (+ test) | `previewEmailTemplate`, `convertTemplateToVisual`, `saveTemplate` union. |
| `auntieos-admin/src/api/emailImageUpload.ts` (+ test) | File checks and the sign, upload, record pipeline returning the URL. |
| `auntieos-admin/src/lib/templateFormat.ts` (+ test) | Visual form fields, validation, save payload, field lookup, `isOldFormat`. |
| `auntieos-admin/src/lib/useEmailPreview.ts` | Debounced preview with stale-response guard and retry. |
| `auntieos-admin/src/components/emailEditor/EmailPreviewPane.tsx` (+ test, css) | The preview panel: loading cue, error, subject, framed HTML, issues, text part. |
| `auntieos-admin/src/components/emailEditor/EmailEditorDialogs.tsx` (+ test) | Link/Button target dialog, Image upload dialog, Insert field dialog. |
| `auntieos-admin/src/components/emailEditor/EmailContentEditor.tsx` (+ test, css) | Toolbar plus TipTap surface. |
| `auntieos-admin/src/components/emailEditor/ConvertCompare.tsx` (+ test) | Old email next to the converted one. |
| `auntieos-admin/src/screens/TemplateEditor.tsx` (+ test, css) | Visual mode, convert flow, leave confirmation. |
| `auntieos-admin/src/screens/Templates.tsx` (+ test) | "Old format" badge on cards. |
| `auntieos-admin/cypress/e2e/email-editor.cy.ts` (new) | Edit, preview, save; convert and leave; real paste. |

---

### Task 1: `listTemplates` returns the visual fields

**Files:**
- Modify: `mytribe/functions/src/admin/listTemplates.ts` (the `TemplateDoc` type and the `templates` map)
- Modify: `mytribe/functions/test/listTemplates.test.ts`
- Modify: `mytribe/functions/CALLABLE_CONTRACT.md` (the `listTemplates` response entry)
- Modify: `auntieos-admin/src/api/templates.ts` (`TemplateSummary`)

**Interfaces:**
- Consumes: the `emailTemplates` doc shape from PR 2 (`format: 'visual'`, `headline`, `content`).
- Produces: `listTemplates` rows carry `format: 'visual'`, `headline`, `content` for visual docs and omit all three for old docs. `TemplateSummary` gains `format?: 'visual'; headline?: string; content?: string`.

- [ ] **Step 1: Set up the branch.** From the main checkout:

```bash
git fetch origin
git worktree add ../tribetails-worktrees/email-editor-web -b feat/email-editor-web origin/main
```

Then, from the new worktree root, `npm ci`, then `npm ci --prefix mytribe/functions`. The pre-commit hook needs both trees; a "tests FAIL" from the hook in a fresh worktree is missing dependencies, not broken code. Confirm PR 2 and PR 3 are in: `git grep -n "previewEmailTemplate" mytribe/functions/src/index.ts` and `git grep -n "convertTemplateToVisual" mytribe/functions/src/index.ts` each print a line. If either is empty, stop and report; this PR cannot start. Also check whether PR 2 or PR 3 already made `listTemplates` return `format`: `git grep -n "headline" mytribe/functions/src/admin/listTemplates.ts`. If it prints the projection, skip Steps 2 to 4's server half and keep only the `TemplateSummary` change. Finally record the baseline: `cd auntieos-admin && npx vitest run 2>&1 | grep -E "Test Files|Tests "` and note both numbers for Task 13.

- [ ] **Step 2: Write the failing test.** Add to `mytribe/functions/test/listTemplates.test.ts`, inside `describe('listTemplates', …)`:

```ts
  it('#953: returns format, headline and content for a visual template, and omits them for an old one', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'auth.password.reset', data: { subject: 'S', format: 'visual', headline: 'Reset', content: '<p>Hi</p>' } },
        { id: 'old.one', data: { subject: 'S', body: 'B', html: '<p>B</p>' } },
      ]),
    );
    const res = await listTemplatesHandler(req());
    expect(res.templates[0]).toMatchObject({
      templateId: 'auth.password.reset',
      format: 'visual',
      headline: 'Reset',
      content: '<p>Hi</p>',
      body: '',
      html: null,
    });
    expect(res.templates[1]).not.toHaveProperty('format');
    expect(res.templates[1]).not.toHaveProperty('headline');
    expect(res.templates[1]).not.toHaveProperty('content');
  });

  it('#953: a visual doc missing headline or content still decodes, as empty strings', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'v', data: { subject: 'S', format: 'visual' } }]));
    const res = await listTemplatesHandler(req());
    expect(res.templates[0]).toMatchObject({ format: 'visual', headline: '', content: '' });
  });
```

- [ ] **Step 3: Run to verify it fails.**
Run: `cd mytribe/functions && npx vitest run test/listTemplates.test.ts`
Expected: the two new tests FAIL (`format` missing); the existing ones pass.

- [ ] **Step 4: Implement.** In `listTemplates.ts`, add to `TemplateDoc`:

```ts
  /** #953: 'visual' = headline + content, framed at send time. Missing = old format. */
  format?: string;
  headline?: string;
  content?: string;
```

and add as the last entries of the object the `templates` map returns (after `sectionDefinitions`):

```ts
      // #953: the editor needs these to tell a visual template from an old one,
      // and the Template Bank badges the old ones. Omitted for old docs, so their
      // rows are byte-identical to what every existing client already decodes.
      ...(data.format === 'visual'
        ? {
            format: 'visual' as const,
            headline: typeof data.headline === 'string' ? data.headline : '',
            content: typeof data.content === 'string' ? data.content : '',
          }
        : {}),
```

Android's `TemplateRepository.listTemplates` reads the map key by key and the desktop decoder uses `ignoreUnknownKeys = true`, so neither breaks on the new keys.

In `CALLABLE_CONTRACT.md`, under the `listTemplates` response fields, add one line in the file's existing style: `format?: 'visual', headline?: string, content?: string: present only on visual templates (#953).`

In `auntieos-admin/src/api/templates.ts`, add to `TemplateSummary` after `sectionDefinitions`:

```ts
  /**
   * #953: present only on a visual template. Missing means the old format
   * (`subject` / `body` / `html`), which keeps sending exactly as before until
   * it is converted. Optional, so every existing fixture and caller is unchanged.
   */
  format?: 'visual';
  /** Visual only: the plain-text headline in the frame's header bar. */
  headline?: string;
  /** Visual only: the sanitized HTML fragment the editor writes. */
  content?: string;
```

- [ ] **Step 5: Run to verify.**
Run: `cd mytribe/functions && npx vitest run test/listTemplates.test.ts` (PASS, all tests), then `cd ../../auntieos-admin && npx tsc --noEmit` (clean).

- [ ] **Step 6: Commit.** Message file:

```
listTemplates returns the visual template fields (#953)

The web editor needs format, headline and content to tell a visual
template from an old one, and the Template Bank badges old ones. Old
rows are unchanged.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

`git add mytribe/functions/src/admin/listTemplates.ts mytribe/functions/test/listTemplates.test.ts mytribe/functions/CALLABLE_CONTRACT.md auntieos-admin/src/api/templates.ts && git commit -F <file>`

---

### Task 2: TipTap dependencies and the content translation

**Files:**
- Modify: `auntieos-admin/package.json`, `package-lock.json` (root)
- Modify: `auntieos-admin/test-setup.ts`
- Create: `auntieos-admin/src/lib/emailContent.ts`
- Test: `auntieos-admin/src/lib/emailContent.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: everything listed for `lib/emailContent.ts` in "Interfaces this PR defines".

- [ ] **Step 1: Add the dependencies from the repo root.**

```bash
npm install -w auntieos-admin @tiptap/core@^3.31.3 @tiptap/react@^3.31.3 @tiptap/starter-kit@^3.31.3 @tiptap/extension-link@^3.31.3
```

Then `npm ls @tiptap/core` must show one version (3.31.3) used by both `auntieos-admin` and `mytribe/web`. If two versions appear, re-run the install with exact `@3.31.3` pins. No image extension is added: the image is a 25-line custom node in Task 3, which pins `<img src alt>` exactly. Read `auntieos-admin/package.json` back and confirm the four lines are in `dependencies`.

- [ ] **Step 2: Let ProseMirror mount in jsdom.** Append to `auntieos-admin/test-setup.ts`:

```ts
// #953: ProseMirror measures the selection to scroll it into view, and jsdom
// has no layout, so Range has no rects. Zero-size rects are what a real
// browser returns for a collapsed, off-screen range, so this changes no
// behaviour a test can observe; it only stops the measurement from throwing.
// Guarded: node-environment specs have no Range at all.
if (typeof Range !== 'undefined') {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto['getBoundingClientRect'] !== 'function') proto['getBoundingClientRect'] = () => rect;
  if (typeof proto['getClientRects'] !== 'function') {
    proto['getClientRects'] = () => Object.assign([rect], { item: (i: number) => (i === 0 ? rect : null) });
  }
  const doc = document as unknown as Record<string, unknown>;
  if (typeof doc['elementFromPoint'] !== 'function') doc['elementFromPoint'] = () => null;
}
```

If a later task's editor mount throws on another missing layout API, add a stub for that API here in the same guarded style. Never mock `@tiptap/*` to get past it.

- [ ] **Step 3: Write the failing test** `auntieos-admin/src/lib/emailContent.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  bodyToContent,
  fieldNameOf,
  fromEmailContent,
  hasTextBlock,
  isLinkTarget,
  normalizeWebTarget,
  toEmailContent,
  tokensIn,
} from './emailContent';

describe('toEmailContent (editor HTML -> stored content)', () => {
  it('writes only the allowed elements and attributes, chips as tokens, list items without inner paragraphs', () => {
    const editorHtml =
      '<h2>T</h2><p>Hi <span data-merge-field="displayName" class="merge-chip" contenteditable="false">{{displayName}}</span></p>' +
      '<p><a href="{{link}}" class="button">Reset</a></p>' +
      '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://x.com/a?b=1&amp;c=2">x</a></p>' +
      '<ul><li><p>a</p></li><li><p></p></li></ul><ol><li><p>one</p><p>two</p></li></ol>' +
      '<blockquote><p>c</p></blockquote>' +
      '<p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt="pup"></p><p><br></p><p></p>';
    expect(toEmailContent(editorHtml)).toBe(
      '<h2>T</h2><p>Hi {{displayName}}</p><p><a href="{{link}}" class="button">Reset</a></p>' +
        '<p><a href="https://x.com/a?b=1&amp;c=2">x</a></p><ul><li>a</li></ul><ol><li>one<br>two</li></ol>' +
        '<blockquote><p>c</p></blockquote><p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt="pup"></p>',
    );
  });

  it('keeps nested marks and escapes text', () => {
    expect(toEmailContent('<p><strong><em>t</em></strong> a &lt; b &amp; c</p>')).toBe('<p><strong><em>t</em></strong> a &lt; b &amp; c</p>');
  });

  it('keeps the text of any element it does not allow', () => {
    expect(toEmailContent('<p><span style="color:red">red</span> <u>u</u></p>')).toBe('<p>red u</p>');
  });
});

describe('fromEmailContent (stored content -> editor HTML)', () => {
  it('turns text tokens into chips, and leaves hrefs and button labels alone', () => {
    expect(
      fromEmailContent(
        '<p>Hi {{displayName}}, {{ link }}</p><p><a href="{{link}}" class="button">Hi {{displayName}}</a></p><p><a href="{{link}}">go</a></p>',
      ),
    ).toBe(
      '<p>Hi <span data-merge-field="displayName"></span>, <span data-merge-field="link"></span></p>' +
        '<p><a href="{{link}}" class="button">Hi {{displayName}}</a></p><p><a href="{{link}}">go</a></p>',
    );
  });
});

describe('bodyToContent (old plain-text body -> paragraphs)', () => {
  it('splits on blank lines, keeps single line breaks, escapes, and keeps tokens as text', () => {
    expect(bodyToContent('Hi {{displayName}},\n\nClick {{link}}\nThanks & bye\r\n\r\n\n')).toBe(
      '<p>Hi {{displayName}},</p><p>Click {{link}}<br>Thanks &amp; bye</p>',
    );
  });
});

describe('targets and tokens', () => {
  it('fieldNameOf reads exactly one whole token', () => {
    expect(fieldNameOf('{{link}}')).toBe('link');
    expect(fieldNameOf(' {{ nextVisit.date }} ')).toBe('nextVisit.date');
    expect(fieldNameOf('https://x.com/{{id}}')).toBeNull();
  });

  it('isLinkTarget allows https, mailto and one token, and nothing else', () => {
    expect(isLinkTarget('https://tribetails.com')).toBe(true);
    expect(isLinkTarget('mailto:auntie@tribetails.com')).toBe(true);
    expect(isLinkTarget('{{link}}')).toBe(true);
    expect(isLinkTarget('http://tribetails.com')).toBe(false);
    expect(isLinkTarget('javascript:alert(1)')).toBe(false);
    expect(isLinkTarget('https://x.com/{{id}}')).toBe(false);
  });

  it('normalizeWebTarget adds https to a bare domain, refuses http, and takes email only where allowed', () => {
    expect(normalizeWebTarget('tribetails.com/help', false)).toBe('https://tribetails.com/help');
    expect(normalizeWebTarget('https://tribetails.com', false)).toBe('https://tribetails.com');
    expect(normalizeWebTarget('http://tribetails.com', false)).toBeNull();
    expect(normalizeWebTarget('auntie@tribetails.com', true)).toBe('mailto:auntie@tribetails.com');
    expect(normalizeWebTarget('auntie@tribetails.com', false)).toBeNull();
    expect(normalizeWebTarget('   ', true)).toBeNull();
  });

  it('hasTextBlock is true for text or an image, false for blank paragraphs', () => {
    expect(hasTextBlock('<p> </p><p><br></p>')).toBe(false);
    expect(hasTextBlock('<p>{{x}}</p>')).toBe(true);
    expect(hasTextBlock('<p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt=""></p>')).toBe(true);
  });

  it('tokensIn lists each field once, sorted', () => {
    expect(tokensIn('Hi {{b}}', '<a href="{{a}}">{{b}}</a>', '')).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 4: Run to verify it fails.**
Run: `cd auntieos-admin && npx vitest run src/lib/emailContent.test.ts`
Expected: FAIL, `Failed to resolve import "./emailContent"`.

- [ ] **Step 5: Implement** `auntieos-admin/src/lib/emailContent.ts`:

```ts
/**
 * #953: the admin side of the visual email format.
 *
 * The editor holds a TipTap document; the template stores `content`, a small
 * HTML fragment the server's allowlist accepts (see the PR 2 sanitizer,
 * `mytribe/functions/src/lib/emailContent.ts`). These functions are the only
 * place in the admin that knows the stored shape:
 *
 *  - `fromEmailContent` turns stored content into editor HTML: each `{{name}}`
 *    in TEXT becomes a merge-field chip element. Attribute values (a `{{link}}`
 *    href) and button labels are left alone.
 *  - `toEmailContent` turns the editor's `getHTML()` back into stored content:
 *    allowed elements and attributes only, chips back to `{{name}}`, list items
 *    without their inner `<p>`, empty blocks dropped.
 *
 * Both run on DOMParser, so they work in the browser and in jsdom.
 */

export const MERGE_TOKEN_SOURCE = '\\{\\{\\s*([A-Za-z_][A-Za-z0-9_.]*)\\s*\\}\\}';
const SINGLE_TOKEN = new RegExp(`^${MERGE_TOKEN_SOURCE}$`);

/** The Cloudinary delivery path every email image must be served from. The server pins the cloud name. */
export const CLOUDINARY_IMAGE = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//;

/** The field name when `href` is exactly one merge token, else null. */
export function fieldNameOf(href: string): string | null {
  const m = SINGLE_TOKEN.exec(href.trim());
  return m ? (m[1] ?? null) : null;
}

/** What a link may point at: https, mailto, or one merge token. */
export function isLinkTarget(href: string): boolean {
  const v = href.trim();
  return /^https:\/\/\S+$/i.test(v) || /^mailto:\S+$/i.test(v) || fieldNameOf(v) !== null;
}

/**
 * Turns what the operator typed into a web target, or null when it cannot be
 * one. A bare domain gains `https://`. Plain `http://` is refused rather than
 * upgraded, because the server refuses it too and a silent rewrite could point
 * at a page that does not exist over https.
 */
export function normalizeWebTarget(raw: string, allowMailto: boolean): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (/^https:\/\/\S+$/i.test(v)) return v;
  if (/^http:\/\//i.test(v)) return null;
  if (allowMailto && /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
  if (allowMailto && /^[^\s@/]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (/^[^\s/@:]+\.[^\s@]+$/.test(v)) return `https://${v}`;
  return null;
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

function parseFragment(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const SHOW_TEXT = 4;

export function fromEmailContent(content: string): string {
  const doc = parseFragment(content);
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    // A button's label is a plain string attribute of the Button node, so its
    // tokens stay text; a chip inside it would be lost when the node parses.
    if (t.parentElement?.closest('a.button')) continue;
    const value = t.data;
    const matches = [...value.matchAll(new RegExp(MERGE_TOKEN_SOURCE, 'g'))];
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      frag.append(value.slice(last, m.index));
      const chip = doc.createElement('span');
      chip.setAttribute('data-merge-field', m[1] ?? '');
      frag.append(chip);
      last = (m.index ?? 0) + m[0].length;
    }
    frag.append(value.slice(last));
    t.replaceWith(frag);
  }
  return doc.body.innerHTML;
}

const isBlank = (html: string) => html.replace(/<br>/g, '').trim() === '';

function inner(el: Element): string {
  return Array.from(el.childNodes).map(write).join('');
}

/** A TipTap list item is `<li><p>…</p></li>`; email wants `<li>…</li>`. Two paragraphs join with `<br>`. */
function listItem(el: Element): string {
  let out = '';
  let prevWasText = false;
  for (const child of Array.from(el.childNodes)) {
    const isP = child.nodeType === ELEMENT_NODE && (child as Element).tagName.toLowerCase() === 'p';
    const html = isP ? inner(child as Element) : write(child);
    if (html === '') continue;
    if (isP && prevWasText) out += '<br>';
    out += html;
    prevWasText = isP;
  }
  return out;
}

function write(node: ChildNode): string {
  if (node.nodeType === TEXT_NODE) return escapeText((node as Text).data);
  if (node.nodeType !== ELEMENT_NODE) return '';
  const el = node as Element;
  const field = el.getAttribute('data-merge-field');
  if (field !== null) return `{{${field}}}`;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'br':
      return '<br>';
    case 'img': {
      const src = el.getAttribute('src') ?? '';
      return src === '' ? '' : `<img src="${escapeAttr(src)}" alt="${escapeAttr(el.getAttribute('alt') ?? '')}">`;
    }
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const body = inner(el);
      if (href === '' || body === '') return body;
      const cls = el.classList.contains('button') ? ' class="button"' : '';
      return `<a href="${escapeAttr(href)}"${cls}>${body}</a>`;
    }
    case 'li': {
      const body = listItem(el);
      return isBlank(body) ? '' : `<li>${body}</li>`;
    }
    case 'strong':
    case 'em': {
      const body = inner(el);
      return body === '' ? '' : `<${tag}>${body}</${tag}>`;
    }
    case 'p':
    case 'h2':
    case 'h3':
    case 'ul':
    case 'ol':
    case 'blockquote': {
      const body = inner(el);
      return isBlank(body) ? '' : `<${tag}>${body}</${tag}>`;
    }
    default:
      return inner(el);
  }
}

export function toEmailContent(editorHtml: string): string {
  return inner(parseFragment(editorHtml).body);
}

/**
 * An old template's plain-text body as content, for the "couldn't read the old
 * layout" path: blank lines separate paragraphs, single newlines become `<br>`.
 */
export function bodyToContent(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${block.split('\n').map((line) => escapeText(line.trim())).join('<br>')}</p>`)
    .join('');
}

/** Mirrors the server's "content must hold something" rule: any text, or an image. */
export function hasTextBlock(content: string): boolean {
  const body = parseFragment(content).body;
  return (body.textContent ?? '').trim() !== '' || body.querySelector('img') !== null;
}

/** Every merge field named anywhere in `parts`, once each, sorted. */
export function tokensIn(...parts: string[]): string[] {
  const names = new Set<string>();
  for (const part of parts) {
    for (const m of part.matchAll(new RegExp(MERGE_TOKEN_SOURCE, 'g'))) if (m[1]) names.add(m[1]);
  }
  return [...names].sort();
}
```

- [ ] **Step 6: Run to verify it passes.**
Run: `npx vitest run src/lib/emailContent.test.ts` then `npx tsc --noEmit`
Expected: PASS (9 tests), tsc clean.

- [ ] **Step 7: Commit** (`Add TipTap to the admin and the email content translation (#953)`, body naming the four packages and the jsdom Range stubs; include `package.json`, root `package-lock.json`, `test-setup.ts`, both new files).

---

### Task 3: The editor extensions: merge-field chip, button, image

**Files:**
- Create: `auntieos-admin/src/components/emailEditor/extensions.ts`
- Test: `auntieos-admin/src/components/emailEditor/extensions.test.ts`

**Interfaces:**
- Consumes: `fromEmailContent`, `toEmailContent`, `isLinkTarget`, `CLOUDINARY_IMAGE` (Task 2).
- Produces: `MergeField`, `EmailButton`, `EmailImage`, `emailEditorExtensions()`, and the commands `insertMergeField(name)`, `insertEmailButton({ label, href })`, `updateEmailButton({ label, href })`, `insertEmailImage({ src, alt })`.

- [ ] **Step 1: Write the failing test.** These run a real headless `Editor` from `@tiptap/core`: the paste, chip and toolbar behaviour below is what ships, so nothing here is mocked.

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { emailEditorExtensions } from './extensions';
import { fromEmailContent, toEmailContent } from '../../lib/emailContent';

let editor: Editor | null = null;
function open(content: string): Editor {
  editor = new Editor({ extensions: emailEditorExtensions(), content: fromEmailContent(content) });
  return editor;
}
const out = (e: Editor) => toEmailContent(e.getHTML());
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const EVERYTHING =
  '<p>Hi {{displayName}},</p><p>Someone asked to reset the password for {{email}}.</p>' +
  '<p><a href="{{link}}" class="button">Reset password</a></p><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>' +
  '<h2>Head</h2><h3>Sub</h3><blockquote><p>Careful</p></blockquote>' +
  '<p>See <a href="https://tribetails.com/help?a=1&amp;b=2">help</a> or <a href="mailto:auntie@tribetails.com">write</a>, <strong>bold</strong> <em>it</em><br>next</p>' +
  '<p><img src="https://res.cloudinary.com/tribetails/image/upload/v1/pup.jpg" alt="Pup"></p>';

describe('round trip', () => {
  it('loads stored content and writes it back byte for byte', () => {
    expect(out(open(EVERYTHING))).toBe(EVERYTHING);
  });

  it('keeps a merge field inside a button label as text', () => {
    const html = '<p><a href="{{link}}" class="button">Hi {{displayName}}</a></p>';
    expect(out(open(html))).toBe(html);
  });
});

describe('merge-field chips', () => {
  it('insertMergeField drops a chip at the cursor, written as {{name}}', () => {
    const e = open('<p>ab</p>');
    e.commands.setTextSelection(3);
    e.commands.insertMergeField('link');
    expect(out(e)).toBe('<p>ab{{link}}</p>');
  });

  it('Backspace right after a chip removes the whole field in one keystroke', () => {
    const e = open('<p>Hi {{displayName}}</p>');
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    expect(e.commands.keyboardShortcut('Backspace')).toBe(true);
    expect(out(e)).toBe('<p>Hi </p>');
  });

  it('Delete right before a chip removes the whole field in one keystroke', () => {
    const e = open('<p>{{link}} x</p>');
    e.commands.setTextSelection(1);
    expect(e.commands.keyboardShortcut('Delete')).toBe(true);
    expect(out(e)).toBe('<p> x</p>');
  });
});

describe('pasting', () => {
  it('Gmail: keeps text, bold and https links; drops styles, http links and Gmail-hosted images', () => {
    const e = open('<p>x</p>');
    e.commands.setTextSelection(2);
    e.commands.insertContent(
      '<div dir="ltr"><span style="font-family:arial;color:#222">Hi <b>there</b></span><div><br></div>' +
        '<div><a href="https://x.com" target="_blank">site</a> and <a href="http://y.com">old</a></div>' +
        '<img src="https://mail.google.com/x.png"></div>',
    );
    expect(out(e)).toBe('<p>x</p><p>Hi <strong>there</strong></p><p><a href="https://x.com">site</a> and old</p>');
  });

  it('Word: styled spans, <o:p>, an h1 and a table become plain paragraphs', () => {
    const e = open('');
    e.commands.insertContent(
      '<p class="MsoNormal" style="margin:0"><span style="font-size:11pt;color:red">Hello<o:p></o:p></span></p>' +
        '<h1>Big</h1><table><tr><td>cell</td></tr></table>',
    );
    expect(out(e)).toBe('<p>Hello</p><p>Big</p><p>cell</p>');
  });
});

describe('toolbar commands produce the allowed HTML', () => {
  it('bold and italic', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection({ from: 1, to: 5 });
    e.chain().focus().toggleBold().toggleItalic().run();
    expect(out(e)).toBe('<p><strong><em>word</em></strong></p>');
  });

  it('heading 2 and heading 3', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(2);
    e.chain().focus().toggleHeading({ level: 2 }).run();
    expect(out(e)).toBe('<h2>word</h2>');
    e.chain().focus().toggleHeading({ level: 3 }).run();
    expect(out(e)).toBe('<h3>word</h3>');
  });

  it('bulleted and numbered lists', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(2);
    e.chain().focus().toggleBulletList().run();
    expect(out(e)).toBe('<ul><li>word</li></ul>');
    e.chain().focus().toggleOrderedList().run();
    expect(out(e)).toBe('<ol><li>word</li></ol>');
  });

  it('callout is a blockquote', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(2);
    e.chain().focus().toggleBlockquote().run();
    expect(out(e)).toBe('<blockquote><p>word</p></blockquote>');
  });

  it('link: https and a merge field are accepted, http is refused', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection({ from: 1, to: 5 });
    expect(e.chain().focus().setLink({ href: 'http://x.com' }).run()).toBe(false);
    expect(out(e)).toBe('<p>word</p>');
    e.chain().focus().setLink({ href: '{{link}}' }).run();
    expect(out(e)).toBe('<p><a href="{{link}}">word</a></p>');
  });

  it('button: inserts in its own paragraph and edits in place', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(5);
    e.commands.insertEmailButton({ label: 'Go', href: 'https://a.com' });
    expect(out(e)).toBe('<p>word</p><p><a href="https://a.com" class="button">Go</a></p>');
    e.commands.setNodeSelection(e.state.doc.child(0).nodeSize + 1);
    expect(e.isActive('emailButton')).toBe(true);
    e.commands.updateEmailButton({ label: 'Went', href: '{{link}}' });
    expect(out(e)).toBe('<p>word</p><p><a href="{{link}}" class="button">Went</a></p>');
  });

  it('image: inserts in its own paragraph; a non-Cloudinary image never loads', () => {
    const e = open('<p>word</p><p><img src="https://evil.example/x.png" alt="x"></p>');
    expect(out(e)).toBe('<p>word</p>');
    e.commands.setTextSelection(5);
    e.commands.insertEmailImage({ src: 'https://res.cloudinary.com/t/image/upload/a.png', alt: 'A' });
    expect(out(e)).toBe('<p>word</p><p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt="A"></p>');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `npx vitest run src/components/emailEditor/extensions.test.ts`
Expected: FAIL, cannot resolve `./extensions`.

- [ ] **Step 3: Implement** `auntieos-admin/src/components/emailEditor/extensions.ts`:

```ts
import { Node, mergeAttributes, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { CLOUDINARY_IMAGE, isLinkTarget } from '../../lib/emailContent';

/**
 * #953: the TipTap schema of the visual email editor. It can only express what
 * the server's content allowlist accepts: paragraphs, headings 2 and 3, lists,
 * bold, italic, links, the Callout (blockquote), and three nodes of our own.
 * Anything pasted that the schema has no place for is dropped by the parse
 * itself, before `toEmailContent` ever sees it.
 */

export interface EmailButtonAttrs {
  label: string;
  href: string;
}
export interface EmailImageAttrs {
  src: string;
  alt: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mergeField: { insertMergeField: (name: string) => ReturnType };
    emailButton: {
      insertEmailButton: (attrs: EmailButtonAttrs) => ReturnType;
      updateEmailButton: (attrs: EmailButtonAttrs) => ReturnType;
    };
    emailImage: { insertEmailImage: (attrs: EmailImageAttrs) => ReturnType };
  }
}

/**
 * A merge field as one atomic inline chip. It is a single position in the
 * document, so it can be selected, moved and deleted only as a whole, and
 * `{{displayNa` can never be left behind. `fromEmailContent` makes the chip
 * elements; `toEmailContent` writes them back as `{{name}}`.
 */
export const MergeField = Node.create({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-merge-field') ?? '',
        renderHTML: (attrs: { name: string }) => ({ 'data-merge-field': attrs.name }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-merge-field]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'merge-chip', contenteditable: 'false' }),
      `{{${node.attrs['name'] as string}}}`,
    ];
  },

  renderText({ node }) {
    return `{{${node.attrs['name'] as string}}}`;
  },

  addCommands() {
    return {
      insertMergeField:
        (name: string) =>
        ({ commands }) =>
          commands.insertContent([{ type: this.name, attrs: { name } }]),
    };
  },

  // ProseMirror leaves a plain Backspace/Delete inside text to the browser,
  // which is not guaranteed to treat a contenteditable=false chip as one unit.
  // Handling the key here makes it one unit everywhere, the way TipTap's own
  // Mention extension does.
  addKeyboardShortcuts() {
    const removeAdjacent = (direction: -1 | 1) => () => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (!selection.empty) return false;
      const node = direction === -1 ? selection.$from.nodeBefore : selection.$from.nodeAfter;
      if (!node || node.type.name !== this.name) return false;
      const from = direction === -1 ? selection.from - node.nodeSize : selection.from;
      view.dispatch(state.tr.delete(from, from + node.nodeSize));
      return true;
    };
    return { Backspace: removeAdjacent(-1), Delete: removeAdjacent(1) };
  },
});

/**
 * A button: a label and a target, written as `<a href class="button">`. An
 * inline atom, inserted in a paragraph of its own. Its parse rule outranks the
 * Link mark (priority 1000 against Link's default), so a stored button never
 * loads as an ordinary link and loses its class on the next save.
 */
export const EmailButton = Node.create({
  name: 'emailButton',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => (el.textContent ?? '').trim(),
        renderHTML: () => ({}),
      },
      href: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('href') ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a.button', priority: 1000 }];
  },

  renderHTML({ node }) {
    return ['a', { href: node.attrs['href'] as string, class: 'button' }, node.attrs['label'] as string];
  },

  renderText({ node }) {
    return `${node.attrs['label'] as string}: ${node.attrs['href'] as string}`;
  },

  addCommands() {
    return {
      insertEmailButton:
        (attrs: EmailButtonAttrs) =>
        ({ commands }) =>
          commands.insertContent({ type: 'paragraph', content: [{ type: this.name, attrs }] }),
      updateEmailButton:
        (attrs: EmailButtonAttrs) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },
});

/**
 * An image from our Cloudinary library. The parse rule refuses any other
 * source, so an image pasted from Gmail or a web page never enters the
 * document (the server would strip it on save anyway, with a warning).
 */
export const EmailImage = Node.create({
  name: 'emailImage',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: { default: '', renderHTML: () => ({}) },
      alt: { default: '', renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el: HTMLElement) => (CLOUDINARY_IMAGE.test(el.getAttribute('src') ?? '') ? null : false),
      },
    ];
  },

  renderHTML({ node }) {
    return ['img', { src: node.attrs['src'] as string, alt: node.attrs['alt'] as string }];
  },

  addCommands() {
    return {
      insertEmailImage:
        (attrs: EmailImageAttrs) =>
        ({ commands }) =>
          commands.insertContent({ type: 'paragraph', content: [{ type: this.name, attrs }] }),
    };
  },
});

/** The full extension list. One function, so the component and the tests build the same schema. */
export function emailEditorExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      codeBlock: false,
      code: false,
      strike: false,
      underline: false,
      horizontalRule: false,
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      HTMLAttributes: { target: null, rel: null, class: null },
      isAllowedUri: (url) => isLinkTarget(url),
    }),
    MergeField,
    EmailButton,
    EmailImage,
  ];
}
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run src/components/emailEditor/extensions.test.ts && npx tsc --noEmit`
Expected: PASS (15 tests), tsc clean. Every expected string above was produced by this schema and serializer in a jsdom probe on 2026-09-24. If one differs, the difference is a real change in behaviour: fix the extension or the serializer, never the expectation.

- [ ] **Step 5: Commit** (`Add the email editor schema: merge-field chip, button and image nodes (#953)`).

---

### Task 4: Callable wrappers and the email image upload

**Files:**
- Modify: `auntieos-admin/src/api/templatesWrite.ts`
- Modify: `auntieos-admin/src/api/templatesWrite.test.ts`
- Create: `auntieos-admin/src/api/emailImageUpload.ts`
- Test: `auntieos-admin/src/api/emailImageUpload.test.ts`

**Interfaces:**
- Consumes: `call` (`lib/fns.ts`); `requestSignedUpload`, `uploadToCloudinary`, `writeMediaFileDoc`, `BUSINESS_ENTITY_ID`, `UploadStage` (`api/mediaUpload.ts`); `SaveVisualTemplatePayload` (declared here as a type import from `lib/templateFormat.ts`, created in Task 5; this task adds the interface to `templateFormat.ts` so it compiles now).
- Produces: `previewEmailTemplate`, `PreviewEmailTemplateRequest`, `PreviewEmailTemplateResult`, `convertTemplateToVisual`, `ConvertTemplateResult`, the widened `saveTemplate`; `EMAIL_IMAGE_MAX_BYTES`, `emailImageFileError`, `uploadEmailImage`.

- [ ] **Step 1: Add the payload type** to `auntieos-admin/src/lib/templateFormat.ts`, directly after the `SaveTemplatePayload` interface:

```ts
/**
 * #953: the `saveTemplate` payload for a visual template. No `body` and no
 * `html` key at all: the server generates both at send time, and PR 2's check
 * refuses a visual save that carries a body.
 */
export interface SaveVisualTemplatePayload {
  templateId: string;
  subject: string;
  format: 'visual';
  headline: string;
  content: string;
  title?: string;
  description?: string;
  tags: string[];
  category?: string;
  usageInstructions: string;
  sectionDefinitions: TemplateSection[];
  expectNew?: boolean;
}
```

- [ ] **Step 2: Write the failing tests.** Append to `src/api/templatesWrite.test.ts` (extend the existing import list with `previewEmailTemplate` and `convertTemplateToVisual`):

```ts
describe('#953 visual template callables', () => {
  it('saveTemplate sends a visual payload untouched, with no body or html keys', async () => {
    call.mockResolvedValue({ templateId: 'auth.password.reset' });
    const visual = {
      templateId: 'auth.password.reset',
      subject: 'Reset',
      format: 'visual' as const,
      headline: 'Reset your password',
      content: '<p>Hi</p>',
      tags: [],
      usageInstructions: '',
      sectionDefinitions: [],
    };
    await saveTemplate(visual);
    expect(call).toHaveBeenCalledWith('saveTemplate', visual);
    const sent = call.mock.calls[0]![1] as Record<string, unknown>;
    expect('body' in sent).toBe(false);
    expect('html' in sent).toBe(false);
  });

  it('previewEmailTemplate calls the callable by name and returns its four fields', async () => {
    const res = { subject: 'S', html: '<html></html>', text: 'T', issues: [] };
    call.mockResolvedValue(res);
    const req = { subject: 'S', headline: 'H', content: '<p>x</p>', catalogKey: 'auth.password.reset' };
    await expect(previewEmailTemplate(req)).resolves.toEqual(res);
    expect(call).toHaveBeenCalledWith('previewEmailTemplate', req);
  });

  it('convertTemplateToVisual sends only the templateId and returns both outcomes as-is', async () => {
    call.mockResolvedValueOnce({ ok: true, subject: 'S', headline: 'H', content: '<p>x</p>' });
    await expect(convertTemplateToVisual('a.b')).resolves.toEqual({ ok: true, subject: 'S', headline: 'H', content: '<p>x</p>' });
    expect(call).toHaveBeenCalledWith('convertTemplateToVisual', { templateId: 'a.b' });
    call.mockResolvedValueOnce({ ok: false, reason: 'unreadable', subject: 'S', body: 'B' });
    await expect(convertTemplateToVisual('a.b')).resolves.toEqual({ ok: false, reason: 'unreadable', subject: 'S', body: 'B' });
  });
});
```

Create `src/api/emailImageUpload.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  requestSignedUpload: vi.fn(),
  uploadToCloudinary: vi.fn(),
  writeMediaFileDoc: vi.fn(),
}));
vi.mock('./mediaUpload', () => ({ ...m, BUSINESS_ENTITY_ID: 'business_settings' }));

import { EMAIL_IMAGE_MAX_BYTES, emailImageFileError, uploadEmailImage } from './emailImageUpload';

const SIGN = { cloudName: 'tribetails', folder: 'tribetails/business/business_settings' };
const URL_OK = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/pup.jpg';
const png = (bytes = 1000) => Object.defineProperty(new File(['x'], 'pup.png', { type: 'image/png' }), 'size', { value: bytes });

beforeEach(() => {
  m.requestSignedUpload.mockResolvedValue(SIGN);
  m.uploadToCloudinary.mockResolvedValue({ secureUrl: URL_OK, publicId: 'p', resourceType: 'image', format: 'jpg', bytes: 1000 });
  m.writeMediaFileDoc.mockResolvedValue('doc1');
});

describe('emailImageFileError', () => {
  it('accepts a normal photo', () => {
    expect(emailImageFileError({ type: 'image/jpeg', size: 200_000 })).toBeNull();
  });
  it('refuses a PDF, naming the formats it takes', () => {
    expect(emailImageFileError({ type: 'application/pdf', size: 1000 })).toBe('Pick a JPG, PNG, GIF or WebP image.');
  });
  it('refuses an image over the limit, saying how big it is', () => {
    expect(emailImageFileError({ type: 'image/png', size: 12 * 1024 * 1024 })).toBe('That image is 12.0 MB. Pick one under 5 MB.');
    expect(emailImageFileError({ type: 'image/png', size: EMAIL_IMAGE_MAX_BYTES })).toBeNull();
  });
});

describe('uploadEmailImage', () => {
  it('signs for the business folder, uploads, records it in the gallery, and returns the delivery URL', async () => {
    const stages: string[] = [];
    await expect(uploadEmailImage(png(), (s) => stages.push(s))).resolves.toBe(URL_OK);
    expect(m.requestSignedUpload).toHaveBeenCalledWith('BUSINESS', 'business_settings', 'image');
    expect(m.writeMediaFileDoc).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'BUSINESS', entityId: 'business_settings', originalFileName: 'pup.png', cloudName: 'tribetails' }),
    );
    expect(stages).toEqual(['signing', 'uploading', 'saving']);
  });

  it('refuses a bad file before signing anything', async () => {
    await expect(uploadEmailImage(png(12 * 1024 * 1024))).rejects.toThrow('That image is 12.0 MB. Pick one under 5 MB.');
    expect(m.requestSignedUpload).not.toHaveBeenCalled();
  });

  it('refuses a URL outside the image delivery path rather than inserting something the server will strip', async () => {
    m.uploadToCloudinary.mockResolvedValue({ secureUrl: 'https://res.cloudinary.com/tribetails/raw/upload/x.png', publicId: 'p', resourceType: 'raw', format: '', bytes: 1 });
    await expect(uploadEmailImage(png())).rejects.toThrow('Cloudinary did not store this file as an image.');
    expect(m.writeMediaFileDoc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify they fail.**
Run: `npx vitest run src/api/templatesWrite.test.ts src/api/emailImageUpload.test.ts`
Expected: FAIL (missing exports / missing module).

- [ ] **Step 4: Implement.** In `templatesWrite.ts`, change the import to `import type { SaveTemplatePayload, SaveVisualTemplatePayload } from '../lib/templateFormat';`, change `saveTemplate`'s signature and call to:

```ts
export async function saveTemplate(
  payload: SaveTemplatePayload | SaveVisualTemplatePayload,
): Promise<{ templateId: string }> {
  const result = await call<SaveTemplatePayload | SaveVisualTemplatePayload, { templateId: string }>('saveTemplate', payload);
  return result;
}
```

and append:

```ts
/** #953: `previewEmailTemplate` (admin). Same sanitizer, frame and renderer as a real send. */
export interface PreviewEmailTemplateRequest {
  subject: string;
  headline: string;
  content: string;
  /** The notification key whose fields get sample values. Omitted when no notification sends the template. */
  catalogKey?: string;
}

export interface PreviewEmailTemplateResult {
  subject: string;
  html: string;
  text: string;
  /** Sanitizer findings, as sentences. Empty when the content is clean. */
  issues: string[];
}

export async function previewEmailTemplate(req: PreviewEmailTemplateRequest): Promise<PreviewEmailTemplateResult> {
  return await call<PreviewEmailTemplateRequest, PreviewEmailTemplateResult>('previewEmailTemplate', req);
}

/**
 * #953: `convertTemplateToVisual` (admin, PR 3). Reads the stored old-format
 * template and returns the visual form. It never writes: the operator's Save
 * is the only write.
 */
export type ConvertTemplateResult =
  | { ok: true; subject: string; headline: string; content: string }
  | { ok: false; reason: 'unreadable'; subject: string; body: string };

export async function convertTemplateToVisual(templateId: string): Promise<ConvertTemplateResult> {
  return await call<{ templateId: string }, ConvertTemplateResult>('convertTemplateToVisual', { templateId });
}
```

Create `src/api/emailImageUpload.ts`:

```ts
import {
  BUSINESS_ENTITY_ID,
  requestSignedUpload,
  uploadToCloudinary,
  writeMediaFileDoc,
  type UploadStage,
} from './mediaUpload';
import { CLOUDINARY_IMAGE } from '../lib/emailContent';

/**
 * #953: images for email templates. The same sign, upload, record pipeline as
 * the gallery (`mediaUpload.ts`), filed under the business so the image also
 * shows in Gallery. `uploadMediaFile` returns the gallery doc id, and an email
 * needs the delivery URL, so the three steps are composed here instead.
 *
 * 5 MB, not Cloudinary's limit: an email is read on phones over mobile data,
 * and a photo larger than this is almost always a camera original nobody
 * meant to send.
 */
export const EMAIL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const EMAIL_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/i;

export function emailImageFileError(file: { type: string; size: number }): string | null {
  if (!EMAIL_IMAGE_TYPES.test(file.type)) return 'Pick a JPG, PNG, GIF or WebP image.';
  if (file.size > EMAIL_IMAGE_MAX_BYTES) {
    return `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Pick one under 5 MB.`;
  }
  return null;
}

export async function uploadEmailImage(file: File, onStage?: (stage: UploadStage) => void): Promise<string> {
  const problem = emailImageFileError(file);
  if (problem) throw new Error(problem);
  onStage?.('signing');
  const sign = await requestSignedUpload('BUSINESS', BUSINESS_ENTITY_ID, 'image');
  onStage?.('uploading');
  const cloud = await uploadToCloudinary(file, sign);
  // The server's allowlist keeps only images on the image delivery path, so an
  // upload Cloudinary filed as `raw` would be stripped on save. Say so now.
  if (!CLOUDINARY_IMAGE.test(cloud.secureUrl)) {
    throw new Error('Cloudinary did not store this file as an image. Pick a JPG, PNG, GIF or WebP image.');
  }
  onStage?.('saving');
  await writeMediaFileDoc({
    entityId: BUSINESS_ENTITY_ID,
    entityType: 'BUSINESS',
    originalFileName: file.name,
    cloud,
    cloudName: sign.cloudName,
  });
  return cloud.secureUrl;
}
```

- [ ] **Step 5: Run to verify they pass.**
Run: `npx vitest run src/api/templatesWrite.test.ts src/api/emailImageUpload.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit** (`Add the preview, convert and email image API wrappers (#953)`).

---

### Task 5: Visual form helpers and the field lookup

**Files:**
- Modify: `auntieos-admin/src/lib/templateFormat.ts`
- Modify: `auntieos-admin/src/lib/templateFormat.test.ts`

**Interfaces:**
- Consumes: `hasTextBlock` (Task 2); `SaveVisualTemplatePayload` (Task 4); `NotificationCatalogEntry` (`api/myNotifications.ts`); `TemplateSummary.format/headline/content` (Task 1).
- Produces: `TemplateFormFields.headline`, `TemplateFormFields.content`, `isOldFormat`, `visualFormError`, `buildVisualSavePayload`, `TemplateFieldSet`, `fieldsForTemplate`.

- [ ] **Step 1: Write the failing tests.** Append to `templateFormat.test.ts` (add the new names to its import from `./templateFormat`):

```ts
describe('#953 visual templates', () => {
  const visualFields = (over: Partial<TemplateFormFields> = {}): TemplateFormFields => ({
    ...blankFormFields(),
    templateId: 'auth.password.reset',
    subject: 'Reset your password',
    headline: 'Reset your password',
    content: '<p>Hi {{displayName}}</p>',
    ...over,
  });

  it('isOldFormat is true unless the template says visual', () => {
    expect(isOldFormat({})).toBe(true);
    expect(isOldFormat({ format: 'visual' })).toBe(false);
  });

  it('templateToFormFields carries headline and content, defaulting to empty', () => {
    const base = { templateId: 't', subject: 's', body: '', html: null, title: 't', description: null, tags: [], category: null, usageInstructions: '', sectionDefinitions: [] };
    expect(templateToFormFields({ ...base, format: 'visual', headline: 'H', content: '<p>x</p>' })).toMatchObject({ headline: 'H', content: '<p>x</p>' });
    expect(templateToFormFields(base)).toMatchObject({ headline: '', content: '' });
  });

  it('visualFormError checks key (create only), subject, headline, then content', () => {
    expect(visualFormError(visualFields({ templateId: '' }), { isCreate: true })).toBe('Template key is required.');
    expect(visualFormError(visualFields({ templateId: '' }), { isCreate: false })).toBeNull();
    expect(visualFormError(visualFields({ subject: ' ' }), { isCreate: false })).toBe('Subject is required.');
    expect(visualFormError(visualFields({ headline: ' ' }), { isCreate: false })).toBe('Headline is required.');
    expect(visualFormError(visualFields({ content: '<p> </p>' }), { isCreate: false })).toBe('The email needs some content.');
    expect(visualFormError(visualFields(), { isCreate: true })).toBeNull();
  });

  it('buildVisualSavePayload is the PR 2 shape exactly: format visual, no body or html keys', () => {
    const p = buildVisualSavePayload(visualFields({ title: ' Reset ', tagsInput: 'auth, reset', category: '' }), { isCreate: true });
    expect(p).toEqual({
      templateId: 'auth.password.reset',
      subject: 'Reset your password',
      format: 'visual',
      headline: 'Reset your password',
      content: '<p>Hi {{displayName}}</p>',
      title: 'Reset',
      tags: ['auth', 'reset'],
      usageInstructions: '',
      sectionDefinitions: [],
      expectNew: true,
    });
    expect('body' in p).toBe(false);
    expect('html' in p).toBe(false);
  });

  it('fieldsForTemplate unions the fields of every notification that sends this template', () => {
    const catalog = [
      { key: 'auth.password.reset', templates: { email: 'auth.password.reset' }, mergeFields: ['link', 'displayName'] },
      { key: 'other', templates: { email: 'auth.password.reset' }, mergeFields: ['email'] },
      { key: 'unrelated', templates: { email: 'x' }, mergeFields: ['nope'] },
    ];
    expect(fieldsForTemplate(catalog, 'auth.password.reset', [])).toEqual({
      catalogKey: 'auth.password.reset',
      fields: ['displayName', 'email', 'link'],
      source: 'catalog',
    });
  });

  it('fieldsForTemplate falls back to the fields the template already uses when no notification sends it', () => {
    expect(fieldsForTemplate([], 'invite.kinfolk', ['inviteLink', 'businessName'])).toEqual({
      catalogKey: null,
      fields: ['businessName', 'inviteLink'],
      source: 'template',
    });
  });
});
```

Also update the two existing expectations in this file that compare `templateToFormFields(...)` or `blankFormFields()` with `toEqual` against a full object: add `headline: ''` and `content: ''` to each expected object. That records the two new fields; it removes no check.

- [ ] **Step 2: Run to verify it fails.**
Run: `npx vitest run src/lib/templateFormat.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** in `templateFormat.ts`:
  - Add `import { hasTextBlock } from './emailContent';` and `import type { NotificationCatalogEntry } from '../api/myNotifications';` at the top.
  - Add to `TemplateFormFields`:

```ts
  /** #953, visual templates: the frame's header-bar line. `''` on an old-format template. */
  headline: string;
  /** #953, visual templates: the stored content fragment the editor reads and writes. `''` on an old-format template. */
  content: string;
```

  - In `templateToFormFields` add `headline: tpl.headline ?? '',` and `content: tpl.content ?? '',`. In `blankFormFields` add `headline: '',` and `content: '',`.
  - Append:

```ts
// ── #953 visual templates ───────────────────────────────────────────────────

/** Old format = anything not marked visual. The Template Bank badges these; the editor offers Convert. */
export function isOldFormat(tpl: Pick<TemplateSummary, 'format'>): boolean {
  return tpl.format !== 'visual';
}

/** The single blocking error for a visual template, or null. Same order and key rules as `templateFormError`. */
export function visualFormError(
  fields: Pick<TemplateFormFields, 'templateId' | 'subject' | 'headline' | 'content'>,
  opts: { isCreate: boolean },
): string | null {
  if (opts.isCreate) {
    const idError = templateIdError(fields.templateId);
    if (idError) return idError;
  }
  if (fields.subject.trim() === '') return 'Subject is required.';
  if (fields.headline.trim() === '') return 'Headline is required.';
  if (!hasTextBlock(fields.content)) return 'The email needs some content.';
  return null;
}

/** The exact visual `saveTemplate` payload. Optional-field rules match `buildSaveTemplatePayload`. */
export function buildVisualSavePayload(
  fields: TemplateFormFields,
  opts: { isCreate?: boolean } = {},
): SaveVisualTemplatePayload {
  const title = fields.title.trim();
  const description = fields.description.trim();
  const category = fields.category.trim();
  return {
    templateId: fields.templateId.trim(),
    subject: fields.subject.trim(),
    format: 'visual',
    headline: fields.headline.trim(),
    content: fields.content,
    ...(title !== '' ? { title } : {}),
    ...(description !== '' ? { description } : {}),
    ...(category !== '' ? { category } : {}),
    tags: parseTagsInput(fields.tagsInput),
    usageInstructions: fields.usageInstructions.trim(),
    sectionDefinitions: parseSections(fields.sections),
    ...(opts.isCreate ? { expectNew: true } : {}),
  };
}

export interface TemplateFieldSet {
  /** The notification key the preview samples, or null when no notification sends this template. */
  catalogKey: string | null;
  fields: string[];
  /** Where `fields` came from: the notification catalog, or the template's own existing tokens. */
  source: 'catalog' | 'template';
}

/**
 * The merge fields "Insert field" offers. A notification row names the
 * template that actually renders its email after bindings (`templates.email`),
 * and `mergeFields` is `TEMPLATE_FIELDS[key]` projected by the server. When no
 * notification sends the template (invites and recovery go through
 * `sendFromTemplate` by key), the only honest list is the fields the template
 * already uses.
 */
export function fieldsForTemplate(
  catalog: ReadonlyArray<Pick<NotificationCatalogEntry, 'key' | 'templates' | 'mergeFields'>>,
  templateId: string,
  alreadyUsed: readonly string[],
): TemplateFieldSet {
  const id = templateId.trim();
  const matches = catalog.filter((entry) => entry.templates['email'] === id);
  if (matches.length === 0) {
    return { catalogKey: null, fields: [...new Set(alreadyUsed)].sort(), source: 'template' };
  }
  return {
    catalogKey: matches[0]!.key,
    fields: [...new Set(matches.flatMap((entry) => [...entry.mergeFields]))].sort(),
    source: 'catalog',
  };
}
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run src/lib/templateFormat.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean. `tsc` will now flag every `TemplateFormFields` literal elsewhere; the only producers are `templateToFormFields` and `blankFormFields`, so it should be clean. If a test fixture builds one by hand, add the two fields to it.

- [ ] **Step 5: Commit** (`Add the visual template form helpers and field lookup (#953)`).

---

### Task 6: Debounced preview and the preview pane

**Files:**
- Create: `auntieos-admin/src/lib/useEmailPreview.ts`
- Create: `auntieos-admin/src/components/emailEditor/EmailPreviewPane.tsx`
- Create: `auntieos-admin/src/components/emailEditor/EmailPreviewPane.css`
- Test: `auntieos-admin/src/components/emailEditor/EmailPreviewPane.test.tsx`

**Interfaces:**
- Consumes: `previewEmailTemplate`, `PreviewEmailTemplateRequest`, `PreviewEmailTemplateResult` (Task 4); `LoadingRow`, `Banner`, `GhostButton`.
- Produces: `PREVIEW_DEBOUNCE_MS`, `EmailPreviewState`, `useEmailPreview(req) -> { state, retry }`; `EmailPreviewPane({ state, onRetry, label? })`.

- [ ] **Step 1: Write the failing test** `EmailPreviewPane.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const { previewEmailTemplate } = vi.hoisted(() => ({ previewEmailTemplate: vi.fn() }));
vi.mock('../../api/templatesWrite', () => ({ previewEmailTemplate }));

import { EmailPreviewPane } from './EmailPreviewPane';
import { PREVIEW_DEBOUNCE_MS, useEmailPreview } from '../../lib/useEmailPreview';
import type { PreviewEmailTemplateRequest } from '../../api/templatesWrite';

function Harness({ req }: { req: PreviewEmailTemplateRequest | null }) {
  const { state, retry } = useEmailPreview(req);
  return <EmailPreviewPane state={state} onRetry={retry} />;
}
const REQ = { subject: 'Hi', headline: 'H', content: '<p>x</p>' };
const RES = { subject: 'Hi Pat', html: '<html><body><h2>H</h2></body></html>', text: 'H\n\nx', issues: [] as string[] };
const pane = () => screen.getByRole('region', { name: 'Preview' });
const tick = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EmailPreviewPane with useEmailPreview', () => {
  it('shows a prompt and calls nothing while there is nothing to preview', async () => {
    render(<Harness req={null} />);
    await tick(PREVIEW_DEBOUNCE_MS * 2);
    expect(screen.getByText('Add a headline and some content to see the email.')).toBeInTheDocument();
    expect(previewEmailTemplate).not.toHaveBeenCalled();
  });

  it('shows the loading cue at once and through a slow answer, then the framed email', async () => {
    let resolve: (r: typeof RES) => void = () => {};
    previewEmailTemplate.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness req={REQ} />);
    expect(pane()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByText('Updating preview…').length).toBeGreaterThan(0);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(previewEmailTemplate).toHaveBeenCalledWith(REQ);
    await tick(10_000);
    expect(pane()).toHaveAttribute('aria-busy', 'true');
    await act(async () => resolve(RES));
    expect(pane()).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByTitle('The email as it will be sent')).toHaveAttribute('srcdoc', RES.html);
    expect(screen.getByText('Hi Pat')).toBeInTheDocument();
    // The text part sits in a closed <details>; jsdom cannot judge visibility,
    // so assert the carrier and the content, not toBeVisible.
    const details = screen.getByText('Plain-text version').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe('H\n\nx');
  });

  it('debounces: typing bursts send one request, for the latest input', async () => {
    previewEmailTemplate.mockResolvedValue(RES);
    const { rerender } = render(<Harness req={REQ} />);
    await tick(100);
    rerender(<Harness req={{ ...REQ, headline: 'H2' }} />);
    await tick(100);
    rerender(<Harness req={{ ...REQ, headline: 'H3' }} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(previewEmailTemplate).toHaveBeenCalledTimes(1);
    expect(previewEmailTemplate).toHaveBeenCalledWith({ ...REQ, headline: 'H3' });
  });

  it('a late answer to an older request never replaces a newer one', async () => {
    const answers: Array<(r: typeof RES) => void> = [];
    previewEmailTemplate.mockImplementation(() => new Promise((r) => answers.push(r)));
    const { rerender } = render(<Harness req={REQ} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    rerender(<Harness req={{ ...REQ, headline: 'New' }} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    await act(async () => answers[1]!({ ...RES, subject: 'Newest' }));
    await act(async () => answers[0]!({ ...RES, subject: 'Stale' }));
    expect(screen.getByText('Newest')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('shows a failure with Try again, which asks again', async () => {
    previewEmailTemplate.mockRejectedValueOnce(new Error('previewEmailTemplate took too long to respond.'));
    render(<Harness req={REQ} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(screen.getByText('Couldn’t update the preview')).toBeInTheDocument();
    expect(screen.getByText('previewEmailTemplate took too long to respond.')).toBeInTheDocument();
    previewEmailTemplate.mockResolvedValueOnce(RES);
    await act(async () => screen.getByRole('button', { name: 'Try again' }).click());
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(previewEmailTemplate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Hi Pat')).toBeInTheDocument();
  });

  it('lists the problems the server found', async () => {
    previewEmailTemplate.mockResolvedValue({ ...RES, issues: ['A merge field was broken apart by formatting. Retype it as one piece.'] });
    render(<Harness req={REQ} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(screen.getByText('Problems found')).toBeInTheDocument();
    expect(screen.getByText('A merge field was broken apart by formatting. Retype it as one piece.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `npx vitest run src/components/emailEditor/EmailPreviewPane.test.tsx`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement** `src/lib/useEmailPreview.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  previewEmailTemplate,
  type PreviewEmailTemplateRequest,
  type PreviewEmailTemplateResult,
} from '../api/templatesWrite';

/**
 * #953: the preview beside the editor, refreshed through the server so it is
 * the email that will be sent. Debounced so a typing burst is one request; a
 * sequence number drops any answer that arrives after a newer request was
 * made, so a slow old answer can never paint over the current text. The last
 * good preview stays on screen while the next one loads.
 */
export const PREVIEW_DEBOUNCE_MS = 500;

export type EmailPreviewState =
  | { status: 'empty' }
  | { status: 'loading'; last: PreviewEmailTemplateResult | null }
  | { status: 'ready'; result: PreviewEmailTemplateResult }
  | { status: 'error'; message: string; last: PreviewEmailTemplateResult | null };

function lastOf(state: EmailPreviewState): PreviewEmailTemplateResult | null {
  if (state.status === 'ready') return state.result;
  if (state.status === 'loading' || state.status === 'error') return state.last;
  return null;
}

export function useEmailPreview(req: PreviewEmailTemplateRequest | null): {
  state: EmailPreviewState;
  retry: () => void;
} {
  const [state, setState] = useState<EmailPreviewState>({ status: 'empty' });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const key = req ? JSON.stringify(req) : null;

  useEffect(() => {
    const mine = ++seq.current;
    if (key === null) {
      setState({ status: 'empty' });
      return;
    }
    setState((prev) => ({ status: 'loading', last: lastOf(prev) }));
    const timer = setTimeout(() => {
      previewEmailTemplate(JSON.parse(key) as PreviewEmailTemplateRequest).then(
        (result) => {
          if (seq.current === mine) setState({ status: 'ready', result });
        },
        (err: unknown) => {
          if (seq.current !== mine) return;
          const message = err instanceof Error ? err.message : 'The preview did not load.';
          setState((prev) => ({ status: 'error', message, last: lastOf(prev) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
```

`src/components/emailEditor/EmailPreviewPane.tsx`:

```tsx
import type { EmailPreviewState } from '../../lib/useEmailPreview';
import { LoadingRow } from '../LoadingRow';
import { Banner } from '../Banner';
import { GhostButton } from '../Buttons';
import './EmailPreviewPane.css';

export interface EmailPreviewPaneProps {
  state: EmailPreviewState;
  onRetry: () => void;
  /** The region's name. "Preview" beside the editor; "Converted email" in the Convert view. */
  label?: string | undefined;
}

/**
 * #953: the server-rendered email. The HTML goes in a sandboxed iframe with
 * no permissions, so the frame's styles cannot leak into the admin and nothing
 * in the email can run.
 */
export function EmailPreviewPane({ state, onRetry, label = 'Preview' }: EmailPreviewPaneProps) {
  const shown = state.status === 'ready' ? state.result : state.status === 'empty' ? null : state.last;
  const loading = state.status === 'loading';
  return (
    <section className="email-preview" aria-label={label} aria-busy={loading}>
      <span className="email-preview__label">{label}</span>
      {loading ? <LoadingRow label="Updating preview…" className="email-preview__loading" /> : null}
      {state.status === 'error' ? (
        <Banner tone="error" title="Couldn’t update the preview" trailing={<GhostButton label="Try again" onClick={onRetry} />}>
          {state.message}
        </Banner>
      ) : null}
      {state.status === 'empty' ? (
        <p className="email-preview__empty">Add a headline and some content to see the email.</p>
      ) : null}
      {shown ? (
        <>
          <p className="email-preview__subject">
            <span className="email-preview__subject-label">Subject:</span> <span>{shown.subject}</span>
          </p>
          <iframe className="email-preview__frame" title="The email as it will be sent" sandbox="" srcDoc={shown.html} />
          {shown.issues.length > 0 ? (
            <div className="email-preview__issues" role="status">
              <span className="email-preview__issues-title">Problems found</span>
              <ul>
                {shown.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="email-preview__text">
            <summary>Plain-text version</summary>
            <pre>{shown.text}</pre>
          </details>
        </>
      ) : null}
    </section>
  );
}
```

`EmailPreviewPane.css` (tokens are the ones `TemplateEditor.css` already uses; open that file and copy its variable names for the label, rule and warning colours if these differ):

```css
.email-preview { display: flex; flex-direction: column; gap: 10px; }
.email-preview__label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.email-preview__subject { margin: 0; font-size: 14px; }
.email-preview__subject-label { color: var(--text-muted); margin-right: 4px; }
.email-preview__frame { width: 100%; min-height: 520px; border: 1px solid var(--hairline); border-radius: 10px; background: #fbfbf9; }
.email-preview__empty { margin: 0; color: var(--text-muted); font-size: 14px; }
.email-preview__issues { border-left: 3px solid var(--warning); padding: 6px 10px; font-size: 13px; }
.email-preview__issues ul { margin: 4px 0 0; padding-left: 18px; }
.email-preview__issues-title { font-weight: 600; }
.email-preview__text pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; margin: 8px 0 0; }
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run src/components/emailEditor/EmailPreviewPane.test.tsx && npx tsc --noEmit`
Expected: PASS (6 tests), tsc clean.

- [ ] **Step 5: Commit** (`Add the debounced email preview pane (#953)`).

---

### Task 7: Editor dialogs: link and button targets, image upload, insert field

**Files:**
- Create: `auntieos-admin/src/components/emailEditor/EmailEditorDialogs.tsx`
- Test: `auntieos-admin/src/components/emailEditor/EmailEditorDialogs.test.tsx`

**Interfaces:**
- Consumes: `normalizeWebTarget`, `fieldNameOf` (Task 2); `uploadEmailImage`, `emailImageFileError` (Task 4); `UploadStage` (`api/mediaUpload.ts`); `Dialog`, `LoadingRow`, `PrimaryButton`, `GhostButton`.
- Produces: `TargetDialog`, `TargetValue`, `ImageDialog`, `FieldDialog`.

- [ ] **Step 1: Write the failing test** `EmailEditorDialogs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { uploadEmailImage } = vi.hoisted(() => ({ uploadEmailImage: vi.fn() }));
vi.mock('../../api/emailImageUpload', async (orig) => ({
  ...(await orig<typeof import('../../api/emailImageUpload')>()),
  uploadEmailImage,
}));

import { FieldDialog, ImageDialog, TargetDialog } from './EmailEditorDialogs';

const file = (name: string, type: string, bytes: number) =>
  Object.defineProperty(new File(['x'], name, { type }), 'size', { value: bytes });

describe('TargetDialog (Button)', () => {
  it('builds a button to a web address, adding https to a bare domain', async () => {
    const onSubmit = vi.fn();
    render(<TargetDialog title="Button" withLabel allowMailto={false} fields={['link']} initial={{ label: '', href: '' }} onSubmit={onSubmit} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Button text'), 'Book a visit');
    await userEvent.type(screen.getByLabelText('Address'), 'tribetails.com/book');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ label: 'Book a visit', href: 'https://tribetails.com/book' });
  });

  it('builds a button to a merge field', async () => {
    const onSubmit = vi.fn();
    render(<TargetDialog title="Button" withLabel allowMailto={false} fields={['displayName', 'link']} initial={{ label: 'Reset', href: '' }} onSubmit={onSubmit} onClose={vi.fn()} />);
    await userEvent.click(screen.getByLabelText('A merge field'));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'link');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ label: 'Reset', href: '{{link}}' });
  });

  it('opens on an existing button with its field selected', () => {
    render(<TargetDialog title="Button" withLabel allowMailto={false} fields={['displayName']} initial={{ label: 'Go', href: '{{link}}' }} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('A merge field')).toBeChecked();
    expect(screen.getByLabelText('Field')).toHaveValue('link');
  });

  it('refuses plain http and an empty label, saying what to do', async () => {
    const onSubmit = vi.fn();
    render(<TargetDialog title="Button" withLabel allowMailto={false} fields={[]} initial={{ label: '', href: '' }} onSubmit={onSubmit} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type the button text.');
    await userEvent.type(screen.getByLabelText('Button text'), 'Go');
    await userEvent.type(screen.getByLabelText('Address'), 'http://tribetails.com');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type a web address starting with https://.');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('A merge field')).toBeDisabled();
  });
});

describe('TargetDialog (Link)', () => {
  it('takes an email address as mailto, and offers Remove link when editing one', async () => {
    const onSubmit = vi.fn();
    const onRemove = vi.fn();
    render(<TargetDialog title="Link" withLabel={false} allowMailto fields={[]} initial={{ label: '', href: 'https://old.com' }} onSubmit={onSubmit} onRemove={onRemove} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Button text')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Address'));
    await userEvent.type(screen.getByLabelText('Address'), 'auntie@tribetails.com');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ label: '', href: 'mailto:auntie@tribetails.com' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('ImageDialog', () => {
  // applyAccept: false, so a PDF reaches the input the way a drag-drop or a
  // browser that ignores `accept` would deliver it.
  const user = () => userEvent.setup({ applyAccept: false });

  it('refuses a PDF before uploading anything', async () => {
    render(<ImageDialog onInsert={vi.fn()} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('menu.pdf', 'application/pdf', 1000));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a JPG, PNG, GIF or WebP image.');
    await user().type(screen.getByLabelText('Description'), 'Menu');
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(uploadEmailImage).not.toHaveBeenCalled();
  });

  it('refuses a 12 MB photo before uploading anything', async () => {
    render(<ImageDialog onInsert={vi.fn()} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('huge.jpg', 'image/jpeg', 12 * 1024 * 1024));
    expect(screen.getByRole('alert')).toHaveTextContent('That image is 12.0 MB. Pick one under 5 MB.');
    expect(uploadEmailImage).not.toHaveBeenCalled();
  });

  it('shows each upload stage, then inserts the image with its description', async () => {
    let finish: (url: string) => void = () => {};
    uploadEmailImage.mockImplementation((_f: File, onStage: (s: string) => void) => {
      onStage('uploading');
      return new Promise((r) => { finish = r; });
    });
    const onInsert = vi.fn();
    render(<ImageDialog onInsert={onInsert} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('pup.png', 'image/png', 1000));
    await user().type(screen.getByLabelText('Description'), 'Two dogs on a walk');
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(screen.getAllByText('Uploading image…').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish('https://res.cloudinary.com/t/image/upload/pup.png');
    await vi.waitFor(() => expect(onInsert).toHaveBeenCalledWith({ src: 'https://res.cloudinary.com/t/image/upload/pup.png', alt: 'Two dogs on a walk' }));
  });

  it('a failed upload says so and inserts nothing', async () => {
    uploadEmailImage.mockRejectedValue(new Error('Upload signing failed (HTTP 500): boom'));
    const onInsert = vi.fn();
    render(<ImageDialog onInsert={onInsert} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('pup.png', 'image/png', 1000));
    await user().type(screen.getByLabelText('Description'), 'Pup');
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The upload didn’t finish: Upload signing failed (HTTP 500): boom');
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Upload and insert' })).toBeEnabled();
  });
});

describe('FieldDialog', () => {
  it('lists the fields and picks one', async () => {
    const onPick = vi.fn();
    render(<FieldDialog fields={['displayName', 'link']} state="ready" note={undefined} onPick={onPick} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '{{link}}' }));
    expect(onPick).toHaveBeenCalledWith('link');
  });

  it('shows a loading cue while the fields load', () => {
    render(<FieldDialog fields={[]} state="loading" note={undefined} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText('Loading fields…').length).toBeGreaterThan(0);
  });

  it('says so when the fields could not load', () => {
    render(<FieldDialog fields={['inviteLink']} state="error" note={undefined} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this template’s fields. These are the fields it already uses.');
    expect(screen.getByRole('button', { name: '{{inviteLink}}' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `npx vitest run src/components/emailEditor/EmailEditorDialogs.test.tsx`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement** `EmailEditorDialogs.tsx`:

```tsx
import { useState } from 'react';
import { Dialog } from '../Dialog';
import { GhostButton, PrimaryButton } from '../Buttons';
import { LoadingRow } from '../LoadingRow';
import { fieldNameOf, normalizeWebTarget } from '../../lib/emailContent';
import { emailImageFileError, uploadEmailImage } from '../../api/emailImageUpload';
import type { UploadStage } from '../../api/mediaUpload';

export interface TargetValue {
  label: string;
  href: string;
}

export interface TargetDialogProps {
  title: string;
  /** True for a button, which needs its own text. A link wraps the selected text instead. */
  withLabel: boolean;
  /** Links may send an email; buttons may not. */
  allowMailto: boolean;
  fields: readonly string[];
  initial: TargetValue;
  onSubmit: (value: TargetValue) => void;
  onRemove?: (() => void) | undefined;
  onClose: () => void;
}

export function TargetDialog({ title, withLabel, allowMailto, fields, initial, onSubmit, onRemove, onClose }: TargetDialogProps) {
  const initialField = fieldNameOf(initial.href);
  const options = initialField && !fields.includes(initialField) ? [initialField, ...fields] : [...fields];
  const [label, setLabel] = useState(initial.label);
  const [kind, setKind] = useState<'web' | 'field'>(initialField ? 'field' : 'web');
  const [web, setWeb] = useState(initialField ? '' : initial.href);
  const [field, setField] = useState(initialField ?? options[0] ?? '');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (withLabel && label.trim() === '') {
      setError('Type the button text.');
      return;
    }
    const href = kind === 'field' ? (field ? `{{${field}}}` : null) : normalizeWebTarget(web, allowMailto);
    if (href === null) {
      setError(
        kind === 'field'
          ? 'Pick a field.'
          : allowMailto
            ? 'Type a web address starting with https://, or an email address.'
            : 'Type a web address starting with https://.',
      );
      return;
    }
    onSubmit({ label: label.trim(), href });
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          {onRemove ? <GhostButton label="Remove link" onClick={onRemove} /> : null}
          <GhostButton label="Cancel" onClick={onClose} />
          <PrimaryButton label="Done" onClick={submit} />
        </>
      }
    >
      {error ? <p className="email-editor__error" role="alert">{error}</p> : null}
      {withLabel ? (
        <label className="email-editor__dlabel">
          Button text
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </label>
      ) : null}
      <fieldset className="email-editor__target">
        <legend>Goes to</legend>
        <label>
          <input type="radio" name="email-target-kind" checked={kind === 'web'} onChange={() => setKind('web')} /> A web address
        </label>
        <label>
          <input
            type="radio"
            name="email-target-kind"
            checked={kind === 'field'}
            disabled={options.length === 0}
            onChange={() => setKind('field')}
          />{' '}
          A merge field
        </label>
        {kind === 'web' ? (
          <label className="email-editor__dlabel">
            Address
            <input type="text" inputMode="url" value={web} onChange={(e) => setWeb(e.target.value)} placeholder="https://tribetails.com" />
          </label>
        ) : (
          <label className="email-editor__dlabel">
            Field
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {options.map((name) => (
                <option key={name} value={name}>{`{{${name}}}`}</option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
    </Dialog>
  );
}

const STAGE_LABEL: Record<UploadStage, string> = {
  signing: 'Getting ready to upload…',
  uploading: 'Uploading image…',
  saving: 'Adding it to the gallery…',
};

export function ImageDialog({ onInsert, onClose }: { onInsert: (img: { src: string; alt: string }) => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null;

  function pick(next: File | null) {
    setFile(next);
    setError(next ? emailImageFileError(next) : null);
  }

  async function upload() {
    if (!file) {
      setError('Pick an image first.');
      return;
    }
    const problem = emailImageFileError(file);
    if (problem) {
      setError(problem);
      return;
    }
    if (alt.trim() === '') {
      setError('Describe the image in a few words.');
      return;
    }
    setError(null);
    setStage('signing');
    try {
      const src = await uploadEmailImage(file, setStage);
      onInsert({ src, alt: alt.trim() });
    } catch (err) {
      setStage(null);
      setError(`The upload didn’t finish: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  return (
    <Dialog
      title="Image"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton label={busy ? 'Uploading…' : 'Upload and insert'} onClick={() => void upload()} disabled={busy} busy={busy} />
        </>
      }
    >
      {error ? <p className="email-editor__error" role="alert">{error}</p> : null}
      <label className="email-editor__dlabel">
        Image file
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="email-editor__dlabel">
        Description
        <input type="text" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={200} disabled={busy} placeholder="Two dogs on a walk" />
      </label>
      {stage ? <LoadingRow label={STAGE_LABEL[stage]} /> : null}
    </Dialog>
  );
}

export interface FieldDialogProps {
  fields: readonly string[];
  state: 'loading' | 'ready' | 'error';
  note: string | undefined;
  onPick: (name: string) => void;
  onClose: () => void;
}

export function FieldDialog({ fields, state, note, onPick, onClose }: FieldDialogProps) {
  return (
    <Dialog title="Insert field" onClose={onClose} footer={<GhostButton label="Cancel" onClick={onClose} />}>
      {state === 'loading' ? <LoadingRow label="Loading fields…" /> : null}
      {state === 'error' ? (
        <p className="email-editor__error" role="alert">
          Couldn’t load this template’s fields. These are the fields it already uses.
        </p>
      ) : null}
      {note ? <p className="email-editor__note">{note}</p> : null}
      {state !== 'loading' && fields.length === 0 ? <p className="email-editor__note">There are no fields to insert.</p> : null}
      <div className="email-editor__fields" role="group" aria-label="Fields">
        {fields.map((name) => (
          <button key={name} type="button" className="email-editor__field" onClick={() => onPick(name)}>
            {`{{${name}}}`}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run src/components/emailEditor/EmailEditorDialogs.test.tsx && npx tsc --noEmit`
Expected: PASS (12 tests), tsc clean.

- [ ] **Step 5: Commit** (`Add the email editor dialogs: targets, image upload, fields (#953)`).

---

### Task 8: The editor component with its toolbar

**Files:**
- Create: `auntieos-admin/src/components/emailEditor/EmailContentEditor.tsx`
- Create: `auntieos-admin/src/components/emailEditor/EmailContentEditor.css`
- Test: `auntieos-admin/src/components/emailEditor/EmailContentEditor.test.tsx`

**Interfaces:**
- Consumes: `emailEditorExtensions` and its commands (Task 3); `fromEmailContent`, `toEmailContent` (Task 2); `TargetDialog`, `ImageDialog`, `FieldDialog` (Task 7).
- Produces: `EmailContentEditor({ initialContent, onChange, fields, fieldsState, fieldsNote?, disabled? })`. It reads `initialContent` once; a parent that needs to replace the content remounts it with a new `key`.

- [ ] **Step 1: Write the failing test.** Real TipTap mounted in jsdom (the Range stubs from Task 2 make that work). The editor instance is read off its DOM node, where TipTap stores it (`view.dom.editor`), to place the selection.

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';

vi.mock('../../api/emailImageUpload', async (orig) => ({
  ...(await orig<typeof import('../../api/emailImageUpload')>()),
  uploadEmailImage: vi.fn().mockResolvedValue('https://res.cloudinary.com/t/image/upload/pup.png'),
}));

import { EmailContentEditor } from './EmailContentEditor';

function setup(initialContent = '<p>word</p>', fields: string[] = ['displayName', 'link']) {
  const onChange = vi.fn();
  render(<EmailContentEditor initialContent={initialContent} onChange={onChange} fields={fields} fieldsState="ready" />);
  const dom = screen.getByRole('textbox', { name: 'Email content' }) as HTMLElement & { editor: Editor };
  const editor = dom.editor;
  const last = () => onChange.mock.calls.at(-1)?.[0] as string;
  return { editor, onChange, last };
}
const tool = (name: string) => screen.getByRole('button', { name });
const selectWord = (editor: Editor) => act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); });

describe('EmailContentEditor toolbar', () => {
  it('Bold and Italic wrap the selection and report pressed', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Bold'));
    await userEvent.click(tool('Italic'));
    expect(last()).toBe('<p><strong><em>word</em></strong></p>');
    expect(tool('Bold')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Heading and Subheading make h2 and h3', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Heading'));
    expect(last()).toBe('<h2>word</h2>');
    await userEvent.click(tool('Subheading'));
    expect(last()).toBe('<h3>word</h3>');
  });

  it('Bulleted list, Numbered list and Callout', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Bulleted list'));
    expect(last()).toBe('<ul><li>word</li></ul>');
    await userEvent.click(tool('Numbered list'));
    expect(last()).toBe('<ol><li>word</li></ol>');
    await userEvent.click(tool('Numbered list'));
    await userEvent.click(tool('Callout'));
    expect(last()).toBe('<blockquote><p>word</p></blockquote>');
  });

  it('Link is off until text is selected, then links it to a merge field', async () => {
    const { editor, last } = setup();
    expect(tool('Link')).toBeDisabled();
    selectWord(editor);
    await userEvent.click(tool('Link'));
    await userEvent.click(screen.getByLabelText('A merge field'));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'link');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(last()).toBe('<p><a href="{{link}}">word</a></p>');
  });

  it('Button inserts a button', async () => {
    const { editor, last } = setup();
    act(() => { editor.commands.setTextSelection(5); });
    await userEvent.click(tool('Button'));
    await userEvent.type(screen.getByLabelText('Button text'), 'Reset password');
    await userEvent.click(screen.getByLabelText('A merge field'));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'link');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(last()).toBe('<p>word</p><p><a href="{{link}}" class="button">Reset password</a></p>');
  });

  it('Image uploads and inserts', async () => {
    const { editor, last } = setup();
    act(() => { editor.commands.setTextSelection(5); });
    await userEvent.click(tool('Image'));
    await userEvent.upload(screen.getByLabelText('Image file'), new File(['x'], 'pup.png', { type: 'image/png' }));
    await userEvent.type(screen.getByLabelText('Description'), 'Pup');
    await userEvent.click(screen.getByRole('button', { name: 'Upload and insert' }));
    await vi.waitFor(() => expect(last()).toBe('<p>word</p><p><img src="https://res.cloudinary.com/t/image/upload/pup.png" alt="Pup"></p>'));
  });

  it('Insert field drops a chip that reads as the token', async () => {
    const { editor, last } = setup();
    act(() => { editor.commands.setTextSelection(5); });
    await userEvent.click(tool('Insert field'));
    await userEvent.click(screen.getByRole('button', { name: '{{displayName}}' }));
    expect(last()).toBe('<p>word{{displayName}}</p>');
    expect(screen.getByRole('textbox', { name: 'Email content' }).querySelector('.merge-chip')).toHaveTextContent('{{displayName}}');
  });

  it('loads stored content with chips and buttons in place', () => {
    setup('<p>Hi {{displayName}}</p><p><a href="{{link}}" class="button">Go</a></p>');
    const doc = screen.getByRole('textbox', { name: 'Email content' });
    expect(doc.querySelector('[data-merge-field="displayName"]')).not.toBeNull();
    expect(doc.querySelector('a.button')).toHaveTextContent('Go');
  });

  it('disabled locks the toolbar', () => {
    render(<EmailContentEditor initialContent="<p>x</p>" onChange={vi.fn()} fields={[]} fieldsState="ready" disabled />);
    expect(tool('Bold')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `npx vitest run src/components/emailEditor/EmailContentEditor.test.tsx`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement** `EmailContentEditor.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { emailEditorExtensions, type EmailButtonAttrs } from './extensions';
import { fromEmailContent, toEmailContent } from '../../lib/emailContent';
import { FieldDialog, ImageDialog, TargetDialog } from './EmailEditorDialogs';
import './EmailContentEditor.css';

type Panel = null | 'link' | 'button' | 'image' | 'field';

export interface EmailContentEditorProps {
  /** Stored content. Read once, at mount; remount with a new `key` to replace it. */
  initialContent: string;
  /** Called with stored-shape content after every change. */
  onChange: (content: string) => void;
  fields: readonly string[];
  fieldsState: 'loading' | 'ready' | 'error';
  fieldsNote?: string | undefined;
  disabled?: boolean | undefined;
}

/**
 * #953: the visual email editor. TipTap set up the way the portal's Messages
 * composer is (`mytribe/web/src/screens/Messages.tsx`), with the schema from
 * `extensions.ts`. It reports stored content, never editor HTML, so the
 * screen that holds it never has to know the difference.
 */
export function EmailContentEditor({
  initialContent,
  onChange,
  fields,
  fieldsState,
  fieldsNote,
  disabled = false,
}: EmailContentEditorProps) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const [panel, setPanel] = useState<Panel>(null);

  const editor = useEditor({
    extensions: emailEditorExtensions(),
    content: fromEmailContent(initialContent),
    editable: !disabled,
    onUpdate: ({ editor: e }) => onChangeRef.current(toEmailContent(e.getHTML())),
    editorProps: {
      attributes: { 'aria-label': 'Email content', role: 'textbox', 'aria-multiline': 'true', class: 'email-editor__doc' },
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            link: e.isActive('link'),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            callout: e.isActive('blockquote'),
            button: e.isActive('emailButton'),
            hasSelection: !e.state.selection.empty,
            linkHref: (e.getAttributes('link')['href'] as string | undefined) ?? '',
            buttonAttrs: e.getAttributes('emailButton') as Partial<EmailButtonAttrs>,
          }
        : null,
  });

  const run = (fn: (e: Editor) => void) => () => {
    if (editor) fn(editor);
  };
  const close = () => setPanel(null);

  const tools: Array<{ label: string; glyph: string; pressed?: boolean; off?: boolean; onClick: () => void }> = [
    { label: 'Bold', glyph: 'B', pressed: s?.bold ?? false, onClick: run((e) => e.chain().focus().toggleBold().run()) },
    { label: 'Italic', glyph: 'I', pressed: s?.italic ?? false, onClick: run((e) => e.chain().focus().toggleItalic().run()) },
    { label: 'Heading', glyph: 'H2', pressed: s?.h2 ?? false, onClick: run((e) => e.chain().focus().toggleHeading({ level: 2 }).run()) },
    { label: 'Subheading', glyph: 'H3', pressed: s?.h3 ?? false, onClick: run((e) => e.chain().focus().toggleHeading({ level: 3 }).run()) },
    { label: 'Bulleted list', glyph: '•', pressed: s?.bullet ?? false, onClick: run((e) => e.chain().focus().toggleBulletList().run()) },
    { label: 'Numbered list', glyph: '1.', pressed: s?.ordered ?? false, onClick: run((e) => e.chain().focus().toggleOrderedList().run()) },
    { label: 'Callout', glyph: '“', pressed: s?.callout ?? false, onClick: run((e) => e.chain().focus().toggleBlockquote().run()) },
    { label: 'Link', glyph: 'Link', pressed: s?.link ?? false, off: !(s?.hasSelection || s?.link), onClick: () => setPanel('link') },
    { label: 'Button', glyph: 'Button', pressed: s?.button ?? false, onClick: () => setPanel('button') },
    { label: 'Image', glyph: 'Image', onClick: () => setPanel('image') },
    { label: 'Insert field', glyph: '{{ }}', onClick: () => setPanel('field') },
  ];

  return (
    <div className="email-editor">
      <div className="email-editor__toolbar" role="toolbar" aria-label="Formatting">
        {tools.map((t) => (
          <button
            key={t.label}
            type="button"
            className="email-editor__tool"
            aria-label={t.label}
            title={t.label === 'Link' && t.off ? 'Select some text first' : t.label}
            {...(t.pressed !== undefined ? { 'aria-pressed': t.pressed } : {})}
            disabled={disabled || !editor || t.off === true}
            // Keep the editor's selection through the click, as Messages does.
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.onClick}
          >
            {t.glyph}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} className="email-editor__content" />

      {panel === 'link' && editor ? (
        <TargetDialog
          title="Link"
          withLabel={false}
          allowMailto
          fields={fields}
          initial={{ label: '', href: s?.linkHref ?? '' }}
          onSubmit={({ href }) => {
            editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
            close();
          }}
          onRemove={
            s?.link
              ? () => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  close();
                }
              : undefined
          }
          onClose={close}
        />
      ) : null}
      {panel === 'button' && editor ? (
        <TargetDialog
          title="Button"
          withLabel
          allowMailto={false}
          fields={fields}
          initial={{ label: s?.buttonAttrs.label ?? '', href: s?.buttonAttrs.href ?? '' }}
          onSubmit={(attrs) => {
            if (s?.button) editor.chain().focus().updateEmailButton(attrs).run();
            else editor.chain().focus().insertEmailButton(attrs).run();
            close();
          }}
          onClose={close}
        />
      ) : null}
      {panel === 'image' && editor ? (
        <ImageDialog
          onInsert={(img) => {
            editor.chain().focus().insertEmailImage(img).run();
            close();
          }}
          onClose={close}
        />
      ) : null}
      {panel === 'field' && editor ? (
        <FieldDialog
          fields={fields}
          state={fieldsState}
          note={fieldsNote}
          onPick={(name) => {
            editor.chain().focus().insertMergeField(name).run();
            close();
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
```

`EmailContentEditor.css` (match variable names to `TemplateEditor.css`'s input rules):

```css
.email-editor { display: flex; flex-direction: column; border: 1px solid var(--hairline); border-radius: 10px; overflow: hidden; }
.email-editor__toolbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; border-bottom: 1px solid var(--hairline); }
.email-editor__tool { min-width: 32px; height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px; background: none; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.email-editor__tool[aria-pressed='true'] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
.email-editor__tool:disabled { opacity: 0.45; cursor: default; }
.email-editor__content .email-editor__doc { min-height: 260px; padding: 12px 14px; outline: none; font-size: 15px; line-height: 1.6; }
.email-editor__doc blockquote { border-left: 4px solid #d5535a; margin: 12px 0; padding: 8px 14px; }
.email-editor__doc a.button { display: inline-block; padding: 10px 20px; background: #df8431; color: #fff; border-radius: 4px; font-weight: 600; text-decoration: none; }
.email-editor__doc img { max-width: 100%; height: auto; }
.merge-chip { display: inline-block; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 22%, transparent); font-family: var(--font-mono); font-size: 0.85em; user-select: all; }
.email-editor__error { margin: 0 0 8px; color: var(--error); font-size: 13px; }
.email-editor__note { margin: 0 0 8px; font-size: 13px; color: var(--text-muted); }
.email-editor__dlabel { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 13px; }
.email-editor__target { border: 0; padding: 0; margin: 0 0 10px; display: flex; flex-direction: column; gap: 6px; }
.email-editor__fields { display: flex; flex-wrap: wrap; gap: 6px; }
.email-editor__field { font-family: var(--font-mono); font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--hairline); background: none; color: inherit; cursor: pointer; }
```

- [ ] **Step 4: Run to verify it passes.**
Run: `npx vitest run src/components/emailEditor/ && npx tsc --noEmit`
Expected: PASS for all four files in the folder, tsc clean. If the mount throws on a missing layout API, extend the guarded stub in `test-setup.ts` (Task 2, Step 2); do not mock TipTap.

- [ ] **Step 5: Commit** (`Add the visual email editor with its toolbar (#953)`).

---

### Task 9: Visual mode in the template editor

**Files:**
- Modify: `auntieos-admin/src/screens/TemplateEditor.tsx`
- Modify: `auntieos-admin/src/screens/TemplateEditor.css`
- Modify: `auntieos-admin/src/screens/TemplateEditor.test.tsx`
- Modify: `auntieos-admin/src/screens/Templates.test.tsx` (mocks only)

**Interfaces:**
- Consumes: `EmailContentEditor` (Task 8); `EmailPreviewPane`, `useEmailPreview` (Task 6); `visualFormError`, `buildVisualSavePayload`, `fieldsForTemplate`, `isOldFormat` (Task 5); `tokensIn` (Task 2); `getNotificationMatrix` (`api/myNotifications.ts`); `saveTemplate` (Task 4).
- Produces: `TemplateEditor` renders visual mode for new templates and for `format: 'visual'` templates. Old-format templates render exactly as before (plus the Convert banner added in Task 10).

- [ ] **Step 1: Write the failing tests.** In `TemplateEditor.test.tsx`:

  1. Extend the hoisted mocks and module mocks at the top:

```tsx
const { saveTemplate, deleteTemplate, previewEmailTemplate, convertTemplateToVisual } = vi.hoisted(() => ({
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  previewEmailTemplate: vi.fn(),
  convertTemplateToVisual: vi.fn(),
}));
// (inside the existing vi.mock('../api/templatesWrite', …) return object, add:)
//   previewEmailTemplate,
//   convertTemplateToVisual,

const { getNotificationMatrix } = vi.hoisted(() => ({ getNotificationMatrix: vi.fn() }));
vi.mock('../api/myNotifications', () => ({ getNotificationMatrix }));

// The editor surface is replaced by a plain textarea in THIS file only. Its
// real behaviour (TipTap, chips, paste, toolbar) is pinned in
// components/emailEditor/*.test.tsx; this file tests the screen around it:
// which fields show, what is seeded, what is saved.
vi.mock('../components/emailEditor/EmailContentEditor', () => ({
  EmailContentEditor: (p: { initialContent: string; onChange: (c: string) => void; fields: readonly string[] }) => (
    <textarea
      aria-label="Email content"
      data-fields={p.fields.join(',')}
      defaultValue={p.initialContent}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
}));
```

  2. In `beforeEach`, add:

```tsx
  previewEmailTemplate.mockReset().mockResolvedValue({ subject: 'S', html: '<html></html>', text: 'T', issues: [] });
  convertTemplateToVisual.mockReset();
  getNotificationMatrix.mockReset().mockResolvedValue({
    catalog: [{ key: 'auth.password.reset', templates: { email: 'auth.password.reset' }, mergeFields: ['displayName', 'link'] }],
    overrides: {}, ungated: [], businessAdminCount: null, businessAdminRosterPath: '', updatedAtMs: null,
  });
```

  3. Add a helper and a new describe block:

```tsx
function visualTpl(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return tpl({
    templateId: 'auth.password.reset',
    subject: 'Reset your password',
    body: '',
    html: null,
    format: 'visual',
    headline: 'Reset your password',
    content: '<p>Hi {{displayName}}</p>',
    ...over,
  });
}

describe('TemplateEditor: visual templates (#953)', () => {
  it('shows Subject, Headline and the content editor, and no Body or HTML fields', async () => {
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Reset your password');
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('Reset your password');
    expect(screen.getByLabelText('Email content')).toHaveValue('<p>Hi {{displayName}}</p>');
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    expect(screen.queryByLabelText(/^html$/i)).toBeNull();
    // The fields come from the notification that sends this template.
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'displayName,link'));
  });

  it('previews through the server with the matched catalog key', async () => {
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() =>
      expect(previewEmailTemplate).toHaveBeenCalledWith({
        subject: 'Reset your password',
        headline: 'Reset your password',
        content: '<p>Hi {{displayName}}</p>',
        catalogKey: 'auth.password.reset',
      }),
    );
    expect(await screen.findByTitle('The email as it will be sent')).toHaveAttribute('srcdoc', '<html></html>');
  });

  it('saves the visual shape: no body, no html', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    const onSaved = vi.fn();
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p>Hello {{displayName}}</p>' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        templateId: 'auth.password.reset',
        subject: 'Reset your password',
        format: 'visual',
        headline: 'Reset your password',
        content: '<p>Hello {{displayName}}</p>',
        title: 'Booking Confirmed',
        tags: [],
        usageInstructions: '',
        sectionDefinitions: [],
      }),
    );
    const sent = saveTemplate.mock.calls[0]![0] as Record<string, unknown>;
    expect('body' in sent).toBe(false);
    expect('html' in sent).toBe(false);
    expect(onSaved).toHaveBeenCalledWith('auth.password.reset');
  });

  it('blocks save on a blank headline and on empty content', async () => {
    render(<TemplateEditor template={visualTpl({ headline: '' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText('Headline is required.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^headline$/i), 'Hi');
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p> </p>' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText('The email needs some content.')).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('when no notification sends the template, offers the fields it already uses', async () => {
    getNotificationMatrix.mockResolvedValue({ catalog: [], overrides: {}, ungated: [], businessAdminCount: null, businessAdminRosterPath: '', updatedAtMs: null });
    render(<TemplateEditor template={visualTpl({ templateId: 'invite.kinfolk', content: '<p><a href="{{inviteLink}}" class="button">Join</a></p>' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'inviteLink'));
  });

  it('a failed field load still leaves the fields the template uses', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('offline'));
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'displayName'));
  });
});
```

  4. **Create mode becomes visual.** New templates are created in the visual format, so the create-mode tests that type into the Body textarea move to Headline plus content. Each keeps its assertions; only the field it types into changes. Add this helper next to `tpl()`:

```tsx
/** Fills the two visual fields a new template needs besides key and subject. */
function fillVisualBody(content = '<p>Body</p>') {
  fireEvent.change(screen.getByLabelText(/^headline$/i), { target: { value: 'Headline' } });
  fireEvent.change(screen.getByLabelText('Email content'), { target: { value: content } });
}
```

  Then change exactly these tests:
  - `renders an empty form with an editable template key field…`: replace `expect(screen.getByLabelText(/^body$/i)).toHaveValue('');` with `expect(screen.getByLabelText(/^headline$/i)).toHaveValue('');` and `expect(screen.getByLabelText('Email content')).toHaveValue('');`.
  - `blocks save and shows an inline error when the template key is blank`, `blocks save on an invalid template key…`, `blocks save when subject is blank`, `surfaces a rejected saveTemplate call…`, `sends expectNew on create…`, `explains a taken key…`: replace each `userEvent.type(screen.getByLabelText(/^body$/i), 'Body')` or `fireEvent.change(screen.getByLabelText(/^body/i), { target: { value: 'Body copy.' } })` with `fillVisualBody()`.
  - `blocks save when body is blank`: rename to `blocks save when the content is empty`, keep the key and subject typing, call `fireEvent.change(screen.getByLabelText(/^headline$/i), { target: { value: 'Headline' } })`, and assert `expect(await screen.findByText('The email needs some content.')).toBeInTheDocument();` plus the unchanged `expect(saveTemplate).not.toHaveBeenCalled();`.
  - `calls saveTemplate with the exact payload and onSaved on success`: replace the body `fireEvent.change` with `fillVisualBody('<p>Hi {{kinfolk_name}}</p>')`, and replace the expected payload with:

```tsx
      expect(saveTemplate).toHaveBeenCalledWith({
        templateId: 'booking.confirmed',
        subject: 'Your booking is confirmed',
        format: 'visual',
        headline: 'Headline',
        content: '<p>Hi {{kinfolk_name}}</p>',
        category: 'Booking',
        tags: ['booking', 'confirmation'],
        usageInstructions: '',
        sectionDefinitions: [],
        expectNew: true,
      }),
```

  - `TemplateEditor: live preview` › `updates as the author types` (the one test there that renders `template={null}`): change its render to `template={tpl()}` so it keeps testing the old-format `MergePreview`, which it was written for. The visual preview is covered by the new block above.
  - Any `#755` layout test that renders `template={null}` and asserts on the Body or merge-chip strip: change the render to `template={tpl()}`. Those tests describe the old-format layout, which is unchanged.

  Every other test in the file renders `tpl(...)` (old format) and must pass unchanged.

  5. In `src/screens/Templates.test.tsx`, add `previewEmailTemplate: vi.fn()` and `convertTemplateToVisual: vi.fn()` to the object its `vi.mock('../api/templatesWrite', …)` factory returns, and add `vi.mock('../api/myNotifications', () => ({ getNotificationMatrix: vi.fn().mockResolvedValue({ catalog: [], overrides: {}, ungated: [], businessAdminCount: null, businessAdminRosterPath: '', updatedAtMs: null }) }));`. Its "New template" tests open a visual editor now, which reads the catalog.

- [ ] **Step 2: Run to verify the new tests fail.**
Run: `npx vitest run src/screens/TemplateEditor.test.tsx`
Expected: the new `visual templates (#953)` tests and the migrated create-mode tests FAIL (no Headline field); the old-format tests pass.

- [ ] **Step 3: Implement** in `TemplateEditor.tsx`.

  Imports to add:

```tsx
import { getNotificationMatrix, type NotificationCatalogEntry } from '../api/myNotifications';
import { EmailContentEditor } from '../components/emailEditor/EmailContentEditor';
import { EmailPreviewPane } from '../components/emailEditor/EmailPreviewPane';
import { useEmailPreview } from '../lib/useEmailPreview';
import { tokensIn } from '../lib/emailContent';
import {
  buildVisualSavePayload,
  fieldsForTemplate,
  isOldFormat,
  visualFormError,
} from '../lib/templateFormat';
```

  State and derived values, directly after the existing `pendingCaret` ref:

```tsx
  // #953: which editor this template gets. New templates are visual; a stored
  // template is visual only when it says so. Task 10 flips this on Convert.
  const [mode, setMode] = useState<'visual' | 'old'>(() => (template === null || !isOldFormat(template) ? 'visual' : 'old'));
  // What the content editor mounts with. `key` changes only when the content
  // is replaced wholesale (Convert), which remounts the editor.
  const [seed, setSeed] = useState(() => ({ key: 0, content: template?.content ?? '' }));
  const [catalog, setCatalog] = useState<
    { status: 'loading' } | { status: 'ready'; entries: NotificationCatalogEntry[] } | { status: 'error' }
  >({ status: 'loading' });

  // Loaded once, in both modes: visual editing needs the fields, and the
  // Convert view (Task 10) needs the catalog key before the mode flips.
  useEffect(() => {
    let live = true;
    getNotificationMatrix().then(
      (matrix) => {
        if (live) setCatalog({ status: 'ready', entries: matrix.catalog });
      },
      () => {
        if (live) setCatalog({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const alreadyUsed = template ? tokensIn(template.subject, template.body, template.html ?? '', template.content ?? '') : [];
  const fieldSet =
    catalog.status === 'ready'
      ? fieldsForTemplate(catalog.entries, fields.templateId, alreadyUsed)
      : { catalogKey: null, fields: alreadyUsed, source: 'template' as const };
  const fieldsNote =
    catalog.status === 'ready' && fieldSet.source === 'template'
      ? 'No notification sends this template, so these are the fields it already uses.'
      : undefined;

  const previewReq =
    mode === 'visual' && (fields.headline.trim() !== '' || fields.content !== '')
      ? {
          subject: fields.subject,
          headline: fields.headline,
          content: fields.content,
          ...(fieldSet.catalogKey ? { catalogKey: fieldSet.catalogKey } : {}),
        }
      : null;
  const preview = useEmailPreview(previewReq);
```

  In `handleSave`, replace the block from `const validationError = …` through `const result = await saveTemplate(payload);` with:

```tsx
    const validationError =
      mode === 'visual' ? visualFormError(effective, { isCreate }) : templateFormError(effective, { isCreate });
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload =
        mode === 'visual' ? buildVisualSavePayload(effective, { isCreate }) : buildSaveTemplatePayload(effective, { isCreate });
      const result = await saveTemplate(payload);
```

  (the rest of `handleSave` is unchanged).

  Heading subtitle (it renders as a tooltip, per the kit): `subtitle={mode === 'visual' ? 'Merge fields fill in for each person when the email is sent.' : 'Subject and body render with Handlebars. Merge fields resolve to each recipient at send time.'}`.

  In the form, keep the key/name row, the channel strip and Subject as they are. Wrap the existing "Insert merge field" chips block and the "Body" block in `{mode === 'old' ? (<>…</>) : null}`, and put this before them:

```tsx
            {mode === 'visual' ? (
              <>
                <div className="template-editor__field">
                  <span className="template-editor__labelrow">
                    <label className="template-editor__label" htmlFor="template-editor-headline">
                      Headline
                    </label>
                    <RequiredMark />
                  </span>
                  <input
                    id="template-editor-headline"
                    type="text"
                    className="template-editor__input"
                    value={fields.headline}
                    onChange={(e) => setField('headline', e.target.value)}
                    placeholder="Reset your password"
                    maxLength={300}
                  />
                </div>
                <div className="template-editor__field">
                  <span className="template-editor__labelrow">
                    <span className="template-editor__label" id="template-editor-content-label">
                      Content
                    </span>
                    <RequiredMark />
                  </span>
                  <EmailContentEditor
                    key={seed.key}
                    initialContent={seed.content}
                    onChange={(content) => setField('content', content)}
                    fields={fieldSet.fields}
                    fieldsState={catalog.status}
                    fieldsNote={fieldsNote}
                    disabled={saving}
                  />
                </div>
              </>
            ) : null}
```

  Wrap the existing "HTML" field block in `{mode === 'old' ? (…) : null}`. Usage instructions and Sections stay for both modes.

  In the aside, replace the two panels with:

```tsx
        <div className="template-editor__aside">
          {mode === 'visual' ? (
            <DenPanel title="" className="template-editor__panel d2">
              <EmailPreviewPane state={preview.state} onRetry={preview.retry} />
            </DenPanel>
          ) : (
            <>
              {/* the existing MergePreview DenPanel, unchanged */}
              {/* the existing "Resolved with sample values" DenPanel, unchanged */}
            </>
          )}
        </div>
```

  (Move the two existing `DenPanel` elements, byte for byte, inside the fragment.)

  CSS: add to `TemplateEditor.css` only what the new field needs, `.template-editor__aside .email-preview__frame { min-height: 560px; }`.

- [ ] **Step 4: Run to verify.**
Run: `npx vitest run src/screens/TemplateEditor.test.tsx src/screens/Templates.test.tsx && npx tsc --noEmit`
Expected: PASS for both files. Open the summary and confirm the TemplateEditor test count is the old count plus 6. A test that passed before and fails now, other than the create-mode ones listed in Step 1, is a regression in old-format editing: fix the screen, not the test.

- [ ] **Step 5: Commit** (`Edit visual templates in the web template editor (#953)`; body notes that new templates are now created in the visual format and lists the migrated create-mode tests).

---

### Task 10: Convert an old-format template

**Files:**
- Create: `auntieos-admin/src/components/emailEditor/ConvertCompare.tsx`
- Test: `auntieos-admin/src/components/emailEditor/ConvertCompare.test.tsx`
- Modify: `auntieos-admin/src/screens/TemplateEditor.tsx`
- Modify: `auntieos-admin/src/screens/TemplateEditor.css`
- Modify: `auntieos-admin/src/screens/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `convertTemplateToVisual`, `ConvertTemplateResult` (Task 4); `bodyToContent`, `escapeText` (Task 2); `useEmailPreview`, `EmailPreviewPane` (Task 6); the Task 9 `mode`, `seed`, `fieldSet` state.
- Produces: `ConvertCompare({ old, converted, catalogKey, onUse, onBack })`; the editor's Convert banner, compare view, and leave confirmation.

- [ ] **Step 1: Write the failing tests.** `ConvertCompare.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { previewEmailTemplate } = vi.hoisted(() => ({ previewEmailTemplate: vi.fn() }));
vi.mock('../../api/templatesWrite', () => ({ previewEmailTemplate }));

import { ConvertCompare } from './ConvertCompare';

const OLD = { subject: 'Old subject', body: 'Hi {{displayName}}', html: '<p>Old <b>html</b></p>' };
const CONVERTED = { subject: 'Old subject', headline: 'Reset', content: '<p>Hi {{displayName}}</p>' };

describe('ConvertCompare', () => {
  it('shows the old email and the server preview of the converted one side by side', async () => {
    previewEmailTemplate.mockResolvedValue({ subject: 'Old subject', html: '<html>new</html>', text: 't', issues: [] });
    render(<ConvertCompare old={OLD} converted={CONVERTED} catalogKey="auth.password.reset" onUse={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTitle('The old email')).toHaveAttribute('srcdoc', OLD.html);
    await vi.waitFor(() =>
      expect(previewEmailTemplate).toHaveBeenCalledWith({ ...CONVERTED, catalogKey: 'auth.password.reset' }),
    );
    expect(await screen.findByTitle('The email as it will be sent')).toHaveAttribute('srcdoc', '<html>new</html>');
    expect(screen.getByRole('region', { name: 'Converted email' })).toBeInTheDocument();
  });

  it('shows an old template with no HTML as its plain text, escaped', () => {
    previewEmailTemplate.mockResolvedValue({ subject: 's', html: '', text: '', issues: [] });
    render(<ConvertCompare old={{ subject: 's', body: 'a < b', html: null }} converted={CONVERTED} catalogKey={null} onUse={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTitle('The old email').getAttribute('srcdoc')).toContain('a &lt; b');
  });

  it('the two buttons call their handlers', async () => {
    previewEmailTemplate.mockResolvedValue({ subject: 's', html: '', text: '', issues: [] });
    const onUse = vi.fn();
    const onBack = vi.fn();
    render(<ConvertCompare old={OLD} converted={CONVERTED} catalogKey={null} onUse={onUse} onBack={onBack} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use the converted version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep the old format' }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
```

Append to `TemplateEditor.test.tsx`:

```tsx
describe('TemplateEditor: converting an old-format template (#953)', () => {
  const OLD = () => tpl({ templateId: 'auth.password.reset', subject: 'Reset', body: 'Hi {{displayName}}\n\nClick {{link}}', html: '<p>Hi</p>' });

  it('offers Convert on an old-format template, and not on a visual one', () => {
    const { unmount } = render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Old format')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeInTheDocument();
    unmount();
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
  });

  it('shows a busy Convert while the server converts', async () => {
    convertTemplateToVisual.mockReturnValue(new Promise(() => {}));
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    const busy = screen.getByRole('button', { name: 'Converting…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });

  it('shows old and converted side by side, and saves nothing until Save', async () => {
    convertTemplateToVisual.mockResolvedValue({ ok: true, subject: 'Reset', headline: 'Reset your password', content: '<p>Hi {{displayName}}</p>' });
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    const onSaved = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={onSaved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(convertTemplateToVisual).toHaveBeenCalledWith('auth.password.reset');
    expect(await screen.findByTitle('The old email')).toHaveAttribute('srcdoc', '<p>Hi</p>');
    await userEvent.click(screen.getByRole('button', { name: 'Use the converted version' }));
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('Reset your password');
    expect(screen.getByLabelText('Email content')).toHaveValue('<p>Hi {{displayName}}</p>');
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    expect(saveTemplate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'visual', headline: 'Reset your password', content: '<p>Hi {{displayName}}</p>' }),
      ),
    );
    expect(onSaved).toHaveBeenCalledWith('auth.password.reset');
  });

  it('Keep the old format goes back to the untouched old fields', async () => {
    convertTemplateToVisual.mockResolvedValue({ ok: true, subject: 'Reset', headline: 'H', content: '<p>x</p>' });
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep the old format' }));
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('Hi {{displayName}}\n\nClick {{link}}');
    expect(screen.getByLabelText(/^html$/i)).toHaveValue('<p>Hi</p>');
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('leaving after converting asks first; Leave closes without saving', async () => {
    convertTemplateToVisual.mockResolvedValue({ ok: true, subject: 'Reset', headline: 'H', content: '<p>x</p>' });
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByText('Template bank'));
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('an unreadable template opens in the editor with its plain text as paragraphs', async () => {
    convertTemplateToVisual.mockResolvedValue({ ok: false, reason: 'unreadable', subject: 'Reset', body: 'Hi {{displayName}}\n\nClick {{link}}' });
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByLabelText('Email content')).toHaveValue('<p>Hi {{displayName}}</p><p>Click {{link}}</p>');
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('');
    expect(screen.getByText('The old layout couldn’t be read, so its text is below. Add a headline and the formatting, then save.')).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('a failed convert says so and keeps the old fields', async () => {
    convertTemplateToVisual.mockRejectedValue(new Error('convertTemplateToVisual took too long to respond.'));
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('convertTemplateToVisual took too long to respond.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^body$/i)).toBeInTheDocument();
  });

  it('Convert is not offered while creating', () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail.**
Run: `npx vitest run src/components/emailEditor/ConvertCompare.test.tsx src/screens/TemplateEditor.test.tsx`
Expected: the new tests FAIL; everything else passes.

- [ ] **Step 3: Implement** `ConvertCompare.tsx`:

```tsx
import { useMemo } from 'react';
import { DenPanel } from '../DenScreenKit';
import { GhostButton, PrimaryButton } from '../Buttons';
import { EmailPreviewPane } from './EmailPreviewPane';
import { useEmailPreview } from '../../lib/useEmailPreview';
import { escapeText } from '../../lib/emailContent';

export interface ConvertCompareProps {
  old: { subject: string; body: string; html: string | null };
  converted: { subject: string; headline: string; content: string };
  catalogKey: string | null;
  onUse: () => void;
  onBack: () => void;
}

/**
 * #953: the old email next to the converted one, before anything changes.
 * The old side is the stored HTML as-is (or its plain text when it has none);
 * the converted side is the server preview, the email that would be sent.
 * Nothing here writes.
 */
export function ConvertCompare({ old, converted, catalogKey, onUse, onBack }: ConvertCompareProps) {
  const req = useMemo(
    () => ({
      subject: converted.subject,
      headline: converted.headline,
      content: converted.content,
      ...(catalogKey ? { catalogKey } : {}),
    }),
    [converted.subject, converted.headline, converted.content, catalogKey],
  );
  const { state, retry } = useEmailPreview(req);
  const oldDoc =
    old.html && old.html.trim() !== ''
      ? old.html
      : `<pre style="white-space:pre-wrap;font-family:sans-serif">${escapeText(old.body)}</pre>`;

  return (
    <div className="convert-compare">
      <div className="convert-compare__cols">
        <DenPanel title="" className="convert-compare__side">
          <span className="email-preview__label">Old email</span>
          <p className="email-preview__subject">
            <span className="email-preview__subject-label">Subject:</span> <span>{old.subject}</span>
          </p>
          <iframe className="email-preview__frame" title="The old email" sandbox="" srcDoc={oldDoc} />
        </DenPanel>
        <DenPanel title="" className="convert-compare__side">
          <EmailPreviewPane state={state} onRetry={retry} label="Converted email" />
        </DenPanel>
      </div>
      <div className="convert-compare__actions">
        <GhostButton label="Keep the old format" onClick={onBack} />
        <PrimaryButton label="Use the converted version" onClick={onUse} />
      </div>
    </div>
  );
}
```

  In `TemplateEditor.tsx`, add imports `convertTemplateToVisual` (from `../api/templatesWrite`), `ConvertCompare`, and `bodyToContent` (from `../lib/emailContent`). Add state after the Task 9 state:

```tsx
  const [convert, setConvert] = useState<
    | { status: 'idle' }
    | { status: 'working' }
    | { status: 'compare'; subject: string; headline: string; content: string }
  >({ status: 'idle' });
  // True from the moment converted content is in the editor until it is saved.
  const [convertedUnsaved, setConvertedUnsaved] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [convertNotice, setConvertNotice] = useState<{ tone: 'info' | 'warning'; text: string } | null>(null);
  // Kept apart from `error`, whose banner is titled "Couldn’t save".
  const [convertError, setConvertError] = useState<string | null>(null);

  function applyVisual(subject: string, headline: string, content: string) {
    setFields((prev) => ({ ...prev, subject, headline, content }));
    setSeed((prev) => ({ key: prev.key + 1, content }));
    setMode('visual');
    setConvertedUnsaved(true);
  }

  async function startConvert() {
    if (isCreate || convert.status === 'working') return;
    setConvert({ status: 'working' });
    setConvertError(null);
    try {
      const res = await convertTemplateToVisual(fields.templateId);
      if (res.ok) {
        setConvert({ status: 'compare', subject: res.subject, headline: res.headline, content: res.content });
        return;
      }
      setConvert({ status: 'idle' });
      applyVisual(res.subject, '', bodyToContent(res.body));
      setConvertNotice({
        tone: 'warning',
        text: 'The old layout couldn’t be read, so its text is below. Add a headline and the formatting, then save.',
      });
    } catch (err) {
      setConvert({ status: 'idle' });
      setConvertError(err instanceof Error ? err.message : 'Convert failed.');
    }
  }

  function acceptConverted() {
    if (convert.status !== 'compare') return;
    applyVisual(convert.subject, convert.headline, convert.content);
    setConvert({ status: 'idle' });
    setConvertNotice({ tone: 'info', text: 'Converted. Nothing is saved until you press Save template.' });
  }
```

  Change `requestClose` so an unsaved conversion asks first:

```tsx
  const requestClose = useCallback(() => {
    if (saving || deleting) return;
    if (convertedUnsaved) {
      setConfirmLeave(true);
      return;
    }
    onClose();
  }, [saving, deleting, convertedUnsaved, onClose]);
```

  In `handleSave`, directly after `const result = await saveTemplate(payload);`, add `setConvertedUnsaved(false);`.

  Render the convert failure in its own banner, directly after the existing "Couldn’t save" banner:

```tsx
      {convertError ? (
        <Banner tone="error" title="Couldn’t convert" className="template-editor__error">
          {convertError}
        </Banner>
      ) : null}
```

  Directly below the page error banners, render the old-format banner and the notice:

```tsx
      {mode === 'old' && !isCreate && convert.status !== 'compare' ? (
        <Banner
          tone="warning"
          title="Old format"
          className="template-editor__error"
          trailing={
            <PrimaryButton
              label={convert.status === 'working' ? 'Converting…' : 'Convert'}
              onClick={() => void startConvert()}
              disabled={convert.status === 'working' || saving}
              busy={convert.status === 'working'}
            />
          }
        >
          Convert it to edit it like a document. You’ll see both versions before anything changes.
        </Banner>
      ) : null}
      {convertNotice ? (
        <Banner tone={convertNotice.tone} className="template-editor__error">
          {convertNotice.text}
        </Banner>
      ) : null}
```

  Render the compare view in place of the two columns:

```tsx
      {convert.status === 'compare' ? (
        <ConvertCompare
          old={{ subject: fields.subject, body: fields.body, html: fields.html.trim() === '' ? null : fields.html }}
          converted={{ subject: convert.subject, headline: convert.headline, content: convert.content }}
          catalogKey={fieldSet.catalogKey}
          onUse={acceptConverted}
          onBack={() => setConvert({ status: 'idle' })}
        />
      ) : (
        <div className="template-editor__cols">{/* the existing two columns, unchanged */}</div>
      )}
```

  The catalog is already loaded on mount in both modes (Task 9), so `fieldSet.catalogKey` is known here and the converted preview samples the right fields.

  The leave confirmation, next to the delete `Dialog`:

```tsx
      {confirmLeave ? (
        <Dialog
          title="Leave without saving?"
          onClose={() => setConfirmLeave(false)}
          footer={
            <>
              <GhostButton label="Stay" onClick={() => setConfirmLeave(false)} />
              <PrimaryButton
                label="Leave"
                onClick={() => {
                  setConfirmLeave(false);
                  onClose();
                }}
              />
            </>
          }
        >
          <p className="template-editor__hint">The converted version isn’t saved. This template stays in the old format.</p>
        </Dialog>
      ) : null}
```

  `TemplateEditor.css`:

```css
.convert-compare { display: flex; flex-direction: column; gap: 14px; }
.convert-compare__cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.convert-compare__actions { display: flex; justify-content: flex-end; gap: 10px; }
@media (max-width: 900px) { .convert-compare__cols { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Run to verify.**
Run: `npx vitest run src/components/emailEditor/ConvertCompare.test.tsx src/screens/TemplateEditor.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit** (`Convert old-format templates in the web editor, saving only on Save (#953)`).

---

### Task 11: "Old format" badge in the Template Bank

**Files:**
- Modify: `auntieos-admin/src/screens/Templates.tsx` (`TemplateCard`)
- Modify: `auntieos-admin/src/screens/Templates.test.tsx`

**Interfaces:**
- Consumes: `isOldFormat` (Task 5); `StatusPill`.
- Produces: an "Old format" pill in a card's meta line for every template not marked visual.

- [ ] **Step 1: Write the failing test.** Append to `Templates.test.tsx`:

```tsx
describe('#953 Old format badge', () => {
  it('badges old-format templates and not visual ones', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'old.one', title: 'Old one' }),
      tpl({ templateId: 'new.one', title: 'New one', body: '', format: 'visual', headline: 'H', content: '<p>x</p>' }),
    ]);
    listTemplateCategories.mockResolvedValue([]);
    render(<Templates />);
    const oldCard = (await screen.findByText('Old one')).closest('li')!;
    const newCard = screen.getByText('New one').closest('li')!;
    expect(within(oldCard).getByText('Old format')).toBeInTheDocument();
    expect(within(newCard).queryByText('Old format')).toBeNull();
  });
});
```

(If `Templates` needs props or a router wrapper in this file, copy the render call the file's other tests use.)

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/screens/Templates.test.tsx`. Expected: the new test FAILS.

- [ ] **Step 3: Implement.** Import `isOldFormat` from `../lib/templateFormat` in `Templates.tsx`, and in `TemplateCard`'s meta line add the pill after the category pill:

```tsx
      <span className="templates__card-meta">
        {category ? <StatusPill label={category} tone="purple" size="compact" /> : null}
        {/* #953: still in the old format; opening it offers Convert. */}
        {isOldFormat(tpl) ? <StatusPill label="Old format" tone="warning" size="compact" /> : null}
        <code className="templates__card-id">{tpl.templateId}</code>
      </span>
```

- [ ] **Step 4: Run.** `npx vitest run src/screens/Templates.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit** (`Badge old-format templates in the Template Bank (#953)`).

---

### Task 12: Cypress: edit, preview, save; convert and leave; a real paste

**Files:**
- Create: `auntieos-admin/cypress/e2e/email-editor.cy.ts`
- Modify: `auntieos-admin/cypress/e2e/templates.cy.ts` (the local `TemplateFixture` type only)

**Interfaces:**
- Consumes: the whole screen; callables `listTemplates`, `listCategories`, `getBusinessNotificationOverrides`, `previewEmailTemplate`, `saveTemplate`, `convertTemplateToVisual`.
- Produces: one spec file.

- [ ] **Step 1: Add the optional fields** to `TemplateFixture` in `templates.cy.ts` (`format?: 'visual'; headline?: string; content?: string;`) so the two specs describe the same row shape.

- [ ] **Step 2: Write the spec** `email-editor.cy.ts`:

```ts
// Generated by Cypress Author, 2026-09-24.

/**
 * #953: the visual email editor on the Template Bank. Every read and write is
 * a callable, and this harness pins callables at a dead port by design
 * (docs/runbooks/e2e.md), so each one is intercepted. Assertions are on the
 * UI only (operator ruling 2026-09-01).
 */
export {};

const CALLABLE = (name: string) => `**/us-central1/${name}`;
const BUDGET_MS = { RENDER: 6_000 } as const;

interface TemplateFixture {
  templateId: string;
  subject: string;
  body: string;
  html: string | null;
  title: string;
  description: string | null;
  tags: string[];
  category: string | null;
  usageInstructions: string;
  sectionDefinitions: { title: string; description: string }[];
  format?: 'visual';
  headline?: string;
  content?: string;
}

const RESET: TemplateFixture = {
  templateId: 'auth.password.reset',
  subject: 'Reset your Tribe Tails password',
  body: '',
  html: null,
  title: 'Password reset',
  description: null,
  tags: [],
  category: null,
  usageInstructions: '',
  sectionDefinitions: [],
  format: 'visual',
  headline: 'Reset your password',
  content: '<p>Hi {{displayName}},</p><p><a href="{{link}}" class="button">Reset password</a></p>',
};

const OLD: TemplateFixture = {
  templateId: 'e2e.visit.reminder',
  subject: 'Reminder: your visit is tomorrow',
  body: 'Hi {{kinfolkName}}, a reminder about tomorrow.',
  html: '<p>Hi {{kinfolkName}}, a reminder about tomorrow.</p>',
  title: 'Visit reminder (e2e)',
  description: null,
  tags: [],
  category: null,
  usageInstructions: '',
  sectionDefinitions: [],
};

function stub() {
  cy.intercept('POST', CALLABLE('listTemplates'), { statusCode: 200, body: { result: { templates: [RESET, OLD], nextCursor: null } } });
  cy.intercept('POST', CALLABLE('listCategories'), { statusCode: 200, body: { result: { categories: [], schemaVersion: 1 } } });
  cy.intercept('POST', CALLABLE('getBusinessNotificationOverrides'), {
    statusCode: 200,
    body: {
      result: {
        catalog: [{ key: 'auth.password.reset', label: 'Password reset', templates: { email: 'auth.password.reset' }, mergeFields: ['displayName', 'link'] }],
        overrides: {},
        ungated: [],
      },
    },
  });
  // A deliberate delay, so the loading cue is on screen long enough to see.
  cy.intercept('POST', CALLABLE('previewEmailTemplate'), {
    statusCode: 200,
    delay: 800,
    body: { result: { subject: 'Reset your Tribe Tails password', html: '<html><body><h2>Reset your password</h2></body></html>', text: 'Reset your password', issues: [] } },
  });
  cy.intercept('POST', CALLABLE('saveTemplate'), { statusCode: 200, body: { result: { templateId: 'auth.password.reset' } } });
  cy.intercept('POST', CALLABLE('convertTemplateToVisual'), {
    statusCode: 200,
    body: { result: { ok: true, subject: OLD.subject, headline: 'Visit reminder', content: '<p>Hi {{kinfolkName}}, a reminder about tomorrow.</p>' } },
  });
}

function openTemplates() {
  stub();
  cy.signIn();
  cy.visit('/templates');
  cy.get('.templates__card', { timeout: BUDGET_MS.RENDER }).should('have.length', 2);
}

describe('email editor', () => {
  it('badges only the old-format template', () => {
    openTemplates();
    cy.contains('.templates__card', OLD.title).should('contain.text', 'Old format');
    cy.contains('.templates__card', RESET.title).should('not.contain.text', 'Old format');
  });

  it('edits a visual template, shows the preview loading and then the email, and saves', () => {
    openTemplates();
    cy.contains('.templates__card', RESET.title).within(() => cy.contains('button', 'Edit').click());

    cy.get('#template-editor-headline').should('have.value', RESET.headline);
    cy.get('#template-editor-html').should('not.exist');
    cy.get('[aria-label="Email content"] .merge-chip').should('contain.text', '{{displayName}}');
    cy.get('[aria-label="Email content"] a.button').should('have.text', 'Reset password');

    cy.get('section[aria-label="Preview"]').should('have.attr', 'aria-busy', 'true');
    cy.contains('Updating preview…').should('exist');
    cy.get('iframe[title="The email as it will be sent"]', { timeout: BUDGET_MS.RENDER }).should('have.attr', 'srcdoc').and('contain', 'Reset your password');
    cy.get('section[aria-label="Preview"]').should('have.attr', 'aria-busy', 'false');

    // Type a new line, then drop a field in at the cursor with the toolbar.
    cy.get('[aria-label="Email content"]').click().type('{moveToEnd}{enter}See you soon ');
    cy.get('button[aria-label="Insert field"]').click();
    cy.get('[role="dialog"]').contains('button', '{{link}}').click();
    cy.get('[aria-label="Email content"] [data-merge-field="link"]').should('exist');

    cy.contains('button', 'Save template').click();
    cy.get('.template-editor').should('not.exist');
    cy.get('.templates__card').should('have.length', 2);
  });

  it('a paste from Gmail lands as clean text', () => {
    openTemplates();
    cy.contains('.templates__card', RESET.title).within(() => cy.contains('button', 'Edit').click());
    cy.get('[aria-label="Email content"]').click().type('{moveToEnd}{enter}');
    cy.get('[aria-label="Email content"]').then(($el) => {
      const data = new DataTransfer();
      data.setData('text/html', '<div dir="ltr"><span style="font-family:arial;color:#222">Pasted <b>words</b></span><img src="https://mail.google.com/x.png"></div>');
      data.setData('text/plain', 'Pasted words');
      $el[0]!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    cy.get('[aria-label="Email content"]').should('contain.text', 'Pasted words');
    cy.get('[aria-label="Email content"] strong').should('contain.text', 'words');
    cy.get('[aria-label="Email content"] [style]').should('not.exist');
    cy.get('[aria-label="Email content"] img[src*="mail.google.com"]').should('not.exist');
  });

  it('converts an old template side by side, and leaving asks before throwing it away', () => {
    openTemplates();
    cy.contains('.templates__card', OLD.title).within(() => cy.contains('button', 'Edit').click());
    cy.get('#template-editor-body').should('have.value', OLD.body);
    cy.contains('button', 'Convert').click();
    cy.get('iframe[title="The old email"]').should('have.attr', 'srcdoc').and('contain', 'a reminder about tomorrow');
    cy.get('section[aria-label="Converted email"]').should('exist');
    cy.contains('button', 'Use the converted version').click();
    cy.get('#template-editor-headline').should('have.value', 'Visit reminder');
    cy.get('#template-editor-body').should('not.exist');
    cy.contains('Nothing is saved until you press Save template.').should('exist');

    cy.contains('.template-editor button', 'Cancel').click();
    cy.get('[role="dialog"]').should('contain.text', 'Leave without saving?');
    cy.contains('[role="dialog"] button', 'Leave').click();
    cy.get('.template-editor').should('not.exist');
    cy.contains('.templates__card', OLD.title).should('contain.text', 'Old format');
  });
});
```

- [ ] **Step 3: Type-check and run.** From `auntieos-admin`: `npm run e2e:cy:tsc`, then `npm run e2e:cy -- --spec cypress/e2e/email-editor.cy.ts` if the emulator harness is available on this machine. If Cypress cannot start locally, say so in the PR body and rely on the CI run; read the CI log for this spec's lines, never only the job's exit status.

- [ ] **Step 4: Commit** (`Add the email editor Cypress spec (#953)`).

---

### Task 13: Full verification and the PR

- [ ] **Step 1: Run everything the change touches, and read the output.**

```bash
cd auntieos-admin && npx vitest run 2>&1 | tail -25
```

Read the summary line: the test-file count must be the baseline recorded in Task 1 Step 1 plus 7 (`emailContent`, `extensions`, `emailImageUpload`, `EmailPreviewPane`, `EmailEditorDialogs`, `EmailContentEditor`, `ConvertCompare`), and zero failed. Then:

```bash
cd auntieos-admin && npm run typecheck
cd ../mytribe/functions && npx vitest run test/listTemplates.test.ts
```

Do not pipe a command into `tail` and then trust its exit code; the shell is zsh and `PIPESTATUS` is empty. Read the printed pass/fail lines.

- [ ] **Step 2: Check the UI copy once more** against the anti-slop skill (CLAUDE.md gate): invoke `anti-ai-slop` on the strings introduced in Tasks 6 to 11 and fix any hit in the component and its test together.

- [ ] **Step 3: Push** (its own Bash call):

```bash
git push -u origin feat/email-editor-web
```

- [ ] **Step 4: Open the PR** (a separate Bash call). Write the body with the Write tool to a scratchpad file, then:

```bash
gh pr create --base main --head feat/email-editor-web --title "Visual email editor on admin web (#953)" --body-file <file>
```

Body contents, in this order: what the operator can now do (edit like a document, preview beside it, convert old templates, "Old format" badge); that new templates are now created in the visual format; the `listTemplates` change (three fields, visual rows only); that email images also appear in Gallery under the business; test counts read from the output of Step 1; the Cypress result (or that it runs in CI only); the operator step from the spec ("After 4: edit on web, and convert any customised templates"). End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

After creating it, re-query the PR's checks with `gh pr checks` rather than reporting a status from memory.
