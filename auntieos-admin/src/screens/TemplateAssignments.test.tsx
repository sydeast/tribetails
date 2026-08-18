// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CatalogKeyRow, TemplateBinding } from '../api/templateBindings';
import type { TemplateSummary } from '../api/templates';

const { listTemplateBindings, listCatalogKeys, assignTemplate, unassignTemplate, listTemplates } =
  vi.hoisted(() => ({
    listTemplateBindings: vi.fn(),
    listCatalogKeys: vi.fn(),
    assignTemplate: vi.fn(),
    unassignTemplate: vi.fn(),
    listTemplates: vi.fn(),
  }));
vi.mock('../api/templateBindings', async (orig) => ({
  ...(await orig<typeof import('../api/templateBindings')>()),
  listTemplateBindings,
  listCatalogKeys,
  assignTemplate,
  unassignTemplate,
}));
vi.mock('../api/templates', async (orig) => ({
  ...(await orig<typeof import('../api/templates')>()),
  listTemplates,
}));

import { TemplateAssignments } from './TemplateAssignments';

function binding(over: Partial<TemplateBinding> = {}): TemplateBinding {
  return { catalogKey: 'booking.confirmed', templateId: 'tmpl_ok', audience: 'kinfolk', triggerKey: null, active: true, ...over };
}
function template(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return { templateId: 'tmpl_ok', subject: 's', body: 'b', html: null, title: 'Booking confirmed', description: null, tags: [], category: null, usageInstructions: '', sectionDefinitions: [], ...over };
}
function catalogRow(over: Partial<CatalogKeyRow> = {}): CatalogKeyRow {
  return {
    key: 'kincare.booking.confirm',
    label: 'KinCare booking confirmed',
    category: 'visit',
    audience: 'both',
    source: 'catalog',
    defaultTemplateId: 'kincare.booking.confirm',
    hasDefaultTemplate: true,
    bound: false,
    resolvedTemplateId: 'kincare.booking.confirm',
    ...over,
  };
}

/** What the fixed listCatalogKeys hands back: the catalog, plus a legacy stray. */
function catalogFixture(): CatalogKeyRow[] {
  return [
    catalogRow(),
    catalogRow({ key: 'kincare.booking.cancel', label: 'KinCare booking canceled', defaultTemplateId: 'kincare.booking.cancel', resolvedTemplateId: 'kincare.booking.cancel' }),
    catalogRow({ key: 'invite.primary', label: 'Portal invite to a primary kinfolk', category: null, audience: null, source: 'direct-send', defaultTemplateId: 'invite.primary', resolvedTemplateId: 'invite.primary' }),
    catalogRow({ key: 'booking.confirmed', label: 'Not in the catalog, nothing dispatches it', category: null, audience: null, source: 'legacy', defaultTemplateId: 'booking.confirmed', hasDefaultTemplate: false, bound: true, resolvedTemplateId: 'tmpl_ok' }),
  ];
}

beforeEach(() => {
  listTemplateBindings.mockReset();
  listCatalogKeys.mockReset();
  assignTemplate.mockReset();
  unassignTemplate.mockReset();
  listTemplates.mockReset();
  listTemplateBindings.mockResolvedValue([binding()]);
  listCatalogKeys.mockResolvedValue(catalogFixture());
  listTemplates.mockResolvedValue([template(), template({ templateId: 'tmpl_reminder', title: 'Reminder' })]);
});

