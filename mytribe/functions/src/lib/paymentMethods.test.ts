import { describe, it, expect } from 'vitest';
import {
  METHOD_SPECS,
  isMethodEnabled,
  payMethodSettingsFrom,
  payMethodSettingsSnapshotOf,
  resolveHomePayMethods,
  resolvePayMethods,
  settingsForInvoice,
  stripeCheckoutMethodTypes,
  type InvoiceDto,
} from './paymentMethods';

/**
 * PR30: the payment method registry. Operator, 2026-08-06: three CTAs now,
 * "but build out for other more payment options" — so this resolves a
 * configured LIST off `business_settings`, not three hardcoded buttons.
 *
 * `invoice()` only ever needs `amountDue` (cents): resolvePayMethods offers
 * nothing once a bill is settled, and that is the one field it reads off the
 * invoice. See `paymentMethods.ts` for why this is NOT the portal's dollars-
 * float `InvoiceDto` from `getMyInvoices.ts`.
 */
function invoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return { amountDue: 12750, ...overrides };
}

describe('resolvePayMethods', () => {
  it('omits a method whose handle is blank rather than rendering a dead button', () => {
    const out = resolvePayMethods(
      { venmoHandle: '', paypalHandle: 'auntie', cashappHandle: '' },
      invoice(),
    );
    expect(out.map((m) => m.id)).toEqual(['stripe', 'paypal']);
  });

  it('normalizes a handle written any of the three ways an operator writes it', () => {
    for (const raw of ['auntie', '@auntie', 'https://venmo.com/u/auntie']) {
      const [venmo] = resolvePayMethods({ venmoHandle: raw }, invoice()).filter((m) => m.id === 'venmo');
      expect(venmo.url).toBe('https://venmo.com/u/auntie');
    }
  });

  it('supports Cash App, which settings already carries', () => {
    const out = resolvePayMethods({ cashappHandle: '$auntie' }, invoice());
    expect(out.find((m) => m.id === 'cashapp')?.url).toBe('https://cash.app/$auntie');
  });

  it('always offers Stripe, which needs no handle', () => {
    expect(resolvePayMethods({}, invoice()).map((m) => m.id)).toEqual(['stripe']);
  });

  it('offers nothing on a settled invoice', () => {
    expect(resolvePayMethods({ venmoHandle: 'auntie' }, invoice({ amountDue: 0 }))).toEqual([]);
  });

  it('offers nothing on an invoice already in credit (negative amountDue)', () => {
    // getMyInvoices documents negative amountDue as the credit signal, not a
    // bill. A "Pay with Venmo" button on a credit invoice is the exact dead
    // button this registry exists to prevent.
    expect(resolvePayMethods({ venmoHandle: 'auntie' }, invoice({ amountDue: -500 }))).toEqual([]);
  });

  it('omits PayPal for an email-form handle rather than building paypal.me/you@email.com', () => {
    // The admin field's own placeholder text is "you@email.com or
    // paypal.me/tribetails". An email is a real PayPal identifier, but
    // paypal.me only resolves a paypal.me USERNAME — appending an email to
    // that base is a 404 with a bill attached, not a working link.
    const out = resolvePayMethods({ paypalHandle: 'auntie@example.com' }, invoice());
    expect(out.map((m) => m.id)).toEqual(['stripe']);
  });

  it('returns Stripe as a checkout method with no url, and link methods with a url', () => {
    const out = resolvePayMethods({ venmoHandle: 'auntie' }, invoice());
    expect(out).toEqual([
      { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null },
      { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie', instructions: null },
    ]);
  });
});

/**
 * ISSUE #409: the list became a toggle.
 *
 * These are the tests that make the deploy safe. The registry grew from four
 * methods to eleven and gained an explicit on/off flag, and the one thing
 * that must NOT happen is an operator's invoices changing under her because
 * a field she has never heard of is absent from her settings doc.
 */
describe('resolvePayMethods enabled flags (issue #409)', () => {
  it('reads a configured method with NO paymentOptions map at all as enabled', () => {
    // This is every existing org on the day this deploys: three handles, no
    // map. The answer has to be byte-identical to the pre-toggle one.
    const out = resolvePayMethods(
      { venmoHandle: 'auntie', paypalHandle: 'auntie', cashappHandle: '$auntie' },
      invoice(),
    );
    expect(out.map((m) => m.id)).toEqual(['stripe', 'venmo', 'paypal', 'cashapp']);
  });

  it('reads a method whose entry exists but never states `enabled` as enabled', () => {
    // An operator who wrote instructions for one method and saved leaves
    // entries with no `enabled` key on the others. Absent is not false.
    const out = resolvePayMethods(
      { venmoHandle: 'auntie', paymentOptions: { venmo: {} } },
      invoice(),
    );
    expect(out.map((m) => m.id)).toEqual(['stripe', 'venmo']);
  });

  it('lets an explicit false beat a perfectly good handle', () => {
    // The whole point of the issue: turning Venmo off is a decision, not a
    // side effect of clearing the handle. The handle stays on the doc.
    const out = resolvePayMethods(
      { venmoHandle: 'auntie', paymentOptions: { venmo: { enabled: false } } },
      invoice(),
    );
    expect(out.map((m) => m.id)).toEqual(['stripe']);
  });

  it('turns the card off when the operator says so', () => {
    expect(resolvePayMethods({ paymentOptions: { stripe: { enabled: false } } }, invoice())).toEqual([]);
  });

  it('leaves every method introduced with the toggle OFF until it is turned on', () => {
    // Klarna and Affirm ride the operator's own Stripe account and Stripe
    // refuses a type she has not activated. Defaulting them on would break
    // checkout for every org that never asked for them.
    const out = resolvePayMethods({}, invoice());
    expect(out.map((m) => m.id)).toEqual(['stripe']);
  });

  it('agrees with the spec table about which methods default on', () => {
    // Stated as a table rather than a list of ids so a new row in
    // METHOD_SPECS has to declare its own answer here.
    const defaults = Object.fromEntries(METHOD_SPECS.map((s) => [s.id, isMethodEnabled({}, s)]));
    expect(defaults).toEqual({
      stripe: true,
      venmo: true,
      paypal: true,
      cashapp: true,
      klarna: false,
      affirm: false,
      zelle: false,
      banktransfer: false,
      check: false,
      cash: false,
      other: false,
    });
  });
});

describe('the instructions kind (issue #409)', () => {
  it("carries the operator's words instead of a url", () => {
    const out = resolvePayMethods(
      { paymentOptions: { zelle: { enabled: true, instructions: 'Zelle to 805-555-0104' } } },
      invoice(),
    );
    expect(out.find((m) => m.id === 'zelle')).toEqual({
      id: 'zelle',
      label: 'Pay with Zelle',
      kind: 'instructions',
      url: null,
      instructions: 'Zelle to 805-555-0104',
    });
  });

  it('omits an enabled method whose instructions are blank, rather than an empty row', () => {
    // Same rule as a blank handle, and for the same reason: a household
    // reading "Pay by check" with nothing under it has been told nothing.
    const out = resolvePayMethods(
      { paymentOptions: { check: { enabled: true, instructions: '   ' }, cash: { enabled: true } } },
      invoice(),
    );
    expect(out.map((m) => m.id)).toEqual(['stripe']);
  });

  it('trims what it ships, so a trailing newline never reaches a screen', () => {
    const out = resolvePayMethods(
      { paymentOptions: { cash: { enabled: true, instructions: '  Leave it with Auntie.\n' } } },
      invoice(),
    );
    expect(out.find((m) => m.id === 'cash')?.instructions).toBe('Leave it with Auntie.');
  });

  it('keeps instructions off the other two kinds entirely', () => {
    const out = resolvePayMethods(
      { venmoHandle: 'auntie', paymentOptions: { venmo: { instructions: 'ignored' } } },
      invoice(),
    );
    expect(out.every((m) => (m.kind === 'instructions') === (m.instructions !== null))).toBe(true);
  });
});

describe('resolveHomePayMethods', () => {
  it('withholds the instructions kind from the business-wide list', () => {
    // Deploy-skew guard: a portal bundle built before this change renders any
    // non-checkout method as an anchor, so an instructions method would reach
    // it as a dead link on a bill. See the function header.
    const settings = {
      venmoHandle: 'auntie',
      paymentOptions: { cash: { enabled: true, instructions: 'Cash is fine.' } },
    };
    expect(resolvePayMethods(settings, invoice()).map((m) => m.id)).toEqual(['stripe', 'venmo', 'cash']);
    expect(resolveHomePayMethods(settings, invoice()).map((m) => m.id)).toEqual(['stripe', 'venmo']);
  });
});

describe('stripeCheckoutMethodTypes', () => {
  it('offers card alone for an operator who has changed nothing', () => {
    expect(stripeCheckoutMethodTypes({})).toEqual(['card']);
  });

  it('reaches payment_method_types once Klarna and Affirm are switched on', () => {
    expect(
      stripeCheckoutMethodTypes({
        paymentOptions: { klarna: { enabled: true }, affirm: { enabled: true } },
      }),
    ).toEqual(['card', 'klarna', 'affirm']);
  });

  it('keeps card in the list even when the card toggle is off', () => {
    // The toggle governs whether a checkout BUTTON is offered. Stripe
    // requires a non-empty array, and Klarna and Affirm are card-adjacent
    // financing rails, so a session with no card type is a button that
    // cannot open.
    expect(
      stripeCheckoutMethodTypes({
        paymentOptions: { stripe: { enabled: false }, klarna: { enabled: true } },
      }),
    ).toEqual(['card', 'klarna']);
  });
});

describe('never leaks a fee to a household', () => {
  it('ships no fee field on any method, in any configuration', () => {
    // Standing ruling. The registry knows every fee; nothing downstream of
    // this resolver may.
    const out = resolvePayMethods(
      {
        venmoHandle: 'auntie',
        paypalHandle: 'auntie',
        cashappHandle: '$auntie',
        paymentOptions: {
          klarna: { enabled: true },
          affirm: { enabled: true },
          zelle: { enabled: true, instructions: 'Zelle to 805-555-0104' },
        },
      },
      invoice(),
    );
    expect(out.length).toBeGreaterThan(5);
    expect(JSON.stringify(out)).not.toMatch(/feeBps|feeFixedCents|fee/i);
    for (const method of out) {
      expect(Object.keys(method).sort()).toEqual(['id', 'instructions', 'kind', 'label', 'url']);
    }
  });
});

describe('payMethodSettingsFrom', () => {
  it('reads handles and options off a raw settings body', () => {
    expect(
      payMethodSettingsFrom({
        venmoHandle: 'auntie',
        paymentOptions: { venmo: { enabled: false }, cash: { enabled: true, instructions: 'Exact change.' } },
      }),
    ).toEqual({
      venmoHandle: 'auntie',
      paypalHandle: undefined,
      cashappHandle: undefined,
      paymentOptions: {
        venmo: { enabled: false },
        cash: { enabled: true, instructions: 'Exact change.' },
      },
    });
  });

  it('drops a key that is not a method in the catalogue', () => {
    // A stale key from an older build, or a typo made in the Firestore
    // console, must not conjure a method that does not exist.
    const out = payMethodSettingsFrom({ paymentOptions: { bitcoin: { enabled: true } } });
    expect(out.paymentOptions).toEqual({});
  });

  it('ignores a wrong-typed handle instead of building a link out of it', () => {
    expect(payMethodSettingsFrom({ venmoHandle: 42 }).venmoHandle).toBeUndefined();
  });

  it('reads a doc with no payment fields at all as an empty configuration', () => {
    expect(payMethodSettingsFrom(undefined).paymentOptions).toBeUndefined();
  });
});

describe('the issue-time snapshot (issue #409)', () => {
  it('captures the settings live at issue, with no undefined values Firestore would refuse', () => {
    const snap = payMethodSettingsSnapshotOf(
      { venmoHandle: 'auntie', paymentOptions: { venmo: { enabled: true } } },
      new Date('2026-08-19T12:00:00.000Z'),
    );
    expect(snap).toEqual({
      capturedAt: '2026-08-19T12:00:00.000Z',
      venmoHandle: 'auntie',
      paymentOptions: { venmo: { enabled: true } },
    });
    expect(Object.values(snap).some((v) => v === undefined)).toBe(false);
  });

  it('is preferred over live settings, so an issued invoice keeps working', () => {
    // The operator turned Venmo off this morning. A bill she sent last week
    // still offers it, because that is what the household was told.
    const live = { venmoHandle: 'auntie', paymentOptions: { venmo: { enabled: false } } };
    const issued = {
      payMethodSettingsSnapshot: payMethodSettingsSnapshotOf({
        venmoHandle: 'auntie',
        paymentOptions: { venmo: { enabled: true } },
      }),
    };
    expect(resolvePayMethods(settingsForInvoice(issued, live), invoice()).map((m) => m.id)).toEqual([
      'stripe',
      'venmo',
    ]);
    expect(resolvePayMethods(live, invoice()).map((m) => m.id)).toEqual(['stripe']);
  });

  it('falls back to live settings for an invoice issued before snapshots existed', () => {
    // No backfill: this is the entire migration story. An old invoice
    // resolves exactly as it does today.
    const live = { venmoHandle: 'auntie' };
    expect(resolvePayMethods(settingsForInvoice({ id: 'old' }, live), invoice()).map((m) => m.id)).toEqual([
      'stripe',
      'venmo',
    ]);
  });

  it('falls back to live settings when the stored snapshot is not an object', () => {
    // Hand-edited or half-written. A household holding a bill needs some way
    // to pay it, and live settings are the honest answer.
    const live = { venmoHandle: 'auntie' };
    const broken = { payMethodSettingsSnapshot: 'nonsense' };
    expect(resolvePayMethods(settingsForInvoice(broken, live), invoice()).map((m) => m.id)).toEqual([
      'stripe',
      'venmo',
    ]);
  });

  it('still offers nothing once the bill is settled, snapshot or no snapshot', () => {
    // The amount owed is deliberately NOT part of the snapshot.
    const issued = {
      payMethodSettingsSnapshot: payMethodSettingsSnapshotOf({ venmoHandle: 'auntie' }),
    };
    expect(resolvePayMethods(settingsForInvoice(issued, {}), invoice({ amountDue: 0 }))).toEqual([]);
  });
});
