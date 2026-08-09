// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TemplateSummary } from '../api/templates';

const { saveTemplate, deleteTemplate } = vi.hoisted(() => ({
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock('../api/templatesWrite', () => ({ saveTemplate, deleteTemplate }));

import { TemplateEditor } from './TemplateEditor';

function tpl(over: Partial<TemplateSummary> = {}): TemplateSummary {
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
  saveTemplate.mockReset();
  deleteTemplate.mockReset();
});

describe('TemplateEditor: create mode', () => {
  it('renders an empty form with an editable template key field', () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /new template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/template key/i)).toHaveValue('');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('');
  });

  it('blocks save and shows an inline error when the template key is blank', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Body');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/template key is required/i)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('blocks save on an invalid template key (matching the backend regex)', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Body');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    // "may only use" is unique to the inline error; the static field hint
    // below the input shares the same character-set wording, so a bare
    // substring match on that wording alone would hit both.
    expect(await screen.findByText(/may only use letters, numbers, underscore, period, and hyphen/i)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('blocks save when subject is blank', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Body');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/subject is required/i)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('blocks save when body is blank', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/body is required/i)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('calls saveTemplate with the exact payload and onSaved on success', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    const onSaved = vi.fn();
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Your booking is confirmed');
    // fireEvent.change, not userEvent.type: user-event's `{`/`}` are special
    // key-sequence syntax, so a literal "{{kinfolk_name}}" typed keystroke by
    // keystroke gets mangled ("{{" is its own escape for a literal "{").
    // Setting the value directly sidesteps that; this test is about the
    // saved payload, not keystroke-level input behavior.
    fireEvent.change(screen.getByLabelText(/^body$/i), { target: { value: 'Hi {{kinfolk_name}}' } });
    await userEvent.type(screen.getByLabelText(/tags/i), 'booking, confirmation');
    await userEvent.type(screen.getByLabelText(/category/i), 'Booking');

    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        templateId: 'booking.confirmed',
        subject: 'Your booking is confirmed',
        body: 'Hi {{kinfolk_name}}',
        html: null,
        category: 'Booking',
        tags: ['booking', 'confirmation'],
        usageInstructions: '',
        sectionDefinitions: [],
      }),
    );
    expect(onSaved).toHaveBeenCalledWith('booking.confirmed');
  });

  it('offers a datalist of known categories without forcing one', () => {
    render(<TemplateEditor template={null} categories={['Booking', 'Reminder']} onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByLabelText(/category/i);
    const listId = input.getAttribute('list');
    expect(listId).toBeTruthy();
    const options = document.querySelectorAll(`#${listId} option`);
    expect(Array.from(options).map((o) => o.getAttribute('value'))).toEqual(['Booking', 'Reminder']);
  });
});

describe('TemplateEditor: edit mode', () => {
  it('pre-fills every field from the given template, and renders the key read-only', () => {
    render(
      <TemplateEditor
        template={tpl({
          templateId: 'booking.confirmed',
          title: 'Booking Confirmed',
          subject: 'Your booking is confirmed',
          body: 'Hi {{kinfolk_name}}',
          html: '<p>Hi</p>',
          description: 'A note',
          category: 'Booking',
          tags: ['a', 'b'],
        })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: /edit template/i })).toBeInTheDocument();
    expect(screen.getByText('booking.confirmed')).toBeInTheDocument();
    expect(screen.queryByLabelText(/template key/i)).toBeNull(); // no editable input in edit mode
    expect(screen.getByLabelText(/title/i)).toHaveValue('Booking Confirmed');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Your booking is confirmed');
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('Hi {{kinfolk_name}}');
    expect(screen.getByLabelText(/html/i)).toHaveValue('<p>Hi</p>');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A note');
    expect(screen.getByLabelText(/category/i)).toHaveValue('Booking');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('a, b');
  });

  it('saves an edit using the existing templateId, unaffected by any read-only rendering quirk', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    const onSaved = vi.fn();
    render(
      <TemplateEditor
        template={tpl({ templateId: 'booking.confirmed', subject: 'Old subject' })}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    const subjectInput = screen.getByLabelText(/^subject$/i);
    await userEvent.clear(subjectInput);
    await userEvent.type(subjectInput, 'New subject');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'booking.confirmed', subject: 'New subject' }),
      ),
    );
    expect(onSaved).toHaveBeenCalledWith('booking.confirmed');
  });

  it('does not require a template key in edit mode (it is not user input there)', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<TemplateEditor template={tpl({ subject: 'Hi', body: 'Body' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(screen.queryByText(/template key is required/i)).toBeNull();
    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
  });
});

describe('TemplateEditor: I9 usage instructions + sections', () => {
  it('pre-fills usage instructions and section rows from the template', () => {
    render(
      <TemplateEditor
        template={tpl({
          usageInstructions: 'Send after the first visit.',
          sectionDefinitions: [{ title: 'Greeting', description: 'Warm hello' }],
        })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/usage instructions/i)).toHaveValue('Send after the first visit.');
    expect(screen.getByLabelText(/section 1 title/i)).toHaveValue('Greeting');
    expect(screen.getByLabelText(/section 1 description/i)).toHaveValue('Warm hello');
  });

  it('adds and removes section rows', async () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText(/section 1 title/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    expect(screen.getByLabelText(/section 1 title/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.queryByLabelText(/section 1 title/i)).toBeNull();
  });

  it('sends edited usage instructions and non-blank sections in the save payload, dropping titleless rows', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(
      <TemplateEditor
        template={tpl({ templateId: 'booking.confirmed' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText(/usage instructions/i), 'Use for confirmed bookings.');

    // First section: fully filled. Second: no title, dropped on save.
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    await userEvent.type(screen.getByLabelText(/section 1 title/i), 'Greeting');
    await userEvent.type(screen.getByLabelText(/section 1 description/i), 'Warm hello');
    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    await userEvent.type(screen.getByLabelText(/section 2 description/i), 'orphan, no title');

    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          usageInstructions: 'Use for confirmed bookings.',
          sectionDefinitions: [{ title: 'Greeting', description: 'Warm hello' }],
        }),
      ),
    );
  });
});

