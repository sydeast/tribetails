import type { ReactNode } from 'react';
import { hasMarkup, parseRichText, type RichNode } from '../lib/richText';
/**
 * Draws a stored message body. Rich text (the server's b/strong/i/em/u/p/br/
 * ul/ol/li/blockquote/a subset) becomes real elements built from a fixed list,
 * so no stored string is ever injected as HTML. A body with no tags (the
 * operator's own plain replies) is shown as text with its line breaks kept.
 */
export function RichText({ body, className }: { body: string; className?: string }) {
  if (!hasMarkup(body)) {
    return <span className={className} style={{ whiteSpace: 'pre-wrap' }}>{body}</span>;
  }
  return <div className={className}>{renderNodes(parseRichText(body))}</div>;
}
function renderNodes(nodes: RichNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.kind === 'text') return n.text;
    const kids = renderNodes(n.children);
    switch (n.tag) {
      case 'b':
        return <b key={i}>{kids}</b>;
      case 'strong':
        return <strong key={i}>{kids}</strong>;
      case 'i':
        return <i key={i}>{kids}</i>;
      case 'em':
        return <em key={i}>{kids}</em>;
      case 'u':
        return <u key={i}>{kids}</u>;
      case 'p':
        return <p key={i}>{kids}</p>;
      case 'br':
        return <br key={i} />;
      case 'ul':
        return <ul key={i}>{kids}</ul>;
      case 'ol':
        return <ol key={i}>{kids}</ol>;
      case 'li':
        return <li key={i}>{kids}</li>;
      case 'blockquote':
        return <blockquote key={i}>{kids}</blockquote>;
      case 'a':
        return n.href ? (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {kids}
          </a>
        ) : (
          <span key={i}>{kids}</span>
        );
    }
  });
}
