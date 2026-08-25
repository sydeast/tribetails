// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboxEntry } from '../lib/inboxChannels';

const { sendExternalMessage } = vi.hoisted(() => ({ sendExternalMessage: vi.fn() }));
vi.mock('../api/externalSend', () => ({ sendExternalMessage }));

const { markVoicemail } = vi.hoisted(() => ({ markVoicemail: vi.fn() }));
vi.mock('../api/inboxChannelsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/inboxChannelsWrite')>()),
  markVoicemail,
}));

import { ThreadActionsCard, mirrorDisclosure } from './ThreadActionsCard';

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'vm1',
    channel: 'voicemail',
    timestamp: '2026-07-20T14:00:00.000Z',
    kinfolkName: 'The Alvarez Household',
    counterpart: '+15551234567',
    preview: 'Can you come Thursday?',
    direction: 'inbound',
    statusHint: 'unread',
    mediaCount: 0,
    replyPhone: '+15551234567',
    replyEmail: '',
    kinfolkId: 'kf1',
    playbackUrl: 'https://api.twilio.com/rec1',
    voicemailId: 'vm1',
    ...over,
  };
}

beforeEach(() => {
  sendExternalMessage.mockReset().mockResolvedValue({
    ok: true,
    channel: 'sms',
    providerMessageId: 'SM123',
    recipientRedacted: '+1******4567',
    mirrored: true,
    mirrorSkippedReason: null,
  });
  markVoicemail.mockReset().mockResolvedValue(undefined);
});

