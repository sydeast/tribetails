// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TemplateSummary } from '../api/templates';

const { listTemplates } = vi.hoisted(() => ({ listTemplates: vi.fn() }));
vi.mock('../api/templates', async (orig) => ({
  ...(await orig<typeof import('../api/templates')>()),
  listTemplates,
}));

const { assignTemplatesToCategory } = vi.hoisted(() => ({ assignTemplatesToCategory: vi.fn() }));
vi.mock('../api/templatesWrite', () => ({ assignTemplatesToCategory }));

import { CategoryBindingDialog } from './CategoryBindingDialog';

function tpl(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    templateId: 'a',
    subject: 's',
    body: 'b',
    html: null,
    title: 'Alpha',
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
  assignTemplatesToCategory.mockReset();
  listTemplates.mockResolvedValue([
    tpl({ templateId: 'a', title: 'Alpha' }),
    tpl({ templateId: 'b', title: 'Beta', category: 'Booking' }),
  ]);
});

describe('CategoryBindingDialog', () => {
  it('renders the full template list as a multi-select checklist and a category input', async () => {
    render(<CategoryBindingDialog categories={['Booking']} onClose={vi.fn()} onBound={vi.fn()} />);
    expect(await screen.findByRole('checkbox', { name: /Alpha/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Beta/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^category$/i)).toBeInTheDocument();
  });

  it('binds the selected templates to a NEW (inline-created) category in one call', async () => {
    assignTemplatesToCategory.mockResolvedValue({
      category: 'Fresh Batch',
      assigned: 2,
      templateIds: ['a', 'b'],
    });
    const onBound = vi.fn();
    render(<CategoryBindingDialog categories={['Booking']} onClose={vi.fn()} onBound={onBound} />);

    await screen.findByRole('checkbox', { name: /Alpha/i });
    // A category not in the datalist: inline creation is just typing a new name.
    await userEvent.type(screen.getByLabelText(/^category$/i), 'Fresh Batch');
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Beta/i }));
    await userEvent.click(screen.getByRole('button', { name: /add .*to category/i }));

    await waitFor(() =>
      expect(assignTemplatesToCategory).toHaveBeenCalledWith({
        category: 'Fresh Batch',
        templateIds: ['a', 'b'],
      }),
    );
    expect(onBound).toHaveBeenCalledWith({ category: 'Fresh Batch', assigned: 2 });
  });

  it('keeps the bind action disabled until a category is entered AND at least one template is selected', async () => {
    render(<CategoryBindingDialog categories={[]} onClose={vi.fn()} onBound={vi.fn()} />);
    await screen.findByRole('checkbox', { name: /Alpha/i });

    const bindButton = screen.getByRole('button', { name: /add .*to category/i });
    expect(bindButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/^category$/i), 'Booking');
    expect(bindButton).toBeDisabled(); // category set, nothing selected yet

    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha/i }));
    expect(bindButton).toBeEnabled();
  });

  it('filters the checklist by search (title or key)', async () => {
    render(<CategoryBindingDialog categories={[]} onClose={vi.fn()} onBound={vi.fn()} />);
    await screen.findByRole('checkbox', { name: /Alpha/i });

    await userEvent.type(screen.getByLabelText(/search templates/i), 'beta');
    expect(screen.queryByRole('checkbox', { name: /Alpha/i })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Beta/i })).toBeInTheDocument();
  });

  it('Select shown ticks every visible template at once', async () => {
    render(<CategoryBindingDialog categories={[]} onClose={vi.fn()} onBound={vi.fn()} />);
    await screen.findByRole('checkbox', { name: /Alpha/i });

    await userEvent.click(screen.getByRole('button', { name: /select shown/i }));
    expect(screen.getByRole('checkbox', { name: /Alpha/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Beta/i })).toBeChecked();
  });

  it('fails loud, naming the callable, when the bind rejects, and never claims success', async () => {
    assignTemplatesToCategory.mockRejectedValue(new Error('not-found: Template(s) not found: a'));
    const onBound = vi.fn();
    render(<CategoryBindingDialog categories={[]} onClose={vi.fn()} onBound={onBound} />);
    await screen.findByRole('checkbox', { name: /Alpha/i });

    await userEvent.type(screen.getByLabelText(/^category$/i), 'Booking');
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha/i }));
    await userEvent.click(screen.getByRole('button', { name: /add .*to category/i }));

    expect(
      await screen.findByText(/assignTemplatesToCategory failed:.*not found/i),
    ).toBeInTheDocument();
    expect(onBound).not.toHaveBeenCalled();
  });

  it('surfaces a template-list load failure fail-loud rather than an empty checklist', async () => {
    listTemplates.mockRejectedValue(new Error('permission-denied'));
    render(<CategoryBindingDialog categories={[]} onClose={vi.fn()} onBound={vi.fn()} />);
    expect(await screen.findByText(/listTemplates failed:.*permission-denied/i)).toBeInTheDocument();
  });
});
