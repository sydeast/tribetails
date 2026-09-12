// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';
import { type GenerateDraftResult } from '../api/communicateGenerate';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { generateDraft } = vi.hoisted(() => ({ generateDraft: vi.fn() }));
vi.mock('../api/communicateGenerate', async (orig) => ({
  ...(await orig<typeof import('../api/communicateGenerate')>()),
  generateDraft,
}));

const { approveGeneratedDraft } = vi.hoisted(() => ({ approveGeneratedDraft: vi.fn() }));
vi.mock('../api/communicateApprove', async (orig) => ({
  ...(await orig<typeof import('../api/communicateApprove')>()),
  approveGeneratedDraft,
}));

const { sendExternalMessage } = vi.hoisted(() => ({ sendExternalMessage: vi.fn() }));
vi.mock('../api/externalSend', () => ({ sendExternalMessage, suppressExternalRecipient: vi.fn() }));

// Stubbed rather than exercised: RecipientContextPanel has its own full test
// file. This file proves only the WIRING, that the panel is mounted for the
// message types that address a household and carries the resolved id.
vi.mock('../components/RecipientContextPanel', () => ({
  RecipientContextPanel: ({ kinfolkId }: { kinfolkId: string }) => (
    <div data-testid="context-stub" data-kinfolk-id={kinfolkId} />
  ),
}));
import { CommunicatePersonalize } from './CommunicatePersonalize';

// NOTE: mocks reset inside `setup()`, called at the top of EACH test body rather
// than from a shared `beforeEach`. Same deviation `api/invoicesWrite.test.ts`
// documents: resetting a hoisted mock of a `vi.mock`'d local module from a
// `beforeEach`, in a test that both configures a rejection and awaits it, makes
// Vitest misreport the caught rejection as an unhandled error.

function kinfolkRow(over: Partial<Kinfolk>): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Dana',
    lastName: 'Halbrook',
    phoneNumber: '+15125551234',
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
    generated_title: 'Nova at the park',
    communication_type: 'visit_report',
    kinfolk_name: 'Dana Halbrook',
    kinfolk_id: 'kf1',
    draft_id: 'd1',
    model: 'claude-sonnet-4-5',
    draftWriteFailed: false,
    warnings: [],
    ...over,
  };
}

const ROWS: Kinfolk[] = [
  kinfolkRow({}),
  kinfolkRow({ _id: 'kf2', firstName: 'Dana', lastName: 'Zamora', email: 'dz@example.com' }),
];

function setup(rows: Async<Kinfolk[]> = { status: 'ready', data: ROWS }) {
  useCollection.mockReset();
  generateDraft.mockReset();
  approveGeneratedDraft.mockReset();
  sendExternalMessage.mockReset();
  useCollection.mockReturnValue(rows);
  approveGeneratedDraft.mockResolvedValue({ ok: true, auditWarning: null, providerId: null, delivered: false });
  return userEvent.setup();
}

/** Opens the typeahead, searches, and picks the named household. */
async function pickRecipient(user: ReturnType<typeof userEvent.setup>, query: string, name: string) {
  await user.click(screen.getByRole('button', { name: /choose|change/i }));
  await user.type(screen.getByLabelText(/search kinfolk/i), query);
  await user.click(screen.getByRole('button', { name: new RegExp(name) }));
}

async function generate(user: ReturnType<typeof userEvent.setup>, notes = 'Nova ate every bite.') {
  await user.type(screen.getByLabelText(/^notes$/i), notes);
  await user.click(screen.getByRole('button', { name: 'Generate draft' }));
}

