// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { previewBlastAudience, scheduleBlast, listMarketingBlasts, cancelMarketingBlast } = vi.hoisted(() => ({
  previewBlastAudience: vi.fn(),
  scheduleBlast: vi.fn(),
  listMarketingBlasts: vi.fn(),
  cancelMarketingBlast: vi.fn(),
}));
vi.mock('../api/marketingBlasts', async (orig) => ({
  ...(await orig<typeof import('../api/marketingBlasts')>()),
  previewBlastAudience,
  scheduleBlast,
  listMarketingBlasts,
  cancelMarketingBlast,
}));

const { listAudienceSegments } = vi.hoisted(() => ({ listAudienceSegments: vi.fn() }));
vi.mock('../api/audienceSegments', () => ({ listAudienceSegments }));

import { MarketingBlasts, buildBlastCriteria } from './MarketingBlasts';

const HOUR = 60 * 60 * 1000;

/** A date/time pair comfortably in the future, in the local zone the form reads. */
function futureDateTime(): { date: string; time: string } {
  const d = new Date(Date.now() + 48 * HOUR);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: '09:00',
  };
}

beforeEach(() => {
  previewBlastAudience.mockReset();
  scheduleBlast.mockReset();
  listMarketingBlasts.mockReset().mockResolvedValue([]);
  cancelMarketingBlast.mockReset();
  listAudienceSegments.mockReset().mockResolvedValue([]);
});

// ── pure helper ─────────────────────────────────────────────────────────────

describe('buildBlastCriteria', () => {
  it('builds "all" regardless of the text fields', () => {
    expect(buildBlastCriteria('all', 'ignored', 'ignored', 'any')).toEqual({ kind: 'all' });
  });

  it('is null for a status filter with nothing typed, never a silent widening to all', () => {
    expect(buildBlastCriteria('status', '  ', '', 'any')).toBeNull();
  });

  it('carries the tag match mode', () => {
    expect(buildBlastCriteria('tags', '', 'vip, loyal', 'all')).toEqual({
      kind: 'tags',
      tags: ['vip', 'loyal'],
      tagMatch: 'all',
    });
  });
});

// ── the screen ──────────────────────────────────────────────────────────────

