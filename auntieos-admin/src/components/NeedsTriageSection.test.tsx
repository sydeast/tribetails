// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import type { Async } from '../lib/async';
import type { Kinfolk } from '../api/directory';
import type { KinTaleEntry } from '../api/kinTales';
import type { OrphanReportEntry } from '../api/kinTaleTriage';

const {
  listOrphanReports,
  assignKinfolkToOrphanReport,
  markOrphanReportAsDuplicate,
  archiveOrphanReportAsBadData,
} = vi.hoisted(() => ({
  listOrphanReports: vi.fn(),
  assignKinfolkToOrphanReport: vi.fn(),
  markOrphanReportAsDuplicate: vi.fn(),
  archiveOrphanReportAsBadData: vi.fn(),
}));
vi.mock('../api/kinTaleTriage', () => ({
  listOrphanReports,
  assignKinfolkToOrphanReport,
  markOrphanReportAsDuplicate,
  archiveOrphanReportAsBadData,
}));

import { NeedsTriageSection } from './NeedsTriageSection';

/** `useToast()` throws outside a provider; render the real one, mirroring KinTales.test.tsx / HouseholdData.test.tsx. */
function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

function orphan(over: Partial<OrphanReportEntry> = {}): OrphanReportEntry {
  return {
    _id: 'legacy_79',
    bodyCopy: 'Fed and walked, all calm today.',
    sentVia: 'legacy_visit_logs',
    createdAt: '2026-05-17T10:00:00.000Z',
    ...over,
  };
}

function kf(over: Partial<Kinfolk> = {}): Kinfolk {
  return { _id: 'kf1', firstName: 'Loretta', lastName: 'Wall', status: 'active', ...over };
}

function tale(over: Partial<KinTaleEntry> = {}): KinTaleEntry {
  return {
    _id: 'tale1',
    kinfolkName: 'The Whitfields',
    title: '',
    bodyCopy: 'A lovely Tuesday walk.',
    ...over,
  };
}

const readyKinfolk = (data: Kinfolk[]): Async<Kinfolk[]> => ({ status: 'ready', data });

const user = userEvent.setup();

beforeEach(() => {
  listOrphanReports.mockReset();
  assignKinfolkToOrphanReport.mockReset();
  markOrphanReportAsDuplicate.mockReset();
  archiveOrphanReportAsBadData.mockReset();
});

describe('NeedsTriageSection: loading, empty, error', () => {
  it('renders nothing while the load is in flight', () => {
    listOrphanReports.mockReturnValue(new Promise(() => {})); // never resolves
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    expect(screen.queryByText('Needs triage')).toBeNull();
  });

  it('renders nothing once proven empty: no orphans is not an error', async () => {
    listOrphanReports.mockResolvedValue([]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    await waitFor(() => expect(listOrphanReports).toHaveBeenCalled());
    expect(screen.queryByText('Needs triage')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces a failed load fail-loud, with a named retry', async () => {
    listOrphanReports.mockRejectedValueOnce(new Error('permission-denied'));
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    expect(await screen.findByText(/Couldn.t load orphaned KinTales/i)).toBeInTheDocument();
    expect(screen.getByText(/permission-denied/)).toBeInTheDocument();

    listOrphanReports.mockResolvedValueOnce([orphan()]);
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('legacy_79')).toBeInTheDocument();
    expect(listOrphanReports).toHaveBeenCalledTimes(2);
  });
});

describe('NeedsTriageSection: the row', () => {
  it('shows the id, a friendly channel label, and the body preview, with all three actions', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    expect(await screen.findByText('legacy_79')).toBeInTheDocument();
    expect(screen.getByText('imported')).toBeInTheDocument(); // legacy_visit_logs collapses, never leaks raw
    expect(screen.getByText('Fed and walked, all calm today.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark duplicate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('names the count in the banner pill, singular and plural', async () => {
    listOrphanReports.mockResolvedValue([orphan({ _id: 'a' }), orphan({ _id: 'b' })]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    // Banner.tsx uppercases every pillLabel, so "2 orphans" renders "2 ORPHANS".
    expect(await screen.findByText('2 ORPHANS')).toBeInTheDocument();
  });
});

describe('NeedsTriageSection: Assign', () => {
  it('assigns the orphan to the chosen kinfolk, confirms, and removes the row', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    assignKinfolkToOrphanReport.mockResolvedValue({ ok: true, action: 'ASSIGN', reportId: 'legacy_79' });
    render(
      <NeedsTriageSection kinfolk={readyKinfolk([kf({ _id: 'kf1', firstName: 'Loretta', lastName: 'Wall' })])} candidateReports={[]} />,
    );
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    const dialog = screen.getByRole('dialog', { name: 'Assign kinfolk to legacy_79' });
    await user.click(within(dialog).getByRole('button', { name: 'Loretta Wall' }));
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));

    expect(assignKinfolkToOrphanReport).toHaveBeenCalledWith('legacy_79', 'kf1', 'Loretta Wall');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The row is gone (triaged) and the whole section quietly disappears (empty again).
    expect(screen.queryByText('legacy_79')).toBeNull();
    expect(await screen.findByText(/Assigned legacy_79 to Loretta Wall/)).toBeInTheDocument();
  });

  it('excludes an archived kinfolk from the search results', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(
      <NeedsTriageSection
        kinfolk={readyKinfolk([kf({ _id: 'kf-arch', firstName: 'Old', lastName: 'Record', status: 'archived' })])}
        candidateReports={[]}
      />,
    );
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    expect(screen.queryByRole('button', { name: 'Old Record' })).toBeNull();
    expect(screen.getByText('No matching kinfolk.')).toBeInTheDocument();
  });

  it('names an unavailable kinfolk directory instead of silently offering an empty list', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(
      <NeedsTriageSection kinfolk={{ status: 'error', message: 'deadline-exceeded' }} candidateReports={[]} />,
    );
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    expect(screen.getByText(/Kinfolk directory unavailable/)).toBeInTheDocument();
    expect(screen.getByText('deadline-exceeded')).toBeInTheDocument();
  });

  it('keeps the Assign button disabled until a kinfolk is picked', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([kf()])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Assign' })).toBeDisabled();
  });

  it('surfaces a failed assign and keeps the row for another try', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    assignKinfolkToOrphanReport.mockRejectedValueOnce(
      new Error('kinfolk/kf1 not found or has no displayable name'),
    );
    render(<NeedsTriageSection kinfolk={readyKinfolk([kf()])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Loretta Wall' }));
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));

    expect(await screen.findByText(/kinfolk\/kf1 not found/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Nothing was removed: the orphan is still there once the dialog is closed.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('legacy_79')).toBeInTheDocument();
  });

  it('cancels without calling the write', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([kf()])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(assignKinfolkToOrphanReport).not.toHaveBeenCalled();
  });
});

