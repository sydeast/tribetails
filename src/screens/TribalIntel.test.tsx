// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type TribalIntelEntry } from '../api/tribalIntel';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { TribalIntel } from './TribalIntel';

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
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<TribalIntelEntry[]>);
});

describe('TribalIntel screen', () => {
  it('renders a streamed row with its title, comm.-type chip, and content', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<TribalIntel />);
    // Scope by the row container, not the button: the row is only a <button>
    // once a detail route wires onSelect; here (unwired) it renders static.
    const row = screen.getByText('Feeding schedule').closest('.tribal-intel__row') as HTMLElement;
    expect(within(row).getByText('Feeding schedule')).toBeInTheDocument();
    expect(within(row).getByText('note')).toBeInTheDocument();
    expect(
      within(row).getByText('Twice daily, half cup each. Watch for the vet-flagged allergy.'),
    ).toBeInTheDocument();
  });

  it('shows an honest "Untitled Document" fallback for a blank title, never a blank row', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ title: '' })] });
    render(<TribalIntel />);
    expect(screen.getByText('Untitled Document')).toBeInTheDocument();
  });

  it('shows the LOCAL uploaded time, not the raw UTC ISO string (AO-18)', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
    // instant.
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ uploadedAt: '2026-07-17T01:00:00.000Z' })],
    });
    render(<TribalIntel />);
    expect(screen.getByText('07-16 20:00')).toBeInTheDocument();
    expect(screen.queryByText('2026-07-17T01:00:00.000Z')).toBeNull();
  });

  it('falls back to "Date TBD" when uploadedAt is blank, never a fabricated time', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ uploadedAt: '' })] });
    render(<TribalIntel />);
    expect(screen.getByText('Date TBD')).toBeInTheDocument();
  });

  it.each([
    ['pending', 'PENDING'],
    ['applied', 'APPLIED'],
    ['skipped', 'SKIPPED'],
    ['error', 'ERROR'],
  ])('renders the %s reconcile status positively as its own chip', (status, chip) => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ reconcileStatus: status })] });
    render(<TribalIntel />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized reconcileStatus renders UNKNOWN, never a fabricated PENDING', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ reconcileStatus: 'some_new_code' })] });
    render(<TribalIntel />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).toBeNull();
  });

  it('shows no reconcile chip at all for a pre-spec-23 doc with a blank reconcileStatus', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ reconcileStatus: '' })] });
    render(<TribalIntel />);
    expect(screen.queryByText('NONE')).toBeNull();
    expect(screen.queryByText('PENDING')).toBeNull();
  });

  it('shows a "Related to" line only when kinfolkRef is set', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ kinfolkRef: 'The Whitfields' })] });
    render(<TribalIntel />);
    expect(screen.getByText('Related to: The Whitfields')).toBeInTheDocument();
  });

  it('omits the "Related to" line entirely when kinfolkRef is blank', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ kinfolkRef: '' })] });
    render(<TribalIntel />);
    expect(screen.queryByText(/related to/i)).toBeNull();
  });

  it('shows an attachment pip only when the doc has attachments', () => {
    useCollection.mockReturnValue({
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
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ attachments: [] })] });
    render(<TribalIntel />);
    expect(screen.queryByText(/attachments?/)).toBeNull();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<TribalIntel />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/no tribal intel yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<TribalIntel />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<TribalIntel />);
    expect(screen.getByText(/no tribal intel yet/i)).toBeInTheDocument();
  });

  it('the search box narrows the visible rows by title, content, or comm. type', async () => {
    useCollection.mockReturnValue({
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
    useCollection.mockReturnValue({
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
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ title: 'Feeding schedule', communicationType: 'note' })],
    });
    render(<TribalIntel />);
    await user.type(screen.getByLabelText(/search tribal intel/i), 'nonexistent-xyz');
    expect(screen.getByText(/no documents match/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tribal intel yet/i)).toBeNull();
  });

  it('re-selecting an already-active comm.-type tab clears it back to "All" (a single-select toggle)', async () => {
    useCollection.mockReturnValue({
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
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ communicationType: '' })] });
    render(<TribalIntel />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('clicking a row calls onSelect with the document id', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'doc-42', title: 'Feeding schedule' })] });
    const onSelect = vi.fn();
    render(<TribalIntel onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Feeding schedule/i }));
    expect(onSelect).toHaveBeenCalledWith('doc-42');
  });

  it('omitting onSelect renders each row STATIC (not a live no-op button)', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<TribalIntel />);
    // The row content renders, but it is NOT an interactive button when
    // unwired: a live button that no-ops on click is the dead-control
    // anti-pattern.
    expect(screen.getByText('Feeding schedule')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Feeding schedule/i })).toBeNull();
  });

  it('the stat strip counts total docs, distinct comm. types, and docs with content positively (never by negation)', () => {
    useCollection.mockReturnValue({
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
});
