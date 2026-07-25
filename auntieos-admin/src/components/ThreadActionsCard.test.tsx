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

import { ThreadActionsCard } from './ThreadActionsCard';

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
    });
    expect(markVoicemail).toHaveBeenCalledWith({
      voicemailId: 'vm1',
      status: 'replied',
      replyLogId: 'SM123',
    });
  });

  /**
   * `sendExternalMessage` records into `external_messages`, not `sms_messages`,
   * so the reply does NOT come back as a row in the channel list. Saying so is
   * the difference between an honest fallback and a silent one.
   */
  it('discloses that the reply is not going to appear as a row in this list', async () => {
    render(<ThreadActionsCard entry={entry()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Reply by text'), 'On my way');
    await userEvent.click(screen.getByRole('button', { name: 'Send text' }));
    expect(await screen.findByText(/external message log/i)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Send text' })).toBeInTheDocument();
  });

  it('closes on demand', async () => {
    const onClose = vi.fn();
    render(<ThreadActionsCard entry={entry()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
