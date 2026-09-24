# Visual Email Editor, PR 2: Server Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Templates can be stored in a visual format (subject, headline, sanitized content) and every email sending route renders them inside one shared frame with an auto-generated text part; a preview callable returns exactly what would be sent.

**Architecture:** Two new pure modules in `mytribe/functions/src/lib/`: `emailContent.ts` (the allowlist sanitizer and token rules) and `emailFrame.ts` (frame, text generation, and `sendPartsFor`, which turns any stored template, old or visual, into the three Handlebars templates `sendTemplatedEmail` already takes). The three senders call `sendPartsFor` instead of reading `subject/body/html` themselves. `saveTemplate` accepts the visual shape and sanitizes it. A new admin callable, `previewEmailTemplate`, renders through the same path.

**Tech Stack:** TypeScript, Firebase Functions v2, zod, sanitize-html 2.17 (already a dependency), htmlparser2 12 (already in the lockfile via sanitize-html; add as a direct dependency), Handlebars, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-visual-email-editor-design.md`

**Depends on:** #952 merged to main (it adds `src/auth/requestPasswordReset.ts` with `loadResetTemplate`). Branch from main after that merge.

## Global Constraints

- Visual template document: `{ subject, headline, content, format: 'visual' }`, and no `body` or `html`.
- Old-format documents (`subject`, `body`, `html?`) send exactly as today. No behavior change for them.
- Allowed content elements: `p`, `br`, `strong`, `em`, `h2`, `h3`, `ul`, `ol`, `li`, `a`, `img`, `blockquote`.
- `blockquote` is the Callout block. It renders as today's `.alert-box`: 7 seeds use it, and the converter maps it. This is the one addition beyond the spec's list, and it is flagged to the operator.
- `a`: keep only `href`, plus `class="button"` for a button. The href must be `https://…`, `mailto:…`, or exactly one merge token `{{name}}`.
- `img`: keep only `src` and `alt`. The src must start with `https://res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/image/upload/`.
- Merge tokens have the form `{{name}}`, where name matches `[A-Za-z_][A-Za-z0-9_.]*`. They are allowed in text and in `href` only. Triple-stash is refused (existing rule).
- `headline` must not be empty. `content` must contain at least one non-empty text block.
- The frame styles are copied verbatim from `mytribe/seeds/notificationTemplates/account.welcome.kinfolk/email.html`, the variant used by 34 of 52 seeds.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Commit with `git commit -F <file>`, where the message file is written with the Write tool.
- Run tests from `mytribe/functions`: `npx vitest run <file>`. The pre-commit hook runs the whole functions suite.

## Review Focus

1. A link whose URL carries `&`, `=` and `%` (the Admin SDK reset link) must arrive verbatim in both parts. Pinned in Task 3.
2. Content pasted from Word or Gmail, with `<span style>`, `<div>` and `<font>`, must save as clean paragraphs, not be refused and not keep the styles. Pinned in Task 1.
3. A merge token inside an `img src`, or split across formatting (`{{li<strong>nk</strong>}}`), must be refused rather than render half a token. Pinned in Task 1.
4. Saving a visual template over an old one must remove `body` and `html`. Otherwise `sendPartsFor` could see both and the old HTML could come back. Pinned in Task 4.
5. The preview for a key with no known merge fields must still render. Unknown tokens are stripped, not left as `{{x}}`. Pinned in Task 5.

---

## Shared interfaces (other PRs' plans depend on these exact names)

```ts
// src/lib/sendFromTemplate.ts (extended)
export interface EmailTemplateDoc {
  subject: string;
  body?: string | null;
  html?: string | null;
  format?: 'visual';
  headline?: string;
  content?: string;
}

// src/lib/emailContent.ts (new)
export const MERGE_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
export interface SanitizeResult { content: string; issues: string[] }
export function sanitizeEmailContent(html: string, cloudName: string): SanitizeResult;

// src/lib/emailFrame.ts (new)
export function isVisualTemplate(doc: EmailTemplateDoc): doc is EmailTemplateDoc & { format: 'visual'; headline: string; content: string };
export function frameHtml(headline: string, content: string): string;
export function contentToText(headline: string, content: string): string;
export interface SendParts { subjectTemplate: string; bodyTemplate: string; htmlTemplate?: string }
export function sendPartsFor(doc: EmailTemplateDoc): SendParts;

// callable saveTemplate: Args gains
//   format?: 'visual'; headline?: string (1..300); content?: string (1..50000)
//   When format === 'visual': body and html must be absent; headline and content required.
// callable previewEmailTemplate (new, wrapAdminCallable, same gate as saveTemplate):
//   req { subject: string; headline: string; content: string; catalogKey?: string }
//   res { subject: string; html: string; text: string; issues: string[] }
```

---

### Task 1: The content sanitizer

**Files:**
- Create: `mytribe/functions/src/lib/emailContent.ts`
- Test: `mytribe/functions/test/emailContent.test.ts`

