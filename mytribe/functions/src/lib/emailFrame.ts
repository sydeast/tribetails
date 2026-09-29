import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import type { EmailTemplateDoc } from './sendFromTemplate';
import { DEFAULT_EMAIL_FRAME, type EmailFrame } from './emailFrameConfig';

/**
 * #953: the one shared frame every visual email is sent in, and the text part
 * generated from the same content. A change here reaches every email.
 *
 * Ruling fix: an earlier draft of this file copied the RED security-alert
 * scheme (`auth.password.reset`, 9 of 52 seeds) under the mistaken belief
 * that it was the dominant variant. Controller ruling: the shared frame is
 * the DOMINANT, orange scheme -- verified 34 of 52 seeds, e.g. the pre-#953
 * `mytribe/seeds/notificationTemplates/account.welcome.kinfolk/email.html`
 * (now split across `content.html` and `headline.txt`)
 * (`border-top: #df8431`, no `.header` background, `h2 { color: #11131f }`,
 * orange `.button`). `blockquote` was that file's `.alert-box` rule,
 * selector changed to `blockquote`, for the Callout block. The 9 red
 * security-alert seeds now share this frame too; their warning content goes
 * in a Callout (`blockquote`) rather than getting its own color scheme.
 *
 * #957: the colors, the footer line, an optional header line and an optional
 * logo are now the operator's (`emailFrameConfig.ts`, stored in
 * `business_settings/email_frame`, read per send by `emailFrameStore.ts`).
 * The values above are the defaults, and with nothing stored the output is
 * byte-identical to the frame before it was editable.
 */
function frameStyle(f: EmailFrame): string {
  return `
        body { background-color: ${f.pageBackground}; color: ${f.textColor}; font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: ${f.cardBackground}; border-top: 8px solid ${f.accentColor}; border-bottom: 4px solid ${f.footerBackground}; }
        .header { padding: 30px 40px 10px 40px; }
        .header h2 { color: ${f.headlineColor}; margin: 0; }
        .content { padding: 10px 40px 30px 40px; font-size: 16px; }
        .footer { padding: 20px 40px; background-color: ${f.footerBackground}; color: ${f.footerTextColor}; font-size: 12px; text-align: center; }
        .button { display: inline-block; padding: 14px 28px; background: ${f.accentColor}; color: ${f.buttonTextColor}; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 20px 0; }
        blockquote { background-color: ${f.calloutBackground}; border-left: 4px solid ${f.accentColor}; padding: 15px 20px; margin: 20px 0; border-radius: 0 4px 4px 0; }`;
}

export function isVisualTemplate(
  doc: EmailTemplateDoc,
): doc is EmailTemplateDoc & { format: 'visual'; headline: string; content: string } {
  return doc.format === 'visual' && typeof doc.headline === 'string' && typeof doc.content === 'string';
}

// #953 review fix: `headline` is plain operator-typed text, not markup, but it
// lands directly inside `<h2>`. An unescaped `&`, `<`, `>` or `"` would either
// break the frame's markup or (worse) let a stray `<script>` typed into the
// headline field execute in the recipient's mail client. Escaped here, not at
// render time, because `frameHtml`'s caller (`sendPartsFor`) hands the RESULT
// to Handlebars as `htmlTemplate`, and Handlebars only escapes `{{var}}`
// substitutions, never the literal template text surrounding them.
//
// `{{token}}` must survive intact: a headline is allowed to carry a merge
// field (see `visualSendRoutes.test.ts`), and curly braces are not among the
// characters this escapes, so a token is untouched by construction.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * #957: operator text placed in the frame as element content. `&`, `<` and
 * `>` are escaped so it can never become markup. The braces are escaped too:
 * this HTML is Handlebars template text, and a `{{` typed into the footer
 * would otherwise become a merge field. Quotes are left alone because this is
 * element content, not an attribute, which keeps the default footer's
 * apostrophe byte-identical to the frame before it was editable.
 */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/** An attribute value: full escaping plus the braces, for the same Handlebars reason. */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

/**
 * The optional header additions. Inline styles, not new `<style>` rules, so a
 * frame with neither set renders the exact `<style>` block it always has.
 */
function headerExtras(f: EmailFrame): string {
  const parts: string[] = [];
  if (f.logoUrl) {
    const alt = f.headerText || 'Tribe Tails';
    parts.push(
      `<img src="${escapeAttr(f.logoUrl)}" alt="${escapeAttr(alt)}" width="160" style="display: block; max-width: 160px; height: auto; margin: 0 0 12px 0; border: 0;">`,
    );
  }
  if (f.headerText) {
    parts.push(
      `<p style="margin: 0 0 8px 0; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: ${f.accentColor};">${escapeText(f.headerText)}</p>`,
    );
  }
  return parts.join('');
}

