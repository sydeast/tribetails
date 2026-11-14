import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { splitSettingsRefusal } from '../../lib/settingsChecks';
import { PAYMENT_TERMS_SETTING_CODES, invoiceTermsDef, type InvoiceTermsCode } from '../../lib/invoiceTerms';
import { FieldError, fieldErrorAttrs } from './sections';
import '../SettingsEdit.css';

interface InvoiceTermsSectionProps {
  data: Pick<BusinessSettings, 'invoicePaymentTerms'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

const FIELD = 'invoicePaymentTerms';

/**
 * #1966: Settings > Invoices > Payment terms, the terms every new invoice
 * starts on (operator ruling 2026-11-12). New invoice, a quote turned into an
 * invoice and any invoice the server raises take their due date from it,
 * counted on the business's clock from the invoice's visits; an invoice with
 * no visits is due on receipt. The per-invoice choice in New invoice and Edit
 * still overrides it. Saved alone, through `saveBusinessSettings`, which
 * checks the value against the same list.
 */
export function InvoiceTermsSection({ data, onSave }: InvoiceTermsSectionProps) {
  // Seeded once, as every section here is: a sibling's save round-trips
  // through `data`, and re-deriving would wipe a choice in progress.
  const [draft, setDraft] = useState<InvoiceTermsCode>(data.invoicePaymentTerms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = draft !== data.invoicePaymentTerms;

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await onSave({ invoicePaymentTerms: draft });
      setJustSaved(true);
    } catch (err) {
      const split = splitSettingsRefusal(err, [FIELD]);
      setFieldError(split.byField[FIELD] ?? null);
      setError(split.banner);
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setDraft(data.invoicePaymentTerms);
    setError(null);
    setFieldError(null);
    setJustSaved(false);
  }

  return (
    <DenPanel title="Invoices">
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <div className="settingsEdit__fields">
        <div className="settingsEdit__fieldGroup">
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Payment terms</span>
            <select
              className="settingsEdit__input"
              value={draft}
              disabled={busy}
              onChange={(e) => {
                setDraft(e.target.value as InvoiceTermsCode);
                setFieldError(null);
                setJustSaved(false);
              }}
              {...fieldErrorAttrs(FIELD, fieldError)}
            >
              {PAYMENT_TERMS_SETTING_CODES.map((code) => (
                <option key={code} value={code}>
                  {invoiceTermsDef(code).label}
                </option>
              ))}
            </select>
            <FieldError id={FIELD} message={fieldError} />
          </label>
        </div>
      </div>
      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save payment terms'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
