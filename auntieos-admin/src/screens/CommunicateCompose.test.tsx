// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { splitList, buildCriteria } from './CommunicateCompose';
import { type SendBroadcastResult } from '../api/communicateWrite';

const { sendBroadcast, getBroadcastProgress, stopBroadcast } = vi.hoisted(() => ({
  sendBroadcast: vi.fn(),
  getBroadcastProgress: vi.fn(),
  stopBroadcast: vi.fn(),
}));
vi.mock('../api/communicateWrite', async (orig) => ({
  ...(await orig<typeof import('../api/communicateWrite')>()),
  sendBroadcast,
  getBroadcastProgress,
  stopBroadcast,
}));

const { listAudienceSegments, saveAudienceSegment, deleteAudienceSegment } = vi.hoisted(() => ({
  listAudienceSegments: vi.fn(),
  saveAudienceSegment: vi.fn(),
  deleteAudienceSegment: vi.fn(),
}));
vi.mock('../api/audienceSegments', () => ({ listAudienceSegments, saveAudienceSegment, deleteAudienceSegment }));

import { CommunicateCompose } from './CommunicateCompose';

beforeEach(() => {
  sendBroadcast.mockReset();
  getBroadcastProgress.mockReset();
  stopBroadcast.mockReset();
  listAudienceSegments.mockReset();
  saveAudienceSegment.mockReset();
  deleteAudienceSegment.mockReset();
  // Default: the segment list loads and is empty, so the ad-hoc builder shows.
  // Individual tests override it.
  listAudienceSegments.mockResolvedValue([]);
});

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
    // #386: the callable now reports recipient-level reach alongside the
    // per-channel tallies, because "matched by the segment" and "actually heard
    // it" stopped being the same number once broadcasts started honoring
    // notification preferences.
    reach: { targeted: 3, reached: 3, suppressedByPrefs: 0 },
    ...over,
  };
}

async function fillMinimalForm() {
  await userEvent.type(screen.getByLabelText(/message/i), 'Hello kinfolk');
}