describe('ThreadActionsCard', () => {
  it('names the row and shows its channel, contact and local time', () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'The Alvarez Household' })).toBeInTheDocument();
    expect(screen.getByText('Voicemail')).toBeInTheDocument();
    expect(screen.getByText('+15551234567')).toBeInTheDocument();
    expect(screen.getByText('Can you come Thursday?')).toBeInTheDocument();
  });

  it('offers tel and sms launchers with the number percent-encoded', () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'Call back' })).toHaveAttribute('href', 'tel:%2B15551234567');
    expect(screen.getByRole('link', { name: 'Text from this device' })).toHaveAttribute(
      'href',
      'sms:%2B15551234567',
    );
    expect(screen.queryByRole('link', { name: 'Email back' })).toBeNull();
  });

  it('offers only a mailto launcher, and no text composer, for an email row', () => {
    render(
      <ThreadActionsCard
        entry={entry({ channel: 'email', replyPhone: '', replyEmail: 'them@example.com', voicemailId: '' })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('link', { name: 'Email back' })).toHaveAttribute(
      'href',
      'mailto:them%40example.com',
    );
    expect(screen.queryByRole('link', { name: 'Call back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send text' })).toBeNull();
    expect(screen.getByText(/carries no phone number/i)).toBeInTheDocument();
  });

  it('renders a real audio element for a row with a recording, and none without one', () => {
    const { unmount, container } = render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('src', 'https://api.twilio.com/rec1');
    unmount();

    const bare = render(<ThreadActionsCard entry={entry({ playbackUrl: '' })} onClose={() => {}} />);
    expect(bare.container.querySelector('audio')).toBeNull();
  });

  it('sends a transactional SMS to the row contact and stamps the voicemail replied', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'Thursday works!');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));

    expect(await screen.findByText(/Sent to \+1\*\*\*\*\*\*4567/)).toBeInTheDocument();
    expect(sendExternalMessage).toHaveBeenCalledWith({
      channel: 'sms',
      to: '+15551234567',
      body: 'Thursday works!',
      transactional: true,
      mirrorToChannel: true,
    });
    expect(markVoicemail).toHaveBeenCalledWith({
      voicemailId: 'vm1',
      status: 'replied',
      replyLogId: 'SM123',
    });
  });

  /**
   * The banner reports what the SERVER did, not what the client asked for. The
   * server refuses to mirror a number with no existing thread, so a card that
   * always claimed the happy path would send the operator hunting for a row
   * that was never written. Each branch is the difference between an honest
   * disclosure and a silent one.
   */
  it('says the reply is now in the thread when the server really mirrored it', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'On my way');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));
    expect(await screen.findByText(/listed below as your reply/i)).toBeInTheDocument();
  });

  it('discloses that a reply to a new number is NOT added to this list', async () => {
    sendExternalMessage.mockResolvedValueOnce({
      ok: true,
      channel: 'sms',
      providerMessageId: 'SM123',
      recipientRedacted: '+1******4567',
      mirrored: false,
      mirrorSkippedReason: 'no_existing_thread',
    });
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));
    expect(await screen.findByText(/has not texted in before/i)).toBeInTheDocument();
  });

  it('still reports a SENT reply when only the mirror failed, so it is not sent twice', async () => {
    sendExternalMessage.mockResolvedValueOnce({
      ok: true,
      channel: 'sms',
      providerMessageId: 'SM123',
      recipientRedacted: '+1******4567',
      mirrored: false,
      mirrorSkippedReason: 'write_failed',
    });
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'Running late');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));
    // Title still says sent. Only the placement is qualified.
    expect(await screen.findByText('Reply sent')).toBeInTheDocument();
    expect(screen.getByText(/could not be added to this channel list/i)).toBeInTheDocument();
  });

  it('never words a skipped mirror as a failed send', () => {
    for (const reason of ['not_requested', 'no_existing_thread', 'write_failed'] as const) {
      const text = mirrorDisclosure(false, reason);
      expect(text.toLowerCase()).not.toMatch(/reply failed|not sent|could not send/);
    }
  });

  it('blocks an empty reply before any network call is made', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sendExternalMessage).not.toHaveBeenCalled();
  });

  it('surfaces a send failure and does not claim the reply was sent', async () => {
    sendExternalMessage.mockRejectedValueOnce(new Error('recipient_opted_out'));
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));

    expect(await screen.findByText(/Something did not go through/i)).toBeInTheDocument();
    expect(screen.queryByText(/Reply sent/i)).toBeNull();
    expect(markVoicemail).not.toHaveBeenCalled();
  });

  /**
   * The send SUCCEEDED. Reporting the follow-up stamp failure as a failed reply
   * would make the operator send the same text twice.
   */
  it('still reports the reply as sent when only the voicemail stamp fails, and says which failed', async () => {
    markVoicemail.mockRejectedValueOnce(new Error('permission-denied'));
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));

    expect(await screen.findByText(/could not be marked replied/i)).toBeInTheDocument();
    expect(screen.getByText(/Reply sent/i)).toBeInTheDocument();
  });

  it('marks a voicemail read without sending anything', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark read' }));

    expect(await screen.findByText(/Nobody has written back to it yet/i)).toBeInTheDocument();
    expect(markVoicemail).toHaveBeenCalledWith({ voicemailId: 'vm1', status: 'read' });
    expect(sendExternalMessage).not.toHaveBeenCalled();
  });

  it('surfaces a mark-read failure rather than showing a false confirmation', async () => {
    markVoicemail.mockRejectedValueOnce(new Error('permission-denied'));
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark read' }));

    expect(await screen.findByText(/Could not mark this voicemail read/i)).toBeInTheDocument();
    expect(screen.queryByText(/Marked read/i)).toBeNull();
  });

  it('offers no Mark read on a call or text row, which carry no reply state', () => {
    render(<ThreadActionsCard entry={entry({ channel: 'sms', voicemailId: '' })} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send text' })).toBeInTheDocument();
  });

  /**
   * S8. Before this, `dismissed` existed on the model, on the Firestore rules
   * and in every reader, and no client could ever write it — so a robocall's
   * only exit from the waiting count was to lie and call it "read".
   */
  it('dismisses a voicemail without sending anything', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(markVoicemail).toHaveBeenCalledWith({ voicemailId: 'vm1', status: 'dismissed' });
    expect(sendExternalMessage).not.toHaveBeenCalled();
    expect(await screen.findByText(/no longer counts as waiting on a reply/i)).toBeInTheDocument();
  });

  it('surfaces a dismiss failure rather than showing a false confirmation', async () => {
    markVoicemail.mockRejectedValueOnce(new Error('permission-denied'));
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByText(/Could not dismiss this voicemail/i)).toBeInTheDocument();
    expect(screen.queryByText(/no longer counts as waiting/i)).toBeNull();
    // The button stays, because the write did not land and the state is
    // unchanged. Hiding it on a failure would strand the voicemail.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('does not offer Dismiss on a voicemail that is already dismissed', () => {
    render(<ThreadActionsCard entry={entry({ statusHint: 'dismissed' })} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    // Mark read stays: dismissing is reversible, and this is how it reverses.
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
  });

  /**
   * Issue #581: a stray tap on Mark read or Dismiss for an already-replied
   * voicemail used to overwrite `repliedAt`/`replyLogId` with no confirmation
   * and no way back. Neither control is offered once `statusHint` is
   * `replied` - the Firestore rule on `voicemails/{id}` refuses the write
   * outright regardless, but the button should not invite a tap that is
   * going to fail.
   */
  it('offers neither Mark read nor Dismiss on an already-replied voicemail', () => {
    render(<ThreadActionsCard entry={entry({ statusHint: 'replied' })} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(markVoicemail).not.toHaveBeenCalled();
  });

  it('withdraws Dismiss once the write lands, so it cannot be pressed twice', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Dismissed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(markVoicemail).toHaveBeenCalledTimes(1);
  });

  /**
   * A voicemail from a withheld number has no `replyPhone`, so it falls into
   * the "nothing to text" branch. That is precisely the voicemail an operator
   * most needs to close out, so both state actions have to survive out there.
   */
  it('still offers Mark read and Dismiss on a voicemail with no callback number', () => {
    render(<ThreadActionsCard entry={entry({ replyPhone: '', counterpart: '' })} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Send text' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('closes on demand', async () => {
    const onClose = vi.fn();
    render(<ThreadActionsCard entry={entry()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
