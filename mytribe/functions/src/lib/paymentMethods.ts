/**
 * THE PAYMENT METHOD REGISTRY (PR30 / U8).
 *
 * Operator, 2026-08-06: three CTAs now, "but build out for other more payment
 * options." So the portal invoice is NOT three hardcoded buttons. It is a
 * configured list, resolved off `business_settings` (`venmoHandle`,
 * `paypalHandle`, `cashappHandle` — already read by `invoicePdf.ts`'s "How to
 * pay" line, but never reachable by the portal client itself). Adding a
 * processor later — Zelle, Apple Pay, whatever comes next — is one row in
 * `METHOD_SPECS` plus a settings field. No portal change.
 *
 * ── NORMALIZATION IS THE POINT ──────────────────────────────────────────
 *
 * These handles are free text an operator typed months ago, in whatever form
 * she had open at the time: `auntie`, `@auntie`, or a pasted
 * `https://venmo.com/u/auntie`. A half-parsed handle produces a button that
 * opens a 404 with a bill attached — a household staring at a broken link
 * with money in hand. `normalizeHandle` below is the one place that parsing
 * happens, so it only has to be right once.
 *
 * An email-shaped handle (`auntie@example.com`) is a real PayPal identifier,
 * but `paypal.me` only resolves a paypal.me USERNAME — gluing an email onto
 * that base is exactly the dead link this file exists to prevent, so an
 * email-shaped handle is omitted rather than guessed at. The admin field's
 * own placeholder text (`you@email.com or paypal.me/tribetails`) invites this
 * exact input.
 *
 * ── THE FEE SCHEDULE, AND WHAT IT IS NOT ────────────────────────────────
 *
 * Every processor charges a percentage plus a fixed base. Stored on each spec
 * as INTEGER basis points and INTEGER cents (`feeBps: 290` = 2.9%,
 * `feeFixedCents: 30` = $0.30) — never a float percentage, which is how
 * rounding errors get into money (see `paymentMoney.ts`).
 *
 * This is a SCHEDULE, not a charged fee. It exists so a recording form can
 * pre-fill an expected fee the operator can correct, and so a display can say
 * what a rail costs. It must never be stored as though it were the charged
 * fee: the standing ruling (`paymentMoney.ts`) is that the fee is known at
 * record time, read off the processor's own site by the operator. A computed
 * figure may SEED that field; it may never silently become the recorded
 * value, and it must never overwrite a figure she typed. For Stripe, the real
 * fee is machine-readable (`balance_transaction.fee`, PR29) — the schedule is
 * a cross-check there, never the source.
 *
 * KINFOLK NEVER SEE FEES (standing ruling; `getMyInvoices.ts` correctly does
 * not select the field). `feeBps`/`feeFixedCents` therefore stay OFF
 * `PayMethod` and everything downstream of `resolvePayMethods` — the portal
 * (`getMyHome`'s `payMethods`, `PayOptions`) never receives them. This file
 * carries the schedule only as far as the registry itself; a future admin
 * surface (recording form pre-fill) reads it from here rather than
 * duplicating the numbers.
 */

/** The `BusinessSettings` string fields this resolver may normalize into a link. */
type LinkFieldKey = 'venmoHandle' | 'paypalHandle' | 'cashappHandle';

interface MethodSpec {
  readonly id: 'stripe' | 'venmo' | 'paypal' | 'cashapp';
  readonly label: string;
  readonly kind: 'checkout' | 'link';
  /** The `OperatorSettings` field carrying this processor's handle. `null` for Stripe, which needs none. */
  readonly field: LinkFieldKey | null;
  /** URL prefix a normalized handle is appended to. `null` for Stripe. */
  readonly base: string | null;
  /** Leading character(s) an operator-typed handle may carry and this resolver strips before appending to `base`. */
  readonly strip: string;
  /** Basis points (1/100 of a percent): 290 = 2.9%. SCHEDULE ONLY — see file header. */
  readonly feeBps: number;
  /** Integer cents: 30 = $0.30. SCHEDULE ONLY — see file header. */
  readonly feeFixedCents: number;
}