describe('CommunicateCompose screen', () => {
  it('defaults to All audience + Email channel, Review disabled until the body is filled', async () => {
    render(<CommunicateCompose />);
    expect(screen.getByRole('radio', { name: 'All active kinfolk' })).toBeChecked();
    expect(screen.getByRole('switch', { name: /send by email/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /send by text/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeDisabled();
  });

  it('requires a subject when email is the only channel, but not when only sms is selected', async () => {
    render(<CommunicateCompose />);
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
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Hi');
    await userEvent.click(screen.getByRole('radio', { name: 'By status' }));
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/statuses/i), 'active');
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeEnabled();
  });

  it('opens a confirm Dialog naming the audience, channels, and message before sending', async () => {
    render(<CommunicateCompose />);
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

    render(<CommunicateCompose />);
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
      // #814: minted per submission, so the value is matched by shape.
      idempotencyKey: expect.stringMatching(/^bcast_\d+_[a-z0-9]+$/),
    });

    release(resultOf({ recipientCount: 5, reach: { targeted: 5, reached: 5, suppressedByPrefs: 0 } }));
    await waitFor(() => expect(screen.getByText('Reached 5 of 5 kinfolk.')).toBeInTheDocument());
    expect(screen.getByText('3 sent · 0 skipped · 0 failed')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * #386: the headline used to read "Reached N kinfolk" off `recipientCount`,
   * which is who the SEGMENT matched. Now that a broadcast honors each
   * household's notification preferences, the two numbers differ, and the
   * operator has to be told which households heard nothing.
   */
  it('reports how many households the broadcast actually reached, and how many have it switched off', async () => {
    sendBroadcast.mockResolvedValue(
      resultOf({
        recipientCount: 9,
        perChannel: { email: { sent: 4, skipped: 5, failed: 0 } },
        reach: { targeted: 9, reached: 4, suppressedByPrefs: 5 },
      }),
    );
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));

    expect(
      await screen.findByText('Reached 4 of 9 kinfolk. 5 households have broadcasts switched off.'),
    ).toBeInTheDocument();
  });

  it('claims no reach at all when the response carries none', async () => {
    // A backend older than the `reach` field: the property is ABSENT, not
    // undefined. Saying "Reached 3" here would be the confident-wrong-number bug
    // this screen's own docs warn about.
    const legacy = resultOf();
    delete legacy.reach;
    sendBroadcast.mockResolvedValue(legacy);
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));

    expect(await screen.findByText('Sent to 3 kinfolk.')).toBeInTheDocument();
  });

  /**
   * #823. A broadcast past about sixty households does not finish inside the
   * callable: it sends for fifteen seconds and a cron sweep carries the rest.
   *
   * Before this, the screen printed "Broadcast sent" and a per-channel table
   * over one leg of a send that was a tenth done — the confident wrong number
   * this screen's own docs warn about, on the one number that matters most.
   */
  it('says a broadcast is still sending, and shows how far it has got', async () => {
    sendBroadcast.mockResolvedValue(
      resultOf({ recipientCount: 900, pending: true, sent: 61, audienceSize: 900 }),
    );
    getBroadcastProgress.mockResolvedValue({
      broadcastId: 'b1',
      fanoutState: 'running',
      sent: 61,
      audienceSize: 900,
      reached: 61,
      suppressedByPrefs: 0,
      stopRequested: false,
    });
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    // The panel title itself is the first honest thing on the screen.
    expect(await screen.findByText('Broadcast sending')).toBeInTheDocument();
    expect(await screen.findByText('61 of 900 households so far.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Households contacted so far' })).toHaveValue(61 / 900);
  });
  it('offers a manual re-read rather than polling, and says a second press did something', async () => {
    sendBroadcast.mockResolvedValue(resultOf({ pending: true, sent: 61, audienceSize: 900 }));
    getBroadcastProgress.mockResolvedValue({
      broadcastId: 'b1',
      fanoutState: 'running',
      sent: 61,
      audienceSize: 900,
      reached: 61,
      suppressedByPrefs: 0,
      stopRequested: false,
    });
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    const check = await screen.findByRole('button', { name: 'Check again' });
    getBroadcastProgress.mockClear();
    await userEvent.click(check);
    await waitFor(() => expect(getBroadcastProgress).toHaveBeenCalledWith('b1'));
    // A tap with no visible consequence reads as a dead button, and the sweep
    // runs once a minute, so the numbers may well not have moved.
    expect(await screen.findByRole('button', { name: 'Ask again' })).toBeInTheDocument();
  });
  /**
   * Stopping a broadcast stops the REMAINDER. Email and SMS already sent cannot
   * be recalled, and the confirmation says so in numbers rather than announcing
   * a cancellation that did not happen.
   */
  it('stops the rest of a running broadcast and is honest about what already went', async () => {
    sendBroadcast.mockResolvedValue(resultOf({ pending: true, sent: 61, audienceSize: 900 }));
    getBroadcastProgress.mockResolvedValue({
      broadcastId: 'b1',
      fanoutState: 'running',
      sent: 61,
      audienceSize: 900,
      reached: 61,
      suppressedByPrefs: 0,
      stopRequested: false,
    });
    stopBroadcast.mockResolvedValue({ sent: 61, neverSent: 839 });
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop the rest' }));
    await waitFor(() => expect(stopBroadcast).toHaveBeenCalledWith('b1'));
    expect(
      await screen.findByText(/61 households have already been contacted and cannot be called back\. 839 will not be\./),
    ).toBeInTheDocument();
  });
  it('shows no still-sending block at all for a broadcast that finished inside the call', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    expect(await screen.findByText('Broadcast sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    expect(getBroadcastProgress).not.toHaveBeenCalled();
  });
  it('fails loud, naming the callable, and leaves the form intact for a retry (no data loss)', async () => {
    sendBroadcast.mockRejectedValueOnce(new Error('permission-denied'));
    render(<CommunicateCompose />);
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

  /**
   * #814. The operator's own retry is the dangerous path: they saw an error, so
   * they press Send again, and without a held key that second press is a second
   * email and a second text to every household the segment matched.
   */
  it('reuses one idempotency key when the operator sends again after a failure', async () => {
    sendBroadcast.mockRejectedValueOnce(new Error('internal'));
    sendBroadcast.mockResolvedValueOnce(resultOf({ deduped: true }));
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    expect(await screen.findByText(/sendBroadcast failed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledTimes(2));

    const [first, second] = sendBroadcast.mock.calls.map((c) => c[0].idempotencyKey);
    expect(first).toMatch(/^bcast_\d+_[a-z0-9]+$/);
    expect(second).toBe(first);
    // And the screen says what actually happened rather than claiming a second send.
    expect(
      await screen.findByText(/You already sent this message\. Nothing went out twice/i),
    ).toBeInTheDocument();
  });

  it('mints a NEW key once the message has been edited, because that is a different send', async () => {
    sendBroadcast.mockRejectedValueOnce(new Error('internal'));
    sendBroadcast.mockResolvedValueOnce(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    expect(await screen.findByText(/sendBroadcast failed/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/message/i), ' and more');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledTimes(2));

    const [first, second] = sendBroadcast.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).not.toBe(first);
  });

  it('maps the no_recipients failure to an honest, specific message', async () => {
    sendBroadcast.mockRejectedValueOnce(new Error('no_recipients'));
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    expect(await screen.findByText(/No kinfolk match this audience/)).toBeInTheDocument();
  });

  it('Cancel closes the confirm Dialog without sending', async () => {
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sendBroadcast).not.toHaveBeenCalled();
  });


  it('"Send another" clears the result and returns to an editable, empty form', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await screen.findByText(/Reached 3 of 3 kinfolk/);

    await userEvent.click(screen.getByRole('button', { name: /send another/i }));
    expect(screen.getByLabelText(/message/i)).toHaveValue('');
    expect(screen.getByLabelText(/subject/i)).toHaveValue('');
  });
});

