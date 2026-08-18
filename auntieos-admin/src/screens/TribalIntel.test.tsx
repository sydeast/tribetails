// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type TribalIntelEntry } from '../api/tribalIntel';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { createTrainingDocument, updateTrainingDocument, deleteTrainingDocument, uploadTribalIntelAttachment } =
  vi.hoisted(() => ({
    createTrainingDocument: vi.fn(),
    updateTrainingDocument: vi.fn(),
    deleteTrainingDocument: vi.fn(),
    uploadTribalIntelAttachment: vi.fn(),
  }));
vi.mock('../api/tribalIntelWrite', () => ({
  createTrainingDocument,
  updateTrainingDocument,
  deleteTrainingDocument,
  uploadTribalIntelAttachment,
}));

import { TribalIntel } from './TribalIntel';

/** Roster rows the target picker streams alongside the Tribal Intel list. */
const ROSTER: Record<string, unknown[]> = {
  kinfolk: [{ _id: 'kf1', firstName: 'Marla', lastName: 'Whitfield' }],
  kin: [{ _id: 'kin1', kinfolkId: 'kf1', name: 'Biscuit', status: 'active' }],
};

/**
 * The screen streams three collections now (training_documents plus the
 * kinfolk/kin rosters the target picker needs), so the mock answers per
 * spec.path. A single mockReturnValue would hand the picker a list of Tribal
 * Intel rows.
 */
function mockTribalIntel(state: unknown) {
  useCollection.mockImplementation((spec: { path: string }) =>
    spec.path === 'training_documents' ? state : { status: 'ready', data: ROSTER[spec.path] ?? [] },
  );
}

function entry(over: Partial<TribalIntelEntry>): TribalIntelEntry {
  return {
    _id: 'doc1',
    title: 'Feeding schedule',
    content: 'Twice daily, half cup each. Watch for the vet-flagged allergy.',
    notes: '',
    communicationType: 'note',
    kinfolkRef: 'The Whitfields',
    targetType: 'KINFOLK',
    targetKinfolkId: 'kf1',
    targetKinId: '',
    attachments: [],
    reconcileStatus: 'pending',
    reconcileNotes: '',
    uploadedAt: '2026-07-16T13:00:00.000Z',
    createdAt: null,
    ...over,
  };
}

// TZ pinned to a west-of-UTC zone so the AO-18 assertions below are
// meaningful on any CI runner (identical rationale as KinTales.test.tsx /
// lib/tribalIntelFormat.test.ts). Restored afterAll for any sibling test file
// sharing this worker.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const user = userEvent.setup();

beforeEach(() => {
  useCollection.mockReset();
  mockTribalIntel({ status: 'ready', data: [] } satisfies Async<TribalIntelEntry[]>);
  createTrainingDocument.mockReset().mockResolvedValue('td-new');
  updateTrainingDocument.mockReset().mockResolvedValue('td-1');
  deleteTrainingDocument.mockReset().mockResolvedValue(undefined);
  uploadTribalIntelAttachment.mockReset();
});

