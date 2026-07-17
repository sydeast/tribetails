// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';
import {
  type GenerateDraftResult,
  type SendPersonalizedResult,
} from '../api/communicateGenerate';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { generateDraft, sendPersonalizedMessage } = vi.hoisted(() => ({
  generateDraft: vi.fn(),
  sendPersonalizedMessage: vi.fn(),
}));
vi.mock('../api/communicateGenerate', async (orig) => ({
  ...(await orig<typeof import('../api/communicateGenerate')>()),
  generateDraft,
  sendPersonalizedMessage,
}));

import { CommunicatePersonalize } from './CommunicatePersonalize';

function kinfolkRow(over: Partial<Kinfolk>): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Dana',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'dana@example.com',
    profilePictureUrl: '',
    status: 'active',
    joinDate: '2026-01-01',
    ...over,
  };
}

function draftResult(over: Partial<GenerateDraftResult> = {}): GenerateDraftResult {
  return {
    generated_copy: 'Nova had the best day at the park today.',
    communication_type: 'email',
    kinfolk_name: 'Dana Halbrook',
    kinfolk_id: 'kf1',
    draft_id: 'd1',
    model: 'claude-sonnet-4-5',
    draftWriteFailed: false,
    warnings: [],
    ...over,
  };
}

let kinfolkAsync: Async<Kinfolk[]>;

beforeEach(() => {
  kinfolkAsync = { status: 'ready', data: [kinfolkRow({})] };
  useCollection.mockReset().mockImplementation(() => kinfolkAsync);
  generateDraft.mockReset();
  sendPersonalizedMessage.mockReset();
});

async function pickRecipient(name = 'Dana Halbrook') {
  await userEvent.selectOptions(screen.getByLabelText(/recipient/i), name);
}

async function fillNotes(text = 'Nova ran for an hour at the park.') {
  await userEvent.type(screen.getByLabelText(/^notes/i), text);
}

