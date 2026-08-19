/**
 * THE PAYMENT METHOD REGISTRY (PR30 / U8; extended for issue #409).
 *
 * Operator, 2026-08-06: three CTAs now, "but build out for other more payment
 * options." So the portal invoice is NOT three hardcoded buttons. It is a
 * configured list, resolved off `business_settings` (`venmoHandle`,
 * `paypalHandle`, `cashappHandle` — already read by `invoicePdf.ts`'s "How to
 * pay" line, but never reachable by the portal client itself). Adding a
 * processor later — Zelle, Apple Pay, whatever comes next — is one row in
 * `METHOD_SPECS` plus a settings field. No portal change.
 *
 * ── ISSUE #409: THE LIST BECAME A TOGGLE ────────────────────────────────
 *
 * Operator, 2026-08-17 walk mark 17: "Retitle name to Payment Options and
 * make it a true toggle for different payment option". A blank handle is not
 * a way of saying "stop offering Venmo" — it is a way of losing the handle.
 * So each method now carries an explicit on/off flag in
 * `business_settings.paymentOptions`, and the catalogue grew to the full set
 * the operator named: card (Stripe), Venmo, PayPal, Cash App, Zelle, Cash,
 * Check, Bank Transfer, Klarna, Affirm, Other.
 *
 * `MethodSpec.defaultEnabled` is what makes that a zero-migration change, and
 * it is the field to read first when this file confuses you:
 *
 *   - The FOUR methods that shipped before the toggle existed (stripe, venmo,
 *     paypal, cashapp) default to ENABLED. An org with no `paymentOptions`
 *     map at all — which is every org the moment this deploys — therefore
 *     resolves to exactly the list it resolved to yesterday. Nothing is
 *     backfilled and nothing changes under anybody.
 *   - The SEVEN methods introduced with the toggle default to DISABLED. An
 *     operator turns them on deliberately. This matters most for Klarna and
 *     Affirm: those ride the operator's own Stripe account and Stripe rejects
 *     a payment method type the account has not activated, so switching them
 *     on for everybody would break checkout for every org that never asked
 *     for them.
 *
 * ── THE THIRD KIND ──────────────────────────────────────────────────────
 *
 * `kind` was `'checkout' | 'link'`, which is to say "Stripe" and "a URL a
 * household taps". Cash, Check, Bank Transfer and Zelle-by-phone have no URL
 * and never will. They are `kind: 'instructions'`: the operator writes the
 * sentence the household needs ("Zelle to 805-555-0104, put the invoice
 * number in the note") and the portal renders that text instead of a button.
 * The omit-rather-than-dead-link rule carries straight over — an enabled
 * instructions method with no instructions written is omitted, exactly as an
 * enabled link method with no handle is.
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
 * (`getMyHome`'s `payMethods`, the per-invoice `payMethods` on
 * `getMyInvoices`, `PayOptions`) never receives them. This file carries the
 * schedule only as far as the registry itself; a future admin surface
 * (recording form pre-fill) reads it from here rather than duplicating the
 * numbers. Methods with no processor behind them (Cash, Check, Bank Transfer,
 * Zelle, Other) carry a zero schedule, which is the truth about them.
 */

/** The `BusinessSettings` string fields this resolver may normalize into a link. */
type LinkFieldKey = 'venmoHandle' | 'paypalHandle' | 'cashappHandle';

/**
 * Every method in the catalogue. A union rather than `string` so a typo in a
 * settings map, a snapshot, or a client is a compile error here rather than a
 * silently missing button on a bill.
 */
export type PayMethodId =
  | 'stripe'
  | 'venmo'
  | 'paypal'
  | 'cashapp'
  | 'zelle'
  | 'cash'
  | 'check'
  | 'banktransfer'
  | 'klarna'
  | 'affirm'
  | 'other';

/**
 * `checkout`     opens a Stripe Checkout Session (`portal/payInvoice.ts`).
 * `link`         a plain anchor to a URL built from an operator handle.
 * `instructions` no URL exists; the operator's own words are the whole method.
 */
