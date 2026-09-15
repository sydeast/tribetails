import { useCallback, useEffect, useState } from 'react';
import {
  importSeedTemplates,
  planSeedTemplateImport,
  importPlanHeadline,
  importRowSummary,
  plannedWriteCount,
  type TemplateImportReport,
  type TemplateImportRow,
} from '../api/templateImport';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import './TemplateImport.css';

interface TemplateImportProps {
  /** Returns to the Template Bank list. A sibling view, not a route. */
  onClose: () => void;
  /** Announced on the Bank once an import has actually written something. */
  onImported: (message: string) => void;
}

/**
 * Bringing the repo's notification templates into Firestore, without a terminal.
 *
 * Issue #468. The operator ruled out the seed script, and a notification whose
 * template document is absent does not degrade: it throws inside the channel
 * sender and no email is delivered. This view is the replacement route.
 *
 * THE PLAN COMES FIRST AND IS NOT SKIPPABLE. Opening the view runs a dry run,
 * which writes nothing. Templates whose stored copy differs from the repo copy
 * are listed as differing and are NOT imported unless the operator ticks them,
 * so nothing anyone edited in the Template Bank is replaced by accident. The
 * tick list is the second call's `overwriteIds`.
 */
export function TemplateImport({ onClose, onImported }: TemplateImportProps) {
  const [report, setReport] = useState<TemplateImportReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<TemplateImportReport | null>(null);

  const plan = useCallback(() => {
    setLoading(true);
    setError(null);
    setResult(null);
    planSeedTemplateImport()
      .then((r) => {
        setReport(r);
        setLoading(false);
      })
      .catch((err) => {
        setReport(null);
        setLoading(false);
        setError(
          `Could not read the import plan: ${err instanceof Error ? err.message : 'request failed'}`,
        );
      });
  }, []);

  useEffect(plan, [plan]);

  function toggleOverwrite(templateId: string) {
    setOverwrite((prev) => {
      const next = new Set(prev);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });
  }

  async function runImport() {
    if (importing || !report) return;
    setImporting(true);
    setError(null);
    try {
      const written = await importSeedTemplates({
        dryRun: false,
        ...(overwrite.size > 0 ? { overwriteIds: Array.from(overwrite) } : {}),
      });
      setImporting(false);
      setResult(written);
      setReport(written);
      setOverwrite(new Set());
      if (written.written > 0) {
        onImported(
          `Imported ${written.written} template document${written.written === 1 ? '' : 's'} from the repo.`,
        );
      }
    } catch (err) {
      setImporting(false);
      setError(
        `The import did not run: ${err instanceof Error ? err.message : 'request failed'}. Nothing was written.`,
      );
    }
  }

  const writeCount = report ? plannedWriteCount(report) : 0;
  // Re-planning after a write is what makes the second visit honest, so the
  // button is only live while there is something to do.
  const canImport = !!report && !importing && !loading && writeCount > 0;

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Import"
        accentTail="templates."
        subtitle="Load the notification templates committed to the repo into Firestore."
        trailing={<GhostButton label="Back to Template Bank" onClick={onClose} />}
      />

      {error && (
        <Banner tone="error" title="Import problem" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {result && (
        <Banner tone="success" title="Import finished" onDismiss={() => setResult(null)}>
          {result.written === 0
            ? 'Nothing needed writing. Every template selected already matched the repo.'
            : `Wrote ${result.written} document${result.written === 1 ? '' : 's'}.`}
        </Banner>
      )}

      <DenPanel
        title="What this run would do"
        subtitle="Read the plan, tick anything you want replaced, then import. Nothing is written until you press Import."
      >
        {loading ? (
          <EmptyHint>Working out what the import would change.</EmptyHint>
        ) : !report ? (
          <EmptyHint>No plan to show. Try again.</EmptyHint>
        ) : (
          <>
            <p className="template-import__headline" data-testid="import-headline">
              {importPlanHeadline(report)}
            </p>

            {report.needsOverwriteChoice.length > 0 && (
              <Banner tone="warning" title="Some stored templates differ from the repo">
                {report.needsOverwriteChoice.length} template
                {report.needsOverwriteChoice.length === 1 ? ' has' : 's have'} been edited since they
                were last imported, or were never imported from this corpus. They are left alone
                unless you tick them below.
              </Banner>
            )}

            {report.refused.length > 0 && (
              <Banner tone="error" title="Refused, and not importable as written">
                <ul className="template-import__refusals">
                  {report.refused.map((r) => (
                    <li key={r.templateId}>
                      <code>{r.templateId}</code>: {r.reason}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}

            <ul className="template-import__rows">
              {report.rows.map((row) => (
                <ImportRow
                  key={row.templateId}
                  row={row}
                  checked={overwrite.has(row.templateId)}
                  onToggle={() => toggleOverwrite(row.templateId)}
                />
              ))}
            </ul>

            <div className="template-import__actions">
              <GhostButton label="Re-check" onClick={plan} />
              <PrimaryButton
                label={importing ? 'Importing' : `Import ${writeCount} document${writeCount === 1 ? '' : 's'}`}
                onClick={runImport}
                disabled={!canImport}
              />
            </div>
          </>
        )}
      </DenPanel>
    </div>
  );
}

function ImportRow({
  row,
  checked,
  onToggle,
}: {
  row: TemplateImportRow;
  checked: boolean;
  onToggle: () => void;
}) {
  // The tick only means anything for a row that differs. A new template needs
  // no permission to be created, and an unchanged one has nothing to replace.
  const offersOverwrite = row.differsFromRepo && !row.blocked;
  return (
    <li className="template-import__row" data-blocked={row.blocked ? 'true' : 'false'}>
      <div className="template-import__row-head">
        <code className="template-import__key">{row.templateId}</code>
        <span className="template-import__summary" data-testid={`summary-${row.templateId}`}>
          {importRowSummary(row)}
        </span>
      </div>

      {/* #892 review 2: the reason sits with the row, not only in the banner above. */}
      {row.blocked && (row.issues?.length ?? 0) > 0 && (
        <p className="template-import__issues" data-testid={`issues-${row.templateId}`}>
          {row.issues!.join(' ')}
        </p>
      )}

      {row.aliasOf && (
        <p className="template-import__alias">
          A retired key. Live sends now go through <code>{row.aliasOf}</code>, and this copy is kept
          so an older binding pointing here still finds something.
        </p>
      )}

      <ul className="template-import__channels">
        {row.channels.map((c) => (
          <li key={c.channel}>
            <span className="template-import__channel-name">{c.channel}</span>
            <span className="template-import__outcome" data-outcome={c.outcome}>
              {c.outcome}
            </span>
            {c.notes.length > 0 && (
              <span className="template-import__notes">{c.notes.join(' ')}</span>
            )}
          </li>
        ))}
      </ul>

      {offersOverwrite && (
        <label className="template-import__overwrite">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            aria-label={`Replace the stored copy of ${row.templateId}`}
          />
          Replace the stored copy with the repo wording
        </label>
      )}
    </li>
  );
}
