import { useCallback, useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';

import { DenPanel, EmptyHint, ErrorHint } from './DenScreenKit';
import { Dialog } from './Dialog';
import { GhostButton, PrimaryButton } from './Buttons';
import { getAccountCreditHistory, giveAccountCredit } from '../api/accountCredit';
import type { GetAccountCreditHistoryResult } from '../contracts/invoiceContracts.generated';
import { mintGiveCreditIdempotencyKey } from '../lib/moneyIdempotency';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import {
  MAX_CREDIT_REASON_LENGTH,
  creditApplicationLines,
  creditGivenNotice,
  creditStatusLine,
  creditUseLine,
  formatCreditDate,
  giveCreditConfirmLine,
  parseGiveCreditForm,
} from '../lib/accountCreditFormat';
import './AccountCreditPanel.css';

/**
 * Q6 (operator ruling 2026-09-27): the household's account credit on its
 * profile. The balance, a "Give credit" action, and the history of every credit
 * given (amount, date, reason, date applied) and every time credit was spent.
 *
 * Owner only. The server refuses anyone else; a `permission-denied` here hides
 * the panel rather than showing an error.
 */

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; data: GetAccountCreditHistoryResult }
  | { status: 'hidden' }
  | { status: 'error'; message: string };

function isPermissionDenied(err: unknown): boolean {
  return err instanceof FirebaseError && err.code === 'functions/permission-denied';
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

export function AccountCreditPanel({ kinfolkId }: { kinfolkId: string }) {
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHistory((h) => (h.status === 'ready' ? h : { status: 'loading' }));
    getAccountCreditHistory(kinfolkId).then(
      (data) => {
        if (!cancelled) setHistory({ status: 'ready', data });
      },
      (err: unknown) => {
        if (cancelled) return;
        setHistory(isPermissionDenied(err) ? { status: 'hidden' } : { status: 'error', message: errorText(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kinfolkId, reloadTick]);

  const onGiven = useCallback((newBalanceCents: number) => {
    setDialogOpen(false);
    setNotice(creditGivenNotice(newBalanceCents));
    setReloadTick((t) => t + 1);
  }, []);

  if (history.status === 'hidden') return null;

  const balanceCents = history.status === 'ready' ? history.data.accountBalanceCents : null;

  return (
    <DenPanel
      title="Account credit"
      subtitle="Credit the household can spend on future invoices. Auto-apply uses it on the next bill."
      {...(balanceCents !== null ? { detail: `${formatCentsUsd(balanceCents)} on account` } : {})}
      trailing={
        <GhostButton
          label="Give credit"
          onClick={() => {
            setNotice(null);
            setDialogOpen(true);
          }}
          disabled={history.status !== 'ready'}
        />
      }
    >
      {notice !== null && (
        <p className="acredit__notice" role="status">
          {notice}
        </p>
      )}
      {history.status === 'loading' && <EmptyHint>Loading account credit…</EmptyHint>}
      {history.status === 'error' && <ErrorHint>Could not load account credit. {history.message}</ErrorHint>}
      {history.status === 'ready' && <CreditHistoryList data={history.data} />}
      {dialogOpen && history.status === 'ready' && (
        <GiveCreditDialog
          kinfolkId={kinfolkId}
          balanceCents={history.data.accountBalanceCents}
          onClose={() => setDialogOpen(false)}
          onGiven={onGiven}
        />
      )}
    </DenPanel>
  );
}

/** The two lists. Also used, read only, nowhere else on the admin. */
export function CreditHistoryList({ data }: { data: GetAccountCreditHistoryResult }) {
  if (data.credits.length === 0 && data.uses.length === 0) {
    return <EmptyHint>No credit given yet.</EmptyHint>;
  }
  return (
    <div className="acredit">
      <h3 className="acredit__heading">Credits given</h3>
      {data.credits.length === 0 ? (
        <EmptyHint>No credit given yet.</EmptyHint>
      ) : (
        <ul className="acredit__list">
          {data.credits.map((c) => (
            <li key={c.creditId} className="acredit__row">
              <div className="acredit__line">
                <span className="acredit__amount">{formatCentsUsd(c.amountCents)}</span>
                <span className="acredit__date">Given {formatCreditDate(c.givenAtMs)}</span>
              </div>
              <p className="acredit__reason">{c.reason}</p>
              <p className="acredit__status">{creditStatusLine(c)}</p>
              {creditApplicationLines(c).map((line, i) => (
                <p key={i} className="acredit__use">
                  {line}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {data.uses.length > 0 && (
        <>
          <h3 className="acredit__heading">Credit used</h3>
          <ul className="acredit__list">
            {data.uses.map((u) => (
              <li key={u.useId} className="acredit__row acredit__use">
                {creditUseLine(u)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Amount and reason, then a confirmation with the new balance, then the call.
 *
 * ONE KEY PER SUBMISSION. Minted when she confirms and kept across a failed
 * attempt, so pressing "Give credit" again after a lost reply lands on the
 * same credit. Editing the amount or the reason makes it a different credit and
 * drops the key.
 */
export function GiveCreditDialog({
  kinfolkId,
  balanceCents,
  onClose,
  onGiven,
}: {
  kinfolkId: string;
  balanceCents: number;
  onClose: () => void;
  onGiven: (newBalanceCents: number) => void;
}) {
  const [amountText, setAmountText] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  const parsed = parseGiveCreditForm(amountText, reasonText);

  function edit(setter: (v: string) => void, value: string) {
    keyRef.current = null;
    setFormError(null);
    setter(value);
  }

  function review() {
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setSaveError(null);
    setStep('confirm');
  }

  async function submit() {
    if (!parsed.ok || busy) return;
    keyRef.current ??= mintGiveCreditIdempotencyKey();
    setBusy(true);
    setSaveError(null);
    try {
      const res = await giveAccountCredit({
        kinfolkId,
        amountCents: parsed.amountCents,
        reason: parsed.reason,
        idempotencyKey: keyRef.current,
      });
      keyRef.current = null;
      onGiven(res.newAccountBalanceCents);
    } catch (err) {
      setSaveError(`Couldn't give credit: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      title="Give credit"
      onClose={close}
      footer={
        step === 'form' ? (
          <>
            <GhostButton label="Cancel" onClick={close} />
            <PrimaryButton label="Review" onClick={review} />
          </>
        ) : (
          <>
            <GhostButton label="Back" onClick={() => !busy && setStep('form')} disabled={busy} />
            <PrimaryButton
              label={busy ? 'Giving credit…' : 'Give credit'}
              onClick={() => void submit()}
              disabled={busy}
              busy={busy}
            />
          </>
        )
      }
    >
      {step === 'form' ? (
        <div className="acredit__form">
          <label className="acredit__field">
            <span className="acredit__field-label">Amount</span>
            <input
              className="acredit__field-input"
              value={amountText}
              onChange={(e) => edit(setAmountText, e.target.value)}
              placeholder="25.00"
              inputMode="decimal"
              aria-label="Credit amount in dollars"
            />
          </label>
          <label className="acredit__field">
            <span className="acredit__field-label">Reason</span>
            <textarea
              className="acredit__field-input"
              value={reasonText}
              onChange={(e) => edit(setReasonText, e.target.value)}
              maxLength={MAX_CREDIT_REASON_LENGTH}
              rows={3}
              aria-label="Reason for the credit"
            />
          </label>
          <p className="acredit__hint">The household sees the amount, the date and the reason.</p>
          {formError !== null && <ErrorHint>{formError}</ErrorHint>}
        </div>
      ) : (
        <div className="acredit__form">
          {parsed.ok && <p className="acredit__confirm">{giveCreditConfirmLine(parsed.amountCents, balanceCents)}</p>}
          {parsed.ok && <p className="acredit__reason">{parsed.reason}</p>}
          {saveError !== null && <ErrorHint>{saveError}</ErrorHint>}
        </div>
      )}
    </Dialog>
  );
}