export type PayMethodKind = 'checkout' | 'link' | 'instructions';

export interface MethodSpec {
  readonly id: PayMethodId;
  /** What the portal CTA says: "Pay with Venmo". */
  readonly label: string;
  /**
   * The bare name, for surfaces that supply their own framing: the printed
   * invoice's "How to pay" line reads "Venmo: @tribetails", and a settings
   * row is titled "Venmo", not "Pay with Venmo".
   */
  readonly shortLabel: string;
  readonly kind: PayMethodKind;
  /** The `OperatorSettings` field carrying this processor's handle. `null` for Stripe, which needs none. */
  readonly field: LinkFieldKey | null;
  /** URL prefix a normalized handle is appended to. `null` for Stripe. */
  readonly base: string | null;
  /** Leading character(s) an operator-typed handle may carry and this resolver strips before appending to `base`. */
  readonly strip: string;
  /**
   * What an ABSENT `paymentOptions` entry means for this method. See the
   * file header: true for the four that predate the toggle (so every existing
   * org keeps behaving identically with no backfill), false for the seven
   * introduced with it.
   */
  readonly defaultEnabled: boolean;
  /**
   * The Stripe `payment_method_types` value this method contributes to a
   * Checkout Session, or `null` when it does not ride Stripe. Klarna and
   * Affirm are Stripe payment method types, not separate integrations: no new
   * secret, no new webhook, one more string in an array
   * (`portal/payInvoice.ts`).
   */
  readonly stripePaymentMethodType: string | null;
  /** Basis points (1/100 of a percent): 290 = 2.9%. SCHEDULE ONLY — see file header. */
  readonly feeBps: number;
  /** Integer cents: 30 = $0.30. SCHEDULE ONLY — see file header. */
  readonly feeFixedCents: number;
}

/**
 * One entry per method, in the order a household sees them. Adding another is
 * a row here plus, if it takes a handle, a settings field.
 *
 * ORDER IS THE PORTAL'S ORDER: card first because it is the one method that
 * settles instantly and needs nothing typed, then the handle-based apps, then
 * the ones that are a sentence rather than a button. `other` is last because
 * it is the catch-all.
 */
export const METHOD_SPECS: readonly MethodSpec[] = [
  { id: 'stripe', label: 'Pay with Credit Card', shortLabel: 'Credit card', kind: 'checkout', field: null, base: null, strip: '', defaultEnabled: true, stripePaymentMethodType: 'card', feeBps: 290, feeFixedCents: 30 },
  { id: 'venmo', label: 'Pay with Venmo', shortLabel: 'Venmo', kind: 'link', field: 'venmoHandle', base: 'https://venmo.com/u/', strip: '@', defaultEnabled: true, stripePaymentMethodType: null, feeBps: 190, feeFixedCents: 10 },
  { id: 'paypal', label: 'Pay with PayPal', shortLabel: 'PayPal', kind: 'link', field: 'paypalHandle', base: 'https://paypal.me/', strip: '@', defaultEnabled: true, stripePaymentMethodType: null, feeBps: 349, feeFixedCents: 49 },
  { id: 'cashapp', label: 'Pay with Cash App', shortLabel: 'Cash App', kind: 'link', field: 'cashappHandle', base: 'https://cash.app/', strip: '', defaultEnabled: true, stripePaymentMethodType: null, feeBps: 260, feeFixedCents: 15 },
  { id: 'klarna', label: 'Pay with Klarna', shortLabel: 'Klarna', kind: 'checkout', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: 'klarna', feeBps: 599, feeFixedCents: 30 },
  { id: 'affirm', label: 'Pay with Affirm', shortLabel: 'Affirm', kind: 'checkout', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: 'affirm', feeBps: 599, feeFixedCents: 30 },
  { id: 'zelle', label: 'Pay with Zelle', shortLabel: 'Zelle', kind: 'instructions', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: null, feeBps: 0, feeFixedCents: 0 },
  { id: 'banktransfer', label: 'Pay by bank transfer', shortLabel: 'Bank transfer', kind: 'instructions', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: null, feeBps: 0, feeFixedCents: 0 },
  { id: 'check', label: 'Pay by check', shortLabel: 'Check', kind: 'instructions', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: null, feeBps: 0, feeFixedCents: 0 },
  { id: 'cash', label: 'Pay in cash', shortLabel: 'Cash', kind: 'instructions', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: null, feeBps: 0, feeFixedCents: 0 },
  // Not "Pay with Other", which is not a sentence anybody says. This heading
  // sits above whatever the operator wrote, so it has to read as an
  // introduction to her words rather than as the name of a processor.
  { id: 'other', label: 'Another way to pay', shortLabel: 'Other', kind: 'instructions', field: null, base: null, strip: '', defaultEnabled: false, stripePaymentMethodType: null, feeBps: 0, feeFixedCents: 0 },
] as const;

