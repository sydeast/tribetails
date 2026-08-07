import type { PayMethod } from '../api/types';
import { formatCentsUsd } from '../lib/invoiceFormat';
import './PayOptions.css';

export interface PayOptionsProps {
  /** Resolved off `getMyHome`'s `payMethods` — never raw operator handles. */
  methods: PayMethod[];
  /** Cents. What a `kind: 'link'` method's caption tells the household to send. */
  amountDue: number;
  /** `kind: 'checkout'` (Stripe) click. Link methods are plain anchors and never call this. */
  onCheckout: () => void;
  /** True while the Stripe checkout mutation is in flight. */
  checkingOut?: boolean;
}

/**
 * One CTA per configured payment processor. Stripe (`kind: 'checkout'`) is
 * the existing `payInvoice` flow; every other method (`kind: 'link'`) is a
 * plain anchor to its resolved URL.
 *
 * A link method cannot be handed an amount — Venmo/PayPal/Cash App have no
 * way to know what this invoice owes — so it carries a caption stating the
 * figure to send. Without it a household guesses and the operator reconciles
 * the mismatch by hand.
 *
 * Renders nothing when `methods` is empty rather than an empty action row:
 * the caller (`InvoiceDetail`) decides what "no methods configured" means for
 * that screen, this component only renders what it's given.
 */
export function PayOptions({ methods, amountDue, onCheckout, checkingOut = false }: PayOptionsProps) {
  if (methods.length === 0) return null;

  return (
    <div className="pay-options">
      {methods.map((method) =>
        method.kind === 'checkout' ? (
          <button
            key={method.id}
            type="button"
            className="btn grad pay-options__cta"
            onClick={onCheckout}
            disabled={checkingOut}
          >
            {checkingOut ? 'Opening checkout…' : method.label}
          </button>
        ) : (
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
        ),
      )}
    </div>
  );
}
