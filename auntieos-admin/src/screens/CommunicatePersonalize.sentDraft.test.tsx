// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Kinfolk } from '../api/directory';

/**
 * #2428: a Communicate draft that already went out opened again as "needs
 * approval", with Approve and send and Delete draft. Approving an Email or Text
 * there sent the household the same message a second time.
 *
 * Only the wires are stubbed. The predicates (`lib/draftSent.ts`), the push
 * sentences and the button rule (`personalizeDraftActions`) are the real ones.
 */

const { useCollection, useDocById } = vi.hoisted(() => ({ useCollection: vi.fn(), useDocById: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection, useDocById }));
const { publishGeneratedDraft, deleteGeneratedDraft } = vi.hoisted(() => ({
  publishGeneratedDraft: vi.fn(),
  deleteGeneratedDraft: vi.fn(),
}));
vi.mock('../api/kinTaleDraftActions', () => ({ publishGeneratedDraft, deleteGeneratedDraft }));
const { approveGeneratedDraft } = vi.hoisted(() => ({ approveGeneratedDraft: vi.fn() }));
vi.mock('../api/communicateApprove', async (orig) => ({
  ...(await orig<typeof import('../api/communicateApprove')>()),
  approveGeneratedDraft,
}));
const { sendExternalMessage } = vi.hoisted(() => ({ sendExternalMessage: vi.fn() }));
vi.mock('../api/externalSend', () => ({ sendExternalMessage, suppressExternalRecipient: vi.fn() }));
const { sendGeneratedDraft } = vi.hoisted(() => ({ sendGeneratedDraft: vi.fn() }));
vi.mock('../api/draftSend', () => ({ sendGeneratedDraft }));
const { sendHouseholdPush } = vi.hoisted(() => ({ sendHouseholdPush: vi.fn() }));
vi.mock('../api/householdPush', async (orig) => ({
  ...(await orig<typeof import('../api/householdPush')>()),
  sendHouseholdPush,
}));
// #2440: the business's zone, as `business_settings.timeZone` resolves. The
// hook reads settings over the network, so the value is handed in here.
// #2316: the Text confirm asks whether the household has a MyTribe account.
vi.mock('../api/visitNoticePreview', () => ({
  previewVisitNotification: vi.fn().mockResolvedValue({ willNotify: true, reason: null }),
}));
const { businessZone } = vi.hoisted(() => ({ businessZone: { value: 'America/Chicago' } }));
vi.mock('../lib/useBusinessZone', () => ({ useBusinessZone: () => businessZone.value }));
vi.mock('../components/RecipientContextPanel', () => ({
  RecipientContextPanel: () => <div data-testid="context-stub" />,
}));

import { CommunicatePersonalize } from './CommunicatePersonalize';

const DANA: Kinfolk = {
  _id: 'kf1',
  firstName: 'Dana',
  lastName: 'Halbrook',
  phoneNumber: '+15125551234',
  email: 'catch@hanasamku.com',
  profilePictureUrl: '',
  status: 'active',
  joinDate: '2026-01-01',
};

// Mocks reset at the top of each test body, the convention the sibling test
// file documents.
function setup(row: Record<string, unknown> | null) {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [DANA] });
  useDocById.mockReset().mockImplementation((path: string, id: string | null) =>
    path === 'generated_drafts' && id === 'gd1' ? { status: 'ready', data: row } : { status: 'ready', data: null },
  );
  approveGeneratedDraft.mockReset();
  sendExternalMessage.mockReset();
  sendHouseholdPush.mockReset();
  publishGeneratedDraft.mockReset();
  deleteGeneratedDraft.mockReset().mockResolvedValue(undefined);
  sendGeneratedDraft.mockReset().mockResolvedValue({ outcome: 'sent', auditWarning: null });
  businessZone.value = 'America/Chicago';
  return userEvent.setup();
}

const EMAIL = {
  _id: 'gd1',
  status: 'generated',
  communication_type: 'email',
  kinfolk_id: 'kf1',
  kinfolk_name: 'Dana Halbrook',
  generated_copy: 'Nova is booked for Friday.',
  generated_title: 'Friday',
};
const TEXT = { ...EMAIL, communication_type: 'sms', generated_title: '' };
const PUSH = { ...EMAIL, communication_type: 'push', generated_title: '', status: 'approved' };

