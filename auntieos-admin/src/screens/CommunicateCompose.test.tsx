// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { splitList, buildCriteria } from './CommunicateCompose';
import { type SendBroadcastResult } from '../api/communicateWrite';

const { sendBroadcast } = vi.hoisted(() => ({ sendBroadcast: vi.fn() }));
vi.mock('../api/communicateWrite', async (orig) => ({
  ...(await orig<typeof import('../api/communicateWrite')>()),
  sendBroadcast,
}));

import { CommunicateCompose } from './CommunicateCompose';

beforeEach(() => sendBroadcast.mockReset());

// ── pure helpers ─────────────────────────────────────────────────────────

describe('splitList', () => {
  it('splits, trims, and drops blank entries', () => {
    expect(splitList(' active,  prospect ,,')).toEqual(['active', 'prospect']);
  });
  it('returns [] for a blank string', () => {
    expect(splitList('   ')).toEqual([]);
  });
});

describe('buildCriteria', () => {
  it('builds an "all" criteria regardless of the text fields', () => {
    expect(buildCriteria('all', '', '', 'any')).toEqual({ kind: 'all' });
  });
  it('builds a "status" criteria from parsed statuses', () => {
    expect(buildCriteria('status', 'active, prospect', '', 'any')).toEqual({
      kind: 'status',
      statuses: ['active', 'prospect'],
    });
  });
  it('returns null for "status" with no statuses typed (never falls back to all)', () => {
    expect(buildCriteria('status', '  ', '', 'any')).toBeNull();
  });
  it('builds a "tags" criteria with the chosen match mode', () => {
    expect(buildCriteria('tags', '', 'vip', 'all')).toEqual({ kind: 'tags', tags: ['vip'], tagMatch: 'all' });
  });
  it('returns null for "tags" with no tags typed', () => {
    expect(buildCriteria('tags', '', '', 'any')).toBeNull();
  });
});

// ── screen ───────────────────────────────────────────────────────────────

function resultOf(over: Partial<SendBroadcastResult> = {}): SendBroadcastResult {
  return {
    ok: true,
    broadcastId: 'b1',
    recipientCount: 3,
    perChannel: { email: { sent: 3, skipped: 0, failed: 0 } },
    ...over,
  };
}

async function fillMinimalForm() {
  await userEvent.type(screen.getByLabelText(/message/i), 'Hello kinfolk');
}

describe('CommunicateCompose screen', () => {
  it('defaults to All audience + Email channel, Review disabled until the body is filled', async () => {
    render(<CommunicateCompose onClose={() => {}} />);
    expect(screen.getByRole('radio', { name: 'All active kinfolk' })).toBeChecked();
    expect(screen.getByRole('switch', { name: /send by email/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /send by text/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeDisabled();
  });

  it('requires a subject when email is the only channel, but not when only sms is selected', async () => {
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    // Email is on by default and subject is empty: still disabled.
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeEnabled();

    // Switch to sms-only: subject becomes optional, still enabled.
    await userEvent.clear(screen.getByLabelText(/subject/i));
    await userEvent.click(screen.getByRole('switch', { name: /send by email/i }));
    await userEvent.click(screen.getByRole('switch', { name: /send by text/i }));
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeEnabled();
  });

  it('requires at least one status/tag before Review enables when that audience kind is chosen', async () => {
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Hi');
    await userEvent.click(screen.getByRole('radio', { name: 'By status' }));
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/statuses/i), 'active');
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeEnabled();
  });

  it('opens a confirm Dialog naming the audience, channels, and message before sending', async () => {
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));

    const dialog = screen.getByRole('dialog', { name: /send this broadcast/i });
    // Scoped to the dialog and matched via the <strong> label's line, since
    // "All active kinfolk"/"Email" alone also appear in the (still-mounted,
    // underneath-the-dialog) form itself.
    expect(within(dialog).getByText('Audience:').closest('p')).toHaveTextContent('All active kinfolk');
    expect(within(dialog).getByText('Channels:').closest('p')).toHaveTextContent('Email');
    expect(within(dialog).getByText('Message:').closest('p')).toHaveTextContent('Hello kinfolk');
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('sends only on explicit confirm, disables the dialog while busy, and shows the real per-channel result', async () => {
    let release!: (v: SendBroadcastResult) => void;
    sendBroadcast.mockReturnValue(new Promise<SendBroadcastResult>((r) => (release = r)));

    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));

    // Busy: Cancel and Send are both disabled, no premature result.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(sendBroadcast).toHaveBeenCalledWith({
      criteria: { kind: 'all' },
      channels: ['email'],
      subject: 'Big news',
      body: 'Hello kinfolk',
    });

    release(resultOf({ recipientCount: 5 }));
    await waitFor(() => expect(screen.getByText('Reached 5 kinfolk.')).toBeInTheDocument());
    expect(screen.getByText('3 sent · 0 skipped · 0 failed')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fails loud, naming the callable, and leaves the form intact for a retry (no data loss)', async () => {
    sendBroadcast.mockRejectedValueOnce(new Error('permission-denied'));
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));

    expect(await screen.findByText(/sendBroadcast failed: permission-denied/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Body/subject survive the failure.
    expect(screen.getByLabelText(/message/i)).toHaveValue('Hello kinfolk');
    expect(screen.getByLabelText(/subject/i)).toHaveValue('Big news');
  });

  it('maps the no_recipients failure to an honest, specific message', async () => {
    sendBroadcast.mockRejectedValueOnce(new Error('no_recipients'));
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    expect(await screen.findByText(/No kinfolk match this audience/)).toBeInTheDocument();
  });

  it('Cancel closes the confirm Dialog without sending', async () => {
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('"Back to Recent" calls onClose', async () => {
    const onClose = vi.fn();
    render(<CommunicateCompose onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /back to recent/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('"Send another" clears the result and returns to an editable, empty form', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose onClose={() => {}} />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await screen.findByText(/Reached 3 kinfolk/);

    await userEvent.click(screen.getByRole('button', { name: /send another/i }));
    expect(screen.getByLabelText(/message/i)).toHaveValue('');
    expect(screen.getByLabelText(/subject/i)).toHaveValue('');
  });
});
