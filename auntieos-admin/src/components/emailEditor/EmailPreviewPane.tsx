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
        <Banner
          tone="error"
          title="Couldn’t update the preview"
          trailing={<GhostButton label="Try again" onClick={onRetry} />}
        >
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
