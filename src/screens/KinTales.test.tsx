// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type KinTaleEntry } from '../api/kinTales';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { KinTales } from './KinTales';

function entry(over: Partial<KinTaleEntry>): KinTaleEntry {
  return {
    _id: 'tale1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    authorDisplayName: 'Auntie Jo',
    kinIds: [],
    serviceType: 'Dog Walk',
    visitDate: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    title: '',
    bodyCopy: 'Biscuit had a wonderful time at the park today.',
    mediaFileIds: [],
    status: 'DRAFT',
    sentAt: '',
    sentVia: '',
    createdAt: '2026-07-16T13:00:00.000Z',
    ...over,
  };
}

// TZ pinned to a west-of-UTC zone so the AO-18 assertions below are
// meaningful on any CI runner (identical rationale as Sessions.test.tsx /
// lib/kinTaleFormat.test.ts). Restored afterAll for any sibling test file
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
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<KinTaleEntry[]>);
});

describe('KinTales screen', () => {
  it('renders a streamed row with its household, headline, service, timestamp, and status chip', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<KinTales />);
    // Scope by the row container, not the button, the row is only a
    // <button> once a detail route wires onSelect; here (unwired) it renders
    // static.
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    expect(within(row).getByText('Dog Walk')).toBeInTheDocument();
    expect(within(row).getByText('Biscuit had a wonderful time at the park today.')).toBeInTheDocument();
    expect(within(row).getByText('DRAFT')).toBeInTheDocument();
  });

  it('prefers a non-blank title over the body preview as the row headline', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ title: 'A great day at the park' })],
    });
    render(<KinTales />);
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('A great day at the park')).toBeInTheDocument();
    expect(within(row).queryByText('Biscuit had a wonderful time at the park today.')).toBeNull();
  });

  it('shows an honest "(empty body)" headline for a blank title and blank body, never a blank row', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ title: '', bodyCopy: '' })] });
    render(<KinTales />);
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('(empty body)')).toBeInTheDocument();
  });

  it('shows the LOCAL clock time in the row, not the UTC hour (AO-18)', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
    // instant.
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ visitDate: '2026-07-17T01:00:00.000Z' })],
    });
    render(<KinTales />);
    expect(screen.getByText('07-16 20:00')).toBeInTheDocument();
  });

  it('falls back to "Date TBD" when every timestamp field is blank, never a fabricated time', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ visitDate: '', arrivedAt: '', sentAt: '', createdAt: '' })],
    });
    render(<KinTales />);
    expect(screen.getByText('Date TBD')).toBeInTheDocument();
  });

  it.each([
    ['DRAFT', 'DRAFT'],
    ['SENT', 'SENT'],
    ['FAILED', 'FAILED'],
  ])('renders the %s status positively as its own chip', (status, chip) => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status })] });
    render(<KinTales />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated DRAFT', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'some_new_code' })] });
    render(<KinTales />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('DRAFT')).toBeNull();
  });

  it('shows a media pip only when the report has attached media', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ mediaFileIds: ['m1', 'm2'] })],
    });
    render(<KinTales />);
    expect(screen.getByText('2 photos')).toBeInTheDocument();
  });

  it('omits the media pip entirely when there is no attached media (never "0 photos")', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ mediaFileIds: [] })] });
    render(<KinTales />);
    expect(screen.queryByText(/photos?/)).toBeNull();
  });

  it('shows the send channel only for a report that actually carries one', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: 'SENT', sentVia: 'email', sentAt: '2026-07-16T14:00:00.000Z' })],
    });
    render(<KinTales />);
    expect(screen.getByText('email')).toBeInTheDocument();
  });

  it('a blank sentVia (a draft) never shows the misleading "imported" pip', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ sentVia: '' })] });
    render(<KinTales />);
    expect(screen.queryByText('imported')).toBeNull();
  });

  it('collapses a legacy backfill marker to "imported" rather than leaking the raw collection name', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: 'SENT', sentVia: 'legacy_visit_logs' })],
    });
    render(<KinTales />);
    expect(screen.getByText('imported')).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<KinTales />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/no kintales sent yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<KinTales />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<KinTales />);
    expect(screen.getByText(/no kintales sent yet/i)).toBeInTheDocument();
  });

  it('filter tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'SENT' }),
        entry({ _id: 'b', kinfolkName: 'Household B', status: 'DRAFT' }),
      ],
    });
    render(<KinTales />);
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.getByText('Household B')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Sent' }));
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.queryByText('Household B')).toBeNull();
  });

  it('shows a "nothing matches" hint (not the top-level empty state) when a filter excludes every row', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'DRAFT' })] });
    render(<KinTales />);
    await user.click(screen.getByRole('tab', { name: 'Failed' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/no kintales sent yet/i)).toBeNull();
  });

  it('clicking a row calls onSelect with the KinTale id', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'tale-42' })] });
    const onSelect = vi.fn();
    render(<KinTales onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelect).toHaveBeenCalledWith('tale-42');
  });

  it('omitting onSelect renders each row STATIC (not a live no-op button)', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<KinTales />);
    // The row content renders, but it is NOT an interactive button when
    // unwired, a live button that no-ops on click is the dead-control
    // anti-pattern.
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /The Whitfields/i })).toBeNull();
  });

  it('the stat strip counts Sent, Draft, and Failed positively (never by negation)', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'SENT' }),
        entry({ _id: 'b', status: 'SENT' }),
        entry({ _id: 'c', status: 'DRAFT' }),
        entry({ _id: 'd', status: 'FAILED' }),
      ],
    });
    render(<KinTales />);
    // Scoped to the stat-card label specifically: "Sent"/"Drafts" also name a
    // filter tab, and an unscoped getByText would be an ambiguous match.
    const sentCard = screen
      .getByText('Sent', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    const draftCard = screen
      .getByText('Drafts', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    const failedCard = screen
      .getByText('Needs another look', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    expect(within(sentCard as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(draftCard as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(within(failedCard as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});
