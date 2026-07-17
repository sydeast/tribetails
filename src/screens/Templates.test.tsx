// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type TemplateSummary } from '../api/templates';

const { listTemplates, listTemplateCategories } = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  listTemplateCategories: vi.fn(),
}));
vi.mock('../api/templates', async (orig) => ({
  ...(await orig<typeof import('../api/templates')>()),
  listTemplates,
  listTemplateCategories,
}));

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
    ...over,
  };
}

beforeEach(() => {
  listTemplates.mockReset();
  listTemplateCategories.mockReset();
  listTemplateCategories.mockResolvedValue([]);
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

  it('calls onSelect with the templateId when a row is activated', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    const onSelect = vi.fn();
    render(<Templates onSelect={onSelect} />);
    await userEvent.click(await screen.findByText('Booking Confirmed'));
    expect(onSelect).toHaveBeenCalledWith('booking.confirmed');
  });

  it('renders rows STATIC (not a live no-op button) when onSelect is unwired', async () => {
    // Fable blocker (KinTales.tsx/Invoices.tsx convention): with the router
    // mounting <Templates/> propless, a live row button that silently does
    // nothing is a dead control.
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    render(<Templates />);
    await screen.findByText('Booking Confirmed');
    const row = screen.getByText('Booking Confirmed').closest('.templates__row-main');
    expect(row?.tagName).toBe('DIV');
    expect(screen.queryByRole('button', { name: /booking confirmed/i })).toBeNull();
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