describe('the composer form', () => {
  it('opens on KinTale, the archive default, unchanged by the wider chip set', () => {
    setup();
    render(<CommunicatePersonalize />);
    expect(screen.getByRole('radio', { name: 'KinTale' })).toBeChecked();
  });

  it('offers all seven message types, in the operator’s order', () => {
    setup();
    render(<CommunicatePersonalize />);
    const chips = screen
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('name') === 'personalizeMessageType');
    expect(chips.map((c) => c.closest('label')?.textContent?.trim())).toEqual([
      'Email',
      'SMS',
      'Push',
      'Social',
      'Blog',
      'General',
      'KinTale',
    ]);
  });

  it('sends the exact wire value for a type the composer could not previously reach', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'push' }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'Push' }));
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);

    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]?.communication_type).toBe('push');
    // A push has no title slot, so no second model call is bought for it.
    expect('want_title' in (generateDraft.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it('asks for a title on a KinTale, which is what TITLE_INSTRUCTION was written for', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);

    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]?.want_title).toBe(true);
  });

  it('opens on Warm and Medium', () => {
    setup();
    render(<CommunicatePersonalize />);
    expect(screen.getByRole('radio', { name: 'Warm' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
  });

  it('offers the archive tone and length sets', () => {
    setup();
    render(<CommunicatePersonalize />);
    for (const label of ['Warm', 'Cheerful', 'Professional', 'Playful', 'Short', 'Medium', 'Long']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  it('hides the recipient picker for a Blog post, which addresses nobody', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    expect(screen.getByText('Recipient')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Blog' }));
    expect(screen.queryByText('Recipient')).not.toBeInTheDocument();
    // Social addresses nobody either.
    await user.click(screen.getByRole('radio', { name: 'Social' }));
    expect(screen.queryByText('Recipient')).not.toBeInTheDocument();
  });
});

describe('the recipient typeahead', () => {
  it('resolves a real kinfolk id, and sends it, so the server never fuzzy-matches a name', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize />);

    await pickRecipient(user, 'Zamora', 'Dana Zamora');
    await generate(user);

    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]?.kinfolk_id).toBe('kf2');
    expect(generateDraft.mock.calls[0]?.[0]?.recipient).toBe('Dana Zamora');
  });

  it('distinguishes two households that share a first name, which a name match could not', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('button', { name: /choose/i }));
    await user.type(screen.getByLabelText(/search kinfolk/i), 'Dana');
    expect(screen.getByRole('button', { name: /Dana Halbrook/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dana Zamora/ })).toBeInTheDocument();
  });

  it('says so plainly when a search matches nobody, instead of falling back to everybody', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('button', { name: /choose/i }));
    await user.type(screen.getByLabelText(/search kinfolk/i), 'Nobody');
    expect(screen.getByText(/no kinfolk match/i)).toBeInTheDocument();
  });

  it('offers no free-text entry, so an unresolved name can never be sent', () => {
    setup();
    render(<CommunicatePersonalize />);
    expect(screen.queryByLabelText(/recipient name/i)).not.toBeInTheDocument();
  });
});

describe('generate', () => {
  it('asks for notes before anything else, and makes no call', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(await screen.findByText('Add a few notes first so Auntie has something to write about.')).toBeInTheDocument();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('asks for a recipient once notes exist, and makes no call', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    await generate(user);
    expect(await screen.findByText('Pick a recipient for this message type first.')).toBeInTheDocument();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('carries the tone and length chips as tone_hint and max_length', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize />);

    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await user.click(screen.getByRole('radio', { name: 'Playful' }));
    await user.click(screen.getByRole('radio', { name: 'Short' }));
    await generate(user);

    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]?.tone_hint).toBe('playful');
    expect(generateDraft.mock.calls[0]?.[0]?.max_length).toBe('short');
  });

  it('puts the copy in an editable box, not a read-only preview', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);

    const box = await screen.findByLabelText(/edit before approving/i);
    expect(box).toBeInstanceOf(HTMLTextAreaElement);
    expect(box).not.toHaveAttribute('readonly');
  });

  it('says the draft was not saved when the server says so, rather than letting the operator lose it', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(
      draftResult({ draft_id: null, draftWriteFailed: true, warnings: ['Draft write failed: quota'] }),
    );
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);

    expect(await screen.findByText(/Draft write failed: quota/)).toBeInTheDocument();
  });

  it('surfaces a generate failure in the server’s own words', async () => {
    const user = setup();
    generateDraft.mockImplementation(() => Promise.reject(new Error('generate_rate_limit_exceeded')));
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    expect(await screen.findByText('generate_rate_limit_exceeded')).toBeInTheDocument();
  });
});

