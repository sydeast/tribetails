import { useQuery } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';

import { getAccountCreditHistory } from '../api/invoicesApi';
import type {
  GetAccountCreditHistoryResultCredit,
  GetAccountCreditHistoryResultUse,
} from '../contracts/invoiceContracts.generated';
import { formatCentsUsd } from '../lib/invoiceFormat';

/**
 * Q6 (operator ruling 2026-09-27): "Those with billing access: biz
 * owner/admin, PK, and SK if PK granted access can see the credit, dates,
 * reason, and date applied when used."
 *
 * The server decides who has billing access. A `permission-denied` answer
 * means this person does not, and the section is not rendered at all: no
 * heading, no error. A failure here never touches the invoice list above it.
 */

/** "Sep 27, 2026", local time. */
export function creditDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Applied Oct 3, 2026", "$10.00 of $25.00 applied", or "Not used yet". */
export function creditStatusLine(c: GetAccountCreditHistoryResultCredit): string {
  if (c.fullyAppliedAtMs !== null) return `Applied ${creditDate(c.fullyAppliedAtMs)}`;
  const used = c.amountCents - c.remainingCents;
  if (used > 0) return `${formatCentsUsd(used)} of ${formatCentsUsd(c.amountCents)} applied`;
  return 'Not used yet';
}

/** One line per partial use. Empty when the credit went in one go. */
export function creditApplicationLines(c: GetAccountCreditHistoryResultCredit): string[] {
  if (c.fullyAppliedAtMs !== null && c.applications.length <= 1) return [];
  return c.applications.map(
    (a) => `${formatCentsUsd(a.amountCents)} on ${a.invoiceNumber ?? 'an invoice'}, ${creditDate(a.appliedAtMs)}`,
  );
}

/** "$25.00 on INV-1009, Oct 3, 2026". */
export function creditUseLine(u: GetAccountCreditHistoryResultUse): string {
  return `${formatCentsUsd(u.amountCents)} on ${u.invoiceNumber ?? 'an invoice'}, ${creditDate(u.usedAtMs)}`;
}

function isPermissionDenied(err: unknown): boolean {
  return err instanceof FirebaseError && err.code === 'functions/permission-denied';
}

export function CreditHistorySection({ kinfolkId }: { kinfolkId: string | undefined }) {
  const history = useQuery({
    queryKey: ['accountCreditHistory', kinfolkId],
    queryFn: () => getAccountCreditHistory(kinfolkId),
    // A refusal is an answer, not a fault; asking again changes nothing.
    retry: (count, err) => !isPermissionDenied(err) && count < 2,
  });

  if (history.isError && isPermissionDenied(history.error)) return null;
  if (history.isPending) return null;
  if (history.isError) {
    return (
      <section className="glass card credithistory">
        <div className="sectlabel">Account credit history</div>
        <p className="chnote" role="alert">
          Could not load account credit history.
        </p>
      </section>
    );
  }

  const { credits, uses } = history.data;
  if (credits.length === 0 && uses.length === 0) return null;

  return (
    <section className="glass card credithistory">
      <div className="sectlabel">Account credit history</div>
      {credits.length > 0 && (
        <>
          <h3 className="chhead">Credits given</h3>
          <ul className="chlist">
            {credits.map((c) => (
              <li key={c.creditId} className="chrow">
                <div className="chline">
                  <b>{formatCentsUsd(c.amountCents)}</b>
                  <small>Given {creditDate(c.givenAtMs)}</small>
                </div>
                <p className="chreason">{c.reason}</p>
                <small className="chstatus">{creditStatusLine(c)}</small>
                {creditApplicationLines(c).map((line, i) => (
                  <small key={i} className="chstatus">
                    {line}
                  </small>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {uses.length > 0 && (
        <>
          <h3 className="chhead">Credit used</h3>
          <ul className="chlist">
            {uses.map((u) => (
              <li key={u.useId} className="chrow">
                <small className="chstatus">{creditUseLine(u)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