// One entry per processor. Adding Zelle or Apple Pay later is a row here plus
// a settings field, and the portal does not change.
const METHOD_SPECS: readonly MethodSpec[] = [
  { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', field: null, base: null, strip: '', feeBps: 290, feeFixedCents: 30 },
  { id: 'venmo', label: 'Pay with Venmo', kind: 'link', field: 'venmoHandle', base: 'https://venmo.com/u/', strip: '@', feeBps: 190, feeFixedCents: 10 },
  { id: 'paypal', label: 'Pay with PayPal', kind: 'link', field: 'paypalHandle', base: 'https://paypal.me/', strip: '@', feeBps: 349, feeFixedCents: 49 },
  { id: 'cashapp', label: 'Pay with Cash App', kind: 'link', field: 'cashappHandle', base: 'https://cash.app/', strip: '', feeBps: 260, feeFixedCents: 15 },
] as const;

/**
 * The subset of `business_settings` (auntieos-admin `BusinessSettings`) this
 * resolver reads. Every field optional: a fresh settings doc, or a partial
 * test fixture, may carry none of them, and Stripe alone is still offered.
 */
export interface OperatorSettings {
  venmoHandle?: string;
  paypalHandle?: string;
  cashappHandle?: string;
}

/**
 * The one field this resolver needs off an invoice, in CENTS. Deliberately
 * NOT the portal's `InvoiceDto` (`getMyInvoices.ts`), whose `amountDue` is a
 * legacy DOLLARS float — mixing the two units here is exactly the kind of
 * rounding bug `paymentMoney.ts` exists to prevent elsewhere. A caller
 * holding the dollars-float shape converts: `Math.round(amountDue * 100)`.
 */
export interface InvoiceDto {
  /**
   * Cents. `<= 0` means nothing is owed — zero (settled) or negative
   * (`getMyInvoices.ts` documents negative `amountDue` as the credit signal,
   * not a bill) — and no method is offered.
   */
  amountDue: number;
}

export interface PayMethod {
  id: 'stripe' | 'venmo' | 'paypal' | 'cashapp';
  label: string;
  kind: 'checkout' | 'link';
  url: string | null;
}

/** A handle that is a full email address, e.g. `auntie@example.com`. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turns an operator-typed handle into the URL a household taps, or `null`
 * when the handle can't be trusted to resolve. Already-a-URL is taken as-is;
 * otherwise the spec's `strip` prefix (if present) is removed and the rest is
 * appended to `base`. Cash App keeps its `$` (`strip: ''`), because
 * `cash.app/$auntie` is the real form.
 */
function normalizeHandle(raw: string, spec: MethodSpec): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !spec.base) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // An email is a real identifier for some processors, but not a URL path
  // segment — see file header. Never glue it onto `base`.
  if (EMAIL_RE.test(trimmed)) return null;
  const stripped = spec.strip && trimmed.startsWith(spec.strip) ? trimmed.slice(spec.strip.length) : trimmed;
  if (!stripped) return null;
  return `${spec.base}${stripped}`;
}

/**
 * Returns only the payment methods that are configured AND usable for this
 * invoice: Stripe always (it needs no handle), a link method only when its
 * settings field holds a handle that normalizes to a real URL, and nothing at
 * all once the invoice has nothing owed. A method whose handle is blank is
 * omitted, never rendered as a dead button.
 */
export function resolvePayMethods(settings: OperatorSettings, invoice: InvoiceDto): PayMethod[] {
  if (invoice.amountDue <= 0) return [];

  const out: PayMethod[] = [];
  for (const spec of METHOD_SPECS) {
    if (spec.kind === 'checkout') {
      out.push({ id: spec.id, label: spec.label, kind: spec.kind, url: null });
      continue;
    }
    const raw = spec.field ? settings[spec.field] : undefined;
    if (!raw) continue;
    const url = normalizeHandle(raw, spec);
    if (!url) continue;
    out.push({ id: spec.id, label: spec.label, kind: spec.kind, url });
  }
  return out;
}
