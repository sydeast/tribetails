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

// #953 review fix: a top-level run of bare text/inline elements (typed with no
// wrapping block, or left behind by an unwrapped href-less <a>) survives the
// sanitizer -- `allowedTags` permits `strong`/`em`/`a`/`br`/`img` at any depth,
// and none of `transformTags` above forces an enclosing block onto them. But
// `contentToText` (emailFrame.ts) only walks TOP-LEVEL tag children, so that
// same content is silently dropped from the plain-text part of every send.
// Wrapping every such run in its own `<p>` at save time makes the stored
// content always block-level, so contentToText renders it and the frame's
// `.content` styling applies to it. A whitespace-only run (e.g. stray text
// between block tags) is dropped rather than wrapped, so it does not become a
// visible empty paragraph.
const BLOCK_LEVEL_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote']);

function wrapBareTopLevelRuns(html: string): string {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let out = '';
  let runStart = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [, closing, name] = m;
    const lname = name.toLowerCase();
    if (closing || !BLOCK_LEVEL_TAGS.has(lname)) continue;

    // Found the start of a top-level block element. Flush whatever bare
    // content preceded it, then locate ITS matching close (tracking nested
    // same-name tags, e.g. a nested <ul>) and copy the whole block verbatim.
    const run = html.slice(runStart, m.index);
    if (run.trim() !== '') out += `<p>${run}</p>`;

    const closeRe = new RegExp(`<(/?)${lname}\\b[^>]*>`, 'gi');
    closeRe.lastIndex = tagRe.lastIndex;
    let depth = 1;
    let blockEnd = html.length;
    let cm: RegExpExecArray | null;
    while ((cm = closeRe.exec(html))) {
      depth += cm[1] ? -1 : 1;
      if (depth === 0) {
        blockEnd = closeRe.lastIndex;
        break;
      }
    }
    out += html.slice(m.index, blockEnd);
    runStart = blockEnd;
    tagRe.lastIndex = blockEnd;
  }
  const tail = html.slice(runStart);
  if (tail.trim() !== '') out += `<p>${tail}</p>`;
  return out;
}

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
  // sanitize-html 2.17.7 writes void elements as `<br />` / `<img ... />`; normalise to
  // `<br>` / `<img ...>`, which is the stored form PR 4's web editor serializes and PR 5's
  // Android parser round-trips.
  const preWrap = content
    .replace(/<p>\s*<p>/g, '<p>')
    .replace(/<\/p>\s*<\/p>/g, '</p>')
    .replace(/<br \/>/g, '<br>')
    .replace(/<img([^>]*?) \/>/g, '<img$1>')
    // A disallowed href leaves an <a> with no href; unwrap it so its text survives as plain text.
    .replace(/<a(?![^>]*\shref=)[^>]*>([\s\S]*?)<\/a>/g, '$1');

  // A bare top-level run (text, or an inline element with nothing wrapping it)
  // survives the allowlist above but is invisible to contentToText, which only
  // walks top-level block children. Give every such run its own <p> so stored
  // content is always block-level.
  const flattened = wrapBareTopLevelRuns(preWrap);

  // Tokens: only in text or as a whole href. Link scheme: an <a href> must be
  // an absolute https:// URL, a mailto:, or (checked elsewhere) a single merge
  // token -- never a bare relative path or fragment, which would resolve
  // against the recipient's mail client rather than the site.
  for (const m of flattened.matchAll(/<[^>]+>/g)) {
    const tag = m[0];
    for (const attr of tag.matchAll(/(\w+)="([^"]*)"/g)) {
      const [, name, value] = attr;
      if (!value.includes('{{')) continue;
      if (name !== 'href') issues.add('A merge field can only be used in text or as a link target.');
      else if (!SINGLE_TOKEN.test(value)) issues.add('A link target must be a web address or a single merge field, not both.');
    }
    if (/^<a\b/i.test(tag)) {
      const hrefMatch = tag.match(/\shref="([^"]*)"/);
      const href = hrefMatch?.[1];
      if (href !== undefined && !href.includes('{{') && !/^https:\/\//i.test(href) && !/^mailto:/i.test(href)) {
        issues.add('A link must point to a web address (https://), an email address (mailto:), or a merge field.');
      }
    }
  }
  // Tokens split by formatting: for each `{{` that sits in text (not inside a
  // tag's attributes -- those are handled by the attribute loop above), walk to
  // its matching `}}` (or the end of the string) and check whether any tag
  // starts in between. No sentinel character is inserted into the text, so
  // legitimate content that happens to contain an unusual character (e.g. a
  // pasted icon-font glyph) can never be mistaken for a tag boundary.
  const tags = [...flattened.matchAll(/<[^>]+>/g)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const isInsideTag = (i: number) => tags.some((t) => i >= t.start && i < t.end);
  for (const openMatch of flattened.matchAll(/\{\{/g)) {
    const openIdx = openMatch.index;
    if (openIdx === undefined || isInsideTag(openIdx)) continue;
    const closeIdx = flattened.indexOf('}}', openIdx);
    const closeBound = closeIdx === -1 ? flattened.length : closeIdx;
    if (tags.some((t) => t.start > openIdx && t.start < closeBound)) {
      issues.add('A merge field was broken apart by formatting. Retype it as one piece.');
    }
  }

  if (flattened.replace(/<[^>]+>/g, '').trim().length === 0 && !/<img /.test(flattened)) {
    issues.add('The email body is empty.');
  }

  return { content: flattened, issues: [...issues] };
}