describe('push channel', () => {
  it('sends push alongside the other channels when toggled on', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('switch', { name: /send by push notification/i }));
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() =>
      expect(sendBroadcast).toHaveBeenCalledWith({
        criteria: { kind: 'all' },
        channels: ['email', 'push'],
        subject: 'Big news',
        body: 'Hello kinfolk',
        idempotencyKey: expect.stringMatching(/^bcast_\d+_[a-z0-9]+$/),
      }),
    );
  });
  it('allows push as the only channel', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.click(screen.getByRole('switch', { name: /send by email/i }));
    await userEvent.click(screen.getByRole('switch', { name: /send by push notification/i }));
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() =>
      expect(sendBroadcast).toHaveBeenCalledWith(expect.objectContaining({ channels: ['push'] })),
    );
  });
  // The server does not require a subject for push, it falls back to
  // "Tribe Tails" as the title. The UI must not invent a stricter rule.
  it('does not require a subject for a push-only broadcast', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.click(screen.getByRole('switch', { name: /send by email/i }));
    await userEvent.click(screen.getByRole('switch', { name: /send by push notification/i }));
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeEnabled();
    expect(screen.getByText(/push will show "Tribe Tails"/i)).toBeInTheDocument();
  });
  it('warns that Kinfolk without a registered device are skipped', async () => {
    render(<CommunicateCompose />);
    await userEvent.click(screen.getByRole('switch', { name: /send by push notification/i }));
    expect(screen.getByText(/without a registered device is skipped/i)).toBeInTheDocument();
  });
});
describe('in-app channel', () => {
  it('offers in-app, the one backend channel this screen used to leave out', () => {
    render(<CommunicateCompose />);
    expect(screen.getByRole('switch', { name: /send in-app/i })).toBeInTheDocument();
  });
  it('requires a subject for in-app, because the callable does', async () => {
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.click(screen.getByRole('switch', { name: /send by email/i })); // email off
    await userEvent.click(screen.getByRole('switch', { name: /send in-app/i }));
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    expect(screen.getByRole('button', { name: /review broadcast/i })).toBeEnabled();
  });
  it('sends inapp on the wire, the value the zod enum accepts', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('switch', { name: /send by email/i }));
    await userEvent.click(screen.getByRole('switch', { name: /send in-app/i }));
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledWith(expect.objectContaining({ channels: ['inapp'] })));
  });
  it('offers no KinTale channel, which the dispatcher could not deliver', () => {
    render(<CommunicateCompose />);
    expect(screen.queryByRole('switch', { name: /kintale/i })).toBeNull();
  });
});
describe('saved segments', () => {
  const SEG = {
    id: 's1',
    name: 'VIP households',
    criteria: { kind: 'tags' as const, tags: ['vip'], tagMatch: 'any' as const },
    description: 'Tags (any): vip',
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  it('lists the saved segments alongside an Ad-hoc option, with Ad-hoc selected', async () => {
    listAudienceSegments.mockResolvedValue([SEG]);
    render(<CommunicateCompose />);
    expect(await screen.findByRole('radio', { name: 'VIP households' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Ad-hoc' })).toBeChecked();
  });
  it('hides the ad-hoc builder once a saved segment is picked, and shows what it means', async () => {
    listAudienceSegments.mockResolvedValue([SEG]);
    render(<CommunicateCompose />);
    await userEvent.click(await screen.findByRole('radio', { name: 'VIP households' }));
    expect(screen.queryByRole('radio', { name: 'All active kinfolk' })).toBeNull();
    expect(screen.getByText('Tags (any): vip')).toBeInTheDocument();
  });
  it('sends segmentId with NO criteria beside it, since the server resolves one from the other', async () => {
    listAudienceSegments.mockResolvedValue([SEG]);
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await userEvent.click(await screen.findByRole('radio', { name: 'VIP households' }));
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalled());
    const args = sendBroadcast.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['segmentId']).toBe('s1');
    expect('criteria' in args).toBe(false);
  });
  it('sends criteria with NO segmentId when Ad-hoc is selected', async () => {
    sendBroadcast.mockResolvedValue(resultOf());
    render(<CommunicateCompose />);
    await fillMinimalForm();
    await userEvent.type(screen.getByLabelText(/subject/i), 'Big news');
    await userEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalled());
    const args = sendBroadcast.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['criteria']).toEqual({ kind: 'all' });
    expect('segmentId' in args).toBe(false);
  });
  it('saves the current ad-hoc audience under a name and reloads the list', async () => {
    saveAudienceSegment.mockResolvedValue('s2');
    render(<CommunicateCompose />);
    await userEvent.click(screen.getByRole('radio', { name: 'By status' }));
    await userEvent.type(screen.getByLabelText(/statuses/i), 'active');
    await userEvent.type(screen.getByLabelText(/save this audience as/i), 'Actives');
    await userEvent.click(screen.getByRole('button', { name: /save segment/i }));
    await waitFor(() =>
      expect(saveAudienceSegment).toHaveBeenCalledWith({
        name: 'Actives',
        criteria: { kind: 'status', statuses: ['active'] },
      }),
    );
    expect(await screen.findByText('Saved "Actives".')).toBeInTheDocument();
    await waitFor(() => expect(listAudienceSegments).toHaveBeenCalledTimes(2));
  });
  it('refuses to save an unnamed segment, and never calls the callable', async () => {
    render(<CommunicateCompose />);
    await userEvent.click(screen.getByRole('button', { name: /save segment/i }));
    expect(await screen.findByText('Name this segment first.')).toBeInTheDocument();
    expect(saveAudienceSegment).not.toHaveBeenCalled();
  });
  it('deletes a saved segment and falls back to Ad-hoc', async () => {
    listAudienceSegments.mockResolvedValue([SEG]);
    deleteAudienceSegment.mockResolvedValue(undefined);
    render(<CommunicateCompose />);
    await userEvent.click(await screen.findByRole('radio', { name: 'VIP households' }));
    await userEvent.click(screen.getByRole('button', { name: /delete this segment/i }));
    await waitFor(() => expect(deleteAudienceSegment).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('Deleted "VIP households".')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Ad-hoc' })).toBeChecked();
  });
  it('says the segment list failed to load, and still lets an ad-hoc broadcast go out', async () => {
    listAudienceSegments.mockRejectedValueOnce(new Error('permission-denied'));
    render(<CommunicateCompose />);
    expect(await screen.findByText(/listAudienceSegments failed: permission-denied/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All active kinfolk' })).toBeInTheDocument();
  });
  it('surfaces a save failure rather than claiming a segment that was never stored', async () => {
    saveAudienceSegment.mockRejectedValueOnce(new Error('invalid-argument'));
    render(<CommunicateCompose />);
    await userEvent.type(screen.getByLabelText(/save this audience as/i), 'Actives');
    await userEvent.click(screen.getByRole('button', { name: /save segment/i }));
    expect(await screen.findByText(/saveAudienceSegment failed: invalid-argument/)).toBeInTheDocument();
    // Scoped to the exact success sentence: "Saved audience" is the fieldset's
    // own legend and would match a looser /^Saved/ query.
    expect(screen.queryByText('Saved "Actives".')).toBeNull();
  });
});
/**
 * The live preview beside the broadcast composer.
 *
 * A broadcast is NOT a notification template. `broadcastMessage` calls
 * `sendTemplatedEmail(... data: {})` and hands SMS/push/in-app the raw string,
 * so no merge field can resolve on this path at all. The preview says so with
 * an empty sample: every `{{token}}` here is unresolved, and that is the truth,
 * not a limitation of the preview.
 */
describe('CommunicateCompose: live preview', () => {
  it('shows the message as a recipient will read it, as the author types', async () => {
    render(<CommunicateCompose />);
    await userEvent.type(screen.getByLabelText(/subject/i), 'Holiday hours');
    await userEvent.type(screen.getByLabelText(/message/i), 'We close at noon.');
    const preview = await screen.findByRole('region', { name: 'Live preview' });
    expect(preview).toHaveTextContent('Holiday hours');
    expect(preview).toHaveTextContent('We close at noon.');
  });
  it('warns that a merge field typed into a broadcast binds to nothing', async () => {
    render(<CommunicateCompose />);
    // fireEvent, not userEvent.type: `{{` is userEvent's escape for a literal
    // brace, so typing a Handlebars token through it needs doubling up and the
    // test then reads as being about userEvent rather than about merge fields.
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'Hi {{kinfolkName}}' } });
    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 merge field has no sample value: kinfolkName',
    );
  });
  it('states what each channel actually does with an unresolved token', async () => {
    render(<CommunicateCompose />);
    expect(
      await screen.findByText(
        /A broadcast carries no merge data\. Email sends these blank; in-app, SMS and push send the braces as typed\./i,
      ),
    ).toBeInTheDocument();
  });
  it('does not warn about ordinary copy with no merge fields', async () => {
    render(<CommunicateCompose />);
    await userEvent.type(screen.getByLabelText(/message/i), 'We close at noon.');
    await screen.findByRole('region', { name: 'Live preview' });
    expect(screen.queryByRole('status')).toBeNull();
  });
  /**
   * The #755 sweep: the mock puts the preview in the SCREEN's right column, in
   * its own panel above Recent, not inside the compose panel. This surface
   * returns a fragment so `Communicate`'s grid can place the two halves; the
   * class names are the contract with `Communicate.css`.
   */
  it('renders the form in the left column and the preview panel in the right, as grid siblings', async () => {
    render(<CommunicateCompose />);
    const preview = await screen.findByRole('region', { name: 'Live preview' });
    const previewSlot = preview.closest('.communicate__preview');
    expect(previewSlot).not.toBeNull();
    expect(within(previewSlot as HTMLElement).getByRole('heading', { name: 'Live preview' })).toBeInTheDocument();
    const form = screen.getByRole('heading', { name: 'Compose' }).closest('.communicate__main');
    expect(form).not.toBeNull();
    // Siblings, not nested: the preview must not sit inside the compose panel.
    expect(form?.contains(previewSlot)).toBe(false);
  });
});
