// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { splitList, buildCriteria } from './CommunicateCompose';
import { type SendBroadcastResult } from '../api/communicateWrite';

const { sendBroadcast } = vi.hoisted(() => ({ sendBroadcast: vi.fn() }));
vi.mock('../api/communicateWrite', async (orig) => ({
  ...(await orig<typeof import('../api/communicateWrite')>()),
  sendBroadcast,
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
    });

    release(resultOf({ recipientCount: 5 }));
    await waitFor(() => expect(screen.getByText('Reached 5 kinfolk.')).toBeInTheDocument());
    expect(screen.getByText('3 sent · 0 skipped · 0 failed')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
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
    await screen.findByText(/Reached 3 kinfolk/);

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
});
