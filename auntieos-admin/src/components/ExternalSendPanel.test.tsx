// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { sendMock, suppressMock } = vi.hoisted(() => ({ sendMock: vi.fn(), suppressMock: vi.fn() }));
vi.mock('../api/externalSend', () => ({
  sendExternalMessage: sendMock,
  suppressExternalRecipient: suppressMock,
}));

import { ExternalSendPanel } from './ExternalSendPanel';

// NOTE: mocks reset at the top of EACH test body, not in a shared `beforeEach`,
// the deviation `api/invoicesWrite.test.ts` documents: resetting a hoisted mock
// of a `vi.mock`'d local module from a `beforeEach`, in a test that both
// configures a rejection and awaits it, makes Vitest misreport the caught
// rejection as unhandled.
function reset() {
  sendMock.mockReset();
  suppressMock.mockReset();
}

async function fill(user: ReturnType<typeof userEvent.setup>, recipient: string, subject: string, body: string) {
  if (recipient !== '') await user.type(screen.getByLabelText(/email address|phone number/i), recipient);
  if (subject !== '') await user.type(screen.getByLabelText(/^subject$/i), subject);
  if (body !== '') await user.type(screen.getByLabelText(/^message$/i), body);
}

describe('ExternalSendPanel', () => {
  it('opens on Email, which is the channel with a subject line', () => {
    reset();
    render(<ExternalSendPanel />);
    expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked();
    expect(screen.getByLabelText(/^subject$/i)).toBeInTheDocument();
  });

  it('hides the subject on Text, which has no subject line', async () => {
    reset();
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await user.click(screen.getByRole('radio', { name: 'Text' }));
    expect(screen.queryByLabelText(/^subject$/i)).not.toBeInTheDocument();
  });

  it('blocks a send with no recipient and never reaches the network', async () => {
    reset();
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await fill(user, '', 'Hi', 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Add a recipient first.')).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('blocks a malformed email and never reaches the network', async () => {
    reset();
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await fill(user, 'not-an-address', 'Hi', 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('That does not look like a valid email address.')).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('accepts an international number, which a US-only rule would have blocked', async () => {
    reset();
    sendMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1', recipientRedacted: '+4****0123' });
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await user.click(screen.getByRole('radio', { name: 'Text' }));
    await user.type(screen.getByLabelText(/phone number/i), '+447700900123');
    await user.type(screen.getByLabelText(/^message$/i), 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
  });

  it('sends as transactional, so a marketing opt-out cannot drop a personal note', async () => {
    reset();
    sendMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'p1', recipientRedacted: 'd***@example.com' });
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await fill(user, 'dana@example.com', 'Nova', 'She had a big day.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(sendMock.mock.calls[0]?.[0]).toEqual({
      channel: 'email',
      to: 'dana@example.com',
      subject: 'Nova',
      body: 'She had a big day.',
      transactional: true,
    });
  });

  it('honors transactional={false} for a caller that really is sending marketing', async () => {
    reset();
    sendMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'p1', recipientRedacted: 'd***@example.com' });
    const user = userEvent.setup();
    render(<ExternalSendPanel transactional={false} />);
    await fill(user, 'dana@example.com', 'Nova', 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(sendMock.mock.calls[0]?.[0]?.transactional).toBe(false);
  });

  it('reports the send with the redacted recipient and the provider id, never the raw address', async () => {
    reset();
    sendMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'p-42', recipientRedacted: 'd***@example.com' });
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await fill(user, 'dana@example.com', 'Nova', 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/d\*\*\*@example\.com/)).toBeInTheDocument();
    expect(await screen.findByText(/p-42/)).toBeInTheDocument();
  });

  it('replaces the opt-out sentinel with copy that says what happened and what to do', async () => {
    reset();
    sendMock.mockImplementation(() => Promise.reject(new Error('FAILED_PRECONDITION: recipient_opted_out')));
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await fill(user, 'dana@example.com', 'Nova', 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText('This recipient has opted out. Nothing was sent. Remove their suppression before sending again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/recipient_opted_out/)).not.toBeInTheDocument();
  });

  it('shows a provider failure in the provider’s own words', async () => {
    reset();
    sendMock.mockImplementation(() => Promise.reject(new Error('smtp2go rejected the sender domain')));
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await fill(user, 'dana@example.com', 'Nova', 'Body');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('smtp2go rejected the sender domain')).toBeInTheDocument();
  });

  it('records an opt-out and confirms with the redacted recipient', async () => {
    reset();
    suppressMock.mockResolvedValue({ ok: true, channel: 'email', recipientRedacted: 'd***@example.com' });
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await user.type(screen.getByLabelText(/email address/i), 'dana@example.com');
    await user.click(screen.getByRole('button', { name: 'Opt out recipient' }));
    await waitFor(() => expect(suppressMock).toHaveBeenCalledWith({ channel: 'email', to: 'dana@example.com' }));
    expect(await screen.findByText(/d\*\*\*@example\.com will no longer receive messages/)).toBeInTheDocument();
  });

  it('needs no subject or body to opt somebody out, because an opt-out sends nothing', async () => {
    reset();
    suppressMock.mockResolvedValue({ ok: true, channel: 'email', recipientRedacted: 'd***@example.com' });
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await user.type(screen.getByLabelText(/email address/i), 'dana@example.com');
    await user.click(screen.getByRole('button', { name: 'Opt out recipient' }));
    await waitFor(() => expect(suppressMock).toHaveBeenCalled());
  });

  it('blocks an opt-out with no recipient, with its own wording', async () => {
    reset();
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await user.click(screen.getByRole('button', { name: 'Opt out recipient' }));
    expect(await screen.findByText('Add a recipient to opt out first.')).toBeInTheDocument();
    expect(suppressMock).not.toHaveBeenCalled();
  });

  it('surfaces an opt-out failure rather than claiming a suppression that was never recorded', async () => {
    reset();
    suppressMock.mockImplementation(() => Promise.reject(new Error('permission-denied')));
    const user = userEvent.setup();
    render(<ExternalSendPanel />);
    await user.type(screen.getByLabelText(/email address/i), 'dana@example.com');
    await user.click(screen.getByRole('button', { name: 'Opt out recipient' }));
    expect(await screen.findByText(/permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/will no longer receive messages/)).not.toBeInTheDocument();
  });
});
