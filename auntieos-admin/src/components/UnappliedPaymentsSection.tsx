import { useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';

import { EmptyHint, ErrorHint } from './DenScreenKit';
import { Dialog } from './Dialog';
import { GhostButton, PrimaryButton } from './Buttons';
import { listUnappliedPayments, resolveUnappliedPayment } from '../api/unappliedPayments';
import type {
  ListUnappliedPaymentsResult,
  ListUnappliedPaymentsResultOpenInvoice,
  ListUnappliedPaymentsResultPayment,
  ResolveUnappliedPaymentResult,
} from '../contracts/invoiceContracts.generated';
import { mintUnappliedDecisionIdempotencyKey } from '../lib/moneyIdempotency';
import {
  DECIDE_DIALOG_TITLE,
  MAX_CREDIT_REASON_LENGTH,
  NO_OPEN_INVOICES,
  UNAPPLIED_EMPTY_FROM_NOTICE,
  UNAPPLIED_LOAD_FAILED,
  UNAPPLIED_SECTION_TITLE,
  decideLeadLine,
  decisionSummaryLine,
  openInvoiceOptionLabel,
  parseDecisionForm,
  unappliedPaymentDetail,
  unappliedPaymentTitle,
} from '../lib/unappliedPaymentFormat';

/**
 * #1003: "Payments needing a decision", inside the household's Account credit
 * panel. Card payments the Stripe webhook took but could not apply to their
 * invoice, each with a Decide action that splits it into account credit, an
 * amount applied to an open invoice, and what stays recorded on the payment.
 *
 * Owner only, like the credit history: a `permission-denied` hides the section.
 * Hidden when there is nothing to decide, unless the `invoice.payment.unapplied`
 * notice opened this profile, in which case it says so instead of vanishing.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; data: ListUnappliedPaymentsResult }
  | { status: 'hidden' }
  | { status: 'error' };

function isPermissionDenied(err: unknown): boolean {
  return err instanceof FirebaseError && err.code === 'functions/permission-denied';
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

export function UnappliedPaymentsSection({
  kinfolkId,
  fromNotice = false,
  focusPaymentId = '',
  onDecided,
}: {
  kinfolkId: string;
  /** Opened from the `invoice.payment.unapplied` notice: show the section even when empty. */
  fromNotice?: boolean;
  /** The notice's payment. Its Decide dialog opens once, if it is still in the list. */
  focusPaymentId?: string;
  /** After a save: the server's answer, so the panel can refresh its history and say what happened. */
  onDecided: (res: ResolveUnappliedPaymentResult) => void;
}) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setList((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    listUnappliedPayments(kinfolkId).then(
      (data) => {
        if (!cancelled) setList({ status: 'ready', data });
      },
      (err: unknown) => {
        if (cancelled) return;
        setList(isPermissionDenied(err) ? { status: 'hidden' } : { status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kinfolkId, reloadTick]);

  // The notice's payment opens its dialog once, on the first list that lands.
  // Guarded so the reload after a save never reopens it.
  useEffect(() => {
    if (list.status !== 'ready' || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (fromNotice) sectionRef.current?.scrollIntoView?.({ block: 'start' });
    const id = focusPaymentId.trim();
    if (id !== '' && list.data.payments.some((p) => p.paymentId === id)) setDecidingId(id);
  }, [list, fromNotice, focusPaymentId]);

  if (list.status === 'hidden') return null;
  if (list.status === 'loading' && !fromNotice) return null;
  if (list.status === 'ready' && list.data.payments.length === 0 && !fromNotice) return null;

  const deciding =
    list.status === 'ready' && decidingId !== null
      ? list.data.payments.find((p) => p.paymentId === decidingId)
      : undefined;

  return (
    <div className="acredit unapplied" ref={sectionRef}>
      <h3 className="acredit__heading">{UNAPPLIED_SECTION_TITLE}</h3>
      {list.status === 'loading' && <EmptyHint>Loading…</EmptyHint>}
      {list.status === 'error' && (
        <div className="unapplied__error">
          <ErrorHint>{UNAPPLIED_LOAD_FAILED}</ErrorHint>
          <GhostButton label="Retry" onClick={() => setReloadTick((t) => t + 1)} />
        </div>
      )}
      {list.status === 'ready' && list.data.payments.length === 0 && (
        <EmptyHint>{UNAPPLIED_EMPTY_FROM_NOTICE}</EmptyHint>
      )}
      {list.status === 'ready' && list.data.payments.length > 0 && (
        <ul className="acredit__list">
          {list.data.payments.map((p) => (
            <li key={p.paymentId} className="acredit__row unapplied__row">
              <div className="unapplied__text">
                <p className="acredit__amount unapplied__title">{unappliedPaymentTitle(p)}</p>
                <p className="acredit__status">{unappliedPaymentDetail(p)}</p>
              </div>
              <GhostButton label="Decide" onClick={() => setDecidingId(p.paymentId)} />
            </li>
          ))}
        </ul>
      )}
      {deciding && list.status === 'ready' && (
        <DecidePaymentDialog
          payment={deciding}
          openInvoices={list.data.openInvoices}
          onClose={() => setDecidingId(null)}
          onSaved={(res) => {
            setDecidingId(null);
            setReloadTick((t) => t + 1);
            onDecided(res);
          }}
        />
      )}
    </div>
  );
}

/**
 * The decision. Built from the form fields only; nothing stored is rebuilt.
 *
 * ONE KEY PER SUBMISSION. Minted on the first Save, kept across a failed
 * attempt so a retry after a lost reply lands on the same decision, and dropped
 * when any field changes, because that is a different decision.
 */
export function DecidePaymentDialog({
  payment,
  openInvoices,
  onClose,
  onSaved,
}: {
  payment: ListUnappliedPaymentsResultPayment;
  openInvoices: readonly ListUnappliedPaymentsResultOpenInvoice[];
  onClose: () => void;
  onSaved: (res: ResolveUnappliedPaymentResult) => void;
}) {
  const [creditText, setCreditText] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [applyInvoiceId, setApplyInvoiceId] = useState('');
  const [applyText, setApplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

  const parsed = parseDecisionForm(payment, openInvoices, { creditText, reasonText, applyInvoiceId, applyText });
  const summary = decisionSummaryLine(payment, creditText, applyText);

  function edit(apply: () => void) {
    if (busy) return;
    keyRef.current = null;
    setSaveError(null);
    apply();
  }

  async function save() {
    if (!parsed.ok || busy) return;
    keyRef.current ??= mintUnappliedDecisionIdempotencyKey();
    setBusy(true);
    setSaveError(null);
    try {
      const res = await resolveUnappliedPayment({
        paymentId: payment.paymentId,
        ...parsed.payload,
        idempotencyKey: keyRef.current,
      });
      keyRef.current = null;
      setBusy(false);
      onSaved(res);
    } catch (err) {
      setSaveError(errorText(err));
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      title={DECIDE_DIALOG_TITLE}
      onClose={close}
      footer={
        <>
          <GhostButton label="Cancel" onClick={close} disabled={busy} />
          <PrimaryButton
            label={busy ? 'Saving...' : 'Save decision'}
            onClick={() => void save()}
            disabled={!parsed.ok || busy}
            busy={busy}
          />
        </>
      }
    >
      <div className="acredit__form">
        <p className="acredit__confirm">{decideLeadLine(payment)}</p>
        <label className="acredit__field">
          <span className="acredit__field-label">Account credit ($)</span>
          <input
            className="acredit__field-input"
            value={creditText}
            onChange={(e) => edit(() => setCreditText(e.target.value))}
            placeholder="0.00"
            inputMode="decimal"
            disabled={busy}
          />
        </label>
        <label className="acredit__field">
          <span className="acredit__field-label">Reason for the credit</span>
          <textarea
            className="acredit__field-input"
            value={reasonText}
            onChange={(e) => edit(() => setReasonText(e.target.value))}
            maxLength={MAX_CREDIT_REASON_LENGTH}
            rows={3}
            disabled={busy}
          />
        </label>
        {openInvoices.length === 0 ? (
          <p className="acredit__hint">{NO_OPEN_INVOICES}</p>
        ) : (
          <>
            <label className="acredit__field">
              <span className="acredit__field-label">Apply to invoice</span>
              <select
                className="acredit__field-input"
                value={applyInvoiceId}
                onChange={(e) => {
                  const next = e.target.value;
                  edit(() => {
                    setApplyInvoiceId(next);
                    if (next === '') setApplyText('');
                  });
                }}
                disabled={busy}
              >
                <option value="">None</option>
                {openInvoices.map((inv) => (
                  <option key={inv.invoiceId} value={inv.invoiceId}>
                    {openInvoiceOptionLabel(inv)}
                  </option>
                ))}
              </select>
            </label>
            <label className="acredit__field">
              <span className="acredit__field-label">Amount to apply ($)</span>
              <input
                className="acredit__field-input"
                value={applyText}
                onChange={(e) => edit(() => setApplyText(e.target.value))}
                placeholder="0.00"
                inputMode="decimal"
                disabled={busy || applyInvoiceId === ''}
              />
            </label>
          </>
        )}
        {summary !== null && <p className="acredit__confirm unapplied__summary">{summary}</p>}
        {!parsed.ok && <ErrorHint>{parsed.error}</ErrorHint>}
        {parsed.ok && saveError !== null && <ErrorHint>{saveError}</ErrorHint>}
      </div>
    </Dialog>
  );
}
