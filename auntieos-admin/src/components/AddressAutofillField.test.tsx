// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { suggestMock, retrieveMock } = vi.hoisted(() => ({
  suggestMock: vi.fn(),
  retrieveMock: vi.fn(),
}));
vi.mock('../api/mapbox', async () => {
  // The token generator is NOT mocked: token stability and rotation are the
  // behavior under test, and a stubbed constant would pass either way.
  const actual = await vi.importActual<typeof import('../api/mapbox')>('../api/mapbox');
  return { ...actual, mapboxSuggest: suggestMock, mapboxRetrieve: retrieveMock };
});

import { AddressAutofillField } from './AddressAutofillField';

const SUGGESTIONS = [
  { name: 'Mill House', fullAddress: '1 Mill St, Austin TX 78701', mapboxId: 'id-1', placeFormatted: 'Austin TX' },
  { name: 'Mill Creek', fullAddress: '2 Mill Creek Rd, Austin TX 78702', mapboxId: 'id-2', placeFormatted: 'Austin TX' },
];

/** Controlled host, so what the field writes back is observable as rendered value. */
function Host({ initial = '', onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <AddressAutofillField
      name="serviceAddress"
      label="Service address"
      value={value}
      error={null}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      onBlur={() => {}}
    />
  );
}

function field() {
  return screen.getByLabelText(/service address/i);
}

