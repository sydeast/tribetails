// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TemplateBinding } from '../api/templateBindings';
import type { TemplateSummary } from '../api/templates';

const { listTemplateBindings, assignTemplate, unassignTemplate, listTemplates } = vi.hoisted(() => ({
  listTemplateBindings: vi.fn(),
  assignTemplate: vi.fn(),
  unassignTemplate: vi.fn(),
  listTemplates: vi.fn(),
}));
vi.mock('../api/templateBindings', async (orig) => ({
  ...(await orig<typeof import('../api/templateBindings')>()),
  listTemplateBindings,
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
  return { templateId: 'tmpl_ok', subject: 's', body: 'b', html: null, title: 'Booking confirmed', description: null, tags: [], category: null, ...over };
}

beforeEach(() => {
  listTemplateBindings.mockReset();
  assignTemplate.mockReset();
  unassignTemplate.mockReset();
  listTemplates.mockReset();
  listTemplateBindings.mockResolvedValue([binding()]);
  listTemplates.mockResolvedValue([template(), template({ templateId: 'tmpl_reminder', title: 'Reminder' })]);
});

describe('TemplateAssignments', () => {
  it('renders each binding by catalog key and its template TITLE (not the raw id)', async () => {
    render(<TemplateAssignments onClose={vi.fn()} />);
    // Scope to the binding row: "Booking confirmed" also appears as a <select> option.
    const row = (await screen.findByText('booking.confirmed')).closest('li')!;
    expect(within(row).getByText('Booking confirmed')).toBeInTheDocument();
  });

  it('assigns a template to a new catalog key, then reloads the bindings', async () => {
    assignTemplate.mockResolvedValue({ catalogKey: 'booking.canceled', templateId: 'tmpl_reminder', active: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.type(screen.getByLabelText(/catalog key/i), 'booking.canceled');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_reminder');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() =>
      expect(assignTemplate).toHaveBeenCalledWith({ catalogKey: 'booking.canceled', templateId: 'tmpl_reminder', audience: undefined }),
    );
    // reload: initial load + reload after assign
    await waitFor(() => expect(listTemplateBindings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/assigned reminder to booking\.canceled/i)).toBeInTheDocument();
  });

  it('does not send audience when left at (none), but sends it when chosen', async () => {
    assignTemplate.mockResolvedValue({ catalogKey: 'x.y', templateId: 'tmpl_ok', active: true });
    render(<TemplateAssignments onClose={vi.fn()} />);
    await screen.findByText('booking.confirmed');

    await userEvent.type(screen.getByLabelText(/catalog key/i), 'x.y');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_ok');
    await userEvent.selectOptions(screen.getByLabelText(/audience/i), 'admin');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() =>
      expect(assignTemplate).toHaveBeenCalledWith({ catalogKey: 'x.y', templateId: 'tmpl_ok', audience: 'admin' }),
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

    await userEvent.type(screen.getByLabelText(/catalog key/i), 'ghost.key');
    await userEvent.selectOptions(screen.getByLabelText(/^template$/i), 'tmpl_ok');
    await userEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    expect(await screen.findByText(/assignTemplate failed:.*not found/i)).toBeInTheDocument();
  });

  it('surfaces a bindings load failure fail-loud rather than an empty state', async () => {
    listTemplateBindings.mockRejectedValue(new Error('permission-denied'));
    render(<TemplateAssignments onClose={vi.fn()} />);
    expect(await screen.findByText(/listTemplateBindings failed:.*permission-denied/i)).toBeInTheDocument();
  });
});
