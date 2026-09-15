// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TemplateImportReport } from '../api/templateImport';

const { importSeedTemplates, planSeedTemplateImport } = vi.hoisted(() => ({
  importSeedTemplates: vi.fn(),
  planSeedTemplateImport: vi.fn(),
}));
// The pure report helpers are NOT mocked: `importPlanHeadline`,
// `importRowSummary` and `plannedWriteCount` are the sentences an operator
// actually reads, so the tests exercise the real ones rather than stubs that
// agree with the test's own expectations.
vi.mock('../api/templateImport', async () => {
  const actual = await vi.importActual<typeof import('../api/templateImport')>(
    '../api/templateImport',
  );
  return { ...actual, importSeedTemplates, planSeedTemplateImport };
});

import { TemplateImport } from './TemplateImport';

function channel(channelName: 'email' | 'sms' | 'push', outcome: string, notes: string[] = []) {
  return { channel: channelName, outcome, notes } as never;
}

function report(over: Partial<TemplateImportReport> = {}): TemplateImportReport {
  return {
    dryRun: true,
    written: 0,
    counts: { create: 3, overwrite: 0, skipped: 0, unchanged: 0, blocked: 0 },
    rows: [
      {
        templateId: 'kincare.reschedule.requested',
        aliasOf: null,
        channels: [channel('email', 'create'), channel('sms', 'create'), channel('push', 'create')],
        differsFromRepo: false,
        blocked: false,
      },
    ],
    needsOverwriteChoice: [],
    refused: [],
    ...over,
  };
}

beforeEach(() => {
  importSeedTemplates.mockReset();
  planSeedTemplateImport.mockReset();
});

describe('TemplateImport: the plan is shown before anything is written', () => {
  it('runs a dry run on open and writes nothing', async () => {
    planSeedTemplateImport.mockResolvedValue(report());
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    await waitFor(() => expect(planSeedTemplateImport).toHaveBeenCalledTimes(1));
    expect(importSeedTemplates).not.toHaveBeenCalled();
    expect(await screen.findByTestId('import-headline')).toHaveTextContent(
      '3 to create. Importing writes 3 documents.',
    );
  });

  it('names each template and each channel outcome', async () => {
    planSeedTemplateImport.mockResolvedValue(report());
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByText('kincare.reschedule.requested')).toBeInTheDocument();
    expect(screen.getByTestId('summary-kincare.reschedule.requested')).toHaveTextContent('New');
    expect(screen.getAllByText('create')).toHaveLength(3);
  });

  it('surfaces a plan failure instead of showing an empty list as if it were fine', async () => {
    planSeedTemplateImport.mockImplementationOnce(() => Promise.reject(new Error('permission-denied')));
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByText(/Could not read the import plan: permission-denied/)).toBeInTheDocument();
  });
});

describe('TemplateImport: overwriting is a per-template choice', () => {
  const differing = report({
    counts: { create: 2, overwrite: 0, skipped: 1, unchanged: 0, blocked: 0 },
    rows: [
      {
        templateId: 'kincare.reschedule.requested',
        aliasOf: null,
        channels: [
          channel('email', 'skipped', ['The stored email copy differs from the repo copy.']),
          channel('sms', 'create'),
          channel('push', 'create'),
        ],
        differsFromRepo: true,
        blocked: false,
      },
    ],
    needsOverwriteChoice: ['kincare.reschedule.requested'],
  });

  it('warns that stored copies differ, and offers the tick only on those rows', async () => {
    planSeedTemplateImport.mockResolvedValue(differing);
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByText(/Some stored templates differ from the repo/)).toBeInTheDocument();
    expect(
      screen.getByLabelText('Replace the stored copy of kincare.reschedule.requested'),
    ).toBeInTheDocument();
  });

  it('imports without overwriteIds when nothing is ticked', async () => {
    planSeedTemplateImport.mockResolvedValue(differing);
    importSeedTemplates.mockResolvedValue({ ...differing, dryRun: false, written: 2 });
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: /Import 2 documents/ }));

    expect(importSeedTemplates).toHaveBeenCalledWith({ dryRun: false });
  });

  it('sends the ticked id in overwriteIds', async () => {
    planSeedTemplateImport.mockResolvedValue(differing);
    importSeedTemplates.mockResolvedValue({ ...differing, dryRun: false, written: 3 });
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    await userEvent.click(
      await screen.findByLabelText('Replace the stored copy of kincare.reschedule.requested'),
    );
    await userEvent.click(screen.getByRole('button', { name: /Import 2 documents/ }));

    expect(importSeedTemplates).toHaveBeenCalledWith({
      dryRun: false,
      overwriteIds: ['kincare.reschedule.requested'],
    });
  });

  it('offers no tick on a row that already matches the repo', async () => {
    planSeedTemplateImport.mockResolvedValue(
      report({
        counts: { create: 0, overwrite: 0, skipped: 0, unchanged: 3, blocked: 0 },
        rows: [
          {
            templateId: 'invoice.new',
            aliasOf: null,
            channels: [
              channel('email', 'unchanged'),
              channel('sms', 'unchanged'),
              channel('push', 'unchanged'),
            ],
            differsFromRepo: false,
            blocked: false,
          },
        ],
      }),
    );
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByTestId('summary-invoice.new')).toHaveTextContent(
      'Already matches the repo',
    );
    expect(screen.queryByLabelText(/Replace the stored copy/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import 0 documents/ })).toBeDisabled();
  });
});