describe('MarketingBlasts', () => {
  it('loads the campaign list on mount and shows the empty sections', async () => {
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());
    expect(await screen.findByText('Nothing scheduled.')).toBeInTheDocument();
    expect(screen.getByText('Nothing sent yet.')).toBeInTheDocument();
  });

  it('surfaces a failed campaign load instead of rendering it as "nothing scheduled"', async () => {
    listMarketingBlasts.mockRejectedValue(new Error('permission-denied'));
    render(<MarketingBlasts />);
    expect(await screen.findByText(/listMarketingBlasts failed: permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing scheduled.')).not.toBeInTheDocument();
  });

  it('previews the audience and shows the four counts as separate readings', async () => {
    previewBlastAudience.mockResolvedValue({
      description: 'All active kinfolk',
      matched: 10,
      noLinkedAccount: 2,
      suppressedByPrefs: 3,
      reachable: 5,
    });
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Check who this reaches' }));

    await waitFor(() =>
      expect(previewBlastAudience).toHaveBeenCalledWith('newsletter.announcement', {
        criteria: { kind: 'all' },
      }),
    );
    expect(await screen.findByText('Will receive it')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('drops the preview when the audience changes, so a stale count is never read as current', async () => {
    previewBlastAudience.mockResolvedValue({
      description: 'All active kinfolk',
      matched: 10,
      noLinkedAccount: 0,
      suppressedByPrefs: 0,
      reachable: 10,
    });
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Check who this reaches' }));
    expect(await screen.findByText('Will receive it')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /By status/ }));

    expect(screen.queryByText('Will receive it')).not.toBeInTheDocument();
    expect(screen.getByText('Not checked yet for this audience.')).toBeInTheDocument();
  });

  it('blocks the schedule until a send time is picked, and says why', async () => {
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());
    expect(screen.getByText('Pick a date and a time to send.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule blast' })).toBeDisabled();
  });

  it('blocks the schedule when a preview proved the audience reaches nobody', async () => {
    previewBlastAudience.mockResolvedValue({
      description: 'All active kinfolk',
      matched: 4,
      noLinkedAccount: 4,
      suppressedByPrefs: 0,
      reachable: 0,
    });
    const when = futureDateTime();
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    // The time is filled FIRST: changing the audience clears a preview, and the
    // point of this test is a live preview sitting beside a valid time.
    await userEvent.type(screen.getByLabelText('Date'), when.date);
    await userEvent.type(screen.getByLabelText('Time'), when.time);
    await userEvent.click(screen.getByRole('button', { name: 'Check who this reaches' }));

    expect(
      await screen.findByText('This audience reaches nobody. Widen it, or check who has opted in.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule blast' })).toBeDisabled();
  });

  it('schedules through the callable with the criteria, the merge data and the local fire time', async () => {
    scheduleBlast.mockResolvedValue({
      blastId: 'b1',
      matched: 9,
      noLinkedAccount: 0,
      dispatched: 9,
      suppressed: 0,
      failed: 0,
    });
    const when = futureDateTime();
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText('Date'), when.date);
    await userEvent.type(screen.getByLabelText('Time'), when.time);
    await userEvent.type(screen.getByLabelText('Name this campaign'), 'June newsletter');
    await userEvent.type(screen.getByLabelText('Merge field 1 name'), 'headline');
    await userEvent.type(screen.getByLabelText('Merge field 1 value'), 'A little news');

    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(scheduleBlast).toHaveBeenCalledTimes(1));
    const args = scheduleBlast.mock.calls[0]?.[0] as {
      key: string;
      audience: unknown;
      data: Record<string, unknown>;
      title?: string;
      fireAtMs: number;
    };
    expect(args.key).toBe('newsletter.announcement');
    expect(args.audience).toEqual({ criteria: { kind: 'all' } });
    expect(args.data).toEqual({ headline: 'A little news' });
    expect(args.title).toBe('June newsletter');
    expect(new Date(args.fireAtMs).getHours()).toBe(9);

    expect(await screen.findByText(/9 queued, 0 suppressed/)).toBeInTheDocument();
    // The list is reloaded so the new campaign appears without a page refresh.
    expect(listMarketingBlasts).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed schedule rather than reporting a campaign that does not exist', async () => {
    scheduleBlast.mockRejectedValue(new Error('no_recipients'));
    const when = futureDateTime();
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText('Date'), when.date);
    await userEvent.type(screen.getByLabelText('Time'), when.time);
    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));

    expect(await screen.findByText(/scheduleMarketingBlast failed: no_recipients/)).toBeInTheDocument();
  });

  /**
   * #814. An operator who sees a timeout presses Schedule again, and that press
   * is the one that used to queue a second set of marketing emails to real
   * households. The key is held across it, so the server answers from the blast
   * the first press already made.
   */
  it('reuses one idempotency key when the operator schedules again after a failure', async () => {
    scheduleBlast.mockRejectedValueOnce(new Error('internal'));
    scheduleBlast.mockResolvedValueOnce({
      blastId: 'b1',
      matched: 9,
      noLinkedAccount: 0,
      dispatched: 9,
      suppressed: 0,
      failed: 0,
      deduped: true,
      pending: false,
    });
    const when = futureDateTime();
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText('Date'), when.date);
    await userEvent.type(screen.getByLabelText('Time'), when.time);
    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));
    expect(await screen.findByText(/scheduleMarketingBlast failed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));
    await waitFor(() => expect(scheduleBlast).toHaveBeenCalledTimes(2));

    const keys = scheduleBlast.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toMatch(/^blast_\d+_[a-z0-9]+$/);
    expect(keys[1]).toBe(keys[0]);
    // And the notice says what happened rather than claiming a second campaign.
    expect(
      await screen.findByText(/You already scheduled this campaign for .*Nothing went out twice/),
    ).toBeInTheDocument();
  });

  it('mints a NEW key once the campaign has been edited, because that is a different campaign', async () => {
    scheduleBlast.mockRejectedValueOnce(new Error('internal'));
    scheduleBlast.mockResolvedValueOnce({
      blastId: 'b2',
      matched: 1,
      noLinkedAccount: 0,
      dispatched: 1,
      suppressed: 0,
      failed: 0,
      deduped: false,
      pending: false,
    });
    const when = futureDateTime();
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText('Date'), when.date);
    await userEvent.type(screen.getByLabelText('Time'), when.time);
    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));
    expect(await screen.findByText(/scheduleMarketingBlast failed/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name this campaign'), 'July newsletter');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));
    await waitFor(() => expect(scheduleBlast).toHaveBeenCalledTimes(2));

    const keys = scheduleBlast.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('sends an explicit uid list when the operator picks accounts', async () => {
    scheduleBlast.mockResolvedValue({
      blastId: 'b2',
      matched: 2,
      noLinkedAccount: 0,
      dispatched: 2,
      suppressed: 0,
      failed: 0,
    });
    const when = futureDateTime();
    render(<MarketingBlasts />);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('radio', { name: 'Pick accounts' }));
    await userEvent.type(screen.getByLabelText('Account ids'), 'u1, u2');
    await userEvent.type(screen.getByLabelText('Date'), when.date);
    await userEvent.type(screen.getByLabelText('Time'), when.time);
    await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(scheduleBlast).toHaveBeenCalledTimes(1));
    expect((scheduleBlast.mock.calls[0]?.[0] as { audience: unknown }).audience).toEqual({ audienceUids: ['u1', 'u2'] });
  });

  it('offers Cancel on a scheduled campaign and not on a sent one', async () => {
    listMarketingBlasts.mockResolvedValue([
      {
        id: 'b1',
        key: 'newsletter.announcement',
        title: 'Next week',
        fireAtMs: Date.now() + HOUR,
        status: 'scheduled',
        audienceDescription: 'All active kinfolk',
        matched: 9,
        noLinkedAccount: 0,
        dispatched: 9,
        suppressed: 0,
        failed: 0,
        cancelledAtMs: null,
      },
      {
        id: 'b2',
        key: 'survey.event',
        title: 'Last month',
        fireAtMs: Date.now() - HOUR,
        status: 'sent',
        audienceDescription: 'Tags (any): vip',
        matched: 4,
        noLinkedAccount: 1,
        dispatched: 3,
        suppressed: 0,
        failed: 0,
        cancelledAtMs: null,
      },
    ]);
    cancelMarketingBlast.mockResolvedValue({ cancelled: 9, stopped: true, neverQueued: 0 });

    render(<MarketingBlasts />);
    expect(await screen.findByText('Next week')).toBeInTheDocument();
    expect(screen.getByText('Last month')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(cancelMarketingBlast).toHaveBeenCalledWith('b1'));
    expect(await screen.findByText(/9 queued notifications removed/)).toBeInTheDocument();
  });

  it('surfaces a cancel the sweep beat, rather than showing it as cancelled', async () => {
    listMarketingBlasts.mockResolvedValue([
      {
        id: 'b1',
        key: 'newsletter.announcement',
        title: 'Too late',
        fireAtMs: Date.now() + HOUR,
        status: 'scheduled',
        audienceDescription: 'All active kinfolk',
        matched: 1,
        noLinkedAccount: 0,
        dispatched: 1,
        suppressed: 0,
        failed: 0,
        cancelledAtMs: null,
      },
    ]);
    cancelMarketingBlast.mockRejectedValue(new Error('already_fired'));

    render(<MarketingBlasts />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(/cancelMarketingBlast failed: already_fired/)).toBeInTheDocument();
    expect(screen.getByText('Too late')).toBeInTheDocument();
  });

  /**
   * #823. A campaign whose fan-out is still walking its roster is its own group.
   *
   * Before this it had nowhere to be: the list split on `status === 'scheduled'`
   * and everything else was history, so a half-queued campaign landed under
   * "Sent and cancelled" wearing a Sent pill. It is the state the issue objects
   * to — one the operator can reach and cannot act on — and the fix is the
   * mock's own third group, with the mock's own progress bar.
   */
  it('files a campaign that is still queueing under Sending, with its progress and a way to stop it', async () => {
    listMarketingBlasts.mockResolvedValue([
      {
        id: 'b1',
        key: 'newsletter.announcement',
        title: 'June newsletter',
        fireAtMs: Date.now() + HOUR,
        status: 'sending',
        audienceDescription: 'All active kinfolk',
        matched: 410,
        noLinkedAccount: 0,
        dispatched: 256,
        suppressed: 0,
        failed: 0,
        cancelledAtMs: null,
        fanoutState: 'running',
        queued: 256,
        audienceSize: 410,
      },
    ]);
    render(<MarketingBlasts />);
    // By role: "Sending" is both the group heading and the row's status pill,
    // and a bare text query cannot tell a reviewer which one it found.
    expect(await screen.findByRole('heading', { name: 'Sending' })).toBeInTheDocument();
    expect(screen.getByText('Sending', { selector: '.den-statuspill' })).toBeInTheDocument();
    expect(screen.getByText(/256 of 410 queued/)).toBeInTheDocument();
    // The mock's bar, and a real one: asserted on the element's own value rather
    // than on a painted width, which jsdom cannot honestly answer.
    const bar = screen.getByRole('progressbar', { name: 'Queued so far' });
    expect(bar).toHaveValue(256 / 410);
    // Stoppable mid fan-out. The un-queued remainder is real.
    expect(screen.getByRole('button', { name: 'Stop sending' })).toBeInTheDocument();
    // And NOT filed under history wearing a Sent pill, which is where it landed
    // before this group existed.
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
  });
  it('says a stalled fan-out has stopped moving rather than calling it slow', async () => {
    listMarketingBlasts.mockResolvedValue([
      {
        id: 'b1',
        key: 'newsletter.announcement',
        title: 'Stuck',
        fireAtMs: Date.now() + HOUR,
        status: 'sending',
        audienceDescription: 'All active kinfolk',
        matched: 410,
        noLinkedAccount: 0,
        dispatched: 40,
        suppressed: 0,
        failed: 0,
        cancelledAtMs: null,
        fanoutState: 'stalled',
        queued: 40,
        audienceSize: 410,
      },
    ]);
    render(<MarketingBlasts />);
    expect(await screen.findByText(/Stopped at 40 of 410 queued/)).toBeInTheDocument();
  });
  /**
   * The manual re-read #819's ruling asks for, on the one wait this screen has
   * that no request is holding open: the fan-out is on the server and the list
   * only moves when it is asked again.
   */
  it('offers a manual re-read while something is queueing, and says a second press did something', async () => {
    listMarketingBlasts.mockResolvedValue([
      {
        id: 'b1',
        key: 'newsletter.announcement',
        title: 'June newsletter',
        fireAtMs: Date.now() + HOUR,
        status: 'sending',
        audienceDescription: 'All active kinfolk',
        matched: 410,
        noLinkedAccount: 0,
        dispatched: 256,
        suppressed: 0,
        failed: 0,
        cancelledAtMs: null,
        fanoutState: 'running',
        queued: 256,
        audienceSize: 410,
      },
    ]);
    render(<MarketingBlasts />);
    const check = await screen.findByRole('button', { name: 'Check again' });
    listMarketingBlasts.mockClear();
    await userEvent.click(check);
    await waitFor(() => expect(listMarketingBlasts).toHaveBeenCalled());
    // The copy changes, because a tap with no visible consequence reads as a
    // dead button and the sweep runs once a minute, so the numbers may well not
    // have moved.
    expect(await screen.findByRole('button', { name: 'Ask again' })).toBeInTheDocument();
    expect(screen.getByText('Asked again. Still queueing.')).toBeInTheDocument();
  });
  it('does not offer the re-read when nothing is queueing', async () => {
    listMarketingBlasts.mockResolvedValue([]);
    render(<MarketingBlasts />);
    expect(await screen.findByText('Nothing scheduled.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });
  it('keeps building an audience possible when the saved segments fail to load', async () => {
    listAudienceSegments.mockRejectedValue(new Error('offline'));
    render(<MarketingBlasts />);
    expect(await screen.findByText(/listAudienceSegments failed: offline/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Build a filter' })).toBeChecked();
  });
});
