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
  // sanitize-html 2.17.7 writes void elements as `<br />` / `<img ... />`; normalise to
  // `<br>` / `<img ...>`, which is the stored form PR 4's web editor serializes and PR 5's
  // Android parser round-trips.
  const flattened = content
    .replace(/<p>\s*<p>/g, '<p>')
    .replace(/<\/p>\s*<\/p>/g, '</p>')
    .replace(/<br \/>/g, '<br>')
    .replace(/<img([^>]*?) \/>/g, '<img$1>')
    // A disallowed href leaves an <a> with no href; unwrap it so its text survives as plain text.
    .replace(/<a(?![^>]*\shref=)[^>]*>([\s\S]*?)<\/a>/g, '$1');

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
