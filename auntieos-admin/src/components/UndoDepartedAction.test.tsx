// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

/**
 * #2250, operator ruling 2026-11-14: "Undo departed" for a few minutes after
 * Departed, for the owner and an Auntie alike, through the server. The server
 * stamps when it closes; this block shows the button until then, says it is
 * waiting, and reads a refusal back in the server's own words.
 */
const { call, useDocById } = vi.hoisted(() => ({
  call: vi.fn(),
  useDocById: vi.fn(),
}));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('../lib/firestore', () => ({ useDocById }));

import { UndoDepartedAction } from './UndoDepartedAction';
import { undoDepartedOpen } from '../lib/undoDeparted';

const NOW = Date.parse('2026-11-14T15:31:00.000Z');
const UNTIL = '2026-11-14T15:35:00.000Z';

const visit = (extra: Record<string, unknown> = {}) => ({
  _id: 's1',
  status: 'COMPLETED',
  undoDepartedUntil: UNTIL,
  ...extra,
});

const button = () => screen.queryByRole('button', { name: 'Undo departed' });

async function confirmUndo() {
  fireEvent.click(screen.getByRole('button', { name: 'Undo departed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, undo departed' }));
  // Timers are faked, so `waitFor` cannot poll: let the callable's promise settle.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  call.mockReset();
  useDocById.mockReset().mockReturnValue({ status: 'ready', data: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('undoDepartedOpen', () => {
  it('is open on a Departed or Completed visit until the stamped moment', () => {
    expect(undoDepartedOpen({ status: 'COMPLETED', undoDepartedUntil: UNTIL }, NOW)).toBe(true);
    expect(undoDepartedOpen({ status: ' departed ', undoDepartedUntil: UNTIL }, Date.parse(UNTIL))).toBe(true);
    expect(undoDepartedOpen({ status: 'COMPLETED', undoDepartedUntil: UNTIL }, Date.parse(UNTIL) + 1)).toBe(false);
  });

  it('is closed with no stamp, an unreadable one, or a visit that is not departed', () => {
    expect(undoDepartedOpen({ status: 'COMPLETED' }, NOW)).toBe(false);
    expect(undoDepartedOpen({ status: 'COMPLETED', undoDepartedUntil: 'soon' }, NOW)).toBe(false);
    expect(undoDepartedOpen({ status: 'ARRIVED', undoDepartedUntil: UNTIL }, NOW)).toBe(false);
    expect(undoDepartedOpen({ status: 'CANCELLED', undoDepartedUntil: UNTIL }, NOW)).toBe(false);
  });
});

describe('the button', () => {
  it('is offered on a just-completed visit and on one still Departed', () => {
    const { unmount } = render(<UndoDepartedAction session={visit()} household="The Rivera Home" />);
    expect(button()).toBeInTheDocument();
    unmount();
    render(<UndoDepartedAction session={visit({ status: 'DEPARTED' })} household="The Rivera Home" />);
    expect(button()).toBeInTheDocument();
  });

  it('draws nothing on a visit with no window, or one that has not departed', () => {
    const { container, rerender } = render(
      <UndoDepartedAction session={visit({ undoDepartedUntil: undefined })} household="" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<UndoDepartedAction session={visit({ status: 'ARRIVED' })} household="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('goes by itself when the few minutes are up, with the screen left open', () => {
    const { container } = render(<UndoDepartedAction session={visit()} household="" />);
    expect(button()).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4 * 60 * 1000 + 2);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('a Departed row the board read before the server stamped it is watched until the stamp arrives', () => {
    useDocById.mockReturnValue({ status: 'ready', data: { status: 'COMPLETED', undoDepartedUntil: UNTIL } });
    render(<UndoDepartedAction session={visit({ status: 'DEPARTED', undoDepartedUntil: undefined })} household="" />);
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 's1');
    expect(button()).toBeInTheDocument();
  });

  it('a row that already carries the stamp opens no listener', () => {
    render(<UndoDepartedAction session={visit()} household="" />);
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', null);
  });
});

describe('undoing', () => {
  it('asks first, in the future tense, and says the household is not told', () => {
    render(<UndoDepartedAction session={visit()} household="The Rivera Home" />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo departed' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'The Rivera Home’s visit will go back to Arrived, with the arrival time it already has. The household is not told.',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('sends the undo to the server, shows it is waiting, then tells the screen to re-read', async () => {
    let finish: (v: unknown) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onUndone = vi.fn();
    render(<UndoDepartedAction session={visit()} household="The Rivera Home" onUndone={onUndone} />);

    await confirmUndo();

    expect(call).toHaveBeenCalledWith('setVisitLifecycle', { sessionId: 's1', action: 'UNDO_DEPARTED' });
    expect(screen.getByRole('status')).toHaveTextContent('Putting the visit back to Arrived…');
    expect(screen.getByRole('button', { name: 'Undo departed' })).toBeDisabled();
    expect(onUndone).not.toHaveBeenCalled();

    await act(async () => {
      finish({ ok: true, sessionId: 's1', status: 'ARRIVED', changed: true });
    });
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it("shows the server's refusal as written", async () => {
    call.mockRejectedValue(
      new Error('Undo departed is only there for 5 minutes after Departed. That time has passed.'),
    );
    render(<UndoDepartedAction session={visit()} household="" />);
    await confirmUndo();
    expect(screen.getByRole('alert')).toHaveTextContent(
        'Couldn’t undo the departure. Undo departed is only there for 5 minutes after Departed. That time has passed.',
      );
  });

  it('keeps a refusal on screen after the button has gone', async () => {
    call.mockRejectedValue(new Error('That time has passed.'));
    render(<UndoDepartedAction session={visit()} household="" />);
    await confirmUndo();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(button()).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('That time has passed.');
  });

  it('a failure with no sentence of its own still says what to do', async () => {
    call.mockRejectedValue('nope');
    render(<UndoDepartedAction session={visit()} household="" />);
    await confirmUndo();
    expect(screen.getByRole('alert')).toHaveTextContent(
        'Couldn’t undo the departure. Check your connection and try again.',
      );
  });
});
