// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  isPaymentMethodEnabled,
  PAYMENT_METHOD_CATALOGUE,
  type BusinessSettings,
} from '../../api/settings';
import { PaymentOptionsSection, type PaymentSettings } from './sections';

/**
 * ISSUE #409: Payment Options, the panel that replaced three free-text boxes.
 *
 * The operator's complaint was that a blank handle was the only way to stop
 * offering a method, which loses the handle. These tests are about the two
 * things that fixes: an explicit switch per method, and a catalogue that runs
 * past the three apps that happen to have a URL.
 *
 * The rule underneath all of them is that ABSENT IS NOT OFF. A settings doc
 * written before this panel existed has no `paymentOptions` map at all, and it
 * has to keep offering exactly what it offered before.
 */
function settings(over: Partial<PaymentSettings> = {}): PaymentSettings {
  return {
    paymentOptions: {},
    venmoHandle: '',
    paypalHandle: '',
    cashappHandle: '',
    ...over,
  };
}

/**
 * Plays the shell's role: `Settings.tsx`'s `persist` feeds a save back through
 * the same `data` prop, and the panel only clears "dirty" (and shows "Saved")
 * once it sees the write it asked for. A static `data` object can never
 * demonstrate that, so the one test that needs "Saved" mounts this instead.
 */
function Harness({
  initial,
  onSave,
}: {
  initial: PaymentSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}) {
  const [data, setData] = useState(initial);
  async function persist(patch: Partial<BusinessSettings>) {
    await onSave(patch);
    setData((d) => ({ ...d, ...patch } as PaymentSettings));
  }
  return <PaymentOptionsSection data={data} onSave={persist} />;
}