**Interfaces:**
- Consumes: `sanitize-html` (already a dependency).
- Produces: `MERGE_TOKEN`, `SanitizeResult`, and `sanitizeEmailContent(html, cloudName)`, as in Shared interfaces.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeEmailContent } from '../src/lib/emailContent';

const CLOUD = 'tribetails';
const IMG = `https://res.cloudinary.com/${CLOUD}/image/upload/v1/brand/pup.jpg`;
const clean = (h: string) => sanitizeEmailContent(h, CLOUD);

describe('sanitizeEmailContent', () => {
  it('keeps every allowed element', () => {
    const html =
      '<h2>Hi</h2><h3>Sub</h3><p>A <strong>b</strong> <em>c</em><br>d</p>' +
      '<ul><li>x</li></ul><ol><li>y</li></ol><blockquote><p>careful</p></blockquote>' +
      `<p><a href="https://tribetails.com">site</a></p><p><img src="${IMG}" alt="pup"></p>`;
    const r = clean(html);
    expect(r.issues).toEqual([]);
    expect(r.content).toBe(html);
  });

  it('keeps a button and a token href', () => {
    const r = clean('<p><a href="{{link}}" class="button">Reset</a></p>');
    expect(r.issues).toEqual([]);
    expect(r.content).toBe('<p><a href="{{link}}" class="button">Reset</a></p>');
  });

  it('strips styles, classes, spans, divs and fonts but keeps their text (pasted from Word or Gmail)', () => {
    const r = clean('<div style="color:red"><span class="x"><font face="Arial">Hello</font></span></div><p style="margin:6px 0">there</p>');
    expect(r.content).toBe('<p>Hello</p><p>there</p>');
    expect(r.issues).toEqual([]);
  });

  it('removes scripts, event handlers and javascript: links entirely', () => {
    const r = clean('<p onclick="x()">a</p><script>alert(1)</script><p><a href="javascript:alert(1)">b</a></p>');
    expect(r.content).toBe('<p>a</p><p>b</p>');
  });

  it('drops images from anywhere but our Cloudinary', () => {
    const r = clean('<p><img src="https://evil.example/x.png"></p><p>t</p>');
    expect(r.content).toBe('<p></p><p>t</p>');
    expect(r.issues).toContain('Removed an image that is not from your Cloudinary library.');
  });

  it('refuses a token anywhere but text or href', () => {
    const r = clean(`<p><img src="${IMG}" alt="{{name}}"></p>`);
    expect(r.issues).toContain('A merge field can only be used in text or as a link target.');
  });

  it('refuses a token split by formatting', () => {
    const r = clean('<p>{{li<strong>nk</strong>}}</p>');
    expect(r.issues).toContain('A merge field was broken apart by formatting. Retype it as one piece.');
  });

  it('refuses an href that mixes a token with other text', () => {
    const r = clean('<p><a href="https://x.com/{{id}}">a</a></p>');
    expect(r.issues).toContain('A link target must be a web address or a single merge field, not both.');
  });

  it('refuses triple-stash', () => {
    expect(clean('<p>{{{raw}}}</p>').issues).toContain('Triple braces {{{ }}} are not allowed.');
  });

  it('reports empty content', () => {
    expect(clean('<p> </p>').issues).toContain('The email body is empty.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mytribe/functions && npx vitest run test/emailContent.test.ts`
Expected: FAIL. `Cannot find module '../src/lib/emailContent'`.

- [ ] **Step 3: Implement**

```ts
import sanitizeHtml from 'sanitize-html';

/**
 * #953: the one allowlist every visual email body passes through, on every save
 * door (saveTemplate, the importer) and in the preview. A body that survives
 * this can be framed, turned into text and rendered by any client.
 */
export const MERGE_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const SINGLE_TOKEN = /^\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}$/;

export interface SanitizeResult {
  content: string;
  issues: string[];
}

const BLOCK_WRAPPERS = ['div', 'section', 'article', 'header', 'footer', 'main'];

export function sanitizeEmailContent(html: string, cloudName: string): SanitizeResult {
  const issues = new Set<string>();
  if (/\{\{\{/.test(html)) issues.add('Triple braces {{{ }}} are not allowed.');

  const imagePrefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;

  const content = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'h2', 'h3', 'ul', 'ol', 'li', 'a', 'img', 'blockquote'],
    allowedAttributes: { a: ['href', 'class'], img: ['src', 'alt'] },
    allowedClasses: { a: ['button'] },
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    // Pasted wrappers become paragraphs so their text survives as its own block.
    transformTags: {
      ...Object.fromEntries(BLOCK_WRAPPERS.map((t) => [t, 'p'])),
      b: 'strong',
      i: 'em',
      h1: 'h2',
      h4: 'h3',
      h5: 'h3',
      h6: 'h3',
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') {
        const src = frame.attribs['src'] ?? '';
        if (!src.startsWith(imagePrefix)) {
          issues.add('Removed an image that is not from your Cloudinary library.');
          return true;
        }
      }
      return false;
    },
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title'],
  });

  // Nested <p> from wrapper transforms (<div><p>x</p></div> -> <p><p>x</p></p>) collapse.
  const flattened = content.replace(/<p>\s*<p>/g, '<p>').replace(/<\/p>\s*<\/p>/g, '</p>');

  // Tokens: only in text or as a whole href.
  for (const m of flattened.matchAll(/<[^>]+>/g)) {
    const tag = m[0];
    for (const attr of tag.matchAll(/(\w+)="([^"]*)"/g)) {
      const [, name, value] = attr;
      if (!value.includes('{{')) continue;
      if (name !== 'href') issues.add('A merge field can only be used in text or as a link target.');
      else if (!SINGLE_TOKEN.test(value)) issues.add('A link target must be a web address or a single merge field, not both.');
    }
  }
  const text = flattened.replace(/<[^>]+>/g, '\u0000');
  if (/\{\{[^}]*\u0000/.test(text)) issues.add('A merge field was broken apart by formatting. Retype it as one piece.');

  if (flattened.replace(/<[^>]+>/g, '').trim().length === 0 && !/<img /.test(flattened)) {
    issues.add('The email body is empty.');
  }

  return { content: flattened, issues: [...issues] };
}
```

Note: sanitize-html drops an `href` whose scheme isn't allowed. A `{{link}}` href has no scheme, so it's kept as a relative URL. That is why the token check above runs after sanitizing.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/emailContent.test.ts`
Expected: PASS, 10 tests. If the wrapper case produces `<p></p>` pairs, adjust only the `flattened` normalisation, never the expectations.

sanitize-html 2.17.7 writes void elements as `<br />` and `<img ... />`; this was checked by running it with these options. So add this to the `flattened` chain: `.replace(/<br \/>/g, '<br>').replace(/<img([^>]*?) \/>/g, '<img$1>')`. The stored form is `<br>` and `<img ...>`, which is what PR 4's web editor serializes and what PR 5's Android parser round-trips. Keep the expectations as written. sanitize-html keeps attributes in the order they arrive; tests that compare exact strings must put `href` before `class` on buttons, as PR 4 serializes them.

- [ ] **Step 5: Commit**

Message file: `Add the visual email content sanitizer (#953)`, a short body, and the Co-Authored-By line.
`git add src/lib/emailContent.ts test/emailContent.test.ts && git commit -F <file>`

---

### Task 2: The frame and the text part

**Files:**
- Create: `mytribe/functions/src/lib/emailFrame.ts`
- Modify: `mytribe/functions/src/lib/sendFromTemplate.ts` (the `EmailTemplateDoc` interface)
- Modify: `mytribe/functions/package.json`: add `"htmlparser2": "^12.0.0"` to dependencies, then run `npm install` (the lockfile already holds 12.0.0)
- Test: `mytribe/functions/test/emailFrame.test.ts`

**Interfaces:**
- Consumes: `EmailTemplateDoc`.
- Produces: `isVisualTemplate`, `frameHtml`, `contentToText`, `SendParts` and `sendPartsFor`, as in Shared interfaces.

- [ ] **Step 1: Extend `EmailTemplateDoc`** in `src/lib/sendFromTemplate.ts`:

```ts
/** One `emailTemplates/{id}` document, as the senders consume it. */
export interface EmailTemplateDoc {
  subject: string;
  /** Old format only. */
  body?: string | null;
  /** Old format only. */
  html?: string | null;
  /** #953: 'visual' means headline + content, framed at send time. */
  format?: 'visual';
  headline?: string;
  content?: string;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { contentToText, frameHtml, isVisualTemplate, sendPartsFor } from '../src/lib/emailFrame';

describe('frameHtml', () => {
  it('puts headline and content inside the shared frame', () => {
    const html = frameHtml('Reset your password', '<p>Hi</p>');
    expect(html).toContain('<div class="header"><h2>Reset your password</h2></div>');
    expect(html).toContain('<div class="content"><p>Hi</p></div>');
    expect(html).toContain("Tribe Tails Pet Care. Your Kin's Favorite Auntie.");
    expect(html).toContain('border-top: 8px solid #D5535A');
    expect(html).toContain('blockquote {');
  });
});

describe('contentToText', () => {
  it('turns blocks into lines, buttons into Label: href, links into text (href)', () => {
    const text = contentToText(
      'Reset',
      '<p>Hi {{displayName}},</p><h3>Steps</h3><ul><li>One</li><li>Two</li></ul>' +
        '<p><a href="{{link}}" class="button">Reset Password</a></p>' +
        '<p>See <a href="https://tribetails.com/help">help</a> or https://x.com.</p>' +
        '<blockquote><p>Careful</p></blockquote><p>Take care,<br><strong>Auntie</strong></p>',
    );
    expect(text).toBe(
      [
        'Reset',
        '',
        'Hi {{displayName}},',
        '',
        'Steps',
        '',
        '- One',
        '- Two',
        '',
        'Reset Password: {{link}}',
        '',
        'See help (https://tribetails.com/help) or https://x.com.',
        '',
        'Careful',
        '',
        'Take care,',
        'Auntie',
      ].join('\n'),
    );
  });

  it('numbers ordered lists and skips images', () => {
    expect(contentToText('H', '<ol><li>a</li><li>b</li></ol><p><img src="x" alt="y"></p>')).toBe('H\n\n1. a\n2. b');
  });

  it('does not repeat a link whose text is its address', () => {
    expect(contentToText('H', '<p><a href="https://x.com">https://x.com</a></p>')).toBe('H\n\nhttps://x.com');
  });
});

describe('sendPartsFor', () => {
  it('passes an old-format template through untouched', () => {
    expect(sendPartsFor({ subject: 's', body: 'b', html: '<p>h</p>' })).toEqual({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: '<p>h</p>',
    });
    expect(sendPartsFor({ subject: 's', body: 'b', html: null })).toEqual({ subjectTemplate: 's', bodyTemplate: 'b' });
  });

  it('frames a visual template and generates its text', () => {
    const parts = sendPartsFor({ subject: 's', format: 'visual', headline: 'H', content: '<p>x</p>' });
    expect(parts.subjectTemplate).toBe('s');
    expect(parts.bodyTemplate).toBe('H\n\nx');
    expect(parts.htmlTemplate).toContain('<div class="content"><p>x</p></div>');
  });

  it('isVisualTemplate needs the flag and both fields', () => {
    expect(isVisualTemplate({ subject: 's', format: 'visual', headline: 'H', content: '<p>x</p>' })).toBe(true);
    expect(isVisualTemplate({ subject: 's', format: 'visual', headline: 'H' })).toBe(false);
    expect(isVisualTemplate({ subject: 's', body: 'b' })).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/emailFrame.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/lib/emailFrame.ts`**

```ts
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import type { EmailTemplateDoc } from './sendFromTemplate';

/**
 * #953: the one shared frame every visual email is sent in, and the text part
 * generated from the same content. A change here reaches every email. The
 * styles are the variant 34 of the 52 seed templates carried, verbatim, plus
 * `blockquote` for the Callout block (the old `.alert-box`).
 */
const FRAME_STYLE = `
        body { background-color: #fbfbf9; color: #11131f; font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-top: 8px solid #D5535A; border-bottom: 4px solid #11131f; }
        .header { padding: 30px 40px 10px 40px; background-color: #fff5f2; }
        .header h2 { color: #D5535A; margin: 0; }
        .content { padding: 10px 40px 30px 40px; font-size: 16px; }
        .footer { padding: 20px 40px; background-color: #11131f; color: #fbfbf9; font-size: 12px; text-align: center; }
        .button { display: inline-block; padding: 14px 28px; background: #df8431; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 20px 0; }
        blockquote { background-color: #fff5f5; border-left: 4px solid #D5535A; padding: 15px 20px; margin: 20px 0; border-radius: 0 4px 4px 0; }`;

const FOOTER = "Tribe Tails Pet Care. Your Kin's Favorite Auntie.";

export function isVisualTemplate(
  doc: EmailTemplateDoc,
): doc is EmailTemplateDoc & { format: 'visual'; headline: string; content: string } {
  return doc.format === 'visual' && typeof doc.headline === 'string' && typeof doc.content === 'string';
}

export function frameHtml(headline: string, content: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `    <style>${FRAME_STYLE}`,
    '    </style>',
    '</head>',
    '<body>',
    '    <div class="container">',
    `        <div class="header"><h2>${headline}</h2></div>`,
    `        <div class="content">${content}</div>`,
    `        <div class="footer">${FOOTER}</div>`,
    '    </div>',
    '</body>',
    '</html>',
  ].join('\n');
}

function textOf(node: ChildNode): string {
  if (node.type === 'text') return node.data;
  if (node.type !== 'tag') return '';
  const el = node as Element;
  if (el.name === 'br') return '\n';
  if (el.name === 'img') return '';
  const inner = el.children.map(textOf).join('');
  if (el.name === 'a') {
    const href = el.attribs['href'] ?? '';
    const label = inner.trim();
    if (el.attribs['class'] === 'button') return `${label}: ${href}`;
    return !href || label === href ? inner : `${inner} (${href})`;
  }
  return inner;
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function contentToText(headline: string, content: string): string {
  const blocks: string[] = [headline.trim()];
  const doc = parseDocument(content, { decodeEntities: false });
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'tag') continue;
      const el = node as Element;
      if (el.name === 'ul' || el.name === 'ol') {
        const items = el.children.filter((c): c is Element => c.type === 'tag' && (c as Element).name === 'li');
        blocks.push(items.map((li, i) => `${el.name === 'ol' ? `${i + 1}.` : '-'} ${decode(textOf(li)).trim()}`).join('\n'));
      } else if (el.name === 'blockquote') {
        walk(el.children);
      } else {
        const line = decode(textOf(el)).split('\n').map((l) => l.trim()).join('\n').trim();
        if (line) blocks.push(line);
      }
    }
  };
  walk(doc.children);
  return blocks.join('\n\n');
}

export interface SendParts {
  subjectTemplate: string;
  bodyTemplate: string;
  htmlTemplate?: string;
}

/** Any stored template, old or visual, as the three Handlebars templates the transport takes. */
export function sendPartsFor(doc: EmailTemplateDoc): SendParts {
  if (isVisualTemplate(doc)) {
    return {
      subjectTemplate: doc.subject,
      bodyTemplate: contentToText(doc.headline, doc.content),
      htmlTemplate: frameHtml(doc.headline, doc.content),
    };
  }
  return {
    subjectTemplate: doc.subject,
    bodyTemplate: doc.body ?? '',
    ...(doc.html ? { htmlTemplate: doc.html } : {}),
  };
}
```

`domhandler` comes with htmlparser2, so its types resolve. If `tsc` can't find `domhandler`, add `"domhandler": "^5.0.3"` to dependencies. It is already in the lockfile.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/emailFrame.test.ts && npx tsc --noEmit -p .`. Expected: PASS, and tsc clean.

- [ ] **Step 6: Commit** (`Add the shared email frame and text generation (#953)`, with package.json and package-lock.json included).

---

### Task 3: Every sending route uses `sendPartsFor`

**Files:**
- Modify: `mytribe/functions/src/notifications/senders/emailChannel.ts` (the send at the end of `sendEmailChannel`)
- Modify: `mytribe/functions/src/lib/sendFromTemplate.ts` (`sendFromTemplate`)
- Modify: `mytribe/functions/src/auth/requestPasswordReset.ts` (the `sendTemplatedEmail` call in `processPasswordResetRequest`)
- Test: `mytribe/functions/test/visualSendRoutes.test.ts`

**Interfaces:**
- Consumes: `sendPartsFor(doc): SendParts` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test.** Real renderer, fake transport. It checks each route with both formats, and that an Admin SDK-shaped link survives.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { sendFromTemplate } from '../src/lib/sendFromTemplate';
import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import { renderEmailParts } from '../src/lib/email';
import { sendPartsFor } from '../src/lib/emailFrame';

const LINK = 'https://kinfolk.tribetails.com/account/secure-reset?mode=resetPassword&oobCode=a-1&continueUrl=https%3A%2F%2Fkinfolk.tribetails.com%2Fsignin';
const VISUAL = { subject: 'Hi {{displayName}}', format: 'visual', headline: 'Reset', content: '<p>Hello {{displayName}}</p><p><a href="{{link}}" class="button">Go</a></p>' };
const OLD = { subject: 'Old', body: 'Body {{link}}', html: "<p><a href='{{link}}'>x</a></p>" };

function sentBody() {
  return JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SMTP2GO_API_KEY', 'k');
  vi.stubEnv('EMAIL_FROM', 'auntie@tribetails.com');
  vi.stubEnv('SEND_SUPPRESS', '');
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: { succeeded: 1, email_id: 'e1' } }) });
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('visual templates on every route', () => {
  it('the link survives a real render of a visual template', () => {
    const out = renderEmailParts({ ...sendPartsFor(VISUAL as never), data: { link: LINK, displayName: 'Pat' } });
    expect(out.html).toContain(`href="${LINK}"`);
    expect(out.text).toContain(`Go: ${LINK}`);
    expect(out.subject).toBe('Hi Pat');
  });

  for (const [name, doc] of [['visual', VISUAL], ['old', OLD]] as const) {
    it(`sendFromTemplate sends a ${name} template`, async () => {
      mocks.dbFn.mockReturnValue(buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': doc } }).db);
      await sendFromTemplate('k', 'pat@x.test', { link: LINK, displayName: 'Pat' });
      const b = sentBody();
      expect(b.text_body).toContain(LINK);
      if (name === 'visual') expect(b.html_body).toContain('<div class="header"><h2>Reset</h2></div>');
      else expect(b.html_body).toBe(`<p><a href='${LINK}'>x</a></p>`);
    });

    it(`the notification email channel sends a ${name} template`, async () => {
      mocks.dbFn.mockReturnValue(
        buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': doc, 'clients/u1': { email: 'pat@x.test' } } }).db,
      );
      await sendEmailChannel({ def: { key: 'k', templates: { email: 'k' } } as never, recipientUid: 'u1', data: { link: LINK, displayName: 'Pat' } } as never);
      expect(sentBody().text_body).toContain(LINK);
    });
  }
});
```

For the reset route, add one case to `test/requestPasswordReset.test.ts` under `sending`:

```ts
  it('sends a visual stored template framed, with its generated text', async () => {
    setup({ 'emailTemplates/auth.password.reset': { subject: 'S', format: 'visual', headline: 'H', content: '<p><a href="{{link}}" class="button">Go</a></p>' } });
    await processPasswordResetRequest({ email: KIN_EMAIL, networkKey: NET });
    const args = mocks.sendTemplatedEmail.mock.calls[0]![0];
    expect(args.bodyTemplate).toBe('H\n\nGo: {{link}}');
    expect(args.htmlTemplate).toContain('<div class="header"><h2>H</h2></div>');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/visualSendRoutes.test.ts test/requestPasswordReset.test.ts`. Expected: the visual cases FAIL, because `bodyTemplate` is undefined and no frame is applied.

- [ ] **Step 3: Implement.** Replace each call site's hand-built parts with `sendPartsFor`.

`sendFromTemplate.ts`:

```ts
import { sendPartsFor } from './emailFrame';
// ...
export async function sendFromTemplate(key: string, to: string, data: Record<string, unknown>): Promise<string> {
  const tpl = await loadEmailTemplate(key);
  if (!tpl) throw new Error(`email template missing: resolved from ${key}`);
  return sendTemplatedEmail({ to, data, ...sendPartsFor(tpl) });
}
```

`emailChannel.ts`, the final send:

```ts
  const providerMessageId = await sendTemplatedEmail({ to: email, data: renderData, ...sendPartsFor(tpl) });
```

(add `import { sendPartsFor } from '../../lib/emailFrame';`)

`requestPasswordReset.ts`, inside the try:

```ts
    await sendTemplatedEmail({
      to: user.email,
      data: { link, email: user.email, displayName: user.displayName || user.email },
      ...sendPartsFor(loaded.template),
    });
```

(add `import { sendPartsFor } from '../lib/emailFrame';`)

`emailFrame.ts` imports only the type from `sendFromTemplate.ts`, and `sendFromTemplate.ts` imports the function from `emailFrame.ts`. A type-only import creates no runtime cycle.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/visualSendRoutes.test.ts test/requestPasswordReset.test.ts test/requestPasswordResetRender.test.ts test/dispatcherFanout.test.ts`. Expected: all PASS.

- [ ] **Step 5: Commit** (`Send visual templates in the shared frame on every route (#953)`).

---

### Task 4: `saveTemplate` accepts and sanitizes the visual format

**Files:**
- Modify: `mytribe/functions/src/admin/saveTemplate.ts`
- Modify: `mytribe/functions/test/callableContract.test.ts` (the `saveTemplate` entry, around line 411: add the three optional fields)
- Test: `mytribe/functions/test/saveTemplateVisual.test.ts`

**Interfaces:**
- Consumes: `sanitizeEmailContent` (Task 1).
- Produces: `Args` gains `format`, `headline` and `content`. The response is unchanged: `{ templateId }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { saveTemplateHandler } from '../src/admin/saveTemplate';

let ctx: ReturnType<typeof buildDbMock>;
beforeEach(() => {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
  ctx = buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': { subject: 'Old', body: 'b', html: '<p>h</p>' } } });
  mocks.dbFn.mockReturnValue(ctx.db);
});
const save = (data: Record<string, unknown>) => saveTemplateHandler(callableRequest(data, { uid: 'op1' }));
const written = () => ctx.writes.filter((w: { path: string }) => w.path === 'emailTemplates/k').at(-1)!.data;

describe('saveTemplate, visual format', () => {
  it('stores subject, headline, sanitized content and the flag, and deletes body and html', async () => {
    await save({ templateId: 'k', subject: 'S', format: 'visual', headline: 'H', content: '<div style="x">Hi</div>' });
    const d = written();
    expect(d).toMatchObject({ subject: 'S', headline: 'H', content: '<p>Hi</p>', format: 'visual' });
    expect(d.body).toEqual(FieldValue.delete());
    expect(d.html).toEqual(FieldValue.delete());
  });

  it('refuses a token outside text or href with the sanitizer message', async () => {
    await expect(
      save({ templateId: 'k', subject: 'S', format: 'visual', headline: 'H', content: '<p><img src="https://res.cloudinary.com/tribetails/image/upload/a.png" alt="{{x}}"></p>' }),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: expect.stringContaining('merge field can only be used') });
  });

  it('refuses a visual save that also sends body or html', async () => {
    await expect(save({ templateId: 'k', subject: 'S', format: 'visual', headline: 'H', content: '<p>x</p>', body: 'b' })).rejects.toBeTruthy();
  });

  it('refuses an empty headline', async () => {
    await expect(save({ templateId: 'k', subject: 'S', format: 'visual', headline: ' ', content: '<p>x</p>' })).rejects.toBeTruthy();
  });

  it('old-format saves are unchanged', async () => {
    await save({ templateId: 'k', subject: 'S2', body: 'b2', html: null });
    expect(written()).toMatchObject({ subject: 'S2', body: 'b2', html: null });
    expect(written().format).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/saveTemplateVisual.test.ts`. Expected: FAIL, because zod rejects an absent `body`.

- [ ] **Step 3: Implement.** In `saveTemplate.ts`:
  - Make `body` optional in `Args`: `z.string().min(1).max(20000).refine(noTripleStash, …).optional()`.
  - Add the new fields:

```ts
  // #953: the visual format. Body and html are generated at send time, so a
  // visual save carries neither.
  format: z.literal('visual').optional(),
  headline: z.string().max(300).refine(noTripleStash, { message: tripleStashMessage('headline') }).optional(),
  content: z.string().max(50000).optional(),
```

and after the object, `.superRefine`:

```ts
}).superRefine((a, ctx) => {
  if (a.format === 'visual') {
    if (a.body !== undefined || (a.html !== undefined && a.html !== null)) {
      ctx.addIssue({ code: 'custom', message: 'A visual template has no body or html; they are generated at send time.' });
    }
    if (!a.headline || a.headline.trim() === '') ctx.addIssue({ code: 'custom', message: 'The headline is empty.' });
    if (!a.content) ctx.addIssue({ code: 'custom', message: 'The email body is empty.' });
  } else if (!a.body) {
    ctx.addIssue({ code: 'custom', message: 'body is required.' });
  }
});
```

  In the handler, parse with `Args.safeParse` and turn failures into `HttpsError('invalid-argument', issues.join(' '))`. Check first how the handler surfaces zod errors today, through `wrapAdminCallable`. If it already maps a ZodError to invalid-argument, keep `Args.parse`. Then build `data` like this:

```ts
  const visual = args.format === 'visual';
  let content: string | undefined;
  if (visual) {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME ?? '';
    const r = sanitizeEmailContent(args.content!, cloud);
    const blocking = r.issues.filter((i) => !i.startsWith('Removed an image'));
    if (blocking.length) throw new HttpsError('invalid-argument', blocking.join(' '));
    content = r.content;
  }
  const data: Record<string, unknown> = {
    subject: args.subject,
    ...(visual
      ? { format: 'visual', headline: args.headline!.trim(), content, body: FieldValue.delete(), html: FieldValue.delete() }
      : { body: args.body, html: args.html ?? null }),
    // ...the existing title/description/tags/category/updatedAt/createdAt fields unchanged
  };
```

  - `expectNew` uses `ref.create(data)`, and `create()` refuses `FieldValue.delete()`. So on the create path, drop the two delete sentinels: `if (args.expectNew) { delete data.body; delete data.html; }` before `create`.
  - Add `'CLOUDINARY_CLOUD_NAME'` to the callable's `secrets` array. Name it as the string, as other callables do (`confirmBrandAssetUpload.ts` uses the `defineSecret` form; either works).
  - Update `callableContract.test.ts`'s `saveTemplate` frozen shape with the three optional fields, and `body` now optional.

- [ ] **Step 4: Run.** `npx vitest run test/saveTemplateVisual.test.ts test/callableContract.test.ts test/saveTemplate*.test.ts`. Expected: PASS. Existing saveTemplate tests must still pass unchanged. If one fails because `body` is now optional in the frozen contract, update only the contract snapshot, never a behavior assertion.

- [ ] **Step 5: Commit** (`saveTemplate stores the visual format, sanitized (#953)`).

---

### Task 4a: `listTemplates` returns the visual fields

Every admin client loads templates through `listTemplates`: web, and Android and desktop through their repositories. Without `format` they can't tell a visual template from an old one. PR 1's read-only rule and PR 4's "Old format" badge both depend on this task.

**Files:**
- Modify: `mytribe/functions/src/admin/listTemplates.ts` (`TemplateDoc` type and the row map)
- Test: `mytribe/functions/test/listTemplates.test.ts` (add cases)

- [ ] **Step 1: Write the failing test.** Add to `listTemplates.test.ts`, reusing its existing db mock setup:

```ts
  it('returns format, headline and content for a visual template, and nulls for an old one', async () => {
    // seed the file's db mock with:
    //   emailTemplates/vis: { subject: 'S', format: 'visual', headline: 'H', content: '<p>c</p>' }
    //   emailTemplates/old: { subject: 'O', body: 'b', html: null }
    const { templates } = await listTemplatesHandler(callableRequest({}, { uid: 'op1' }));
    const vis = templates.find((t) => t.templateId === 'vis')!;
    const old = templates.find((t) => t.templateId === 'old')!;
    expect(vis).toMatchObject({ format: 'visual', headline: 'H', content: '<p>c</p>', body: '', html: null });
    expect(old).toMatchObject({ format: null, headline: null, content: null, body: 'b' });
  });
```

Use the file's existing mock helper to seed these two documents; match how its other cases seed.

- [ ] **Step 2: Run to verify it fails.** Run `npx vitest run test/listTemplates.test.ts`. Expected: FAIL, because `format` is undefined.

- [ ] **Step 3: Implement.** Add to `TemplateDoc`: `format?: string; headline?: string; content?: string;`. Add to the returned row:

```ts
      // #953: visual templates. Null on old-format rows so clients can branch on `format`.
      format: data.format === 'visual' ? 'visual' : data.format ? String(data.format) : null,
      headline: typeof data.headline === 'string' ? data.headline : null,
      content: typeof data.content === 'string' ? data.content : null,
```

An unknown `format` value is passed through as it is, so PR 1's clients treat it as READ_ONLY.

- [ ] **Step 4: Run.** Run `npx vitest run test/listTemplates.test.ts`. Expected: PASS. If `callableContract.test.ts` freezes the `listTemplates` response shape, update that snapshot with the three fields.

- [ ] **Step 5: Commit**: "listTemplates returns the visual template fields (#953)".

---

### Task 5: `previewEmailTemplate`

**Files:**
- Create: `mytribe/functions/src/admin/previewEmailTemplate.ts`
- Modify: `mytribe/functions/src/index.ts` (export it next to `saveTemplate`)
- Test: `mytribe/functions/test/previewEmailTemplate.test.ts`

**Interfaces:**
- Consumes: `sanitizeEmailContent`, `sendPartsFor`, `renderEmailParts` (`lib/email.ts`), and `TEMPLATE_FIELDS` (`notifications/enrichTemplateData.ts`).
- Produces: callable `previewEmailTemplate`, with req `{ subject, headline, content, catalogKey? }` and res `{ subject, html, text, issues }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callableRequest } from './_helpers/callableRequest';
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
import { previewEmailTemplateHandler, sampleDataFor } from '../src/admin/previewEmailTemplate';
import { renderEmailParts } from '../src/lib/email';
import { sendPartsFor } from '../src/lib/emailFrame';

beforeEach(() => vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails'));
const req = { subject: 'Hi {{displayName}}', headline: 'Reset', content: '<p>{{displayName}}</p><p><a href="{{link}}" class="button">Go</a></p>' };

describe('previewEmailTemplate', () => {
  it('renders exactly what a real send renders, with sample data for the key', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, catalogKey: 'auth.password.reset' }, { uid: 'op1' }));
    const real = renderEmailParts({
      ...sendPartsFor({ subject: req.subject, format: 'visual', headline: req.headline, content: req.content }),
      data: sampleDataFor('auth.password.reset'),
    });
    expect(res).toEqual({ ...real, issues: [] });
  });

  it('samples link-like fields as https URLs so buttons are clickable', () => {
    expect(sampleDataFor('auth.password.reset')['link']).toMatch(/^https:\/\//);
  });

  it('renders with no key, stripping unknown tokens', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: '<p>{{mystery}}x</p>' }, { uid: 'op1' }));
    expect(res.html).not.toContain('{{');
    expect(res.text).toBe('Reset\n\nx');
  });

  it('returns sanitizer issues instead of throwing, so the editor can show them', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: '<p>{{{raw}}}</p>' }, { uid: 'op1' }));
    expect(res.issues).toContain('Triple braces {{{ }}} are not allowed.');
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Expected: module not found.

- [ ] **Step 3: Implement**

```ts
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeEmailContent } from '../lib/emailContent';
import { sendPartsFor } from '../lib/emailFrame';
import { renderEmailParts } from '../lib/email';
import { TEMPLATE_FIELDS } from '../notifications/enrichTemplateData';

/**
 * #953: what the editor shows beside the content. Same sanitizer, same frame,
 * same renderer as a real send, so the preview cannot disagree with the inbox.
 */
const Args = z.object({
  subject: z.string().max(500),
  headline: z.string().max(300),
  content: z.string().max(50000),
  catalogKey: z.string().max(200).optional(),
});

const SAMPLE_URL = 'https://kinfolk.tribetails.com/sample';

export function sampleDataFor(catalogKey?: string): Record<string, string> {
  const fields = (catalogKey && TEMPLATE_FIELDS[catalogKey]) || [];
  const out: Record<string, string> = {};
  for (const f of fields) out[f] = /link|url/i.test(f) ? SAMPLE_URL : `[${f}]`;
  return out;
}

export async function previewEmailTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ subject: string; html: string; text: string; issues: string[] }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);
  const { content, issues } = sanitizeEmailContent(args.content, process.env.CLOUDINARY_CLOUD_NAME ?? '');
  const parts = sendPartsFor({ subject: args.subject, format: 'visual', headline: args.headline, content });
  const out = renderEmailParts({ ...parts, data: sampleDataFor(args.catalogKey) });
  return { subject: out.subject, html: out.html ?? '', text: out.text, issues };
}

export const previewEmailTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('previewEmailTemplate', previewEmailTemplateHandler),
);
```

Add `export { previewEmailTemplate } from './admin/previewEmailTemplate';` to `src/index.ts` beside `saveTemplate`. Check `test/appCheck*.test.ts` and any callable registry test (`git grep -n "saveTemplate" test | grep -v saveTemplate.test`) and add `previewEmailTemplate` wherever `saveTemplate` is listed as an admin callable. Also add it to `CALLABLE_CONTRACT.md` under `saveTemplate` in the same style.

- [ ] **Step 4: Run.** `npx vitest run test/previewEmailTemplate.test.ts` and then the full `npm test`. Expected: PASS everywhere. Read the summary line and confirm the number of files run is at least the pre-change count.

- [ ] **Step 5: Commit** (`Add previewEmailTemplate (#953)`).

---

### Task 6: PR

- [ ] Push the branch in its own Bash call, then `gh pr create` in a separate call. Title: `Visual email templates: server format, frame and preview (#953)`. Body: what changed, the Callout addition (flagged for the operator), that old-format templates are unchanged, the test counts read from the output, and the note that it depends on #952 being merged. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