describe('CommunicatePersonalize screen', () => {
  it('lists kinfolk in the recipient picker and disables Generate until a recipient and notes are supplied', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1', firstName: 'Dana', lastName: 'Halbrook' })] };
    render(<CommunicatePersonalize onClose={() => {}} />);
    expect(screen.getByRole('option', { name: 'Dana Halbrook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate draft/i })).toBeDisabled();

    await pickRecipient();
    expect(screen.getByRole('button', { name: /generate draft/i })).toBeDisabled();

    await fillNotes();
    expect(screen.getByRole('button', { name: /generate draft/i })).toBeEnabled();
  });

  it('shows a loading state while the kinfolk listener is still loading', () => {
    kinfolkAsync = { status: 'loading' };
    render(<CommunicatePersonalize onClose={() => {}} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('surfaces a kinfolk load failure fail-loud, never a false empty picker', () => {
    kinfolkAsync = { status: 'error', message: 'permission-denied' };
    render(<CommunicatePersonalize onClose={() => {}} />);
    expect(screen.getByText(/permission-denied/)).toBeInTheDocument();
  });

  it('shows the proven-empty state when there is no kinfolk on file', () => {
    kinfolkAsync = { status: 'ready', data: [] };
    render(<CommunicatePersonalize onClose={() => {}} />);
    expect(screen.getByText(/no kinfolk on file yet/i)).toBeInTheDocument();
  });

  it('defaults the channel to email when the recipient has one on file', async () => {
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    expect(screen.getByRole('radio', { name: /email/i })).toBeChecked();
  });

  it('defaults to text when the recipient has only a phone number on file', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ email: '' })] };
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    expect(screen.getByRole('radio', { name: /text/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /email/i })).toBeDisabled();
  });

  it('shows a "no contact method" banner and disables both channels when neither is on file', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ email: '', phoneNumber: '' })] };
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    expect(screen.getByText(/no contact method on file/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /email/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /text/i })).toBeDisabled();
  });

  it('calls generateDraft with the recipient, channel, and trimmed notes, omitting empty optional fields', async () => {
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes('  Nova ran for an hour.  ');
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));

    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft).toHaveBeenCalledWith({
      communication_type: 'email',
      recipient: 'Dana Halbrook',
      raw_notes: 'Nova ran for an hour.',
    });
  });

  it('includes tone_hint and max_length only when filled in', async () => {
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.type(screen.getByLabelText(/tone/i), 'celebratory');
    await userEvent.type(screen.getByLabelText(/length/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));

    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ tone_hint: 'celebratory', max_length: 'short' }),
    );
  });

  it('shows the generated draft in an editable textarea', async () => {
    generateDraft.mockResolvedValue(draftResult({ generated_copy: 'Nova had a wonderful time today.' }));
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));

    const draftBox = await screen.findByDisplayValue('Nova had a wonderful time today.');
    await userEvent.clear(draftBox);
    await userEvent.type(draftBox, 'Edited by the operator.');
    expect(draftBox).toHaveValue('Edited by the operator.');
  });

  it('surfaces a draftWriteFailed warning without hiding the generated copy', async () => {
    generateDraft.mockResolvedValue(
      draftResult({ draftWriteFailed: true, draft_id: null, warnings: ['Draft write failed: permission-denied'] }),
    );
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));

    expect(await screen.findByText(/draft not saved/i)).toBeInTheDocument();
    expect(screen.getByText(/Draft write failed: permission-denied/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Nova had the best day at the park today.')).toBeInTheDocument();
  });

  it('fails loud on a generate error and leaves the form intact for a retry', async () => {
    generateDraft.mockRejectedValueOnce(new Error('No Kinfolk match for "Dana Halbrook"'));
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes('Some notes');
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));

    expect(await screen.findByText(/No Kinfolk match for "Dana Halbrook"/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^notes/i)).toHaveValue('Some notes');
    expect(screen.queryByRole('button', { name: /regenerate/i })).toBeNull();
  });

  it('regenerates with avoid_opening set to the current draft opening', async () => {
    generateDraft.mockResolvedValueOnce(draftResult({ generated_copy: 'Well, Nova had quite a day. She ran the whole time.' }));
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByDisplayValue('Well, Nova had quite a day. She ran the whole time.');

    generateDraft.mockResolvedValueOnce(draftResult({ generated_copy: 'Nova ran the whole visit today.' }));
    await userEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));

    await waitFor(() =>
      expect(generateDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ avoid_opening: 'Well, Nova had quite a day.' }),
      ),
    );
  });

  it('opens a confirm Dialog naming the recipient, channel, and exact message before sending', async () => {
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByDisplayValue('Nova had the best day at the park today.');
    await userEvent.click(screen.getByRole('button', { name: /review & send/i }));

    const dialog = screen.getByRole('dialog', { name: /send this message/i });
    expect(dialog).toHaveTextContent('Dana Halbrook');
    expect(dialog).toHaveTextContent('dana@example.com');
    expect(dialog).toHaveTextContent('Email');
    expect(dialog).toHaveTextContent('Nova had the best day at the park today.');
    expect(sendPersonalizedMessage).not.toHaveBeenCalled();
  });

  it('sends only on explicit confirm, disables the dialog while busy, and shows the real result', async () => {
    generateDraft.mockResolvedValue(draftResult());
    let release!: (v: SendPersonalizedResult) => void;
    sendPersonalizedMessage.mockReturnValue(new Promise<SendPersonalizedResult>((r) => (release = r)));

    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByDisplayValue('Nova had the best day at the park today.');
    await userEvent.click(screen.getByRole('button', { name: /review & send/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));

    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(sendPersonalizedMessage).toHaveBeenCalledWith({
      channel: 'email',
      message_body: 'Nova had the best day at the park today.',
      kinfolk_id: 'kf1',
      recipient_email: 'dana@example.com',
    });

    release({ ok: true, providerId: 'SM123' });
    await waitFor(() => expect(screen.getByText(/message sent/i)).toBeInTheDocument());
    expect(screen.getByText(/Provider reference: SM123/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fails loud on a send error, closes the dialog, and preserves the draft for a retry', async () => {
    generateDraft.mockResolvedValue(draftResult());
    sendPersonalizedMessage.mockRejectedValueOnce(new Error('recipient_opted_out'));

    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByDisplayValue('Nova had the best day at the park today.');
    await userEvent.click(screen.getByRole('button', { name: /review & send/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));

    expect(await screen.findByText(/recipient_opted_out/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByDisplayValue('Nova had the best day at the park today.')).toBeInTheDocument();
  });

  it('Cancel closes the confirm Dialog without sending', async () => {
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByDisplayValue('Nova had the best day at the park today.');
    await userEvent.click(screen.getByRole('button', { name: /review & send/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sendPersonalizedMessage).not.toHaveBeenCalled();
  });

  it('"Send another" clears the form back to an empty, unselected state', async () => {
    generateDraft.mockResolvedValue(draftResult());
    sendPersonalizedMessage.mockResolvedValue({ ok: true, providerId: null });

    render(<CommunicatePersonalize onClose={() => {}} />);
    await pickRecipient();
    await fillNotes();
    await userEvent.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByDisplayValue('Nova had the best day at the park today.');
    await userEvent.click(screen.getByRole('button', { name: /review & send/i }));
    await userEvent.click(screen.getByRole('button', { name: /^send now$/i }));
    await screen.findByText(/message sent/i);

    await userEvent.click(screen.getByRole('button', { name: /send another/i }));
    expect(screen.getByLabelText(/recipient/i)).toHaveValue('');
    expect(screen.getByLabelText(/^notes/i)).toHaveValue('');
    expect(screen.queryByDisplayValue('Nova had the best day at the park today.')).toBeNull();
  });

  it('"Back to Recent" calls onClose', async () => {
    const onClose = vi.fn();
    render(<CommunicatePersonalize onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /back to recent/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