/** One method's operator configuration: is it offered, and what does it say. */
export interface PayMethodOption {
  /**
   * ABSENT IS NOT FALSE. Absent means "the operator has never touched this
   * toggle", which resolves to `MethodSpec.defaultEnabled` — see the file
   * header. Only an explicit `false` turns a method off.
   */
  enabled?: boolean;
  /** Operator-written text for a `kind: 'instructions'` method. Blank omits the method. */
  instructions?: string;
}

/**
 * The subset of `business_settings` (auntieos-admin `BusinessSettings`) this
 * resolver reads. Every field optional: a fresh settings doc, or a partial
 * test fixture, may carry none of them, and the default-enabled methods are
 * still offered.
 *
 * The three handle fields are UNCHANGED and stay exactly where they always
 * were. `paymentOptions` is added alongside them, never in place of them: the
 * PDF's "How to pay" line, the admin's own text inputs, and every other
 * reader of `venmoHandle` keep reading the same field.
 */
export interface OperatorSettings {
  venmoHandle?: string;
  paypalHandle?: string;
  cashappHandle?: string;
  /** Keyed by `PayMethodId`. Sparse: only the methods an operator has touched. */
  paymentOptions?: Partial<Record<PayMethodId, PayMethodOption>>;
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
  id: PayMethodId;
  label: string;
  kind: PayMethodKind;
  /** The URL a `kind: 'link'` method opens. Always null for the other two kinds. */
  url: string | null;
  /**
   * What a `kind: 'instructions'` method tells the household, in the
   * operator's own words. Always null for the other two kinds, so no client
   * has to branch on kind to know whether to look here.
   */
  instructions: string | null;
}

/** A handle that is a full email address, e.g. `auntie@example.com`. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How long an operator's instructions may run before a writer refuses them. */
export const MAX_INSTRUCTIONS_LENGTH = 500;

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
 * Is this method offered at all?
 *
 * The whole of the zero-migration promise lives in the `??`: an absent entry,
 * and an entry that exists but never states `enabled`, both fall through to
 * the spec's default. Only an explicit `false` turns a method off.
 */
export function isMethodEnabled(settings: OperatorSettings, spec: MethodSpec): boolean {
  return settings.paymentOptions?.[spec.id]?.enabled ?? spec.defaultEnabled;
}

/**
 * Returns only the payment methods that are ENABLED and usable for this
 * invoice: a checkout method whenever it is on (it needs nothing typed), a
 * link method only when its settings field holds a handle that normalizes to
 * a real URL, an instructions method only when the operator has written
 * instructions, and nothing at all once the invoice has nothing owed.
 *
 * A method whose handle is blank, or whose instructions are blank, is
 * OMITTED — never rendered as a dead button or an empty row. That rule is the
 * reason this resolver exists and it applies identically to all three kinds.
 */
