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

/** What listCatalogKeys hands back: the catalog, plus a legacy stray. */
function catalogFixture(): CatalogKeyRow[] {
  return [
    catalogRow(),
    catalogRow({ key: 'kincare.booking.cancel', label: 'KinCare booking canceled', defaultTemplateId: 'kincare.booking.cancel', resolvedTemplateId: 'kincare.booking.cancel' }),
    catalogRow({ key: 'invite.primary', label: 'Portal invite to a primary kinfolk', category: null, audience: null, source: 'direct-send', defaultTemplateId: 'invite.primary', resolvedTemplateId: 'invite.primary' }),
    catalogRow({ key: 'booking.confirmed', label: 'Not in the catalog, nothing dispatches it', category: null, audience: null, source: 'legacy', defaultTemplateId: 'booking.confirmed', hasDefaultTemplate: false, bound: true, resolvedTemplateId: 'tmpl_ok' }),
  ];
}

/**
 * The state the operator actually walked into on 2026-08-17: no bindings at all.
 * Every key still sends, by the naming convention.
 */
function noOverridesAnywhere(): CatalogKeyRow[] {
  return [
    catalogRow(),
    catalogRow({ key: 'kincare.booking.cancel', label: 'KinCare booking canceled', defaultTemplateId: 'kincare.booking.cancel', resolvedTemplateId: 'kincare.booking.cancel' }),
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

// ── #384: an empty bindings collection is not an empty routing table ──────────

describe('TemplateAssignments routing table', () => {
  it('shows what every catalog key sends when there are no bindings at all', async () => {
    listTemplateBindings.mockResolvedValue([]);
    listCatalogKeys.mockResolvedValue(noOverridesAnywhere());
    render(<TemplateAssignments onClose={vi.fn()} />);

    // The old screen said "No catalog keys are bound yet" here, which was true of
    // the collection and false about the business.
    expect(screen.queryByText(/no catalog keys are bound yet/i)).not.toBeInTheDocument();
    const row = (await screen.findByText('kincare.booking.confirm')).closest('li')!;
    expect(within(row).getByText(/sends kincare\.booking\.confirm/i)).toBeInTheDocument();
    expect(within(row).getByText(/default, matched by name/i)).toBeInTheDocument();
  });

  it('counts how many keys route by override and how many by name', async () => {
    listTemplateBindings.mockResolvedValue([]);
    listCatalogKeys.mockResolvedValue(noOverridesAnywhere());
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(
      await screen.findByText(/2 keys route today\. 0 of them through an override, the rest by name/i),
    ).toBeInTheDocument();
  });

  it('calls an overridden key an override and names the template it sends', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;
    // resolvedTemplateId is tmpl_ok, whose bank title is "Booking confirmed".
    expect(within(row).getByText(/sends Booking confirmed/i)).toBeInTheDocument();
    expect(within(row).getByText(/override, assigned by an admin/i)).toBeInTheDocument();
  });

  it('says a paused binding falls back to the name-matched default', async () => {
    listTemplateBindings.mockResolvedValue([binding({ catalogKey: 'invoice.new', active: false })]);
    listCatalogKeys.mockResolvedValue([
      catalogRow({
        key: 'invoice.new',
        label: 'New invoice',
        defaultTemplateId: 'invoice.new',
        // The server already applied resolveTemplateId's rule: inactive means
        // "revert to default", so resolved equals the default here.
        resolvedTemplateId: 'invoice.new',
        bound: true,
      }),
    ]);
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('invoice.new')).closest('li')!;
    expect(
      within(row).getByText(/binding is paused, so the name-matched default applies/i),
    ).toBeInTheDocument();
  });

  it('warns loudly about a key whose template document does not exist', async () => {
    listTemplateBindings.mockResolvedValue([]);
    listCatalogKeys.mockResolvedValue([
      catalogRow({
        key: 'account.welcome.business',
        label: 'Business welcome',
        defaultTemplateId: 'account.welcome.business',
        resolvedTemplateId: 'account.welcome.business',
        hasDefaultTemplate: false,
      }),
    ]);
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('account.welcome.business')).closest('li')!;
    expect(
      within(row).getByText(/no emailTemplates\/account\.welcome\.business document/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/1 key resolves to a template document that does not exist/i),
    ).toBeInTheDocument();
  });

  it('does not paint every override as broken when the template bank fails to load', async () => {
    // titleById is empty in that state, so an existence check against it would
    // report every overridden key as missing. It must not.
    listTemplates.mockRejectedValue(new Error('permission-denied'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;
    expect(within(row).queryByText(/does not exist/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/to a template document that does not exist/i)).not.toBeInTheDocument();
  });

  it('offers Override on an unbound key and Remove override only on a bound one', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const unbound = (await screen.findByText('kincare.booking.confirm')).closest('li')!;
    expect(within(unbound).getByRole('button', { name: /^override$/i })).toBeInTheDocument();
    expect(within(unbound).queryByRole('button', { name: /remove override/i })).not.toBeInTheDocument();

    const bound = (await screen.findByText('booking.confirmed')).closest('li')!;
    expect(within(bound).getByRole('button', { name: /change override/i })).toBeInTheDocument();
    expect(within(bound).getByRole('button', { name: /remove override/i })).toBeInTheDocument();
  });

  it('seeds the editor from what an unbound key sends today, not from blank', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('kincare.booking.confirm')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: /^override$/i }));

    expect((screen.getByLabelText(/catalog key/i) as HTMLSelectElement).value).toBe('kincare.booking.confirm');
    // Not in the bank, so it is preserved as the "missing from bank" option.
    expect((screen.getByLabelText(/^template$/i) as HTMLSelectElement).value).toBe('kincare.booking.confirm');
  });

  it('states that an override is email only and that audience changes nothing', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(
      await screen.findByText(/an override changes the EMAIL template only/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/SMS and push read the template ids frozen in the catalog/i)).toBeInTheDocument();
    expect(screen.getByText(/audience is written to the binding and no sender reads it/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/audience \(stored, unused\)/i)).toBeInTheDocument();
  });
});

