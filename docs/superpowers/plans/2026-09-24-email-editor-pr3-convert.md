# Visual Email Editor, PR 3: Convert the Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 52 repo email templates are stored in the visual format, Template Import writes them as visual documents, and a callable converts any old-format stored template for the web editor's Convert button.

**Architecture:**
- **Converter:** `convertLegacyTemplate` in `src/notifications/convertLegacyTemplate.ts`, a pure function. It reads the old frame's header `h2` and `.content` box, maps `.alert-box` to `blockquote`, and runs the result through PR 2's sanitizer.
- **One-time run:** a script converts each seed directory's `email.html` and `email.txt` into `subject.txt`, `headline.txt` and `content.html`, then deletes the two old files.
- **Downstream:** the corpus generator, `SeedCorpusEntry`, the import planner, the reset template fallback and the tests move to the new files.
- **New callable:** `convertTemplateToVisual` returns the converted fields without writing them.

**Tech Stack:** TypeScript, htmlparser2 12, sanitize-html, vitest, ts-node scripts.

**Spec:** `docs/superpowers/specs/2026-09-24-visual-email-editor-design.md` (Part 3)

**Depends on:** PR 2 merged. This plan uses `sanitizeEmailContent`, `sendPartsFor` and the `EmailTemplateDoc` visual fields.

## Global Constraints

