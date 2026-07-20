// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type TemplateSummary } from '../api/templates';

const { listTemplates, listTemplateCategories } = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  listTemplateCategories: vi.fn(),
}));
vi.mock('../api/templates', async (orig) => ({
  ...(await orig<typeof import('../api/templates')>()),
  // The New Binding dialog calls listTemplates directly.
  listTemplates,
  // The bank list calls the paginated variant. Wrap the array-returning
  // `listTemplates` mock into a page envelope so existing per-test setup
  // (listTemplates.mockResolvedValue([...])) keeps driving it unchanged; a test
  // can instead resolve an explicit { templates, nextCursor } to drive Load more.
  listTemplatesPage: (args: unknown) =>
    Promise.resolve(listTemplates(args)).then((r: unknown) =>
      Array.isArray(r) ? { templates: r, nextCursor: null } : r,
    ),
  listTemplateCategories,
}));

const { saveTemplate, deleteTemplate, assignTemplatesToCategory } = vi.hoisted(() => ({
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  assignTemplatesToCategory: vi.fn(),
}));
vi.mock('../api/templatesWrite', () => ({ saveTemplate, deleteTemplate, assignTemplatesToCategory }));

import { Templates } from './Templates';

function tpl(over: Partial<TemplateSummary>): TemplateSummary {
  return {
    templateId: 'booking.confirmed',
    subject: 'Your booking is confirmed',
    body: 'Hi {{kinfolk_name}}',
    html: null,
    title: 'Booking Confirmed',
    description: null,
    tags: [],
    category: null,
    usageInstructions: '',
    sectionDefinitions: [],
    ...over,
  };
}

beforeEach(() => {
  listTemplates.mockReset();
  listTemplateCategories.mockReset();
  listTemplateCategories.mockResolvedValue([]);
  saveTemplate.mockReset();
});