// ── behaviour carried over from #382/#383, still required ─────────────────────

describe('TemplateAssignments picker and writes', () => {
  it('offers the real catalog keys as a picker, not a text box', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    const picker = await screen.findByLabelText(/catalog key/i);
    expect(picker.tagName).toBe('SELECT');
    const values = within(picker as HTMLSelectElement)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('kincare.booking.confirm');
    expect(values).toContain('invite.primary');
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
    await userEvent.click(within(row).getByRole('button', { name: /change override/i }));

    const picker = await screen.findByLabelText(/catalog key/i);
    expect((picker as HTMLSelectElement).value).toBe('booking.confirmed');
    expect(picker).toBeDisabled();
    expect(
      within(picker as HTMLSelectElement).getByRole('option', { name: /not in the catalog/i }),
    ).toBeInTheDocument();
  });

  it('saves an override on a picked catalog key, then reloads bindings and the routing table', async () => {
    assignTemplate.mockResolvedValue({ catalogKey: 'kincare.booking.cancel', templateId: 'tmpl_reminder', active: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.selectOptions(screen.getByLabelText(/catalog key/i), 'kincare.booking.cancel');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_reminder');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(assignTemplate).toHaveBeenCalledWith({ catalogKey: 'kincare.booking.cancel', templateId: 'tmpl_reminder', audience: undefined }),
    );
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
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(assignTemplate).toHaveBeenCalledWith({ catalogKey: 'invite.primary', templateId: 'tmpl_ok', audience: 'admin' }),
    );
  });

  it('confirm-gates removing an override, then calls unassignTemplate and reloads', async () => {
    unassignTemplate.mockResolvedValue({ catalogKey: 'booking.confirmed', removed: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;

    await userEvent.click(within(row).getByRole('button', { name: /remove override/i }));
    expect(unassignTemplate).not.toHaveBeenCalled();
    expect(within(row).getByText(/drop this override and go back to the name-matched default/i)).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: /remove override/i }));
    await waitFor(() => expect(unassignTemplate).toHaveBeenCalledWith('booking.confirmed'));
    await waitFor(() => expect(listTemplateBindings).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/removed the override on booking\.confirmed/i),
    ).toBeInTheDocument();
  });

  it('fails loud (names the callable) when assign rejects, and never claims success', async () => {
    assignTemplate.mockRejectedValue(new Error('not-found: Template not found'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.selectOptions(screen.getByLabelText(/catalog key/i), 'kincare.booking.confirm');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_ok');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/assignTemplate failed:.*not found/i)).toBeInTheDocument();
  });

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
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(
      await screen.findByText(/refused this catalog key:.*Unknown catalog key 'kincare\.bookng\.confirm'/i),
    ).toBeInTheDocument();
  });

  it('surfaces a bindings load failure fail-loud rather than an empty state', async () => {
    listTemplateBindings.mockRejectedValue(new Error('permission-denied'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(await screen.findByText(/listTemplateBindings failed:.*permission-denied/i)).toBeInTheDocument();
  });

  it('surfaces a catalog-keys load failure instead of an empty routing table', async () => {
    listCatalogKeys.mockRejectedValue(new Error('permission-denied'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(await screen.findByText(/listCatalogKeys failed:.*permission-denied/i)).toBeInTheDocument();
  });
});