describe('TemplateAssignments', () => {
  it('renders each binding by catalog key and its template TITLE (not the raw id)', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    // Scope to the binding row: "Booking confirmed" also appears as a <select> option.
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;
    expect(within(row).getByText('Booking confirmed')).toBeInTheDocument();
  });

  // ── #383: the key box was free text because there was no list to pick from ──

  it('offers the real catalog keys as a picker, not a text box', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const picker = await screen.findByLabelText(/catalog key/i);
    expect(picker.tagName).toBe('SELECT');
    const options = within(picker as HTMLSelectElement).getAllByRole('option');
    const values = options.map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('kincare.booking.confirm');
    expect(values).toContain('invite.primary');
  });

  it('labels each key with what it is and whether it is bound', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const picker = await screen.findByLabelText(/catalog key/i);
    expect(
      within(picker as HTMLSelectElement).getByRole('option', {
        name: /kincare\.booking\.confirm · KinCare booking confirmed \(no binding/i,
      }),
    ).toBeInTheDocument();
  });

  it('never offers a legacy key as something new to bind', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const picker = await screen.findByLabelText(/catalog key/i);
    const values = within(picker as HTMLSelectElement)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).not.toContain('booking.confirmed');
  });

  it('still shows a legacy key when you open the binding that uses it', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: /^change$/i }));

    const picker = await screen.findByLabelText(/catalog key/i);
    expect((picker as HTMLSelectElement).value).toBe('booking.confirmed');
    expect(picker).toBeDisabled();
    expect(
      within(picker as HTMLSelectElement).getByRole('option', { name: /not in the catalog/i }),
    ).toBeInTheDocument();
  });

  it('says how many keys have no binding yet', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(await screen.findByText(/3 catalog keys, 3 with no binding yet/i)).toBeInTheDocument();
  });

  it('assigns a template to a picked catalog key, then reloads bindings and the catalog', async () => {
    assignTemplate.mockResolvedValue({ catalogKey: 'kincare.booking.cancel', templateId: 'tmpl_reminder', active: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.selectOptions(screen.getByLabelText(/catalog key/i), 'kincare.booking.cancel');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_reminder');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() =>
      expect(assignTemplate).toHaveBeenCalledWith({ catalogKey: 'kincare.booking.cancel', templateId: 'tmpl_reminder', audience: undefined }),
    );
    // reload: initial load + reload after assign, for both reads
    await waitFor(() => expect(listTemplateBindings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listCatalogKeys).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/assigned reminder to kincare\.booking\.cancel/i)).toBeInTheDocument();
  });

  it('does not send audience when left at (none), but sends it when chosen', async () => {
    assignTemplate.mockResolvedValue({ catalogKey: 'invite.primary', templateId: 'tmpl_ok', active: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.selectOptions(screen.getByLabelText(/catalog key/i), 'invite.primary');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_ok');
    await userEvent.selectOptions(screen.getByLabelText(/audience/i), 'admin');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() =>
      expect(assignTemplate).toHaveBeenCalledWith({ catalogKey: 'invite.primary', templateId: 'tmpl_ok', audience: 'admin' }),
    );
  });

  it('confirm-gates unassign, then calls unassignTemplate and reloads', async () => {
    unassignTemplate.mockResolvedValue({ catalogKey: 'booking.confirmed', removed: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;

    await userEvent.click(within(row).getByRole('button', { name: /^unassign$/i }));
    // A confirm step appears; the callable has NOT fired yet.
    expect(unassignTemplate).not.toHaveBeenCalled();
    expect(within(row).getByText(/unassign this key\?/i)).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: /^unassign$/i }));
    await waitFor(() => expect(unassignTemplate).toHaveBeenCalledWith('booking.confirmed'));
    await waitFor(() => expect(listTemplateBindings).toHaveBeenCalledTimes(2));
  });

  it('fails loud (names the callable) when assign rejects, and never claims success', async () => {
    assignTemplate.mockRejectedValue(new Error('not-found: Template not found'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.selectOptions(screen.getByLabelText(/catalog key/i), 'kincare.booking.confirm');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_ok');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    expect(await screen.findByText(/assignTemplate failed:.*not found/i)).toBeInTheDocument();
  });

  // ── #382: the server now refuses an unreal key; the screen repeats its words ──

  it('repeats the server sentence verbatim when the key is refused', async () => {
    const refusal = Object.assign(
      new Error("Unknown catalog key 'kincare.bookng.confirm'. It is not in the notification catalog."),
      { code: 'functions/invalid-argument' },
    );
    assignTemplate.mockRejectedValue(refusal);
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.selectOptions(screen.getByLabelText(/catalog key/i), 'kincare.booking.confirm');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_ok');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    expect(
      await screen.findByText(/refused this catalog key:.*Unknown catalog key 'kincare\.bookng\.confirm'/i),
    ).toBeInTheDocument();
  });

  it('surfaces a bindings load failure fail-loud rather than an empty state', async () => {
    listTemplateBindings.mockRejectedValue(new Error('permission-denied'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(await screen.findByText(/listTemplateBindings failed:.*permission-denied/i)).toBeInTheDocument();
  });

  it('surfaces a catalog-keys load failure instead of an empty picker', async () => {
    listCatalogKeys.mockRejectedValue(new Error('permission-denied'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(await screen.findByText(/listCatalogKeys failed:.*permission-denied/i)).toBeInTheDocument();
  });
});