export function frameHtml(headline: string, content: string, frame: EmailFrame = DEFAULT_EMAIL_FRAME): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `    <style>${frameStyle(frame)}`,
    '    </style>',
    '</head>',
    '<body>',
    '    <div class="container">',
    `        <div class="header">${headerExtras(frame)}<h2>${escapeHtml(headline)}</h2></div>`,
    `        <div class="content">${content}</div>`,
    `        <div class="footer">${escapeText(frame.footerText)}</div>`,
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
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

export function contentToText(headline: string, content: string): string {
  const blocks: string[] = [headline.trim()];
  const doc = parseDocument(content, { decodeEntities: false });
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'tag') continue;
      const el = node as Element;
      if (el.name === 'ul' || el.name === 'ol') {
        // Walked in DOCUMENT ORDER, not `<li>`-only: `{{#each visits}}` /
        // `{{/each}}` (assignment.assigned, kincare.booking.confirm) are bare
        // text nodes the seed writer put directly inside the `<ul>`, around
        // the single `<li>` that is the loop's body. Dropping them (as the
        // old `<li>`-only filter did) left the `<li>` line with no `#each`
        // wrapper around it, so `{{this.weekday}}` etc. resolved against the
        // top-level context instead of a loop item and rendered blank -- one
        // broken `- ,  at ` line instead of one line per visit.
        //
        // A number for `ol` still counts `<li>` only: the block-tag text
        // nodes are not items and must not shift the numbering.
        const lines: string[] = [];
        let liIndex = 0;
        for (const child of el.children) {
          if (child.type === 'tag' && (child as Element).name === 'li') {
            const li = child as Element;
            // A <br> inside a <li> (sanitizer-legal) produces a continuation
            // line, which is indented to align under the item text rather
            // than reading as a detached, unmarked line.
            const marker = el.name === 'ol' ? `${liIndex + 1}.` : '-';
            liIndex++;
            const indent = ' '.repeat(marker.length + 1);
            // Drop empty lines (a leading/trailing <br> with nothing on the
            // other side) before marking, so the first line to survive is
            // the one that gets the marker, not a blank continuation.
            const itemLines = decode(textOf(li))
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            lines.push(itemLines.map((line, idx) => (idx === 0 ? `${marker} ${line}` : `${indent}${line}`)).join('\n'));
          } else if (child.type === 'text') {
            // A bare text node here is a Handlebars block tag (`{{#each
            // visits}}`, `{{/each}}`), emitted as its own line so the loop
            // still wraps the `<li>` line once Handlebars renders this text
            // template. Handlebars strips a "standalone" block-tag line --
            // one with nothing but whitespace before and after it on its own
            // line -- entirely, INCLUDING its trailing newline, which is why
            // the final rendered text has no blank line where this one sat.
            const text = decode(child.data).trim();
            if (text) lines.push(text);
          }
        }
        blocks.push(lines.join('\n'));
      } else if (el.name === 'blockquote') {
        // Recurse into tag children as before, but a bare text node directly
        // inside the <blockquote> (never wrapped in a <p>) must not be
        // dropped the way plain `walk` drops top-level text: it is visible
        // callout content, not layout noise.
        for (const child of el.children) {
          if (child.type === 'tag') {
            walk([child as Element]);
          } else if (child.type === 'text') {
            const text = decode(child.data).trim();
            if (text) blocks.push(text);
          }
        }
      } else {
        const line = decode(textOf(el))
          .split('\n')
          .map((l) => l.trim())
          .join('\n')
          .trim();
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

/**
 * Any stored template, old or visual, as the three Handlebars templates the
 * transport takes. `frame` is the stored frame the send route read once for
 * this invocation (`loadEmailFrame`); it only affects a visual template, since
 * an old-format template carries its own full HTML.
 */
export function sendPartsFor(doc: EmailTemplateDoc, frame: EmailFrame = DEFAULT_EMAIL_FRAME): SendParts {
  if (isVisualTemplate(doc)) {
    return {
      subjectTemplate: doc.subject,
      bodyTemplate: contentToText(doc.headline, doc.content),
      htmlTemplate: frameHtml(doc.headline, doc.content, frame),
    };
  }
  // A document tagged `format: 'visual'` but missing `headline` or `content`
  // (a partial write, a botched migration) has no old-format `body`/`html` to
  // fall back to either -- `saveTemplate` deletes those on every visual save.
  // Falling through to the old-format branch below would silently send an
  // empty body instead of surfacing the corrupt document.
  if (doc.format === 'visual') {
    throw new Error('email template is marked visual but has no headline or content');
  }
  return {
    subjectTemplate: doc.subject,
    bodyTemplate: doc.body ?? '',
    ...(doc.html ? { htmlTemplate: doc.html } : {}),
  };
}