const UNCONFIRMED_WORDS =
  'The send of this email to Dana Halbrook on Nov 20, 2026 did not get an answer, so it is not known whether it reached them. ' +
  'It is not sent again from this draft. Write a new one if it has to go again.';
/** The refusal `sendGeneratedDraft` answers with: the SDK's error, with the server's `details`. */
function refusal(message: string, code: string): Error {
  return Object.assign(new Error(message), { code: 'functions/failed-precondition', details: { code } });
}
/** Nothing on the screen can send this draft or delete it. */
function expectFinished() {
  expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.queryByText('needs approval')).toBeNull();
}

describe('#2428: opening a draft that already went out', () => {
  it('HAPPY: an Email the server stamped sent opens as sent, with no Approve and no Delete', async () => {
    setup({ ...EMAIL, status: 'approved', generatedCopy: 'Nova is booked for Friday at 9.', sentAt: '2026-11-20T16:00:00.000Z', sentChannel: 'email' });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Already sent')).toBeInTheDocument();
    expect(screen.getByText('Sent to Dana Halbrook by email on Nov 20, 2026. It is not sent again.')).toBeInTheDocument();
    expect(screen.getByLabelText(/edit before approving/i)).toHaveValue('Nova is booked for Friday at 9.');
    expectFinished();
    expect(screen.queryByText('Draft approved')).toBeNull();
  });

  it('HAPPY: a Text an older version approved and sent opens as already approved, with neither button', async () => {
    setup({ ...TEXT, status: 'approved', approvedAt: '2026-11-03T16:00:00.000Z' });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Already approved')).toBeInTheDocument();
    expect(
      screen.getByText('This text for Dana Halbrook was approved on Nov 3, 2026. Approving sends it, so it is not sent again.'),
    ).toBeInTheDocument();
    expectFinished();
  });

  // #2452: this used to assert "Already approved", which reads as sent about a
  // send nobody can vouch for.
  it('SAD: an Email whose send was cut off before it answered is not offered again, and is not called approved or sent', async () => {
    setup({ ...EMAIL, status: 'approved', approvedAt: '2026-11-20T16:00:00.000Z', sendClaimedAt: '2026-11-20T16:00:00.000Z' });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Send not confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Already approved')).toBeNull();
    expect(screen.queryByText('Already sent')).toBeNull();
    expectFinished();
  });

  it('HAPPY: a Push that reached their phone opens with what happened and neither button', async () => {
    setup({ ...PUSH, pushOutcome: 'sent', pushReason: '' });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Push sent')).toBeInTheDocument();
    expect(screen.getByText("Sent to Dana Halbrook's phone. It is on their notifications list too.")).toBeInTheDocument();
    expectFinished();
  });

  it('HAPPY: a Push that only reached their notifications list opens the same way, and says why no push went', async () => {
    setup({ ...PUSH, pushOutcome: 'listed', pushReason: 'no_device' });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('On their notifications list')).toBeInTheDocument();
    expect(screen.getByText(/nobody in the household has turned on pushes in the app yet/)).toBeInTheDocument();
    expectFinished();
  });

  it('NEGATIVE: editing the words of a Push already on their list does not bring Approve back', async () => {
    // Approving it again with new words rewrote the notice the household already had.
    const user = setup({ ...PUSH, pushOutcome: 'listed', pushReason: 'household_push_off' });
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByText('On their notifications list');
    await user.type(screen.getByLabelText(/edit before approving/i), ' And one more thing.');
    expectFinished();
    expect(approveGeneratedDraft).not.toHaveBeenCalled();
    expect(sendHouseholdPush).not.toHaveBeenCalled();
  });

  it('NEGATIVE: editing the words of a sent Email does not bring Approve back', async () => {
    const user = setup({ ...EMAIL, status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' });
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByText('Already sent');
    await user.type(screen.getByLabelText(/edit before approving/i), ' Again.');
    expectFinished();
    expect(sendGeneratedDraft).not.toHaveBeenCalled();
  });

  it('HAPPY: an Email nobody has approved still opens with Approve and send and Delete draft', async () => {
    setup({ ...EMAIL });
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeEnabled();
    expect(screen.getByText('needs approval')).toBeInTheDocument();
    expect(screen.queryByText('Already sent')).toBeNull();
    expect(screen.queryByText('Already approved')).toBeNull();
  });

  it('HAPPY: an Email the provider refused is unsent again, so it can be sent', async () => {
    setup({ ...EMAIL, sendFailedAt: '2026-11-20T16:00:01.000Z' });
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
  });

  it('HAPPY: an approved Blog post, which is sent by nothing, opens as it always did', async () => {
    setup({ ...EMAIL, communication_type: 'blog_post', status: 'approved' });
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    expect(screen.getByRole('button', { name: 'Approve draft' })).toBeEnabled();
    expect(screen.queryByText('Already approved')).toBeNull();
  });
});

describe('#2428: approving an Email or Text draft sends it once', () => {
  async function openAndConfirm(user: ReturnType<typeof userEvent.setup>) {
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    return screen.findByRole('button', { name: 'Send now' });
  }

  it('HAPPY: a stored Text goes through the server send, with no address and no approve write of its own', async () => {
    const user = setup({ ...TEXT });
    await user.click(await openAndConfirm(user));
    await waitFor(() => expect(sendGeneratedDraft).toHaveBeenCalledTimes(1));
    expect(sendGeneratedDraft).toHaveBeenCalledWith({ draftId: 'gd1', kinfolkId: 'kf1', body: 'Nova is booked for Friday.' });
    expect(approveGeneratedDraft).not.toHaveBeenCalled();
    expect(sendExternalMessage).not.toHaveBeenCalled();
    expect(await screen.findByText('Approved and sent.')).toBeInTheDocument();
    expectFinished();
  });

  it('NEGATIVE: when the server says it had already gone, the screen says so and claims no new send', async () => {
    const user = setup({ ...EMAIL });
    sendGeneratedDraft.mockResolvedValue({ outcome: 'already_sent', auditWarning: null });
    await user.click(await openAndConfirm(user));
    expect(await screen.findByText('This message already went to Dana Halbrook. Nothing new was sent.')).toBeInTheDocument();
    expect(screen.queryByText('Approved and sent.')).toBeNull();
    expectFinished();
  });

  it('ERROR: a refused send says why, claims nothing, and leaves Approve and send live', async () => {
    const user = setup({ ...EMAIL });
    sendGeneratedDraft.mockImplementation(() => Promise.reject(new Error('Dana Halbrook has no email address on file.')));
    await user.click(await openAndConfirm(user));
    expect(await screen.findByText('Dana Halbrook has no email address on file.')).toBeInTheDocument();
    expect(screen.queryByText('Approved and sent.')).toBeNull();
    expect(screen.queryByText('Already sent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeEnabled();
  });

  it('SAD: a sent message whose activity entry failed says both', async () => {
    const user = setup({ ...EMAIL });
    sendGeneratedDraft.mockResolvedValue({ outcome: 'sent', auditWarning: 'audit chain busy' });
    await user.click(await openAndConfirm(user));
    expect(await screen.findByText(/Approved and sent\. The audit entry could not be written: audit chain busy/)).toBeInTheDocument();
  });

  it('NEGATIVE: two taps on Send now in the same moment send once', async () => {
    const user = setup({ ...EMAIL });
    let answer: (r: { outcome: string; auditWarning: null }) => void = () => undefined;
    sendGeneratedDraft.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const sendNow = await openAndConfirm(user);
    // Two clicks before React draws the disabled button.
    act(() => {
      fireEvent.click(sendNow);
      fireEvent.click(sendNow);
    });
    expect(sendGeneratedDraft).toHaveBeenCalledTimes(1);
    await act(async () => answer({ outcome: 'sent', auditWarning: null }));
    expect(await screen.findByText('Approved and sent.')).toBeInTheDocument();
    expect(sendGeneratedDraft).toHaveBeenCalledTimes(1);
  });
});

describe('#2452: a send that was never confirmed', () => {
  const MARKED = {
    ...EMAIL,
    status: 'approved',
    approvedAt: '2026-11-20T16:00:00.000Z',
    sendClaimedAt: '2026-11-20T16:00:00.000Z',
    sendUnconfirmedAt: '2026-11-20T16:00:31.000Z',
  };
  async function openAndConfirm(user: ReturnType<typeof userEvent.setup>) {
    render(<CommunicatePersonalize draftId="gd1" />);
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    return screen.findByRole('button', { name: 'Send now' });
  }
  it('HAPPY: opens with its own notice, in the warning tone, with no Approve and no Delete', async () => {
    setup(MARKED);
    render(<CommunicatePersonalize draftId="gd1" />);
    const title = await screen.findByText('Send not confirmed');
    expect(screen.getByText(UNCONFIRMED_WORDS)).toBeInTheDocument();
    expect(title.closest('.banner')).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByText(/Already approved|Already sent|Approved and sent/)).toBeNull();
    expectFinished();
  });
  it('HAPPY: the same notice takes the place of Approve and Delete in the sitting where it happened', async () => {
    const user = setup({ ...EMAIL });
    sendGeneratedDraft.mockImplementation(() =>
      Promise.reject(refusal('The send did not get an answer, so it is not known whether this message reached the household.', 'draft_send_unconfirmed')),
    );
    await user.click(await openAndConfirm(user));
    expect(await screen.findByText('Send not confirmed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The send of this email to Dana Halbrook did not get an answer, so it is not known whether it reached them. ' +
          'It is not sent again from this draft. Write a new one if it has to go again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Approve blocked')).toBeNull();
    expect(screen.queryByText('Approved and sent.')).toBeNull();
    expectFinished();
    expect(deleteGeneratedDraft).not.toHaveBeenCalled();
  });
  it('NEGATIVE: the notice is told by the code. The same words without it are an ordinary refusal', async () => {
    const user = setup({ ...EMAIL });
    sendGeneratedDraft.mockImplementation(() => Promise.reject(new Error('The send did not get an answer.')));
    await user.click(await openAndConfirm(user));
    expect(await screen.findByText('The send did not get an answer.')).toBeInTheDocument();
    expect(screen.queryByText('Send not confirmed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
  });
  it('NEGATIVE: a send that is still running is not called unconfirmed', async () => {
    const user = setup({ ...EMAIL });
    sendGeneratedDraft.mockImplementation(() =>
      Promise.reject(refusal('This message is being sent right now.', 'draft_send_in_flight')),
    );
    await user.click(await openAndConfirm(user));
    expect(await screen.findByText('This message is being sent right now.')).toBeInTheDocument();
    expect(screen.queryByText('Send not confirmed')).toBeNull();
  });
  it('SAD: a Text claimed a moment ago opens as being sent, with neither button', async () => {
    setup({ ...TEXT, status: 'approved', sendClaimedAt: new Date().toISOString() });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Being sent')).toBeInTheDocument();
    expect(
      screen.getByText('This text for Dana Halbrook is being sent right now. Open it again in a few minutes to see what happened.'),
    ).toBeInTheDocument();
    expectFinished();
  });
});
describe('#2440: the sent date is the business day', () => {
  // 03:30 UTC on Nov 21 is 9:30 PM on Nov 20 in Chicago and 5:30 PM in Honolulu.
  const LATE = { ...EMAIL, status: 'approved', sentAt: '2026-11-21T03:30:00.000Z' };
  it('HAPPY: reads America/Chicago by default, whatever zone the browser is in', async () => {
    setup(LATE);
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Sent to Dana Halbrook by email on Nov 20, 2026. It is not sent again.')).toBeInTheDocument();
  });
  it('HAPPY: reads the zone in business settings when one is set', async () => {
    setup(LATE);
    businessZone.value = 'UTC';
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText('Sent to Dana Halbrook by email on Nov 21, 2026. It is not sent again.')).toBeInTheDocument();
  });
});
