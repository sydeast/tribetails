// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';
import { type GenerateDraftResult } from '../api/communicateGenerate';

const { useCollection, useDocById } = vi.hoisted(() => ({ useCollection: vi.fn(), useDocById: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection, useDocById }));
const { publishGeneratedDraft, deleteGeneratedDraft } = vi.hoisted(() => ({
  publishGeneratedDraft: vi.fn(),
  deleteGeneratedDraft: vi.fn(),
}));
vi.mock('../api/kinTaleDraftActions', () => ({ publishGeneratedDraft, deleteGeneratedDraft }));

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
// #2061: only the wire is stubbed; the sentences are the real ones.
const { sendHouseholdPush } = vi.hoisted(() => ({ sendHouseholdPush: vi.fn() }));
vi.mock('../api/householdPush', async (orig) => ({
  ...(await orig<typeof import('../api/householdPush')>()),
  sendHouseholdPush,
}));

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
  publishGeneratedDraft.mockReset().mockResolvedValue({ ok: true, reportId: 'r1', alreadyPublished: false });
  deleteGeneratedDraft.mockReset().mockResolvedValue(undefined);
  useDocById.mockReset().mockReturnValue({ status: 'ready', data: null });
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
  // A General note: a type that approves without sending, so these cases test
  // the approve path itself. A KinTale sends (#1563) and has its own cases.
  async function draftReady(user: ReturnType<typeof userEvent.setup>, over: Partial<GenerateDraftResult> = {}) {
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'general', ...over }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'General' }));
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

  it('sends nothing for a General note, which has no single destination', async () => {
    const user = setup();
    await draftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));
    await waitFor(() => expect(approveGeneratedDraft).toHaveBeenCalled());
    expect(approveGeneratedDraft.mock.calls[0]?.[0]?.deliver).toBeUndefined();
    expect(publishGeneratedDraft).not.toHaveBeenCalled();
  });
  it('#1563: sends a KinTale to the household through publishGeneratedDraft, after a confirm', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    const box = await screen.findByLabelText(/edit before approving/i);
    await user.type(box, ' Edited.');
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    expect(await screen.findByText(/not undoable/i)).toBeInTheDocument();
    expect(publishGeneratedDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(publishGeneratedDraft).toHaveBeenCalledTimes(1));
    expect(publishGeneratedDraft).toHaveBeenCalledWith({
      draftId: 'd1',
      bodyCopy: 'Nova had the best day at the park today. Edited.',
      title: 'Nova at the park',
    });
    // The server writes the approve; no client-side approve write runs first.
    expect(approveGeneratedDraft).not.toHaveBeenCalled();
    expect(await screen.findByText(/Sent to Dana Halbrook/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
  });
  it('#1563: reports a failed KinTale send and leaves the send button live', async () => {
    const user = setup();
    publishGeneratedDraft.mockImplementation(() =>
      Promise.reject(new Error('The household this draft is addressed to no longer exists.')),
    );
    generateDraft.mockResolvedValue(draftResult());
    render(<CommunicatePersonalize />);
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.queryByText(/Sent to/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
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

  it('#1592: a delivered approve says it was sent, never the provider message id', async () => {
    const user = setup();
    approveGeneratedDraft.mockResolvedValue({
      ok: true,
      auditWarning: null,
      providerId: 'SG.msg-123',
      delivered: true,
    });
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'email' }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'Email' }));
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await user.type(screen.getByLabelText(/^subject$/i), 'Nova at the park');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/Approved and sent\./)).toBeInTheDocument();
    expect(screen.queryByText(/SG\.msg-123/)).toBeNull();
    expect(screen.queryByText(/Provider id/)).toBeNull();
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

/**
 * #1563: every stored draft was stranded. KinTales > Drafts opened them in a
 * report screen that could not find them, and Home's "Review and send tales"
 * opened this form blank. `draftId` is the way in: it loads one
 * `generated_drafts` doc, whichever writer's spelling it carries.
 */