beforeEach(() => {
  suggestMock.mockReset().mockResolvedValue(SUGGESTIONS);
  retrieveMock.mockReset().mockResolvedValue('1 Mill St, Austin TX 78701');
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Keystroke-by-keystroke typing driven by fireEvent rather than userEvent.
 * userEvent's own internal delay timer deadlocks against `vi.useFakeTimers`,
 * and the debounce window is precisely what these tests need to control, so the
 * input events are dispatched directly.
 */
async function typeInto(el: HTMLElement, text: string) {
  const start = (el as HTMLInputElement).value;
  for (let i = 1; i <= text.length; i += 1) {
    const next = start + text.slice(0, i);
    await act(async () => {
      fireEvent.change(el, { target: { value: next } });
    });
  }
}

/** Types, then advances past the 250 ms debounce so the lookup fires. */
async function typeAndSettle(text: string, opts: { advance?: number } = {}) {
  await typeInto(field(), text);
  await act(async () => {
    vi.advanceTimersByTime(opts.advance ?? 300);
  });
}

describe('AddressAutofillField', () => {
  it('renders a plain editable input that saves what is typed, with no lookup at all', async () => {
    const onValue = vi.fn();
    render(<Host onValue={onValue} />);
    await userEvent.type(field(), 'ab');
    expect((field() as HTMLInputElement).value).toBe('ab');
    expect(onValue).toHaveBeenLastCalledWith('ab');
  });

  it('does NOT look up the address the form LOADED with', async () => {
    vi.useFakeTimers();
    render(<Host initial="123 Bark Ave" />);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it('still looks up once the operator edits a loaded address', async () => {
    vi.useFakeTimers();
    render(<Host initial="123 Bark Ave" />);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await typeAndSettle('nue');
    expect(suggestMock).toHaveBeenCalledTimes(1);
    expect(suggestMock.mock.calls[0]?.[0]).toBe('123 Bark Avenue');
  });

  it('does NOT look up under 3 characters', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('12');
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it('debounces: no call until 250 ms after the last keystroke', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeInto(field(), '123 Mill');
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(suggestMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(suggestMock).toHaveBeenCalledTimes(1);
  });

  it('fires ONE lookup for a burst of keystrokes, on the final query', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    expect(suggestMock).toHaveBeenCalledTimes(1);
    expect(suggestMock.mock.calls[0]?.[0]).toBe('123 Mill');
  });

  it('reuses ONE session token across keystrokes so Mapbox bills a single session', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    await typeAndSettle(' St');
    expect(suggestMock).toHaveBeenCalledTimes(2);
    const [, firstToken] = suggestMock.mock.calls[0] as [string, string];
    const [, secondToken] = suggestMock.mock.calls[1] as [string, string];
    expect(firstToken).toMatch(/^[0-9a-f]{32}$/);
    expect(secondToken).toBe(firstToken);
  });

  it('retrieves with the SAME token the suggests used, then ROTATES it for the next search', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    const [, suggestToken] = suggestMock.mock.calls[0] as [string, string];

    const option = screen.getByRole('button', { name: /Mill House/ });
    await act(async () => {
      fireEvent.click(option);
    });

    expect(retrieveMock).toHaveBeenCalledWith('id-1', suggestToken);

    // A NEW search must not reuse the retired token.
    await typeAndSettle('9 Oak');
    const lastCall = suggestMock.mock.calls[suggestMock.mock.calls.length - 1] as [string, string];
    expect(lastCall[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(lastCall[1]).not.toBe(suggestToken);
  });

  it('writes the RESOLVED address back into the field when a suggestion is picked', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Mill House/ }));
    });
    expect((field() as HTMLInputElement).value).toBe('1 Mill St, Austin TX 78701');
  });

  it('picking a suggestion does not immediately re-open the dropdown for the address it just wrote', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    const callsBefore = suggestMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Mill House/ }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(suggestMock.mock.calls.length).toBe(callsBefore);
    expect(screen.queryByRole('button', { name: /Mill Creek/ })).not.toBeInTheDocument();
  });

  it('shows each suggestion as name plus its full address', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    const option = screen.getByRole('button', { name: /Mill House/ });
    expect(option).toHaveTextContent('Mill House');
    expect(option).toHaveTextContent('1 Mill St, Austin TX 78701');
  });

  it('fails LOUD on a lookup error, naming the failure and pointing at manual entry', async () => {
    vi.useFakeTimers();
    suggestMock.mockRejectedValue(new Error('mapbox_502'));
    render(<Host />);
    await typeAndSettle('123 Mill');
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(
      'Address lookup failed: mapbox_502. Type the full street address manually.',
    );
  });

  it('keeps the field fully typeable after a lookup error (lookup is additive, never blocking)', async () => {
    vi.useFakeTimers();
    suggestMock.mockRejectedValue(new Error('mapbox_502'));
    const onValue = vi.fn();
    render(<Host onValue={onValue} />);
    await typeAndSettle('123 Mill');
    screen.getByRole('alert');

    expect(field()).not.toBeDisabled();
    await typeInto(field(), ' St, Austin TX');
    expect((field() as HTMLInputElement).value).toBe('123 Mill St, Austin TX');
    expect(onValue).toHaveBeenLastCalledWith('123 Mill St, Austin TX');
  });

  it('surfaces a RETRIEVE failure in the same banner and leaves the typed address alone', async () => {
    vi.useFakeTimers();
    retrieveMock.mockRejectedValue(new Error('mapbox_500'));
    render(<Host />);
    await typeAndSettle('123 Mill');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Mill House/ }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Address lookup failed: mapbox_500.');
    expect((field() as HTMLInputElement).value).toBe('123 Mill');
  });

  it('clears a stale error banner once a later lookup succeeds', async () => {
    vi.useFakeTimers();
    suggestMock.mockRejectedValueOnce(new Error('mapbox_502'));
    render(<Host />);
    await typeAndSettle('123 Mill');
    screen.getByRole('alert');
    await typeAndSettle(' St');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dismisses the dropdown on Escape', async () => {
    vi.useFakeTimers();
    render(<Host />);
    await typeAndSettle('123 Mill');
    screen.getByRole('button', { name: /Mill House/ });
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Escape' });
    });
    expect(screen.queryByRole('button', { name: /Mill House/ })).not.toBeInTheDocument();
  });

  it('dismisses the dropdown on an outside pointerdown', async () => {
    vi.useFakeTimers();
    render(
      <>
        <Host />
        <button type="button">elsewhere</button>
      </>,
    );
    await typeAndSettle('123 Mill');
    screen.getByRole('button', { name: /Mill House/ });
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    });
    expect(screen.queryByRole('button', { name: /Mill House/ })).not.toBeInTheDocument();
  });

  it('renders the caller-supplied validation error, unrelated to lookup', () => {
    render(
      <AddressAutofillField
        name="serviceAddress"
        label="Service address"
        value=""
        error="A service address is required."
        onChange={vi.fn()}
        onBlur={vi.fn()}
      />,
    );
    expect(screen.getByText('A service address is required.')).toBeInTheDocument();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });
});
