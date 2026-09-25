import { useMemo } from 'react';
import { DenPanel } from '../DenScreenKit';
import { GhostButton, PrimaryButton } from '../Buttons';
import { Banner } from '../Banner';
import { EmailPreviewPane } from './EmailPreviewPane';
import { useEmailPreview } from '../../lib/useEmailPreview';
import { escapeText } from '../../lib/emailContent';
import './EmailPreviewPane.css';

export interface ConvertCompareProps {
  old: { subject: string; body: string; html: string | null };
  /** The server's conversion. `warnings` name what it could not carry over (ruling C2). */
  converted: { subject: string; headline: string; content: string; warnings: readonly string[] };
  catalogKey: string | null;
  onUse: () => void;
  onBack: () => void;
}

/**
 * #953: the old email next to the converted one, before anything changes.
 * The old side is the stored HTML as it is (or its plain text when it has
 * none); the converted side is the server preview, the email that would be
 * sent. Nothing here writes: "Use the converted version" only puts it in the
 * editor, and the operator's Save is the one write.
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
      {converted.warnings.length > 0 ? (
        <Banner tone="warning" title="Not carried over" className="convert-compare__warnings">
          <ul className="convert-compare__warning-list">
            {converted.warnings.map((w, i) => (
              // The server can repeat a sentence (two images dropped), so the key is the position.
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <div className="convert-compare__cols">
        <DenPanel title="" className="convert-compare__side">
          <section className="email-preview" aria-label="Old email">
            <span className="email-preview__label">Old email</span>
            <p className="email-preview__subject">
              <span className="email-preview__subject-label">Subject:</span> <span>{old.subject}</span>
            </p>
            <iframe className="email-preview__frame" title="The old email" sandbox="" srcDoc={oldDoc} />
          </section>
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