describe('TribalIntel screen', () => {
  it('renders a streamed row with its title, comm.-type chip, and content', () => {
    mockTribalIntel({ status: 'ready', data: [entry({})] });
    render(<TribalIntel />);
    // Scope by the row container: the row body is static text, with the
    // Edit/Delete controls as the only buttons inside it.
    const row = screen.getByText('Feeding schedule').closest('.tribal-intel__row') as HTMLElement;
    expect(within(row).getByText('Feeding schedule')).toBeInTheDocument();
    expect(within(row).getByText('note')).toBeInTheDocument();
    expect(
      within(row).getByText('Twice daily, half cup each. Watch for the vet-flagged allergy.'),
    ).toBeInTheDocument();
  });

  it('shows an honest "Untitled Document" fallback for a blank title, never a blank row', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ title: '' })] });
    render(<TribalIntel />);
    expect(screen.getByText('Untitled Document')).toBeInTheDocument();
  });

  it('shows the LOCAL uploaded time, not the raw UTC ISO string (AO-18)', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
    // instant.
    mockTribalIntel({
      status: 'ready',
      data: [entry({ uploadedAt: '2026-07-17T01:00:00.000Z' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('07-16 20:00')).toBeInTheDocument();
    expect(screen.queryByText('2026-07-17T01:00:00.000Z')).toBeNull();
  });

  it('falls back to "Date TBD" when uploadedAt is blank, never a fabricated time', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ uploadedAt: '' })] });
    render(<TribalIntel />);
    expect(screen.getByText('Date TBD')).toBeInTheDocument();
  });

  it.each([
    ['pending', 'PENDING'],
    ['applied', 'APPLIED'],
    ['skipped', 'SKIPPED'],
    ['error', 'ERROR'],
  ])('renders the %s reconcile status positively as its own chip', (status, chip) => {
    mockTribalIntel({ status: 'ready', data: [entry({ reconcileStatus: status })] });
    render(<TribalIntel />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized reconcileStatus renders UNKNOWN, never a fabricated PENDING', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ reconcileStatus: 'some_new_code' })] });
    render(<TribalIntel />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).toBeNull();
  });

  it('shows no reconcile chip at all for a pre-spec-23 doc with a blank reconcileStatus', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ reconcileStatus: '' })] });
    render(<TribalIntel />);
    expect(screen.queryByText('NONE')).toBeNull();
    expect(screen.queryByText('PENDING')).toBeNull();
  });

  // ── who the row says it is about (issue #393) ───────────────────────────

  it('names a kinfolk-targeted row after the kinfolk, never after the household', () => {
    // The reported defect: this row read "Related to: demo-family-002" with
    // household wording, on an entry that is about one kinfolk.
    mockTribalIntel({
      status: 'ready',
      data: [entry({ targetType: 'KINFOLK', targetKinfolkId: 'kf1' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Kinfolk: Marla Whitfield')).toBeInTheDocument();
    expect(screen.queryByText(/^Household:/)).toBeNull();
  });

  it('names a household-targeted row after the household', () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Household: the Whitfields')).toBeInTheDocument();
  });

  it('names a kin-targeted row after the animal', () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'kin1' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Kin: Biscuit')).toBeInTheDocument();
  });

  it('reads a legacy row with no target type as the household it is filed under', () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ targetType: '', targetKinfolkId: '', kinfolkRef: 'kf1' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Household: the Whitfields')).toBeInTheDocument();
  });

  it('shows the raw id when the roster holds no match, rather than a blank', () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ targetType: 'HOUSEHOLD', targetKinfolkId: 'demo-family-002', kinfolkRef: '' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Household: demo-family-002')).toBeInTheDocument();
  });

  it('omits the target line entirely when the row names nobody', () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ targetType: '', targetKinfolkId: '', kinfolkRef: '' })],
    });
    render(<TribalIntel />);
    expect(screen.queryByText(/^(Household|Kinfolk|Kin):/)).toBeNull();
  });

  it('shows an attachment pip only when the doc has attachments', () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({
          attachments: [
            { storageUrl: 'https://x', cloudinaryPublicId: 'a', fileType: 'image', mimeType: 'image/png', fileName: 'a.png' },
            { storageUrl: 'https://y', cloudinaryPublicId: 'b', fileType: 'image', mimeType: 'image/png', fileName: 'b.png' },
          ],
        }),
      ],
    });
    render(<TribalIntel />);
    expect(screen.getByText('2 attachments')).toBeInTheDocument();
  });

  it('omits the attachment pip entirely when there are no attachments (never "0 attachments")', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ attachments: [] })] });
    render(<TribalIntel />);
    expect(screen.queryByText(/attachments?/)).toBeNull();
  });

  it('surfaces a listener error, never a false empty', () => {
    mockTribalIntel({ status: 'error', message: 'permission-denied' });
    render(<TribalIntel />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/no tribal intel yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    mockTribalIntel({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<TribalIntel />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    mockTribalIntel({ status: 'ready', data: [] });
    render(<TribalIntel />);
    expect(screen.getByText(/no tribal intel yet/i)).toBeInTheDocument();
  });

  it('the search box narrows the visible rows by title, content, or comm. type', async () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({ _id: 'a', title: 'Feeding schedule', content: 'kibble', communicationType: 'note' }),
        entry({ _id: 'b', title: 'Walk routine', content: 'leash pulling', communicationType: 'guide' }),
      ],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Feeding schedule')).toBeInTheDocument();
    expect(screen.getByText('Walk routine')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/search tribal intel/i), 'walk');
    expect(screen.queryByText('Feeding schedule')).toBeNull();
    expect(screen.getByText('Walk routine')).toBeInTheDocument();
  });

  it('dynamic comm.-type tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({ _id: 'a', title: 'Feeding schedule', communicationType: 'note' }),
        entry({ _id: 'b', title: 'Walk routine', communicationType: 'guide' }),
      ],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Feeding schedule')).toBeInTheDocument();
    expect(screen.getByText('Walk routine')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'guide' }));
    expect(screen.queryByText('Feeding schedule')).toBeNull();
    expect(screen.getByText('Walk routine')).toBeInTheDocument();
  });

  it('shows a "no documents match" hint (not the top-level empty state) when the search excludes every row', async () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ title: 'Feeding schedule', communicationType: 'note' })],
    });
    render(<TribalIntel />);
    await user.type(screen.getByLabelText(/search tribal intel/i), 'nonexistent-xyz');
    expect(screen.getByText(/no documents match/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tribal intel yet/i)).toBeNull();
  });

  it('re-selecting an already-active comm.-type tab clears it back to "All" (a single-select toggle)', async () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({ _id: 'a', title: 'Feeding schedule', communicationType: 'note' }),
        entry({ _id: 'b', title: 'Walk routine', communicationType: 'guide' }),
      ],
    });
    render(<TribalIntel />);
    await user.click(screen.getByRole('tab', { name: 'note' }));
    expect(screen.queryByText('Walk routine')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'note' }));
    expect(screen.getByText('Feeding schedule')).toBeInTheDocument();
    expect(screen.getByText('Walk routine')).toBeInTheDocument();
  });

  it('does not render comm.-type tabs at all when every row has a blank communicationType', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ communicationType: '' })] });
    render(<TribalIntel />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('the stat strip counts total docs, distinct comm. types, and docs with content positively (never by negation)', () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({ _id: 'a', communicationType: 'note', content: 'has content' }),
        entry({ _id: 'b', communicationType: 'guide', content: 'has content too' }),
        entry({ _id: 'c', communicationType: 'note', content: '' }),
      ],
    });
    render(<TribalIntel />);
    const totalCard = screen.getByText('Total', { selector: '.den-stat-label' }).closest('.den-stat, button.den-stat--button');
    const commCard = screen
      .getByText('Comm. types', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    const contentCard = screen
      .getByText('With content', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    expect(within(totalCard as HTMLElement).getByText('3')).toBeInTheDocument();
    expect(within(commCard as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(contentCard as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  // ── junk rows ────────────────────────────────────────────────────────────
  it('drops a content-less junk row so it never surfaces as "Untitled Document"', () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({ _id: 'real', title: 'Feeding schedule' }),
        entry({ _id: 'junk', title: '', content: '', notes: '', attachments: [] }),
      ],
    });
    render(<TribalIntel />);
    expect(screen.getByText('Feeding schedule')).toBeInTheDocument();
    expect(screen.queryByText('Untitled Document')).toBeNull();
  });
  it('junk rows do not inflate the stat strip either', () => {
    mockTribalIntel({
      status: 'ready',
      data: [
        entry({ _id: 'real', title: 'Feeding schedule', content: 'kibble', communicationType: 'note' }),
        entry({ _id: 'junk', title: '', content: '', communicationType: '', attachments: [] }),
      ],
    });
    render(<TribalIntel />);
    const totalCard = screen
      .getByText('Total', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button') as HTMLElement;
    expect(within(totalCard).getByText('1')).toBeInTheDocument();
  });
  it('shows the proven-empty state when every streamed row is junk, never a list of blanks', () => {
    mockTribalIntel({ status: 'ready', data: [entry({ _id: 'junk', title: '', content: '', attachments: [] })] });
    render(<TribalIntel />);
    expect(screen.getByText(/no tribal intel yet/i)).toBeInTheDocument();
  });
  // ── create ───────────────────────────────────────────────────────────────
  it('the Add intel button opens the create form', async () => {
    render(<TribalIntel />);
    expect(screen.queryByLabelText('Intel')).toBeNull();
    await user.click(screen.getByRole('button', { name: /add intel/i }));
    expect(screen.getByLabelText('Intel')).toBeInTheDocument();
  });
  it('a successful save closes the form and confirms the fold happens on the NEXT reconcile pass', async () => {
    render(<TribalIntel />);
    await user.click(screen.getByRole('button', { name: /add intel/i }));
    await user.type(screen.getByLabelText('Intel'), 'Side gate code is now 4417.');
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(await screen.findByText(/next reconcile pass, not instantly/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Intel')).toBeNull();
  });
  // ── edit ─────────────────────────────────────────────────────────────────
  it('Edit on a row opens the form prefilled with that entry', async () => {
    mockTribalIntel({
      status: 'ready',
      data: [entry({ _id: 'td-7', title: 'Feeding schedule', targetKinfolkId: 'kf1' })],
    });
    render(<TribalIntel />);
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByLabelText('Title')).toHaveValue('Feeding schedule');
  });
  // ── delete ───────────────────────────────────────────────────────────────
  it('Delete asks first, and the confirm states that already-folded dossier and 411 text is NOT unmerged', async () => {
    mockTribalIntel({ status: 'ready', data: [entry({ _id: 'td-7' })] });
    render(<TribalIntel />);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/does not unmerge/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/dossier/i)).toBeInTheDocument();
    expect(deleteTrainingDocument).not.toHaveBeenCalled();
  });
  it('confirming the delete calls the callable with the document id', async () => {
    mockTribalIntel({ status: 'ready', data: [entry({ _id: 'td-7' })] });
    render(<TribalIntel />);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /delete entry/i }));
    expect(deleteTrainingDocument).toHaveBeenCalledWith('td-7');
  });
  it('cancelling the delete confirm writes nothing', async () => {
    mockTribalIntel({ status: 'ready', data: [entry({ _id: 'td-7' })] });
    render(<TribalIntel />);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(deleteTrainingDocument).not.toHaveBeenCalled();
  });
  it('a failed delete fails loud in a banner rather than silently leaving the row', async () => {
    deleteTrainingDocument.mockRejectedValueOnce(new Error('not-found: Tribal Intel entry not found.'));
    mockTribalIntel({ status: 'ready', data: [entry({ _id: 'td-7' })] });
    render(<TribalIntel />);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /delete entry/i }));
    expect(await screen.findByText('not-found: Tribal Intel entry not found.')).toBeInTheDocument();
    expect(screen.getByText(/could not delete/i)).toBeInTheDocument();
  });
});
