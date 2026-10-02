// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * #1083: the do-not-send list. Asserted on what reaches the callables, so a
 * button wired to nothing cannot pass on its label.
 */
const api = vi.hoisted(() => ({
  listMessageSuppressions: vi.fn(),
  clearMessageSuppression: vi.fn(),
}));

vi.mock('../../api/messageSuppressions', async (orig) => ({
  ...(await orig<typeof import('../../api/messageSuppressions')>()),
  listMessageSuppressions: api.listMessageSuppressions,
  clearMessageSuppression: api.clearMessageSuppression,
}));

import { DoNotSendSection } from './DoNotSendSection';

const BOUNCED = {
  recipient: 'gone@example.com',
  recipientRedacted: 'g***@example.com',
  channel: 'email',
  reason: 'hard_bounce',
  source: 'smtp2go',
  suppressedAtMs: Date.UTC(2026, 9, 1, 15, 30),
  optedOut: false,
  eventId: 'evt-9',
};

const OPTED = {
  recipient: '+14155552671',
  recipientRedacted: '+1******2671',
  channel: 'sms',
  reason: 'opt_out',
  source: 'admin',
  suppressedAtMs: Date.UTC(2026, 8, 20, 12, 0),
  optedOut: true,
  eventId: null,
};

/** Bounced and opted out: Clear removes the bounce and the opt-out stays. */
const BOTH = {
  recipient: 'both@example.com',
  recipientRedacted: 'b***@example.com',
  channel: 'email',
  reason: 'hard_bounce',
  source: 'smtp2go',
  suppressedAtMs: Date.UTC(2026, 9, 2, 9, 0),
  optedOut: true,
  eventId: 'evt-2',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listMessageSuppressions.mockResolvedValue({ items: [BOUNCED, OPTED], nextCursor: null });
});

describe('Do-not-send section', () => {
  it('lists each address with its reason, source and when', async () => {
    render(<DoNotSendSection />);

    const row = (await screen.findByText('gone@example.com')).closest('li')!;
    expect(within(row).getByText('Hard bounce')).toBeInTheDocument();
    expect(within(row).getByText('smtp2go')).toBeInTheDocument();
    expect(within(row).getByText(/2026-10-0[12] \d\d:\d\d/)).toBeInTheDocument();

    const other = screen.getByText('+14155552671').closest('li')!;
    expect(within(other).getByText('Opted out')).toBeInTheDocument();
    expect(within(other).getByText('Admin')).toBeInTheDocument();
    expect(api.listMessageSuppressions).toHaveBeenCalledWith({ reason: 'all' });
  });

  it('shows a loading cue while the list loads', () => {
    api.listMessageSuppressions.mockReturnValue(new Promise(() => undefined));
    render(<DoNotSendSection />);
    expect(screen.getByText('Loading the do-not-send list…')).toBeInTheDocument();
  });

  it('says so when the list is empty', async () => {
    api.listMessageSuppressions.mockResolvedValue({ items: [], nextCursor: null });
    render(<DoNotSendSection />);
    expect(await screen.findByText('No addresses on the list.')).toBeInTheDocument();
  });

  it('shows a load failure with a working retry', async () => {
    api.listMessageSuppressions.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<DoNotSendSection />);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('gone@example.com')).toBeInTheDocument();
  });

  it('re-queries by reason when the filter changes', async () => {
    const user = userEvent.setup();
    render(<DoNotSendSection />);
    await screen.findByText('gone@example.com');

    await user.click(screen.getByRole('radio', { name: 'Hard bounces' }));
    await waitFor(() => expect(api.listMessageSuppressions).toHaveBeenLastCalledWith({ reason: 'hard_bounce' }));
  });

  it('loads the next page with the cursor and appends it', async () => {
    api.listMessageSuppressions
      .mockResolvedValueOnce({ items: [BOUNCED], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ items: [OPTED], nextCursor: null });
    const user = userEvent.setup();
    render(<DoNotSendSection />);
    await screen.findByText('gone@example.com');

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('+14155552671')).toBeInTheDocument();
    expect(api.listMessageSuppressions).toHaveBeenLastCalledWith({ reason: 'all', cursor: 'cur1' });
    expect(screen.getByText('gone@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('gives an opt-out only row no Clear action, and says why in a tooltip', async () => {
    render(<DoNotSendSection />);

    const row = (await screen.findByText('+14155552671')).closest('li')!;
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row).getByTitle('Opted out by the household')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear gone@example.com' })).toBeInTheDocument();
  });

  it('marks a bounced row that is also opted out', async () => {
    api.listMessageSuppressions.mockResolvedValue({ items: [BOTH], nextCursor: null });
    render(<DoNotSendSection />);

    const row = (await screen.findByText('both@example.com')).closest('li')!;
    expect(within(row).getByText('Also opted out')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Clear both@example.com' })).toBeInTheDocument();
  });

  it('asks inside the page before clearing, and clears nothing on Keep it', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<DoNotSendSection />);

    await user.click(await screen.findByRole('button', { name: 'Clear gone@example.com' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/gone@example\.com/)).toBeInTheDocument();
    expect(api.clearMessageSuppression).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.clearMessageSuppression).not.toHaveBeenCalled();
    expect(screen.getByText('gone@example.com')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('confirming sends the full address, drops the row and says so', async () => {
    api.clearMessageSuppression.mockResolvedValue({
      ok: true,
      channel: 'email',
      recipientRedacted: 'g***@example.com',
      optOutKept: false,
    });
    const user = userEvent.setup();
    render(<DoNotSendSection />);

    await user.click(await screen.findByRole('button', { name: 'Clear gone@example.com' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear address' }));
    await waitFor(() => expect(api.clearMessageSuppression).toHaveBeenCalledWith('gone@example.com'));
    await waitFor(() => expect(screen.queryByText('gone@example.com')).not.toBeInTheDocument());
    expect(screen.getByText('Cleared g***@example.com. It can be mailed again.')).toBeInTheDocument();
    expect(screen.getByText('+14155552671')).toBeInTheDocument();
  });

  it('clearing a bounce on an opted-out address keeps the row as an opt-out with no Clear', async () => {
    api.listMessageSuppressions.mockResolvedValue({ items: [BOTH], nextCursor: null });
    api.clearMessageSuppression.mockResolvedValue({
      ok: true,
      channel: 'email',
      recipientRedacted: 'b***@example.com',
      optOutKept: true,
    });
    const user = userEvent.setup();
    render(<DoNotSendSection />);

    await user.click(await screen.findByRole('button', { name: 'Clear both@example.com' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear address' }));
    expect(
      await screen.findByText('Cleared the bounce on b***@example.com. The opt-out stays.'),
    ).toBeInTheDocument();

    const row = screen.getByText('both@example.com').closest('li')!;
    expect(within(row).getByText('Opted out')).toBeInTheDocument();
    expect(within(row).queryByText('Hard bounce')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the row and shows the server reason when the clear fails', async () => {
    api.clearMessageSuppression.mockRejectedValue(new Error('That address is not on the do-not-send list.'));
    const user = userEvent.setup();
    render(<DoNotSendSection />);

    await user.click(await screen.findByRole('button', { name: 'Clear gone@example.com' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear address' }));
    expect(await screen.findByText('That address is not on the do-not-send list.')).toBeInTheDocument();
    expect(screen.getByText('gone@example.com')).toBeInTheDocument();
  });
});