describe('NeedsTriageSection: Mark duplicate', () => {
  it('marks the orphan as a duplicate of the chosen report and removes the row', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    markOrphanReportAsDuplicate.mockResolvedValue({ ok: true, action: 'DUPLICATE', reportId: 'legacy_79' });
    render(
      <NeedsTriageSection
        kinfolk={readyKinfolk([])}
        candidateReports={[tale({ _id: 'tale1', kinfolkName: 'The Whitfields' })]}
      />,
    );
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Mark duplicate' }));

    const dialog = screen.getByRole('dialog', { name: 'Mark legacy_79 as duplicate' });
    await user.click(within(dialog).getByText(/tale1 - The Whitfields/));
    await user.click(within(dialog).getByRole('button', { name: 'Mark duplicate' }));

    expect(markOrphanReportAsDuplicate).toHaveBeenCalledWith('legacy_79', 'tale1');
    expect(await screen.findByText(/Marked legacy_79 as a duplicate of tale1/)).toBeInTheDocument();
    expect(screen.queryByText('legacy_79')).toBeNull();
  });

  it('says so when there are no candidates to search, rather than an empty list', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Mark duplicate' }));
    expect(screen.getByText('No matching reports.')).toBeInTheDocument();
  });

  it('never offers another orphan as a duplicate candidate', async () => {
    listOrphanReports.mockResolvedValue([orphan({ _id: 'legacy_79' }), orphan({ _id: 'legacy_80' })]);
    render(
      <NeedsTriageSection
        kinfolk={readyKinfolk([])}
        // Simulates the parent accidentally including an orphan in the loaded
        // window; the section itself must still filter it out.
        candidateReports={[tale({ _id: 'legacy_80', kinfolkName: 'Should not appear' })]}
      />,
    );
    await screen.findByText('legacy_79');
    const rows = screen.getAllByRole('button', { name: 'Mark duplicate' });
    await user.click(rows[0]!);
    expect(screen.queryByText(/Should not appear/)).toBeNull();
    expect(screen.getByText('No matching reports.')).toBeInTheDocument();
  });

  it('surfaces a failed mark-duplicate write', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    markOrphanReportAsDuplicate.mockRejectedValueOnce(new Error('Canonical report not found'));
    render(
      <NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[tale({ _id: 'tale1' })]} />,
    );
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Mark duplicate' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText(/tale1/));
    await user.click(within(dialog).getByRole('button', { name: 'Mark duplicate' }));
    expect(await screen.findByText(/Canonical report not found/)).toBeInTheDocument();
  });
});

describe('NeedsTriageSection: Archive', () => {
  it('archives with a reason of at least 5 characters and removes the row', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    archiveOrphanReportAsBadData.mockResolvedValue({ ok: true, action: 'ARCHIVE', reportId: 'legacy_79' });
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = screen.getByRole('dialog', { name: 'Archive legacy_79 as bad data' });
    await user.type(within(dialog).getByLabelText(/Archive reason/), 'test data from the May migration');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));

    expect(archiveOrphanReportAsBadData).toHaveBeenCalledWith(
      'legacy_79',
      'test data from the May migration',
    );
    expect(await screen.findByText(/Archived legacy_79/)).toBeInTheDocument();
    expect(screen.queryByText('legacy_79')).toBeNull();
  });

  it('blocks a reason shorter than 5 characters, and says so', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Archive reason/), 'bad');
    expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Reason must be at least 5 characters.');
    expect(archiveOrphanReportAsBadData).not.toHaveBeenCalled();
  });

  it('surfaces a failed archive and keeps the row', async () => {
    listOrphanReports.mockResolvedValue([orphan()]);
    archiveOrphanReportAsBadData.mockRejectedValueOnce(new Error('permission-denied'));
    render(<NeedsTriageSection kinfolk={readyKinfolk([])} candidateReports={[]} />);
    await screen.findByText('legacy_79');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Archive reason/), 'known test data row');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/permission-denied/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('legacy_79')).toBeInTheDocument();
  });
});
