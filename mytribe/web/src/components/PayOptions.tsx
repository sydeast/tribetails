import type { PayMethod } from '../api/types';
import { formatCentsUsd } from '../lib/invoiceFormat';
import './PayOptions.css';
import { BusyLabel } from '../components/Loading';

export interface PayOptionsProps {
  /** Resolved server-side — never raw operator handles. Prefer an invoice's own `payMethods`. */
  methods: PayMethod[];
  /** Cents. What a `kind: 'link'` method's caption tells the household to send. */
  amountDue: number;
  /** `kind: 'checkout'` (Stripe) click. Link methods are plain anchors and never call this. */
  onCheckout: () => void;
  /** True while the Stripe checkout mutation is in flight. */
  checkingOut?: boolean;
}

/**
 * One row per configured payment option. `kind: 'checkout'` is the existing
 * `payInvoice` Stripe flow; `kind: 'link'` is a plain anchor to its resolved
 * URL; `kind: 'instructions'` (issue #409) is a method with no link to open,
 * so it renders the operator's own words instead of a button.
 *
 * A link or instructions method cannot be handed an amount — Venmo, a check,
 * and a bank transfer have no way to know what this invoice owes — so each
 * carries a caption stating the figure to send. Without it a household
 * guesses and the operator reconciles the mismatch by hand.
 *
 * NOTHING HERE EVER RENDERS AN EMPTY TARGET. The server omits a method it
 * cannot resolve (blank handle, blank instructions) rather than sending one
 * through, so a dead link is not a state this component has to defend
 * against. It stays a rule worth knowing when editing this file.
 *
 * Renders nothing when `methods` is empty rather than an empty action row:
 * the caller (`InvoiceDetail`) decides what "no methods configured" means for
 * that screen, this component only renders what it's given.
 */
export function PayOptions({ methods, amountDue, onCheckout, checkingOut = false }: PayOptionsProps) {
  if (methods.length === 0) return null;

  return (
    <div className="pay-options">
      {methods.map((method) => {
        if (method.kind === 'checkout') {
          return (
            <button
              key={method.id}
              type="button"
              className="btn grad pay-options__cta"
              onClick={onCheckout}
              disabled={checkingOut}
            >
              {checkingOut ? <BusyLabel>Opening checkout…</BusyLabel> : method.label}
            </button>
          );
        }

        if (method.kind === 'instructions') {
          return (
            <div key={method.id} className="pay-options__instructions">
              <h4 className="pay-options__instructionsTitle">{method.label}</h4>
              <p className="pay-options__instructionsBody">{method.instructions}</p>
              <p className="pay-options__hint">
                Send {formatCentsUsd(amountDue)}, then let your Auntie know it&rsquo;s on its way.
              </p>
            </div>
          );
        }

        return (
          <div key={method.id} className="pay-options__link-group">
            <a
              className="btn ghost pay-options__cta"
              href={method.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {method.label}
            </a>
            <p className="pay-options__hint">
              Send {formatCentsUsd(amountDue)}, then let your Auntie know it&rsquo;s on its way.
            </p>
          </div>
        );
      })}
    </div>
  );
}