describe('#1563 opening a stored draft', () => {
  /** A May-era n8n draft, camelCase and `pending`, like the walk's five. */
  const MIGRATED = {
    _id: 'gd1',
    status: 'pending',
    communicationType: 'visit_report',
    kinfolkId: 'kf1',
    kinfolkName: 'Dana Halbrook',
    generatedCopy: 'Biscuit chased every leaf in the yard.',
    createdOn: '2026-05-23T22:23:00.000Z',
  };

  function stored(row: Record<string, unknown> | null) {
    useDocById.mockImplementation((path: string, id: string | null) =>
      path === 'generated_drafts' && id === 'gd1' ? { status: 'ready', data: row } : { status: 'ready', data: null },
    );
  }

  it('reads the draft by its id, not out of Home’s capped stream', () => {
    setup();
    stored(MIGRATED);
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(useDocById).toHaveBeenCalledWith('generated_drafts', 'gd1');
  });

  it('loads the household, the type and the copy, ready to edit and send', async () => {
    const user = setup();
    stored(MIGRATED);
    render(<CommunicatePersonalize draftId="gd1" />);
    const box = await screen.findByLabelText(/edit before approving/i);
    expect(box).toHaveValue('Biscuit chased every leaf in the yard.');
    expect(screen.getByRole('radio', { name: 'KinTale' })).toBeChecked();
    expect(screen.getByText('Dana Halbrook', { selector: '.personalize__recipient-name' })).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'Biscuit chased every leaf.');
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(publishGeneratedDraft).toHaveBeenCalledTimes(1));
    expect(publishGeneratedDraft.mock.calls[0]?.[0]).toMatchObject({ draftId: 'gd1', bodyCopy: 'Biscuit chased every leaf.' });
    expect(await screen.findByText(/Sent to Dana Halbrook/)).toBeInTheDocument();
  });

  it('reads the snake_case draft generate.js writes, title included', async () => {
    setup();
    stored({
      _id: 'gd1',
      status: 'generated',
      communication_type: 'visit_report',
      kinfolk_id: 'kf2',
      kinfolk_name: 'Dana Zamora',
      generated_copy: 'Mochi napped in the sun.',
      generated_title: 'A sunny nap',
    });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByLabelText(/edit before approving/i)).toHaveValue('Mochi napped in the sun.');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('A sunny nap');
    expect(screen.getByText('Dana Zamora', { selector: '.personalize__recipient-name' })).toBeInTheDocument();
  });

  it('opens a stored text draft on the SMS chip, so it sends as a text', async () => {
    setup();
    stored({ ...MIGRATED, communicationType: 'sms' });
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    expect(screen.getByRole('radio', { name: 'SMS' })).toBeChecked();
  });

  it('says a draft already sent as a KinTale was sent, and offers no second send', async () => {
    const onOpenKinTale = vi.fn();
    const user = setup();
    stored({ ...MIGRATED, status: 'published', publishedReportId: 'r7' });
    render(<CommunicatePersonalize draftId="gd1" onOpenKinTale={onOpenKinTale} />);
    expect(await screen.findByText(/already sent to Dana Halbrook/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open the KinTale' }));
    expect(onOpenKinTale).toHaveBeenCalledWith('r7');
  });

  it('says so when the draft is gone, instead of a blank form that looks like a fresh start', async () => {
    setup();
    stored(null);
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(await screen.findByText(/no longer here/i)).toBeInTheDocument();
  });

  it('shows a loading cue while the draft is on its way', () => {
    setup();
    useDocById.mockReturnValue({ status: 'loading' });
    render(<CommunicatePersonalize draftId="gd1" />);
    expect(screen.getByText('Opening the draft…')).toBeInTheDocument();
  });

  it('deletes an unsent draft after a confirm', async () => {
    const user = setup();
    stored(MIGRATED);
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(deleteGeneratedDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteGeneratedDraft).toHaveBeenCalledWith('gd1'));
    expect(await screen.findByText('Draft deleted.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/edit before approving/i)).toBeNull();
  });

  it('keeps the draft and says why when the delete is refused', async () => {
    const user = setup();
    deleteGeneratedDraft.mockImplementation(() => Promise.reject(new Error('Admin claim required.')));
    stored(MIGRATED);
    render(<CommunicatePersonalize draftId="gd1" />);
    await screen.findByLabelText(/edit before approving/i);
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Admin claim required.')).toBeInTheDocument();
    expect(screen.queryByText('Draft deleted.')).toBeNull();
  });
});
/**
 * #2061: an approved Push draft for one household is sent through
 * sendHouseholdPush, and the result says what reached the household. Before
 * this the screen said "Nothing was sent, this message type delivers
 * elsewhere" and offered nothing to send it with.
 */
describe('a Push draft (#2061)', () => {
  function pushSetup() {
    const user = setup();
    sendHouseholdPush.mockReset();
    // The real approve runs the deliver step after its write; the stub does the same.
    approveGeneratedDraft.mockImplementation(async (a: { deliver?: () => Promise<string | null> }) => {
      const providerId = a.deliver ? await a.deliver() : null;
      return { ok: true, auditWarning: null, providerId, delivered: a.deliver !== undefined };
    });
    return user;
  }
  async function pushDraftReady(user: ReturnType<typeof userEvent.setup>) {
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'push', generated_copy: 'Nova says hi from the park.' }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'Push' }));
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);
  }
  it('offers Approve and send, confirms, and pushes the edited line to the household', async () => {
    const user = pushSetup();
    sendHouseholdPush.mockResolvedValue({ outcome: 'sent', reason: null });
    await pushDraftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    expect(await screen.findByText(/Push, to their phone and their notifications list/)).toBeInTheDocument();
    expect(sendHouseholdPush).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(sendHouseholdPush).toHaveBeenCalledTimes(1));
    expect(sendHouseholdPush).toHaveBeenCalledWith({ kinfolkId: 'kf1', draftId: 'd1', body: 'Nova says hi from the park.' });
    expect(await screen.findByText("Sent to Dana Halbrook's phone. It is on their notifications list too.")).toBeInTheDocument();
    expect(screen.queryByText(/delivers elsewhere/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
  });
  it('says plainly when the send gate held it, and sends it once household notices are on', async () => {
    const user = pushSetup();
    sendHouseholdPush
      .mockResolvedValueOnce({ outcome: 'held', reason: 'household_notices_off' })
      .mockResolvedValueOnce({ outcome: 'sent', reason: null });
    await pushDraftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Not sent')).toBeInTheDocument();
    expect(screen.getByText(/Notices to households are switched off\. Switch on "Send notices to households" in Settings/)).toBeInTheDocument();
    expect(screen.queryByText(/Sent to Dana Halbrook's phone/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sendHouseholdPush).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Sent to Dana Halbrook's phone. It is on their notifications list too.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
  it('says it is on their list and no push went out when their settings keep push off', async () => {
    const user = pushSetup();
    sendHouseholdPush.mockResolvedValue({ outcome: 'listed', reason: 'household_push_off' });
    await pushDraftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/No push went to their phone, because their settings keep pushes for your messages off\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
  it('names a household nobody has signed in to, and never claims a send', async () => {
    const user = pushSetup();
    sendHouseholdPush.mockResolvedValue({ outcome: 'held', reason: 'household_has_no_portal_account' });
    await pushDraftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/Nobody in the household has signed in to the portal yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Approved and sent/)).toBeNull();
  });
  it('reports a failed send call and leaves the send button live', async () => {
    const user = setup();
    sendHouseholdPush.mockReset();
    approveGeneratedDraft.mockRejectedValue(new Error('The draft is approved, but the send failed: unavailable'));
    await pushDraftReady(user);
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText(/the send failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
  });
  it('a General note still sends nothing, and says so without "delivers elsewhere"', async () => {
    const user = setup();
    generateDraft.mockResolvedValue(draftResult({ communication_type: 'general' }));
    render(<CommunicatePersonalize />);
    await user.click(screen.getByRole('radio', { name: 'General' }));
    await pickRecipient(user, 'Halbrook', 'Dana Halbrook');
    await generate(user);
    await screen.findByLabelText(/edit before approving/i);
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));
    expect(await screen.findByText(/Nothing was sent: Social, Blog and General drafts are not sent from here/)).toBeInTheDocument();
    expect(sendHouseholdPush).not.toHaveBeenCalled();
  });
});
