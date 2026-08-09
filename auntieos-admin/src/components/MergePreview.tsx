import { useMemo } from 'react';
import { renderPreview, unresolvedKeys, type PreviewSegment } from '../lib/mergeFields';
import './MergePreview.css';

export interface MergePreviewProps {
  /** Subject line. Merge fields in it count towards the warning, same as the body. */
  subject: string;
  /** Plain-text body. Blank lines become paragraph breaks. */
  body: string;
  /**
   * The bindings to preview against. `lib/mergeFields.ts#ENRICHABLE_SAMPLE` is
   * the right value wherever the notification pipeline will do the filling; an
   * empty object is the right value where nothing will (an ad-hoc broadcast).
   */
  sample: Record<string, string>;
  /** One line under the card saying what happens to merge fields at send time. */
  footnote?: string;
  /** Masthead wordmark. The Android twin defaults the same way. */
  brandName?: string;
}

/**
 * The live preview pane: what this copy looks like once the merge fields are
 * filled in, and which of them nothing will fill.
 *
 * WHY IT EXISTS. The template editor was two textareas with no rendering
 * anywhere, so nobody ever saw a template the way a kinfolk receives it. The
 * live `account.welcome.business` body ends "See their account here: []" and
 * shipped that way; a preview is the cheapest thing that would have caught it.
 * Six of the operator's mockups tag a `SUGGESTION: live preview pane`, and the
 * Template Bank mock draws it as a cream email card in a right-hand column
 * (ui-ideas/auntieos-template-bank-2026-05-27.html, the `.pv` rules).
 *
 * The inner card is deliberately LIGHT in both app themes: it is a picture of an
 * inbox, not another admin surface, and the Android twin
 * (`ui/components/AuntieEmailPreviewCard.kt`) has made the same call since it
 * was written.
 *
 * WHAT THE WARNING MEANS, precisely. A `role="status"` line names the merge
 * fields the supplied `sample` does not bind. That is not "these are broken";
 * it is "nothing here fills these in, so somebody else has to". On a
 * notification template the sample is the twelve tokens
 * `enrichTemplateData.ts` hydrates, so an unbound token is one the emitting
 * function has to pass. On an ad-hoc broadcast the sample is empty, because
 * `broadcastMessage` sends `data: {}` and no token can resolve at all. The
 * consumer supplies the `footnote` that says which of those two it is, so the
 * pane never implies a resolution that will not happen.
 */
export function MergePreview({ subject, body, sample, footnote, brandName = 'TribeTails' }: MergePreviewProps) {
  const subjectSegments = useMemo(() => renderPreview(subject, sample), [subject, sample]);
  const bodySegments = useMemo(() => renderPreview(body, sample), [body, sample]);

  // DISTINCT keys, not occurrences. A body that says `{{link}}` three times has
  // one thing wrong with it, and a line reading "3 merge fields ...: link" would
  // list fewer names than it counted.
  const missing = useMemo(
    () => unresolvedKeys([...subjectSegments, ...bodySegments]),
    [subjectSegments, bodySegments],
  );

  const isEmpty = subject.trim() === '' && body.trim() === '';

  return (
    <section className="merge-preview" aria-label="Live preview">
      <span className="merge-preview__label">Live preview</span>

      <div className="merge-preview__card">
        <div className="merge-preview__masthead">
          <span className="merge-preview__wordmark">{brandName}</span>
        </div>

        <div className="merge-preview__paper">
          {isEmpty ? (
            <p className="merge-preview__empty">
              Nothing to preview yet. Type a subject or a body and it appears here as a kinfolk
              receives it.
            </p>
          ) : (
            <>
              <h4 className="merge-preview__subject">
                <Segments segments={subjectSegments} />
              </h4>
              <p className="merge-preview__body">
                <Segments segments={bodySegments} />
              </p>
            </>
          )}
        </div>
      </div>

      {/* `role="status"` rather than `role="alert"`: the author is typing, and an
          assertive live region would interrupt them on every keystroke that
          adds a brace. Polite is also what Banner's non-error tones use. */}
      {missing.length > 0 ? (
        <p className="merge-preview__warning" role="status">
          {missing.length === 1
            ? `1 merge field has no sample value: ${missing[0]}`
            : `${missing.length} merge fields have no sample value: ${missing.join(', ')}`}
        </p>
      ) : null}

      {footnote ? <p className="merge-preview__footnote">{footnote}</p> : null}
    </section>
  );
}

/**
 * Render the cut-up body. A bound field is a tinted chip carrying its VALUE,
 * because that is what the customer reads. An unbound one keeps its raw
 * `{{token}}` in a warning chip, because that is the string the author has to
 * go find in the textarea above.
 */
function Segments({ segments }: { segments: readonly PreviewSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : seg.value === null ? (
          <span key={i} className="merge-preview__field merge-preview__field--missing">
            {`{{${seg.key}}}`}
          </span>
        ) : (
          <span key={i} className="merge-preview__field">
            {seg.value}
          </span>
        ),
      )}
    </>
  );
}