- Seed directory files after conversion: `subject.txt` (one line), `headline.txt` (one line), `content.html` (sanitized fragment), `sms.txt`, `push.txt`. No `email.html`, no `email.txt`.
- The converter never guesses. With no `.header h2` or no `.content` box, it returns `{ ok: false, reason: 'unreadable' }`.
- Conversion keeps, for every seed:
  - the exact set of `{{tokens}}` from the old email.html plus email.txt (the tokens in both old parts must be the same set; if one ever isn't, list it in the PR body);
  - every button's label and href;
  - a non-empty headline;
  - a sanitizer result with no issues.
- `.alert-box` becomes `<blockquote>`. `style="margin:6px 0"` and `class="visits"` are dropped.
- The importer writes visual documents with `body: null, html: null`, so an overwrite clears the old parts. It never touches a document the operator didn't tick (`overwriteIds`); that rule is unchanged.
- Templates arrive through the importer, never through a seed script. `mytribe/scripts/seedNotificationTemplates.ts` is updated to read the new files, so it stays runnable against the emulator, and it is not promoted.
- Commits: message file written with the Write tool, `git commit -F`, ending `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A seed whose `.content` contains a nested `div` (not alert-box) must keep its text as paragraphs, not drop it. Pinned in Task 1.
2. A button written with single-quoted attributes (`href='{{link}}' class='button'`, as in the reset seed) must convert to a button. Pinned in Task 1.
3. A stored template the operator edited must be skipped by Import unless ticked, even though every seed now differs from every stored old document. Pinned in Task 4.
4. `convertTemplateToVisual` on a template that is already visual returns its current fields, and never an unreadable error. Pinned in Task 5.
5. The reset fallback (no stored template) must still send a working link after the seed files change shape. Pinned in Task 4.

---

## Shared interfaces

```ts
// src/notifications/convertLegacyTemplate.ts
export type ConvertResult =
  | { ok: true; headline: string; content: string }
  | { ok: false; reason: 'unreadable' };
export function convertLegacyTemplate(html: string, cloudName: string): ConvertResult;

// src/notifications/seedCorpus.generated.ts (shape emitted by the generator)
export interface SeedCorpusEntry {
  readonly key: string;
  readonly emailSubject: string;
  readonly emailHeadline: string;
  readonly emailContent: string;
  readonly smsTxt: string;
  readonly pushTxt: string;
}

// callable convertTemplateToVisual (wrapAdminCallable, same gate as saveTemplate)
//   req { templateId: string }
//   res { ok: true; subject: string; headline: string; content: string }
//     | { ok: false; reason: 'unreadable'; subject: string; body: string }
```

---

### Task 1: The converter

**Files:**
- Create: `mytribe/functions/src/notifications/convertLegacyTemplate.ts`
- Test: `mytribe/functions/test/convertLegacyTemplate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { convertLegacyTemplate } from '../src/notifications/convertLegacyTemplate';

const frame = (inner: string, h = 'Hello there') =>
  `<!DOCTYPE html><html><head><style>.x{}</style></head><body><div class="container">` +
  `<div class="header"><h2>${h}</h2></div><div class="content">${inner}</div>` +
  `<div class="footer">Tribe Tails Pet Care.</div></div></body></html>`;

describe('convertLegacyTemplate', () => {
  it('takes the headline from the header and the content from the content box', () => {
    expect(convertLegacyTemplate(frame('<p>Hi {{displayName}}</p>'), '')).toEqual({
      ok: true,
      headline: 'Hello there',
      content: '<p>Hi {{displayName}}</p>',
    });
  });

  it("keeps a single-quoted button as a button", () => {
    const r = convertLegacyTemplate(frame("<a href='{{link}}' class='button'>Reset Password</a>"), '');
    expect(r).toMatchObject({ ok: true, content: '<p><a href="{{link}}" class="button">Reset Password</a></p>' });
  });

  it('turns an alert box into a callout and drops styling', () => {
    const r = convertLegacyTemplate(frame('<div class="alert-box"><strong>Heads up</strong> x</div><p style="margin:6px 0">y</p><ul class="visits"><li>z</li></ul>'), '');
    expect(r).toMatchObject({ ok: true, content: '<blockquote><p><strong>Heads up</strong> x</p></blockquote><p>y</p><ul><li>z</li></ul>' });
  });

  it('keeps the text of any other nested div as paragraphs', () => {
    const r = convertLegacyTemplate(frame('<div>Plain words</div>'), '');
    expect(r).toMatchObject({ ok: true, content: '<p>Plain words</p>' });
  });

  it('refuses HTML without the frame', () => {
    expect(convertLegacyTemplate('<p>hand built</p>', '')).toEqual({ ok: false, reason: 'unreadable' });
    expect(convertLegacyTemplate(frame('<p>x</p>', ''), '')).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('converts the real reset seed', () => {
    const html = readFileSync(join(__dirname, '../../seeds/notificationTemplates/auth.password.reset/email.html'), 'utf8');
    const r = convertLegacyTemplate(html, '');
    expect(r).toMatchObject({ ok: true, headline: 'Reset your Tribe Tails password' });
    expect((r as { content: string }).content).toContain('<a href="{{link}}" class="button">Reset Password</a>');
  });
});
```

The last test reads the seed before Task 2 deletes `email.html`. Task 2 replaces it with a fixture copy (see Task 2, Step 4).

- [ ] **Step 2: Run to verify it fails.** Run `cd mytribe/functions && npx vitest run test/convertLegacyTemplate.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement**

```ts
import { parseDocument, DomUtils } from 'htmlparser2';
import render from 'dom-serializer';
import type { Element } from 'domhandler';
import { sanitizeEmailContent } from '../lib/emailContent';

/**
 * #953: an old-format template (the seeds' shared frame, or a stored copy of
 * one) as headline + content. Never guesses: without the frame's header and
 * content box it answers `unreadable`, and the editor starts from the plain
 * text body instead.
 */
export type ConvertResult = { ok: true; headline: string; content: string } | { ok: false; reason: 'unreadable' };

const hasClass = (el: Element, c: string) => (el.attribs['class'] ?? '').split(/\s+/).includes(c);

export function convertLegacyTemplate(html: string, cloudName: string): ConvertResult {
  const doc = parseDocument(html);
  const header = DomUtils.findOne((el) => el.name === 'div' && hasClass(el, 'header'), doc.children, true);
  const box = DomUtils.findOne((el) => el.name === 'div' && hasClass(el, 'content'), doc.children, true);
  const h2 = header && DomUtils.findOne((el) => el.name === 'h2', header.children, true);
  const headline = h2 ? DomUtils.textContent(h2).trim() : '';
  if (!box || !headline) return { ok: false, reason: 'unreadable' };

  for (const el of DomUtils.findAll((e) => e.name === 'div' && hasClass(e, 'alert-box'), box.children)) {
    el.name = 'blockquote';
    el.attribs = {};
  }
  // A bare inline element directly in the box (the reset seed's button) gets its own paragraph.
  box.children = box.children.map((child) => {
    if (child.type === 'tag' && ['a', 'strong', 'em', 'span'].includes((child as Element).name)) {
      const p = parseDocument('<p></p>').children[0] as Element;
      p.children = [child];
      child.parent = p;
      return p;
    }
    return child;
  });

  const { content, issues } = sanitizeEmailContent(render(box.children, { encodeEntities: false }), cloudName);
  const blocking = issues.filter((i) => !i.startsWith('Removed an image'));
  if (blocking.length) return { ok: false, reason: 'unreadable' };
  // Alert boxes held inline text directly; give it a paragraph inside the callout.
  const tidy = content
    .replace(/<blockquote>(?!<p>)([\s\S]*?)<\/blockquote>/g, '<blockquote><p>$1</p></blockquote>')
    .replace(/>\s+</g, '><')
    .trim();
  return { ok: true, headline, content: tidy };
}
```

`dom-serializer` ships with htmlparser2. If `tsc` can't resolve it, add `"dom-serializer": "^2.0.0"` to dependencies; it is already in the lockfile.

- [ ] **Step 4: Run.** Run `npx vitest run test/convertLegacyTemplate.test.ts`. Expected: 6 PASS. When whitespace between tags differs, fix the `tidy` normalisation, not the expectations.

- [ ] **Step 5: Commit**: "Convert old-format email templates to headline and content (#953)".

---

### Task 2: Convert the 52 seed directories

**Files:**
- Create: `mytribe/functions/scripts/convertSeedsToVisual.ts` (one-time, deleted in Step 6)
- Modify: every `mytribe/seeds/notificationTemplates/*/`, adding `subject.txt`, `headline.txt` and `content.html` and removing `email.html` and `email.txt`
- Create: `mytribe/functions/test/fixtures/legacyResetEmail.html`, a copy of the old reset `email.html` so Task 1's last test keeps a stable input

- [ ] **Step 1: Write the one-time script**

```ts
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { convertLegacyTemplate } from '../src/notifications/convertLegacyTemplate';
import { parseEmailTxt } from '../src/notifications/templateParsers';
import { MERGE_TOKEN } from '../src/lib/emailContent';

const root = resolve(__dirname, '../../seeds/notificationTemplates');
const tokens = (s: string) => new Set([...s.matchAll(MERGE_TOKEN)].map((m) => m[1]));
const buttons = (s: string) =>
  [...s.matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*class=["']button["'][^>]*>([\s\S]*?)<\/a>/g)].map((m) => `${m[2].trim()} -> ${m[1]}`).sort();
const problems: string[] = [];

for (const key of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort()) {
  const dir = join(root, key);
  const html = readFileSync(join(dir, 'email.html'), 'utf8');
  const { subject, body } = parseEmailTxt(readFileSync(join(dir, 'email.txt'), 'utf8'));
  const r = convertLegacyTemplate(html, '');
  if (!r.ok) { problems.push(`${key}: unreadable`); continue; }
  const before = new Set([...tokens(html), ...tokens(body)]);
  const after = new Set([...tokens(r.content), ...tokens(r.headline)]);
  const missing = [...before].filter((t) => !after.has(t) && !tokens(subject).has(t));
  if (missing.length) problems.push(`${key}: tokens only in the old text part: ${missing.join(', ')}`);
  if (JSON.stringify(buttons(html)) !== JSON.stringify(buttons(r.content))) problems.push(`${key}: buttons changed`);
  writeFileSync(join(dir, 'subject.txt'), `${subject}\n`);
  writeFileSync(join(dir, 'headline.txt'), `${r.headline}\n`);
  writeFileSync(join(dir, 'content.html'), `${r.content}\n`);
  unlinkSync(join(dir, 'email.html'));
  unlinkSync(join(dir, 'email.txt'));
}
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'All seeds converted cleanly.');
process.exitCode = problems.length ? 1 : 0;
```

- [ ] **Step 2: Copy the fixture first**: `cp ../seeds/notificationTemplates/auth.password.reset/email.html test/fixtures/legacyResetEmail.html`. Point Task 1's last test at `join(__dirname, 'fixtures/legacyResetEmail.html')`.

- [ ] **Step 3: Run it**: `cd mytribe/functions && npx ts-node --project scripts/tsconfig.json scripts/convertSeedsToVisual.ts`. Read the output.
  - **Expected:** "All seeds converted cleanly."
  - **Tokens only in the old text part:** these are merge fields that appeared in `email.txt` and not in `email.html`. That text is now generated from the content, so the field would be lost. Fix the seed's `content.html` by hand: add the sentence that carried it, copied from the old `email.txt`, which you can see with `git show HEAD:<path>/email.txt`.
  - **Buttons changed or unreadable:** fix `content.html` and `headline.txt` by hand from `git show HEAD:<path>/email.html`.
  - List every hand-fixed key; the PR body names them.

- [ ] **Step 4: Spot-check three by eye**: `auth.password.reset`, one alert-box seed (`git grep -l alert-box HEAD -- '../seeds/*/email.html'`), and one list seed (`visits`). Diff the old HTML against the new `content.html` with `git diff --no-index`, or with `git show`.

- [ ] **Step 5: Delete the script**: `rm scripts/convertSeedsToVisual.ts`. It was one-time; the result is committed.

- [ ] **Step 6: Commit** the seed changes and the fixture: "Convert the 52 seed email templates to the visual format (#953)". The commit body lists any hand-fixed keys.

---

### Task 3: Generator, corpus shape and seed tests

**Files:**
- Modify: `mytribe/functions/scripts/generateSeedCorpus.ts` (`REQUIRED_FILES`, `RawCorpusEntry`, `readCorpus`, `emitCorpusModule`, the interface text it emits)
- Regenerate: `mytribe/functions/src/notifications/seedCorpus.generated.ts` (`npm run seeds:generate`)
- Modify tests that read the old files:
  - `test/notifications/seedTemplateIntegrity.test.ts:36-42`
  - `test/templateValidation.test.ts:38`
  - `test/notificationKeyAliases.test.ts:90`
  - `test/importSeedTemplates.test.ts`
  - `test/notifications/templateParsers.test.ts`, only where it reads seed files
- Modify: `mytribe/scripts/seedNotificationTemplates.ts:42-49`, which reads the new files and writes the visual shape
- Modify: the comment at `src/notifications/enrichTemplateData.ts:45`, which lists the new filenames
- Create: `mytribe/functions/test/seedVisualIntegrity.test.ts`

- [ ] **Step 1: Write the failing integrity test**

```ts
import { describe, it, expect } from 'vitest';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { sanitizeEmailContent, MERGE_TOKEN } from '../src/lib/emailContent';
import { TEMPLATE_FIELDS } from '../src/notifications/enrichTemplateData';

describe('every seed is a valid visual template', () => {
  it('there are 52', () => expect(SEED_CORPUS.length).toBe(52));
  for (const s of SEED_CORPUS) {
    it(`${s.key}: headline, clean content, known tokens`, () => {
      expect(s.emailSubject.trim()).not.toBe('');
      expect(s.emailHeadline.trim()).not.toBe('');
      const r = sanitizeEmailContent(s.emailContent, '');
      expect(r.issues).toEqual([]);
      expect(r.content).toBe(s.emailContent);
      const fields = TEMPLATE_FIELDS[s.key];
      if (fields) {
        for (const m of `${s.emailSubject}${s.emailHeadline}${s.emailContent}`.matchAll(MERGE_TOKEN)) {
          expect(fields, `${s.key} uses {{${m[1]}}}`).toContain(m[1]);
        }
      }
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**: `npx vitest run test/seedVisualIntegrity.test.ts`. Expected: FAIL, because `emailSubject` is undefined.

- [ ] **Step 3: Implement the generator change**:
  - `REQUIRED_FILES = ['subject.txt', 'headline.txt', 'content.html', 'sms.txt', 'push.txt'] as const`.
  - `RawCorpusEntry` becomes `{ key, emailSubject, emailHeadline, emailContent, smsTxt, pushTxt }`, reading and `.trim()`-ing the three new files. `parseEmailTxt` goes away; `parsePushTxt` and the sms check stay.
  - `readCorpus` refuses an empty subject or headline with `seed corpus: ${key}: subject.txt is empty` and the same form for headline.
  - `emitCorpusModule` writes the three new properties and emits the `SeedCorpusEntry` interface from Shared interfaces.
  - Run `npm run seeds:generate`, then `npm run seeds:check`. Expected: no difference.

- [ ] **Step 4: Update the old-file readers**:
  - `seedTemplateIntegrity.test.ts:36-42` reads `content.html` for `{{link}}`. The text part is now generated, so drop the `email.txt` half and assert that `SEED_CORPUS`'s reset entry, run through `contentToText`, contains `{{link}}`.
  - `templateValidation.test.ts:38` reads `content.html`.
  - `notificationKeyAliases.test.ts:90` expects `content.html`.
  - `importSeedTemplates.test.ts` fixtures use the new entry shape.
  - `mytribe/scripts/seedNotificationTemplates.ts` reads the new files and writes `{ subject, headline, content, format: 'visual', body: null, html: null }`.
  - Grep again, `git grep -n "email\.html\|email\.txt\|emailHtml\|emailTxt" -- mytribe`. The only matches left should be the fixture file, docs and the archived `auntieos-admin/generate_templates.py`.

- [ ] **Step 5: Run**: `npx vitest run test/seedVisualIntegrity.test.ts test/notifications test/templateValidation.test.ts test/notificationKeyAliases.test.ts test/enrichTemplateData.test.ts`. Expected: PASS, including the 52 integrity cases.

- [ ] **Step 6: Commit**: "Seed corpus carries the visual format (#953)".

---

### Task 4: The importer writes visual documents, and the reset fallback reads them

**Files:**
- Modify: `mytribe/functions/src/notifications/importPlanner.ts`: `CONTENT_FIELDS.email`, `channelContent` email branch
- Modify: `mytribe/functions/src/lib/templateValidation.ts`: add `visualEmailTemplateIssues`
- Modify: `mytribe/functions/src/auth/requestPasswordReset.ts`: `loadResetTemplate` seed branch
- Modify: `mytribe/functions/test/requestPasswordResetRender.test.ts` and `test/requestPasswordReset.test.ts`, the fallback expectations
- Test: `mytribe/functions/test/importPlannerVisual.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { planImport, plannedWrites } from '../src/notifications/importPlanner';

const entry = { key: 'k', emailSubject: 'S', emailHeadline: 'H', emailContent: '<p>x</p>', smsTxt: 'sms', pushTxt: 'Title. body\n' };

describe('import planner, visual seeds', () => {
  it('creates a visual doc that clears body and html', () => {
    const plan = planImport({ corpus: [entry], existing: {} });
    const w = plannedWrites(plan).find((x) => x.path === 'emailTemplates/k')!;
    expect(w.content).toEqual({ subject: 'S', headline: 'H', content: '<p>x</p>', format: 'visual', body: null, html: null });
  });

  it('skips an edited old-format doc unless ticked, then overwrites it', () => {
    const existing = { 'emailTemplates/k': { subject: 'Mine', body: 'b', html: '<p>h</p>' } };
    const skipped = planImport({ corpus: [entry], existing });
    expect(skipped.templates[0]!.channels.find((c) => c.channel === 'email')!.outcome).toBe('skipped');
    const ticked = planImport({ corpus: [entry], existing, overwriteIds: ['k'] });
    expect(ticked.templates[0]!.channels.find((c) => c.channel === 'email')!.outcome).toBe('overwrite');
  });

  it('is unchanged when the stored doc already matches', () => {
    const existing = { 'emailTemplates/k': { subject: 'S', headline: 'H', content: '<p>x</p>', format: 'visual', body: null, html: null } };
    expect(planImport({ corpus: [entry], existing }).templates[0]!.channels.find((c) => c.channel === 'email')!.outcome).toBe('unchanged');
  });

  it('blocks a seed whose content fails the sanitizer', () => {
    const bad = { ...entry, emailContent: '<p>{{{raw}}}</p>' };
    expect(planImport({ corpus: [bad], existing: {} }).templates[0]!.blocked).toBe(true);
  });
});
```

Check the push fixture format against `parsePushTxt` and fix `pushTxt` to whatever it accepts. In `requestPasswordResetRender.test.ts`, the fallback now yields a visual doc. Render it through `sendPartsFor`, and expect `href="${LINK}"` with double quotes, plus `Reset Password: ${LINK}` in the text.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** In `templateValidation.ts`:

```ts
export function visualEmailTemplateIssues(v: { subject: string; headline: string; content: string }): string[] {
  const issues: string[] = [];
  if (v.subject.trim() === '') issues.push('subject is empty.');
  if (v.headline.trim() === '') issues.push('headline is empty.');
  for (const [field, value] of [['subject', v.subject], ['headline', v.headline]] as const) {
    const issue = tripleStashIssue(field, value);
    if (issue) issues.push(issue);
  }
  const r = sanitizeEmailContent(v.content, '');
  issues.push(...r.issues.filter((i) => !i.startsWith('Removed an image')));
  if (r.content !== v.content) issues.push('content is not in the stored form; regenerate it with the converter.');
  return issues;
}
```

(import `sanitizeEmailContent` from `./emailContent`). In `importPlanner.ts`:

```ts
const CONTENT_FIELDS = Object.freeze({
  email: ['subject', 'headline', 'content', 'format', 'body', 'html'],
  sms: ['text'],
  push: ['title', 'body'],
});
```

and the email branch of `channelContent`:

```ts
    if (channel === 'email') {
      const content = {
        subject: entry.emailSubject,
        headline: entry.emailHeadline,
        content: entry.emailContent,
        format: 'visual',
        body: null,
        html: null,
      };
      return { content, issues: visualEmailTemplateIssues(content) };
    }
```

In `requestPasswordReset.ts`, the seed branch of `loadResetTemplate`:

```ts
  return {
    template: { subject: seed.emailSubject, format: 'visual', headline: seed.emailHeadline, content: seed.emailContent },
    source: 'seed',
  };
```

Remove its `parseEmailTxt` import if unused. The existing test `falls back to the repo copy, link included` changes to expect `args.htmlTemplate` to contain `{{link}}` and `args.bodyTemplate` to contain `Reset Password: {{link}}`.

- [ ] **Step 4: Run**: `npx vitest run test/importPlannerVisual.test.ts test/importSeedTemplates.test.ts test/requestPasswordReset.test.ts test/requestPasswordResetRender.test.ts test/templateValidation.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**: "Template Import writes visual templates; reset fallback uses them (#953)".

---

### Task 5: `convertTemplateToVisual`

**Files:**
- Create: `mytribe/functions/src/admin/convertTemplateToVisual.ts`
- Modify: `mytribe/functions/src/index.ts` (export), `CALLABLE_CONTRACT.md`, and any admin-callable registry test that lists `saveTemplate`
- Test: `mytribe/functions/test/convertTemplateToVisual.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
import { convertTemplateToVisualHandler } from '../src/admin/convertTemplateToVisual';

const legacy = readFileSync(join(__dirname, 'fixtures/legacyResetEmail.html'), 'utf8');
let ctx: ReturnType<typeof buildDbMock>;
const run = (templateId: string) => convertTemplateToVisualHandler(callableRequest({ templateId }, { uid: 'op1' }));

beforeEach(() => {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      'emailTemplates/old': { subject: 'S', body: 'Plain {{link}}', html: legacy },
      'emailTemplates/hand': { subject: 'S2', body: 'Line one\n\nLine two', html: '<table><tr><td>x</td></tr></table>' },
      'emailTemplates/vis': { subject: 'S3', format: 'visual', headline: 'H', content: '<p>c</p>' },
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
});

describe('convertTemplateToVisual', () => {
  it('converts a framed old template without writing anything', async () => {
    const r = await run('old');
    expect(r).toMatchObject({ ok: true, subject: 'S', headline: 'Reset your Tribe Tails password' });
    expect(ctx.writes).toEqual([]);
  });
  it('answers unreadable with the plain body for hand-built HTML', async () => {
    expect(await run('hand')).toEqual({ ok: false, reason: 'unreadable', subject: 'S2', body: 'Line one\n\nLine two' });
  });
  it('returns an already-visual template as it is', async () => {
    expect(await run('vis')).toEqual({ ok: true, subject: 'S3', headline: 'H', content: '<p>c</p>' });
  });
  it('is not-found for a missing template', async () => {
    await expect(run('nope')).rejects.toMatchObject({ code: 'not-found' });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { TEMPLATE_ID_MAX_LENGTH, TEMPLATE_ID_PATTERN } from '../lib/templateValidation';
import { convertLegacyTemplate } from '../notifications/convertLegacyTemplate';
import type { EmailTemplateDoc } from '../lib/sendFromTemplate';

/** #953: the web editor's Convert button. Reads, converts, writes nothing; Save does the write. */
const Args = z.object({ templateId: z.string().min(1).max(TEMPLATE_ID_MAX_LENGTH).regex(TEMPLATE_ID_PATTERN) });

export type ConvertTemplateResponse =
  | { ok: true; subject: string; headline: string; content: string }
  | { ok: false; reason: 'unreadable'; subject: string; body: string };

export async function convertTemplateToVisualHandler(req: CallableRequest<unknown>): Promise<ConvertTemplateResponse> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const { templateId } = Args.parse(req.data);
  const snap = await db().doc(`emailTemplates/${templateId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', `No template ${templateId}.`);
  const doc = snap.data() as EmailTemplateDoc;
  if (doc.format === 'visual' && doc.headline && doc.content) {
    return { ok: true, subject: doc.subject, headline: doc.headline, content: doc.content };
  }
  const r = doc.html ? convertLegacyTemplate(doc.html, process.env.CLOUDINARY_CLOUD_NAME ?? '') : ({ ok: false } as const);
  if (r.ok) return { ok: true, subject: doc.subject, headline: r.headline, content: r.content };
  return { ok: false, reason: 'unreadable', subject: doc.subject, body: doc.body ?? '' };
}

export const convertTemplateToVisual = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('convertTemplateToVisual', convertTemplateToVisualHandler),
);
```

Export it from `src/index.ts` next to `previewEmailTemplate`. Add it wherever PR 2 registered `previewEmailTemplate`: the admin-callable lists and `CALLABLE_CONTRACT.md`.

- [ ] **Step 4: Run**, first `npx vitest run test/convertTemplateToVisual.test.ts`, then the full `npm test`. Read the summary line: the test count must rise by this PR's new tests, with 0 failed.

- [ ] **Step 5: Commit**: "Add convertTemplateToVisual for the editor's Convert button (#953)".

---

### Task 6: PR

- [ ] Push in its own Bash call, then run `gh pr create` in a separate call. Title: "Convert the email templates to the visual format (#953)". The body covers:
  - the conversion result, including any hand-fixed keys;
  - the Callout mapping;
  - that Template Import now writes visual docs;
  - the operator step: after release, Template Import, tick the untouched templates;
  - test counts.

  End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