describe('TemplateImport: refusals', () => {
  it('lists a refused template with the reason, and blocks its channels', async () => {
    planSeedTemplateImport.mockResolvedValue(
      report({
        counts: { create: 0, overwrite: 0, skipped: 0, unchanged: 0, blocked: 3 },
        rows: [
          {
            templateId: 'kincare.booking.confirm',
            aliasOf: null,
            channels: [
              channel('email', 'blocked', [
                'html uses the Handlebars triple stash {{{...}}}, which sends a merge value as raw HTML.',
              ]),
              channel('sms', 'blocked', ['Held back because another channel of this template was refused.']),
              channel('push', 'blocked', ['Held back because another channel of this template was refused.']),
            ],
            differsFromRepo: false,
            blocked: true,
          },
        ],
        refused: [
          {
            templateId: 'kincare.booking.confirm',
            reason: 'email: html uses the Handlebars triple stash {{{...}}}.',
          },
        ],
      }),
    );
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByText(/Refused, and not importable as written/)).toBeInTheDocument();
    expect(screen.getAllByText(/triple stash/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('summary-kincare.booking.confirm')).toHaveTextContent('Refused');
  });

  it('shows why a template was refused on its own row, next to Refused (#892 review 2)', async () => {
    const reason = 'email: html puts a merge field straight into an attribute without quotes, like href={{link}}.';
    planSeedTemplateImport.mockResolvedValue(
      report({
        counts: { create: 0, overwrite: 0, skipped: 0, unchanged: 0, blocked: 3 },
        rows: [
          {
            templateId: 'assignment.assigned',
            aliasOf: null,
            channels: [channel('email', 'blocked'), channel('sms', 'blocked'), channel('push', 'blocked')],
            differsFromRepo: false,
            blocked: true,
            issues: [reason],
          },
        ],
        refused: [],
      }),
    );
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByTestId('summary-assignment.assigned')).toHaveTextContent('Refused');
    expect(screen.getByTestId('issues-assignment.assigned')).toHaveTextContent(reason);
  });

  it('shows no reason line on a row that was not refused', async () => {
    planSeedTemplateImport.mockResolvedValue(report());
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);
    await screen.findByTestId('summary-kincare.reschedule.requested');
    expect(screen.queryByTestId('issues-kincare.reschedule.requested')).not.toBeInTheDocument();
  });

  it('says nothing was written when the import call itself fails', async () => {
    planSeedTemplateImport.mockResolvedValue(report());
    importSeedTemplates.mockImplementationOnce(() => Promise.reject(new Error('deadline-exceeded')));
    render(<TemplateImport onClose={vi.fn()} onImported={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: /Import 3 documents/ }));

    expect(
      await screen.findByText(/The import did not run: deadline-exceeded\. Nothing was written\./),
    ).toBeInTheDocument();
  });
});

describe('TemplateImport: after a successful run', () => {
  it('reports the count and tells the Bank what happened', async () => {
    const onImported = vi.fn();
    planSeedTemplateImport.mockResolvedValue(report());
    importSeedTemplates.mockResolvedValue({
      ...report(),
      dryRun: false,
      written: 3,
      counts: { create: 0, overwrite: 0, skipped: 0, unchanged: 3, blocked: 0 },
      rows: [
        {
          templateId: 'kincare.reschedule.requested',
          aliasOf: null,
          channels: [
            channel('email', 'unchanged'),
            channel('sms', 'unchanged'),
            channel('push', 'unchanged'),
          ],
          differsFromRepo: false,
          blocked: false,
        },
      ],
    });
    render(<TemplateImport onClose={vi.fn()} onImported={onImported} />);

    await userEvent.click(await screen.findByRole('button', { name: /Import 3 documents/ }));

    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith('Imported 3 template documents from the repo.'),
    );
    expect(await screen.findByText('Wrote 3 documents.')).toBeInTheDocument();
  });
});