describe('approve', () => {
  async function draftReady(user: ReturnType<typeof userEvent.setup>, over: Partial<GenerateDraftResult> = {}) {
    generateDraft.mockResolvedValue(draftResult(over));
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);
  }

  it('promotes the draft through the ordered approve, passing the edited copy', async () => {
    const user = setup();
    await draftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));

    await waitFor(() => expect(approveGeneratedDraft).toHaveBeenCalled());
    const args = approveGeneratedDraft.mock.calls[0]?.[0];
    expect(args?.draftId).toBe('d1');
    expect(args?.kinfolkId).toBe('kf1');
    expect(args?.editedCopy).toBe('Nova had the best day at the park today.');
  });

  it('sends nothing for a KinTale report, which delivers from the KinTale flow rather than here', async () => {
    const user = setup();
    await draftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));
    await waitFor(() => expect(approveGeneratedDraft).toHaveBeenCalled());
    expect(approveGeneratedDraft.mock.calls[0]?.[0]?.deliver).toBeUndefined();
  });

  it('confirms before a deliverable send, because it reaches a real household and is not undoable', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'email' }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'Email' }));
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await user.type(screen.getByLabelText(/^subject$/i), 'Nova at the park');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);

    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    expect(await screen.findByText(/not undoable/i)).toBeInTheDocument();
    expect(approveGeneratedDraft).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(approveGeneratedDraft).toHaveBeenCalled());
    expect(typeof approveGeneratedDraft.mock.calls[0]?.[0]?.deliver).toBe('function');
  });

  it('refuses to approve a draft the server never saved', async () => {
    const user = setup();
    await draftReady(user, { draft_id: null, draftWriteFailed: true, warnings: [] });
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));
    expect(
      await screen.findByText('This draft was not saved, so there is nothing to approve. Regenerate and try again.'),
    ).toBeInTheDocument();
    expect(approveGeneratedDraft).not.toHaveBeenCalled();
  });

  it('refuses an email with no subject, before the send would', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'email', generated_title: '' }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'Email' }));
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);

    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    expect(await screen.findByText('Email needs a subject.')).toBeInTheDocument();
    expect(approveGeneratedDraft).not.toHaveBeenCalled();
  });

  it('reports an approve failure and never claims the draft was promoted', async () => {
    const user = setup();
    approveGeneratedDraft.mockImplementation(() =>
      Promise.reject(new Error('Approve failed, the draft was not promoted: PERMISSION_DENIED')),
    );
    await draftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));

    expect(await screen.findByText(/the draft was not promoted/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Draft approved$/i)).not.toBeInTheDocument();
  });

  it('says the draft is approved but the audit entry is missing, rather than hiding one or the other', async () => {
    const user = setup();
    approveGeneratedDraft.mockResolvedValue({
      ok: true,
      auditWarning: 'audit chain busy',
      providerId: null,
      delivered: false,
    });
    await draftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));

    expect(await screen.findByText(/audit chain busy/)).toBeInTheDocument();
    expect(screen.getByText(/Draft approved/i)).toBeInTheDocument();
  });

  /**
   * The #755 sweep, against `ui-ideas/auntieos-communicate-2026-05-27.html`:
   * the generator wears the purple-to-pink `.gen` wash, and the draft sits in
   * the purple `.draft` card with a "needs approval" capsule that leaves once
   * the draft is approved.
   */
  it('paints the generator as Auntie AI and the draft as a purple card that needs approval', async () => {
    const user = setup();
    await draftReady(user);
    expect(screen.getByRole('button', { name: 'Regenerate' })).toHaveClass('personalize__generate');
    const draft = screen.getByRole('heading', { name: 'Auntie AI draft' }).closest('section');
    expect(draft).toHaveClass('den-panel', 'personalize__draft');
    const pill = within(draft as HTMLElement).getByText('needs approval');
    expect(pill).toHaveClass('den-statuspill');
    expect(pill).toHaveAttribute('data-tone', 'purple');

    await user.click(screen.getByRole('button', { name: 'Approve draft' }));
    await screen.findByText(/Draft approved/i);
    expect(within(draft as HTMLElement).queryByText('needs approval')).toBeNull();
  });

  it('keeps the whole surface in the left column of the Communicate grid', async () => {
    const user = setup();
    await draftReady(user);
    const main = screen.getByRole('heading', { name: 'Personalize' }).closest('.communicate__main');
    expect(main).not.toBeNull();
    expect(main?.contains(screen.getByRole('heading', { name: 'Auntie AI draft' }))).toBe(true);
  });
});
describe('the recipient context panel', () => {
  it('is mounted for a message type that addresses a household', () => {
    setup();
    render(<CommunicatePersonalize />);
    expect(screen.getByTestId('context-stub')).toBeInTheDocument();
  });
  it('hands it the resolved kinfolk id once one is picked', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    expect(screen.getByTestId('context-stub')).toHaveAttribute('data-kinfolk-id', '');
    await pickRecipient(user, 'Zamora', 'Dana Zamora');
    expect(screen.getByTestId('context-stub')).toHaveAttribute('data-kinfolk-id', 'kf2');
  });
  it('is not mounted for a Blog post, which addresses nobody and has no dossier to read', async () => {
    const user = setup();
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'Blog' }));
    expect(screen.queryByTestId('context-stub')).toBeNull();
  });
});