/** The one patch the panel sent, typed, so a test does not index into `unknown`. */
function savedPatch(onSave: ReturnType<typeof vi.fn>): Partial<BusinessSettings> {
  const call = onSave.mock.calls[0];
  if (!call) throw new Error('onSave was never called');
  return call[0] as Partial<BusinessSettings>;
}
describe('PaymentOptionsSection catalogue', () => {
  it('shows a switch for every method in the catalogue, not only the three with handles', () => {
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    for (const method of PAYMENT_METHOD_CATALOGUE) {
      expect(screen.getByRole('switch', { name: `Offer ${method.label}` })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('switch')).toHaveLength(11);
  });

  /**
   * Mirrored from `mytribe/functions/src/lib/paymentMethods.ts`'s `METHOD_SPECS`
   * (the two apps are not workspace members of each other, so there is no import
   * to share). The server registry's own suite pins the same table. Two tables
   * that must agree, each stated outright, is what keeps a mirror from quietly
   * becoming a fork.
   */
  it('agrees with the server registry about which methods default on', () => {
    const defaults = Object.fromEntries(
      PAYMENT_METHOD_CATALOGUE.map((m) => [m.id, isPaymentMethodEnabled({}, m)]),
    );
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

  it('reads a settings doc with no paymentOptions map as the pre-toggle behaviour', () => {
    // Every existing org, on the day this deploys: the four that shipped before
    // the toggle are on, the seven introduced with it are off.
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Offer Venmo' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Offer Credit card' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Offer Klarna' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Offer Zelle' })).toHaveAttribute('aria-checked', 'false');
  });

  it('honours an explicit off over a handle that is still on the doc', () => {
    render(
      <PaymentOptionsSection
        data={settings({ venmoHandle: '@auntie', paymentOptions: { venmo: { enabled: false } } })}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Offer Venmo' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('PaymentOptionsSection fields', () => {
  it('offers a handle box for a link method and an instructions box for a written one', () => {
    render(
      <PaymentOptionsSection
        data={settings({ paymentOptions: { zelle: { enabled: true } } })}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Venmo handle')).toBeInTheDocument();
    expect(screen.getByLabelText('What kinfolk should do')).toBeInTheDocument();
  });

  it('gives a checkout method no box at all, because there is nothing to type', () => {
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    expect(screen.queryByLabelText('Credit card handle')).not.toBeInTheDocument();
  });

  it("hides a method's boxes when it is switched off, without clearing them", async () => {
    // Turning Cash App off for a month and back on must not cost the operator
    // the handle. That is the whole reason a toggle beats a blank box.
    render(<PaymentOptionsSection data={settings({ cashappHandle: '$auntie' })} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Cash App handle')).toHaveValue('$auntie');

    await userEvent.click(screen.getByRole('switch', { name: 'Offer Cash App' }));
    expect(screen.queryByLabelText('Cash App handle')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: 'Offer Cash App' }));
    expect(screen.getByLabelText('Cash App handle')).toHaveValue('$auntie');
  });

  it('says so when a method is on with nothing behind it', async () => {
    // The portal omits such a method rather than shipping a dead link, so
    // without this the operator gets silence and no way to tell it from
    // success.
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Zelle' }));
    expect(screen.getByText(/Write what kinfolk should do/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('What kinfolk should do'), 'Zelle to 805-555-0104');
    expect(screen.queryByText(/Write what kinfolk should do/)).not.toBeInTheDocument();
  });

  it('shows the fee schedule for the methods that carry one, and none for the rest', () => {
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    expect(screen.getByText('Venmo charges about 1.9% + $0.10 per payment.')).toBeInTheDocument();
    expect(screen.getByText('Credit card charges about 2.9% + $0.30 per payment.')).toBeInTheDocument();
    expect(screen.queryByText(/^Cash charges about/)).not.toBeInTheDocument();
  });
});

describe('PaymentOptionsSection saving', () => {
  it('stays disabled until something actually changes', async () => {
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    const save = screen.getByRole('button', { name: /save payment options/i });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Klarna' }));
    expect(save).toBeEnabled();
  });

  it('writes an explicit flag for every method, and leaves the handles in their own fields', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PaymentOptionsSection data={settings({ venmoHandle: '@auntie' })} onSave={onSave} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Offer Venmo' }));
    await userEvent.click(screen.getByRole('button', { name: /save payment options/i }));

    const patch = savedPatch(onSave);
    // The handle is NOT moved into the map. Every other reader of `venmoHandle`
    // (the invoice PDF's "How to pay" line, the portal's link resolver) keeps
    // reading the field it always read.
    expect(patch.venmoHandle).toBe('@auntie');
    expect(patch.paymentOptions?.venmo).toEqual({ enabled: false, instructions: '' });
    // Written for all eleven, including the untouched ones, so a later change
    // to a shipped default cannot silently rewrite a decision already made.
    expect(Object.keys(patch.paymentOptions ?? {}).sort()).toEqual(
      PAYMENT_METHOD_CATALOGUE.map((m) => m.id).sort(),
    );
  });

  it('trims the instructions it saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PaymentOptionsSection
        data={settings({ paymentOptions: { cash: { enabled: true } } })}
        onSave={onSave}
      />,
    );
    await userEvent.type(screen.getByLabelText('What kinfolk should do'), '  Exact change.  ');
    await userEvent.click(screen.getByRole('button', { name: /save payment options/i }));
    expect(savedPatch(onSave).paymentOptions?.cash?.instructions).toBe('Exact change.');
  });

  it('confirms the save once the shell hands the write back', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Klarna' }));
    await userEvent.click(screen.getByRole('button', { name: /save payment options/i }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('says what went wrong and keeps the change when the save is refused', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<PaymentOptionsSection data={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Klarna' }));
    await userEvent.click(screen.getByRole('button', { name: /save payment options/i }));

    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Offer Klarna' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /save payment options/i })).toBeEnabled();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});

/**
 * #1593: each handle refuses what its app cannot open, beside the handle, with
 * the server's sentence; and Cancel puts the panel back to what is saved.
 */
describe('PaymentOptionsSection handle checks and Cancel', () => {
  const SAVE = { name: /save payment options/i };
  const VENMO = 'Enter the Venmo username: 5 to 30 letters, numbers, - or _.';
  const PAYPAL = 'Enter the PayPal.Me name: up to 20 letters and numbers.';
  const CASHAPP = 'Enter the $Cashtag: up to 20 letters, numbers or _, with at least one letter.';

  it.each([
    ['Venmo handle', 'abc', VENMO],
    ['PayPal handle', 'paypal.me/tribetails', PAYPAL],
    ['Cash App handle', '$12345', CASHAPP],
  ])('%s: %j is refused beside the box and Save stays off', async (label, typed, sentence) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PaymentOptionsSection data={settings()} onSave={onSave} />);
    const box = screen.getByLabelText(label);
    await userEvent.type(box, typed);
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleErrorMessage(sentence);
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a fixed handle clears the sentence and saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PaymentOptionsSection data={settings()} onSave={onSave} />);
    const box = screen.getByLabelText('Venmo handle');
    await userEvent.type(box, '@abc');
    expect(screen.getByText(VENMO)).toBeInTheDocument();
    await userEvent.type(box, 'de');
    expect(screen.queryByText(VENMO)).toBeNull();
    expect(box).not.toHaveAttribute('aria-invalid');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(savedPatch(onSave).venmoHandle).toBe('@abcde');
  });

  it('a blank handle passes the check (the on-but-blank warning still says so)', async () => {
    render(<PaymentOptionsSection data={settings()} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Venmo handle')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(VENMO)).toBeNull();
  });

  it('keeps a refused handle on screen while its method is off, because the handle is saved either way', async () => {
    render(
      <PaymentOptionsSection
        data={settings({ venmoHandle: 'abc', paymentOptions: { venmo: { enabled: false } } })}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Offer Venmo' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Venmo handle')).toHaveAccessibleErrorMessage(VENMO);
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Klarna' }));
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
  });

  it('Cancel is off until something changes, then puts every field back', async () => {
    render(
      <PaymentOptionsSection data={settings({ venmoHandle: '@tribetails' })} onSave={vi.fn()} />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    const box = screen.getByLabelText('Venmo handle');
    await userEvent.clear(box);
    await userEvent.type(box, 'x');
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Klarna' }));
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(screen.getByLabelText('Venmo handle')).toHaveValue('@tribetails');
    expect(screen.queryByText(VENMO)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Offer Klarna' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
    expect(cancel).toBeDisabled();
  });

  it('puts a server refusal for a handle beside that handle', async () => {
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error(PAYPAL), {
        details: { code: 'settings_refused', field: 'paypalHandle', refusals: [{ field: 'paypalHandle', message: PAYPAL }] },
      }),
    );
    render(<PaymentOptionsSection data={settings()} onSave={onSave} />);
    const box = screen.getByLabelText('PayPal handle');
    await userEvent.type(box, 'tribetails');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText(PAYPAL)).toBeInTheDocument();
    expect(box).toHaveAccessibleErrorMessage(PAYPAL);
    expect(screen.queryByText('Save failed')).toBeNull();
  });

  it('shows a refusal for a field it does not draw in the banner', async () => {
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error('Each payment method has to be on or off.'), {
        details: {
          code: 'settings_refused',
          field: 'paymentOptions',
          refusals: [{ field: 'paymentOptions', message: 'Each payment method has to be on or off.' }],
        },
      }),
    );
    render(<PaymentOptionsSection data={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Klarna' }));
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText('Each payment method has to be on or off.')).toBeInTheDocument();
    expect(screen.getByText('Save failed')).toBeInTheDocument();
  });
});
