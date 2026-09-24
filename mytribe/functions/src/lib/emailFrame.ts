import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import type { EmailTemplateDoc } from './sendFromTemplate';

/**
 * #953: the one shared frame every visual email is sent in, and the text part
 * generated from the same content. A change here reaches every email.
 *
 * Ruling fix: an earlier draft of this file copied the RED security-alert
 * scheme (`auth.password.reset`, 9 of 52 seeds) under the mistaken belief
 * that it was the dominant variant. Controller ruling: the shared frame is
 * the DOMINANT, orange scheme -- verified 34 of 52 seeds, e.g.
 * `mytribe/seeds/notificationTemplates/account.welcome.kinfolk/email.html`
 * (`border-top: #df8431`, no `.header` background, `h2 { color: #11131f }`,
 * orange `.button`). `blockquote` below is that file's `.alert-box` rule,
 * selector changed to `blockquote`, for the Callout block. The 9 red
 * security-alert seeds now share this frame too; their warning content goes
 * in a Callout (`blockquote`) rather than getting its own color scheme.
 */
const FRAME_STYLE = `
        body { background-color: #fbfbf9; color: #11131f; font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-top: 8px solid #df8431; border-bottom: 4px solid #11131f; }
        .header { padding: 30px 40px 10px 40px; }
        .header h2 { color: #11131f; margin: 0; }
        .content { padding: 10px 40px 30px 40px; font-size: 16px; }
        .footer { padding: 20px 40px; background-color: #11131f; color: #fbfbf9; font-size: 12px; text-align: center; }
        .button { display: inline-block; padding: 14px 28px; background: #df8431; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 20px 0; }
        blockquote { background-color: #fff5f5; border-left: 4px solid #df8431; padding: 15px 20px; margin: 20px 0; border-radius: 0 4px 4px 0; }`;

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
        const items = el.children.filter((c): c is Element => c.type === 'tag' && (c as Element).name === 'li');
        blocks.push(
          items
            .map((li, i) => {
              // A <br> inside a <li> (sanitizer-legal) produces a continuation
              // line, which is indented to align under the item text rather
              // than reading as a detached, unmarked line.
              const marker = el.name === 'ol' ? `${i + 1}.` : '-';
              const indent = ' '.repeat(marker.length + 1);
              // Drop empty lines (a leading/trailing <br> with nothing on the
              // other side) before marking, so the first line to survive is
              // the one that gets the marker, not a blank continuation.
              const lines = decode(textOf(li))
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
              return lines.map((line, idx) => (idx === 0 ? `${marker} ${line}` : `${indent}${line}`)).join('\n');
            })
            .join('\n'),
        );
      } else if (el.name === 'blockquote') {
        walk(el.children);
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