describe('TemplateEditor: save failure (fail loud)', () => {
  it('surfaces a rejected saveTemplate call, naming the callable, and keeps the dialog open with entered data intact', async () => {
    saveTemplate.mockRejectedValue(new Error('templateId already exists'));
    const onSaved = vi.fn();
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Body');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    expect(await screen.findByText(/saveTemplate failed: templateId already exists/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/template key/i)).toHaveValue('booking.confirmed');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('TemplateEditor: busy + close guards', () => {
  it('disables Cancel and Save, and marks Save busy, while a save is in flight', async () => {
    let resolveSave: (value: { templateId: string }) => void = () => {};
    saveTemplate.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<TemplateEditor template={tpl({ subject: 'Hi', body: 'Body' })} onClose={vi.fn()} onSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    const saveButton = screen.getByRole('button', { name: /saving/i });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();

    resolveSave({ templateId: 'booking.confirmed' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /saving/i })).toBeNull());
  });

  it('calls onClose when Cancel is clicked and no save is in flight', async () => {
    const onClose = vi.fn();
    render(<TemplateEditor template={tpl({})} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose on Escape when no save is in flight', async () => {
    const onClose = vi.fn();
    render(<TemplateEditor template={tpl({})} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('TemplateEditor: delete (edit mode only)', () => {
  it('create mode never offers a Delete action, even with onDeleted supplied', () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('edit mode omits the Delete action when onDeleted is not supplied (no handler, no interactive control)', () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('edit mode with onDeleted supplied offers a Delete action that opens a confirm dialog', async () => {
    render(<TemplateEditor template={tpl({ templateId: 'booking.confirmed' })} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete this template\?/i })).toBeInTheDocument();
    expect(screen.getByText('booking.confirmed')).toBeInTheDocument();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it('Back returns to the edit dialog without deleting', async () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByRole('dialog', { name: /edit template/i })).toBeInTheDocument();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it('confirming delete calls deleteTemplate with the templateId and onDeleted on success', async () => {
    deleteTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    const onDeleted = vi.fn();
    render(
      <TemplateEditor
        template={tpl({ templateId: 'booking.confirmed' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith('booking.confirmed'));
    expect(onDeleted).toHaveBeenCalledWith('booking.confirmed');
  });

  it('surfaces a rejected deleteTemplate call fail-loud, naming the callable, and keeps the confirm dialog open', async () => {
    deleteTemplate.mockRejectedValue(
      new Error('failed-precondition: Template "booking.confirmed" is still assigned to notification catalog key(s): kin.booking.confirmed.'),
    );
    const onDeleted = vi.fn();
    render(
      <TemplateEditor
        template={tpl({ templateId: 'booking.confirmed' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    expect(await screen.findByText(/deleteTemplate failed: failed-precondition/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /delete this template\?/i })).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('disables Back and Delete, and marks Delete busy, while a delete is in flight', async () => {
    let resolveDelete: (value: { templateId: string }) => void = () => {};
    deleteTemplate.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));

    const deleteButton = screen.getByRole('button', { name: /deleting/i });
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled();

    resolveDelete({ templateId: 'booking.confirmed' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /deleting/i })).toBeNull());
  });

  it('calls onClose (fully exits) on Escape from the confirm dialog, not just Back', async () => {
    const onClose = vi.fn();
    render(<TemplateEditor template={tpl({})} onClose={onClose} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });
});
/**
 * The live preview pane (six mockups tag it `SUGGESTION: live preview pane`).
 * `account.welcome.business` shipped with "See their account here: []" because
 * nothing in this editor ever rendered a template, so these assertions are
 * about the editor showing what a kinfolk receives, not about decoration.
 */
describe('TemplateEditor: live preview', () => {
  it('renders the preview beside the form, filled from the sample bindings', () => {
    render(
      <TemplateEditor
        template={tpl({ subject: 'Your visit is confirmed', body: 'Hi {{kinfolkName}}, see you then.' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const preview = screen.getByRole('region', { name: 'Live preview' });
    expect(preview).toHaveTextContent('Your visit is confirmed');
    // The sample value, not the raw token: the point is seeing the sent copy.
    expect(preview).toHaveTextContent('Sandy Wren');
  });
  it('updates as the author types', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hello there');
    expect(screen.getByRole('region', { name: 'Live preview' })).toHaveTextContent('Hello there');
  });
  it('names a merge field the notification pipeline will not fill', () => {
    // `link` is emitter-supplied, not enrichable (enrichTemplateData.ts), so the
    // author has to know the emitting function must pass it.
    render(
      <TemplateEditor
        template={tpl({ body: 'See their account here: {{link}}' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 merge field has no sample value: link');
  });
  it('says nothing when every merge field is one the pipeline fills', () => {
    render(
      <TemplateEditor
        template={tpl({ subject: 'Confirmed', body: 'Hi {{kinfolkName}}, {{kinName}} is booked.' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('drops the preview on the confirm-delete view, which previews nothing', async () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.queryByRole('region', { name: 'Live preview' })).toBeNull();
  });
});