export function resolvePayMethods(settings: OperatorSettings, invoice: InvoiceDto): PayMethod[] {
  if (invoice.amountDue <= 0) return [];

  const out: PayMethod[] = [];
  for (const spec of METHOD_SPECS) {
    if (!isMethodEnabled(settings, spec)) continue;

    if (spec.kind === 'checkout') {
      out.push({ id: spec.id, label: spec.label, kind: spec.kind, url: null, instructions: null });
      continue;
    }

    if (spec.kind === 'instructions') {
      const written = settings.paymentOptions?.[spec.id]?.instructions?.trim();
      if (!written) continue;
      out.push({ id: spec.id, label: spec.label, kind: spec.kind, url: null, instructions: written });
      continue;
    }

    const raw = spec.field ? settings[spec.field] : undefined;
    if (!raw) continue;
    const url = normalizeHandle(raw, spec);
    if (!url) continue;
    out.push({ id: spec.id, label: spec.label, kind: spec.kind, url, instructions: null });
  }
  return out;
}

/**
 * The same list, minus the `instructions` kind. This is what `getMyHome`
 * ships, and the reason is DEPLOY SKEW rather than product design.
 *
 * A web bundle built before issue #409 renders every non-checkout method as
 * `<a href={method.url ?? undefined}>` (`PayOptions.tsx`). Hand that bundle an
 * instructions method and it draws an anchor with no href: a dead link on a
 * bill, which is the exact defect this registry was written to prevent.
 * Functions and web do not deploy atomically, so that bundle WILL meet this
 * server.
 *
 * The full catalogue therefore rides only the per-invoice `payMethods` on
 * `getMyInvoices`, a field an old client does not read at all. `getMyHome`'s
 * business-wide list keeps its old two kinds and its old meaning.
 */
export function resolveHomePayMethods(settings: OperatorSettings, invoice: InvoiceDto): PayMethod[] {
  return resolvePayMethods(settings, invoice).filter((m) => m.kind !== 'instructions');
}

/**
 * The `payment_method_types` a Stripe Checkout Session should offer, derived
 * from which checkout methods the operator has enabled.
 *
 * ALWAYS INCLUDES 'card', and always first. Two reasons, both load-bearing:
 * Stripe requires a non-empty array, and an operator who turns the card off
 * without noticing that Klarna and Affirm are card-adjacent financing rails
 * would otherwise leave a checkout button that cannot open. The card toggle
 * governs whether a checkout button is OFFERED at all
 * (`resolvePayMethods`); this function governs what the session behind that
 * button can accept.
 */
export function stripeCheckoutMethodTypes(settings: OperatorSettings): string[] {
  const types: string[] = [];
  for (const spec of METHOD_SPECS) {
    if (spec.kind !== 'checkout' || !spec.stripePaymentMethodType) continue;
    if (!isMethodEnabled(settings, spec)) continue;
    types.push(spec.stripePaymentMethodType);
  }
  if (!types.includes('card')) types.unshift('card');
  return types;
}

/** Every id in the catalogue, for callers validating an operator-supplied key. */
export const PAY_METHOD_IDS: readonly PayMethodId[] = METHOD_SPECS.map((s) => s.id);

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Reads an `OperatorSettings` out of a raw Firestore body — a
 * `business_settings` doc, or a snapshot copied onto an invoice.
 *
 * ONE DECODER FOR BOTH. `getMyHome`, `getMyInvoices`, `payInvoice`, the PDF
 * renderer and the three snapshot writers all come through here, so the
 * snapshot's shape cannot drift from the live doc's: they are the same read.
 *
 * Type-checked rather than cast, in the house style (`api/settings.ts`'s
 * `pickString`): a legacy or hand-edited doc with a number where a handle
 * belongs reads as absent, not as `[object Object]` in a payment link.
 * Unknown method ids are dropped, so a stale key left by an older build, or a
 * typo made in the Firestore console, cannot conjure a method that does not
 * exist.
 */