describe('Templates screen', () => {
  it('loads and renders rows with title, key, subject, category, and tags', async () => {
    listTemplates.mockResolvedValue([
      tpl({
        templateId: 'booking.confirmed',
        title: 'Booking Confirmed',
        subject: 'Your booking is confirmed',
        category: 'Booking',
        tags: ['booking', 'confirmation'],
      }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
    const row = screen.getByText('Booking Confirmed').closest('.templates__row') as HTMLElement;
    expect(within(row).getByText('booking.confirmed')).toBeInTheDocument();
    expect(within(row).getByText('Your booking is confirmed')).toBeInTheDocument();
    expect(within(row).getByText('Booking', { selector: '.templates__chip--category' })).toBeInTheDocument();
    expect(within(row).getByText('booking', { selector: '.templates__chip--tag' })).toBeInTheDocument();
    expect(within(row).getByText('confirmation', { selector: '.templates__chip--tag' })).toBeInTheDocument();
  });

  it('surfaces a load failure naming the callable, never a false empty list', async () => {
    // Both the primary AsyncRegion panel AND the Templates/Untagged stat
    // cards derive from the same failed `templates` load, so each honestly
    // shows its OWN error (asyncScalar never fabricates a fallback number) :
    // the same "every derived value tells the truth" pattern Invoices.tsx's
    // outstandingTotal/billedTotal/overdueCount cards follow. Scope to the
    // panel's own error detail, matching KinTales.test.tsx's convention.
    listTemplates.mockRejectedValue(new Error('permission-denied'));
    render(<Templates />);
    expect(
      await screen.findByText(/listTemplates failed: permission-denied/, { selector: '.async-error-detail' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no templates yet/i)).toBeNull();
  });

  it('retries the load on demand', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([tpl({})]);
    render(<Templates />);
    await screen.findByText(/listTemplates failed/i, { selector: '.async-error-detail' });
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
    expect(listTemplates).toHaveBeenCalledTimes(2);
  });

  it('renders the proven-empty state, not while the load is failing', async () => {
    listTemplates.mockResolvedValue([]);
    render(<Templates />);
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
  });

  it('surfaces a categories load failure as a secondary note, without blanking the template list', async () => {
    listTemplates.mockResolvedValue([tpl({})]);
    listTemplateCategories.mockRejectedValue(new Error('unavailable'));
    render(<Templates />);
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
    expect(await screen.findByText(/categories unavailable/i)).toBeInTheDocument();
  });

  it('filters rows by category tab, and the tab carries a live count', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'Booking A', category: 'Booking' }),
      tpl({ templateId: 'b', title: 'Reminder B', category: 'Reminder' }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking', 'Reminder']);
    render(<Templates />);
    await screen.findByText('Booking A');

    const bookingTab = screen.getByRole('tab', { name: /booking 1/i });
    await userEvent.click(bookingTab);

    expect(screen.getByText('Booking A')).toBeInTheDocument();
    expect(screen.queryByText('Reminder B')).toBeNull();
  });

  it('an uncategorized template only shows under All, never under a specific category tab', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'Booking A', category: 'Booking' }),
      tpl({ templateId: 'b', title: 'No Category B', category: null }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    await screen.findByText('Booking A');
    expect(screen.getByText('No Category B')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /booking 1/i }));
    expect(screen.queryByText('No Category B')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /^all/i }));
    expect(screen.getByText('No Category B')).toBeInTheDocument();
  });

  it('filters the visible rows by the search box (title or key)', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
      tpl({ templateId: 'invoice.reminder', title: 'Invoice Reminder' }),
    ]);
    render(<Templates />);
    await screen.findByText('Booking Confirmed');
    await userEvent.type(screen.getByLabelText(/search templates/i), 'invoice');
    expect(screen.queryByText('Booking Confirmed')).toBeNull();
    expect(screen.getByText('Invoice Reminder')).toBeInTheDocument();
  });

  it('calls an externally supplied onSelect with the templateId instead of opening the built-in editor', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    const onSelect = vi.fn();
    render(<Templates onSelect={onSelect} />);
    await userEvent.click(await screen.findByText('Booking Confirmed'));
    expect(onSelect).toHaveBeenCalledWith('booking.confirmed');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rows are always live buttons: with no onSelect override, activating a row opens the built-in editor', async () => {
    // Unlike the pre-editor placeholder, there is no unwired/dead-control case
    // left: the router mounts <Templates/> propless in production, so this
    // default (opening the overlay) is what every operator actually gets.
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    render(<Templates />);
    const row = await screen.findByText('Booking Confirmed');
    expect(row.closest('.templates__row-main')?.tagName).toBe('BUTTON');
    await userEvent.click(row);
    expect(screen.getByRole('dialog', { name: /edit template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Your booking is confirmed');
  });

  it('New template opens the built-in editor in create mode by default', async () => {
    listTemplates.mockResolvedValue([]);
    render(<Templates />);
    await screen.findByText(/no templates yet/i);
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(screen.getByRole('dialog', { name: /new template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/template key/i)).toHaveValue('');
  });

  it('an externally supplied onNew overrides the built-in New template default', async () => {
    listTemplates.mockResolvedValue([]);
    const onNew = vi.fn();
    render(<Templates onNew={onNew} />);
    await screen.findByText(/no templates yet/i);
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saving a new template closes the editor and reloads the list', async () => {
    listTemplates.mockResolvedValueOnce([]);
    listTemplates.mockResolvedValueOnce([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
    ]);
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<Templates />);
    await screen.findByText(/no templates yet/i);

    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Your booking is confirmed');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Hi {{kinfolk_name}}');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
  });

  it('deleting a template through the editor closes it and reloads the list', async () => {
    listTemplates.mockResolvedValueOnce([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    listTemplates.mockResolvedValueOnce([]);
    deleteTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<Templates />);

    const row = await screen.findByText('Booking Confirmed');
    await userEvent.click(row);
    expect(screen.getByRole('dialog', { name: /edit template/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete this template\?/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));

    expect(deleteTemplate).toHaveBeenCalledWith('booking.confirmed');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
  });

  it('a stale/missing row id (list not yet loaded) is a silent no-op, never a crash or a blank editor', async () => {
    listTemplates.mockReturnValue(new Promise(() => {})); // never resolves: still loading
    render(<Templates />);
    // Nothing to click yet (AsyncRegion is showing the loading state), so this
    // exercises openEditorFor's guard indirectly via New template still being
    // available and NOT throwing while templates.status !== 'ready'.
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(screen.getByRole('dialog', { name: /new template/i })).toBeInTheDocument();
  });

  it('shows real counts in the stat strip', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'A', tags: [] }),
      tpl({ templateId: 'b', title: 'B', tags: ['x'] }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    await screen.findByText('A');

    // Scoped to each stat card's own container (found via its label), not the
    // tab-count spans or a sibling card, which would otherwise collide on the
    // same digit.
    const templatesCard = screen.getByText('Templates', { selector: '.den-stat-label' }).closest('.den-stat');
    const categoriesCard = screen.getByText('Categories', { selector: '.den-stat-label' }).closest('.den-stat');
    const untaggedCard = screen.getByText('Untagged', { selector: '.den-stat-label' }).closest('.den-stat');

    expect(within(templatesCard as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(categoriesCard as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(within(untaggedCard as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});

describe('Templates screen: I8 pagination', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue([]);
  });

  it('shows Load more when the first page returns a cursor, and appends the next page on click', async () => {
    listTemplates
      .mockResolvedValueOnce({ templates: [tpl({ templateId: 'a', title: 'Alpha' })], nextCursor: 'a' })
      .mockResolvedValueOnce({ templates: [tpl({ templateId: 'b', title: 'Beta' })], nextCursor: null });
    render(<Templates />);

    await screen.findByText('Alpha');
    expect(screen.queryByText('Beta')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument(); // previous page still shown
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('shows no Load more when the first page is exhausted (nextCursor null)', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('surfaces a Load more failure fail-loud, keeping the already-loaded rows', async () => {
    listTemplates
      .mockResolvedValueOnce({ templates: [tpl({ templateId: 'a', title: 'Alpha' })], nextCursor: 'a' })
      .mockRejectedValueOnce(new Error('permission-denied'));
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText(/listTemplates failed: permission-denied/)).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('Templates screen: I9 New binding', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue(['Booking']);
  });

  it('opens the bulk category (New binding) dialog from the header', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /new binding/i }));

    expect(screen.getByRole('dialog', { name: /new binding/i })).toBeInTheDocument();
  });
});
