import { useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';

import { GhostButton, PrimaryButton } from './Buttons';
import { applyAccountCredit, getAccountCreditHistory } from '../api/accountCredit';
import type { ApplyAccountCreditResult } from '../contracts/invoiceContracts.generated';
import { mintApplyCreditIdempotencyKey } from '../lib/moneyIdempotency';
import {
  applyCreditConfirmLine,
  availableCreditLine,
  creditAppliedNotice,
  parseApplyCreditAmount,
} from '../lib/applyCreditFormat';
import './InvoiceApplyCredit.css';

/**
 * #1872 (operator ruling 2026-11-11): ACCOUNT CREDIT IS NEVER SPENT
 * AUTOMATICALLY. It goes onto an invoice only here, as an amount the admin
 * types: the household's available credit, an amount box, a confirmation that
 * names the amount and the invoice, and then the one call.
 *
 * Shown on an invoice that can take a payment. The server decides everything
 * again (`applyAccountCredit`); a refusal it sends is shown beside the field in
 * its own words.
 *
 * ONE KEY PER SUBMISSION. Minted when she confirms and kept across a failed
 * attempt, so pressing Apply again after a lost reply lands on the same payment
 * instead of applying the amount twice. Changing the amount drops the key.
 *
 * Owner only. An Auntie never sees money: the balance read is refused for her
 * and the whole block stays hidden.
 */

type BalanceState =
  | { status: 'loading' }
  | { status: 'ready'; availableCents: number }
  | { status: 'hidden' }
  | { status: 'error'; message: string };

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

export function InvoiceApplyCredit({
  invoiceId,
  invoiceNumber,
  kinfolkId,
  dueCents,
  onApplied,
}: {
  invoiceId: string;
  invoiceNumber: string | null | undefined;
  kinfolkId: string;
  /** What the invoice still owes, or null when that figure could not be read. */
  dueCents: number | null;
  /** Called once credit has moved, with the server's answer and the sentence that says so. */
  onApplied: (res: ApplyAccountCreditResult, notice: string) => void;
}) {
  const [balance, setBalance] = useState<BalanceState>({ status: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const [amountText, setAmountText] = useState('');
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (kinfolkId === '') {
      setBalance({ status: 'hidden' });
      return;
    }
    getAccountCreditHistory(kinfolkId).then(
      (data) => {
        if (!cancelled) setBalance({ status: 'ready', availableCents: Math.max(0, data.accountBalanceCents) });
      },
      (err: unknown) => {
        if (cancelled) return;
        const denied = err instanceof FirebaseError && err.code === 'functions/permission-denied';
        setBalance(denied ? { status: 'hidden' } : { status: 'error', message: errorText(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kinfolkId, reloadTick]);

  if (balance.status === 'hidden') return null;

  const availableCents = balance.status === 'ready' ? balance.availableCents : 0;
  const parsed = parseApplyCreditAmount(amountText, { availableCents, dueCents });

  function review() {
    if (!parsed.ok) {
      setFieldError(parsed.error);
      return;
    }
    setFieldError(null);
    setStep('confirm');
  }

  async function submit() {
    if (!parsed.ok || busy) return;
    keyRef.current ??= mintApplyCreditIdempotencyKey();
    setBusy(true);
    setFieldError(null);
    try {
      const res = await applyAccountCredit({
        invoiceId,
        amountCents: parsed.amountCents,
        idempotencyKey: keyRef.current,
      });
      keyRef.current = null;
      setAmountText('');
      setStep('form');
      setBalance({ status: 'ready', availableCents: Math.max(0, res.accountBalanceCents) });
      onApplied(res, creditAppliedNotice({ ...res, invoiceNumber }));
    } catch (err) {
      // The server's refusal is already in plain words; it goes beside the
      // field, and the form comes back so she can change the amount.
      setFieldError(errorText(err));
      setStep('form');
      // What she holds or owes may have moved under her: read it again.
      setReloadTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="invoice-credit" aria-label="Account credit">
      <div className="invoice-credit__head">
        <h3 className="invoice-credit__title">Account credit</h3>
        {balance.status === 'ready' && (
          <span className="invoice-credit__available" data-testid="invoice-credit-available">
            {availableCreditLine(balance.availableCents)}
          </span>
        )}
      </div>

      {balance.status === 'loading' && (
        <p className="invoice-credit__hint" role="status">
          Loading account credit…
        </p>
      )}
      {balance.status === 'error' && (
        <p className="invoice-credit__error" role="alert">
          Could not load account credit. {balance.message}{' '}
          <button type="button" className="invoice-credit__retry" onClick={() => setReloadTick((t) => t + 1)}>
            Try again
          </button>
        </p>
      )}

      {balance.status === 'ready' && balance.availableCents > 0 && step === 'form' && (
        <div className="invoice-credit__form">
          <label className="invoice-credit__field">
            <span className="invoice-credit__label">Amount to apply</span>
            <input
              className="invoice-credit__input"
              value={amountText}
              onChange={(e) => {
                keyRef.current = null;
                setFieldError(null);
                setAmountText(e.target.value);
              }}
              placeholder="25.00"
              inputMode="decimal"
              aria-label="Account credit to apply, in dollars"
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError !== null ? 'invoice-credit-error' : undefined}
            />
          </label>
          <GhostButton label="Apply credit" onClick={review} />
          {fieldError !== null && (
            <p className="invoice-credit__error" id="invoice-credit-error" role="alert">
              {fieldError}
            </p>
          )}
        </div>
      )}

      {balance.status === 'ready' && step === 'confirm' && parsed.ok && (
        <div className="invoice-credit__confirm">
          <p className="invoice-credit__confirm-line">
            {applyCreditConfirmLine({
              amountCents: parsed.amountCents,
              invoiceNumber,
              availableCents: balance.availableCents,
              dueCents,
            })}
          </p>
          <div className="invoice-credit__actions">
            <GhostButton label="Back" onClick={() => !busy && setStep('form')} disabled={busy} />
            <PrimaryButton
              label={busy ? 'Applying credit…' : 'Apply credit'}
              onClick={() => void submit()}
              disabled={busy}
              busy={busy}
            />
          </div>
        </div>
      )}
    </section>
  );
}