export function payMethodSettingsFrom(raw: unknown): OperatorSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: OperatorSettings = {
    venmoHandle: stringOrUndefined(r['venmoHandle']),
    paypalHandle: stringOrUndefined(r['paypalHandle']),
    cashappHandle: stringOrUndefined(r['cashappHandle']),
  };

  const rawOptions = r['paymentOptions'];
  if (typeof rawOptions === 'object' && rawOptions !== null && !Array.isArray(rawOptions)) {
    const options: Partial<Record<PayMethodId, PayMethodOption>> = {};
    for (const spec of METHOD_SPECS) {
      const entry = (rawOptions as Record<string, unknown>)[spec.id];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const option: PayMethodOption = {};
      if (typeof e['enabled'] === 'boolean') option.enabled = e['enabled'];
      const instructions = stringOrUndefined(e['instructions']);
      if (instructions !== undefined) option.instructions = instructions;
      options[spec.id] = option;
    }
    out.paymentOptions = options;
  }

  return out;
}

/**
 * The settings an invoice carries forward from the moment it was issued.
 *
 * ── WHAT "OFF" MEANS, AND WHY IT IS A SNAPSHOT ──────────────────────────
 *
 * Operator ruling on issue #409: turning a method off stops offering it on
 * NEW invoices; invoices already issued keep working. A household that was
 * told "Zelle to this number" three weeks ago, and is holding that bill,
 * still gets that answer.
 *
 * So the settings that were live when the invoice was ISSUED are copied onto
 * it, and the portal resolves against the snapshot in preference to the live
 * doc. Nothing is backfilled: an invoice issued before this shipped has no
 * snapshot, falls back to the live settings, and therefore behaves exactly as
 * it does today. That fallback IS the migration.
 *
 * The amount owed is NOT part of the snapshot. Payability is still resolved
 * live off the invoice, so a bill settled after issue stops offering anything
 * the moment it is paid, snapshot or no snapshot.
 */
export interface PayMethodSettingsSnapshot extends OperatorSettings {
  /** ISO instant the snapshot was taken, for anybody reading the doc by hand. */
  capturedAt: string;
}

/**
 * Builds the snapshot written onto an invoice at issue time.
 *
 * Returns a plain object with no `undefined` values anywhere: Firestore
 * rejects `undefined`, and an invoice write failing because the operator has
 * never filled in a Cash App handle would be an absurd way to lose a bill.
 */
export function payMethodSettingsSnapshotOf(
  raw: unknown,
  capturedAt: Date = new Date(),
): PayMethodSettingsSnapshot {
  const settings = payMethodSettingsFrom(raw);
  const snapshot: PayMethodSettingsSnapshot = { capturedAt: capturedAt.toISOString() };
  if (settings.venmoHandle !== undefined) snapshot.venmoHandle = settings.venmoHandle;
  if (settings.paypalHandle !== undefined) snapshot.paypalHandle = settings.paypalHandle;
  if (settings.cashappHandle !== undefined) snapshot.cashappHandle = settings.cashappHandle;
  if (settings.paymentOptions !== undefined) snapshot.paymentOptions = settings.paymentOptions;
  return snapshot;
}

/** The invoice field the snapshot is stored under. Named once, read everywhere. */
export const PAY_METHOD_SNAPSHOT_FIELD = 'payMethodSettingsSnapshot';

/**
 * The settings an invoice should be resolved against: its own snapshot when it
 * has one, the live business settings when it does not.
 *
 * `invoiceData` is the raw invoice body. A snapshot that is present but is not
 * an object (hand-edited, half-written) is ignored in favour of live settings,
 * because a household holding a bill needs SOME way to pay it and the live doc
 * is the honest fallback.
 */
export function settingsForInvoice(
  invoiceData: Record<string, unknown> | undefined,
  liveSettings: OperatorSettings,
): OperatorSettings {
  const snapshot = invoiceData?.[PAY_METHOD_SNAPSHOT_FIELD];
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return liveSettings;
  return payMethodSettingsFrom(snapshot);
}
