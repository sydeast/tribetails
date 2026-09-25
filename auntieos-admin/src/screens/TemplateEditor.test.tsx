// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TemplateSummary } from '../api/templates';

const { saveTemplate, deleteTemplate, previewEmailTemplate, convertTemplateToVisual } = vi.hoisted(() => ({
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  previewEmailTemplate: vi.fn(),
  convertTemplateToVisual: vi.fn(),
}));
// `isLiveNotificationKeyWarning` and `isTemplateKeyTakenError` are NOT mocked:
// they are the real predicates from the api module, so these tests exercise the
// same details-shape checks the screen runs in production rather than stubs that
// agree with themselves.
vi.mock('../api/templatesWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/templatesWrite')>(
    '../api/templatesWrite',
  );
  return {
    saveTemplate,
    deleteTemplate,
    previewEmailTemplate,
    convertTemplateToVisual,
    isLiveNotificationKeyWarning: actual.isLiveNotificationKeyWarning,
    isTemplateKeyTakenError: actual.isTemplateKeyTakenError,
  };
});

const { getNotificationMatrix } = vi.hoisted(() => ({ getNotificationMatrix: vi.fn() }));
vi.mock('../api/myNotifications', () => ({ getNotificationMatrix }));

// The editor surface is replaced by a plain textarea in THIS file only. Its
// real behaviour (TipTap, chips, paste, toolbar) is pinned in
// components/emailEditor/*.test.tsx; this file tests the screen around it:
// which fields show, what is seeded, what is saved. The round-trip lock check
// (lib/emailRoundTrip.ts) is NOT mocked: it runs a real headless editor here.
vi.mock('../components/emailEditor/EmailContentEditor', () => ({
  EmailContentEditor: (p: {
    initialContent: string;
    onChange: (c: string) => void;
    fields: readonly string[];
    disabled?: boolean;
  }) => (
    <textarea
      aria-label="Email content"
      data-fields={p.fields.join(',')}
      defaultValue={p.initialContent}
      disabled={p.disabled}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
}));

/**
 * A rejection shaped like the one the Functions SDK throws for the live-key
 * warning: a `failed-precondition` FirebaseError carrying `details`. The screen
 * reads `details.reason`, never the sentence.
 */
function liveKeyRejection(message: string): Error & { details: unknown } {
  return Object.assign(new Error(message), {
    code: 'functions/failed-precondition',
    details: {
      reason: 'live-catalog-key',
      templateId: 'kincare.booking.confirm',
      label: 'KinCare booking confirmed',
      acknowledgeable: true,
    },
  });
}

const LIVE_KEY_MESSAGE =
  'failed-precondition: emailTemplates/kincare.booking.confirm is what the notification ' +
  '"kincare.booking.confirm" (KinCare booking confirmed) sends, matched by name. Deleting it ' +
  'leaves that notification throwing "email template missing" on its next send. If that is ' +
  'what you want, confirm the delete and it will go through.';

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

/** Fills the two visual fields a new template needs besides key and subject. */
function fillVisualBody(content = '<p>Body</p>') {
  fireEvent.change(screen.getByLabelText(/^headline$/i), { target: { value: 'Headline' } });
  fireEvent.change(screen.getByLabelText('Email content'), { target: { value: content } });
}
beforeEach(() => {
  saveTemplate.mockReset();
  deleteTemplate.mockReset();
  previewEmailTemplate.mockReset().mockResolvedValue({ subject: 'S', html: '<html></html>', text: 'T', issues: [] });
  convertTemplateToVisual.mockReset();
  getNotificationMatrix.mockReset().mockResolvedValue({
    catalog: [{ key: 'auth.password.reset', templates: { email: 'auth.password.reset' }, mergeFields: ['displayName', 'link'] }],
    overrides: {}, ungated: [], businessAdminCount: null, businessAdminRosterPath: '', updatedAtMs: null,
  });
});

describe('TemplateEditor: create mode', () => {
  it('renders an empty form with an editable template key field, as a page with the create crumb', () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    // A page, not a modal (#755): the mock's "Template bank / New template"
    // trail and its "Email template" heading, and no dialog anywhere.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Email template');
    expect(screen.getByText('New template')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText(/template key/i)).toHaveValue('');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('');
    expect(screen.getByLabelText('Email content')).toHaveValue('');
  });

  it('blocks save and shows an inline error when the template key is blank', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    fillVisualBody();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/template key is required/i)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('blocks save on an invalid template key (matching the backend regex)', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    fillVisualBody();
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
    fillVisualBody();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/subject is required/i)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('blocks save when the content is empty', async () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    fireEvent.change(screen.getByLabelText(/^headline$/i), { target: { value: 'Headline' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText('The email needs some content.')).toBeInTheDocument();
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
    fillVisualBody('<p>Hi {{kinfolk_name}}</p>');
    // The tag row: a comma commits the first, Enter the second, each becoming
    // its own capsule.
    await userEvent.type(screen.getByLabelText(/add a tag/i), 'booking,confirmation{Enter}');
    expect(screen.getByRole('button', { name: 'Remove tag booking' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tag confirmation' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/category/i), 'Booking');

    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        templateId: 'booking.confirmed',
        subject: 'Your booking is confirmed',
        format: 'visual',
        headline: 'Headline',
        content: '<p>Hi {{kinfolk_name}}</p>',
        category: 'Booking',
        tags: ['booking', 'confirmation'],
        usageInstructions: '',
        sectionDefinitions: [],
        // Issue #468: create says so, so the server refuses a taken key rather
        // than upserting over whatever is already stored under it.
        expectNew: true,
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
    expect(screen.getByText('Edit template')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('booking.confirmed')).toBeInTheDocument();
    expect(screen.queryByLabelText(/template key/i)).toBeNull(); // no editable input in edit mode
    expect(screen.getByLabelText(/display name/i)).toHaveValue('Booking Confirmed');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Your booking is confirmed');
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('Hi {{kinfolk_name}}');
    expect(screen.getByLabelText(/html/i)).toHaveValue('<p>Hi</p>');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A note');
    expect(screen.getByLabelText(/category/i)).toHaveValue('Booking');
    // Tags are the mock's capsules, one remove each, with the add box empty.
    expect(screen.getByRole('button', { name: 'Remove tag a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tag b' })).toBeInTheDocument();
    expect(screen.getByLabelText(/add a tag/i)).toHaveValue('');
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
  it('surfaces a rejected saveTemplate call, naming the callable, and keeps the page up with entered data intact', async () => {
    saveTemplate.mockRejectedValue(new Error('templateId already exists'));
    const onSaved = vi.fn();
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    fillVisualBody();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    expect(await screen.findByText(/saveTemplate failed: templateId already exists/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Email template');
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

  it('the "Template bank" crumb is the way back and calls onClose', async () => {
    const onClose = vi.fn();
    render(<TemplateEditor template={tpl({})} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Template bank' }));
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
    const confirm = screen.getByRole('dialog', { name: /delete this template\?/i });
    expect(within(confirm).getByText('booking.confirmed')).toBeInTheDocument();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it('Back closes the confirm and leaves the page as it was, without deleting', async () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Edit template')).toHaveAttribute('aria-current', 'page');
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
    await waitFor(() =>
      expect(deleteTemplate).toHaveBeenCalledWith('booking.confirmed', {
        acknowledgeLiveKey: false,
      }),
    );
    expect(onDeleted).toHaveBeenCalledWith('booking.confirmed');
  });

  it('an ordinary template needs no acknowledgement: one press, one call, no second dialog state', async () => {
    // The whole point of the round trip is that the operator is only asked about
    // templates a live notification actually sends. Everything else deletes on
    // the first press exactly as it always did.
    deleteTemplate.mockResolvedValue({ templateId: 'one.off.blast' });
    render(
      <TemplateEditor
        template={tpl({ templateId: 'one.off.blast' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledTimes(1));
    expect(deleteTemplate).toHaveBeenCalledWith('one.off.blast', { acknowledgeLiveKey: false });
    expect(screen.queryByRole('button', { name: /delete anyway/i })).toBeNull();
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

  it('shows the #381 name-matched warning verbatim and offers to proceed', async () => {
    // The server's sentence is the only thing telling the operator what breaks,
    // so it has to arrive intact rather than be summarised away. What changed
    // since #440 is the ending: it is a confirmation now, not a wall.
    deleteTemplate.mockRejectedValue(liveKeyRejection(LIVE_KEY_MESSAGE));
    const onDeleted = vi.fn();
    render(
      <TemplateEditor
        template={tpl({ templateId: 'kincare.booking.confirm' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    expect(await screen.findByText(/matched by name/)).toBeInTheDocument();
    expect(screen.getByText(/email template missing/)).toBeInTheDocument();
    // A warning to read, not an error to report: no "deleteTemplate failed".
    expect(screen.queryByText(/deleteTemplate failed/)).toBeNull();
    expect(screen.getByRole('button', { name: /delete anyway/i })).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('OPERATOR RULING: pressing Delete anyway acknowledges the warning and the delete goes through', async () => {
    // "that was my doing I did not need that type of notification. I should be
    // able to delete templates without being yelled at." The second press sends
    // acknowledgeLiveKey, which is what the server needs to let it past.
    deleteTemplate
      .mockRejectedValueOnce(liveKeyRejection(LIVE_KEY_MESSAGE))
      .mockResolvedValueOnce({ templateId: 'kincare.booking.confirm' });
    const onDeleted = vi.fn();
    render(
      <TemplateEditor
        template={tpl({ templateId: 'kincare.booking.confirm' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    await userEvent.click(await screen.findByRole('button', { name: /delete anyway/i }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('kincare.booking.confirm'));
    expect(deleteTemplate).toHaveBeenNthCalledWith(1, 'kincare.booking.confirm', {
      acknowledgeLiveKey: false,
    });
    expect(deleteTemplate).toHaveBeenNthCalledWith(2, 'kincare.booking.confirm', {
      acknowledgeLiveKey: true,
    });
  });

  it('a binding refusal is NOT acknowledgeable: it stays an error with no Delete anyway', async () => {
    // The two failed-precondition cases must not blur together. A binding has a
    // one-tap remedy (unassign), so offering "Delete anyway" here would offer a
    // delete that can never succeed.
    deleteTemplate.mockRejectedValue(
      new Error(
        'failed-precondition: Template "booking.confirmed" is still assigned to notification ' +
          'catalog key(s): kin.booking.confirmed.',
      ),
    );
    render(
      <TemplateEditor
        template={tpl({ templateId: 'booking.confirmed' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    expect(await screen.findByText(/deleteTemplate failed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete anyway/i })).toBeNull();
  });

  it('Back after a warning clears it, so reopening the confirm asks again unacknowledged', async () => {
    // The acknowledgement is scoped to the warning the operator just read. If
    // they back out, the next attempt starts from the server's judgement again
    // rather than carrying a stale "yes" forward.
    deleteTemplate.mockRejectedValue(liveKeyRejection(LIVE_KEY_MESSAGE));
    render(
      <TemplateEditor
        template={tpl({ templateId: 'kincare.booking.confirm' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    await screen.findByRole('button', { name: /delete anyway/i });
    await userEvent.click(screen.getByRole('button', { name: /^back$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(screen.getByRole('button', { name: /delete template/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete anyway/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));
    expect(deleteTemplate).toHaveBeenNthCalledWith(2, 'kincare.booking.confirm', {
      acknowledgeLiveKey: false,
    });
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
    render(<TemplateEditor template={tpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
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
  it('keeps the page, preview included, under the confirm-delete dialog', async () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete this template\?/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Live preview' })).toBeInTheDocument();
  });
});
describe('TemplateEditor: a template that also carries HTML', () => {
  it('says the preview is showing plain text only, rather than implying it is the whole email', () => {
    // account.welcome.business is exactly this shape: an email.txt AND an
    // email.html, and the html is where `<a href='[]'>` lives.
    render(
      <TemplateEditor
        template={tpl({ body: 'See their account here: []', html: "<a href='[]'>View Account</a>" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('HTML body provided. Preview shows plain text only.')).toBeInTheDocument();
  });
  it('counts a merge field that only appears in the HTML', () => {
    render(
      <TemplateEditor
        template={tpl({ body: 'Plain.', html: '<a href="{{link}}">Account</a>' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 merge field has no sample value: link');
  });
});
// Issue #468. Creating a template used to be an upsert with a friendly name on
// it: typing the key of a template that already existed replaced its subject
// and body without a word. The editor now says it is creating, and the server
// refuses when the key is taken.
describe('TemplateEditor: creating cannot overwrite an existing template', () => {
  function keyTakenRejection(templateId: string): Error & { details: unknown } {
    return Object.assign(new Error('already exists'), {
      code: 'functions/already-exists',
      details: { reason: 'template-exists', templateId },
    });
  }
  it('sends expectNew on create, so the server refuses a taken key', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    fillVisualBody();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    expect(saveTemplate.mock.calls[0]?.[0]).toMatchObject({ expectNew: true });
  });
  it('does NOT send expectNew when editing, so an edit stays an update', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(
      <TemplateEditor
        template={tpl({ templateId: 'booking.confirmed', subject: 'Hi', body: 'Body' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    expect(saveTemplate.mock.calls[0]?.[0]).not.toHaveProperty('expectNew');
  });
  it('explains a taken key rather than showing the raw callable failure', async () => {
    saveTemplate.mockImplementationOnce(() =>
      Promise.reject(keyTakenRejection('booking.confirmed')),
    );
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Hi');
    fillVisualBody();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(
      await screen.findByText(/The key booking\.confirmed is already in use/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/saveTemplate failed/)).not.toBeInTheDocument();
  });
});
describe('TemplateEditor: the email creation mock (#755)', () => {
  it('lays the page out as the mock: heading, then the form panel, then preview and legend panels on the right', () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Email template');
    // The kicker's place is taken by the crumb trail on a nested screen.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Template bank/Edit template');
    const panels = document.querySelectorAll('.template-editor__cols .den-panel');
    expect(panels).toHaveLength(3);
    expect(panels[0]!.querySelector('fieldset')).not.toBeNull();
    expect(panels[1]!.querySelector('.merge-preview')).not.toBeNull();
    expect(panels[2]!.querySelector('.template-editor__legend')).not.toBeNull();
    // The right-hand pair sits in its own column, after the form panel.
    expect(panels[1]!.parentElement).toHaveClass('template-editor__aside');
  });
  it('puts Cancel and Save in the heading, where the mock draws them', () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    const trailing = document.querySelector('.den-heading-trailing');
    expect(trailing).not.toBeNull();
    const names = Array.from(trailing!.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(names).toEqual(['Cancel', 'Delete', 'Save template']);
  });
  it('states the channel with a kit pill and nothing else on the strip', () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} />);
    const strip = document.querySelector('.template-editor__strip');
    expect(strip).not.toBeNull();
    const pill = strip!.querySelector('.den-statuspill');
    expect(pill).toHaveTextContent('Channel · Email');
    expect(pill).toHaveAttribute('data-tone', 'teal');
    // No dead Push/SMS switch and no binding toggle: nothing else interactive.
    expect(strip!.querySelectorAll('button, input')).toHaveLength(0);
  });
  it('offers one merge-field chip per token the pipeline fills, and drops it at the caret', async () => {
    render(<TemplateEditor template={tpl({ body: 'Hello , see you then.' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    const chips = screen.getByRole('group', { name: 'Insert merge field' });
    const labels = within(chips).getAllByRole('button').map((b) => b.textContent?.replace('+', '').trim());
    expect(labels).toContain('{{kinfolkName}}');
    expect(labels).toContain('{{kinName}}');
    // The mock's illustrative names are not what the enricher fills, so they
    // are not offered.
    expect(labels).not.toContain('{{kinfolk_name}}');
    const body = screen.getByLabelText(/^body$/i) as HTMLTextAreaElement;
    body.focus();
    body.setSelectionRange(6, 6);
    await userEvent.click(within(chips).getByRole('button', { name: '{{kinfolkName}}' }));
    expect(body).toHaveValue('Hello {{kinfolkName}}, see you then.');
    expect(body.selectionStart).toBe(6 + '{{kinfolkName}}'.length);
    // A token the pipeline fills, so the preview shows the value and no warning.
    expect(screen.getByRole('region', { name: 'Live preview' })).toHaveTextContent('Sandy Wren');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('counts the body under the editor, beside the handlebars badge', async () => {
    render(<TemplateEditor template={tpl({ body: 'Hi there' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('8 chars')).toBeInTheDocument();
    expect(screen.getByText('{{ }} handlebars')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^body$/i), '!');
    expect(screen.getByText('9 chars')).toBeInTheDocument();
  });
  it('lists every sample value the preview resolves against', () => {
    render(<TemplateEditor template={tpl({})} onClose={vi.fn()} onSaved={vi.fn()} />);
    const legend = document.querySelector('.template-editor__legend')!;
    const rows = Array.from(legend.querySelectorAll('.template-editor__legend-row'));
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveTextContent('{{kinfolkName}}');
    expect(rows[0]).toHaveTextContent('Sandy Wren');
    expect(rows[5]).toHaveTextContent('{{invoiceNumber}}');
    expect(rows[5]).toHaveTextContent('INV-1042');
  });
  it('removes a tag from its capsule and folds a tag left in the add box into the save', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(
      <TemplateEditor
        template={tpl({ tags: ['a', 'b'], subject: 'Hi', body: 'Body' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove tag a' }));
    expect(screen.queryByRole('button', { name: 'Remove tag a' })).toBeNull();
    // Typed but never committed with Enter: Save keeps it anyway.
    await userEvent.type(screen.getByLabelText(/add a tag/i), 'c');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith(expect.objectContaining({ tags: ['b', 'c'] })),
    );
  });
  it('keeps the persisted fields the mock does not draw editable: HTML, usage instructions, sections', () => {
    render(<TemplateEditor template={tpl({ html: '<p>x</p>', usageInstructions: 'When' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/^html$/i)).toHaveValue('<p>x</p>');
    expect(screen.getByLabelText(/usage instructions/i)).toHaveValue('When');
    expect(screen.getByRole('button', { name: /add section/i })).toBeInTheDocument();
  });
});
function visualTpl(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return tpl({
    templateId: 'auth.password.reset',
    subject: 'Reset your password',
    body: '',
    html: null,
    format: 'visual',
    headline: 'Reset your password',
    content: '<p>Hi {{displayName}}</p>',
    ...over,
  });
}

const seedsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../mytribe/seeds/notificationTemplates');
const seedContent = (key: string) => readFileSync(join(seedsDir, key, 'content.html'), 'utf8').trimEnd();

describe('TemplateEditor: visual templates (#953)', () => {
  it('shows Subject, Headline and the content editor, and no Body or HTML fields', async () => {
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Reset your password');
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('Reset your password');
    expect(screen.getByLabelText('Email content')).toHaveValue('<p>Hi {{displayName}}</p>');
    expect(screen.getByLabelText('Email content')).not.toBeDisabled();
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    expect(screen.queryByLabelText(/^html$/i)).toBeNull();
    // The fields come from the notification that sends this template.
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'displayName,link'));
  });

  it('previews through the server with the matched catalog key', async () => {
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(
      () =>
        expect(previewEmailTemplate).toHaveBeenCalledWith({
          subject: 'Reset your password',
          headline: 'Reset your password',
          content: '<p>Hi {{displayName}}</p>',
          catalogKey: 'auth.password.reset',
        }),
      { timeout: 2000 },
    );
    expect(await screen.findByTitle('The email as it will be sent', {}, { timeout: 2000 })).toHaveAttribute(
      'srcdoc',
      '<html></html>',
    );
  });

  it('saves the visual shape: no body, no html', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    const onSaved = vi.fn();
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p>Hello {{displayName}}</p>' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        templateId: 'auth.password.reset',
        subject: 'Reset your password',
        format: 'visual',
        headline: 'Reset your password',
        content: '<p>Hello {{displayName}}</p>',
        title: 'Booking Confirmed',
        tags: [],
        usageInstructions: '',
        sectionDefinitions: [],
      }),
    );
    const sent = saveTemplate.mock.calls[0]![0] as Record<string, unknown>;
    expect('body' in sent).toBe(false);
    expect('html' in sent).toBe(false);
    expect(onSaved).toHaveBeenCalledWith('auth.password.reset');
  });

  it('keeps every metadata field the template carries on a visual save', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    render(
      <TemplateEditor
        template={visualTpl({
          title: 'Password reset',
          description: 'Sent when someone asks for a new password',
          category: 'Account',
          tags: ['auth', 'account'],
          usageInstructions: 'Sent by the reset flow only.',
          sectionDefinitions: [{ title: 'Greeting', description: 'Hi line' }],
        })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.clear(screen.getByLabelText(/^subject$/i));
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'New subject');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        templateId: 'auth.password.reset',
        subject: 'New subject',
        format: 'visual',
        headline: 'Reset your password',
        content: '<p>Hi {{displayName}}</p>',
        title: 'Password reset',
        description: 'Sent when someone asks for a new password',
        category: 'Account',
        tags: ['auth', 'account'],
        usageInstructions: 'Sent by the reset flow only.',
        sectionDefinitions: [{ title: 'Greeting', description: 'Hi line' }],
      }),
    );
  });

  it('blocks save on a blank headline and on empty content', async () => {
    render(<TemplateEditor template={visualTpl({ headline: '' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText('Headline is required.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^headline$/i), 'Hi');
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p> </p>' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText('The email needs some content.')).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('when no notification sends the template, offers the fields it already uses', async () => {
    getNotificationMatrix.mockResolvedValue({ catalog: [], overrides: {}, ungated: [], businessAdminCount: null, businessAdminRosterPath: '', updatedAtMs: null });
    render(<TemplateEditor template={visualTpl({ templateId: 'invite.kinfolk', content: '<p><a href="{{inviteLink}}" class="button">Join</a></p>' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'inviteLink'));
  });

  it('a failed field load still leaves the fields the template uses', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('offline'));
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'displayName'));
  });

  it('shows the server refusal word for word, and keeps what was typed', async () => {
    const refusal = Object.assign(
      new Error('A merge field can only be used in text or as a link target.'),
      { code: 'functions/invalid-argument' },
    );
    saveTemplate.mockRejectedValue(refusal);
    const onSaved = vi.fn();
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/^headline$/i), { target: { value: 'New headline' } });
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p>Edited {{displayName}}</p>' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(
      await screen.findByText(/A merge field can only be used in text or as a link target\./),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('New headline');
    expect(screen.getByLabelText('Email content')).toHaveValue('<p>Edited {{displayName}}</p>');
    expect(screen.getByRole('button', { name: /save template/i })).not.toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('TemplateEditor: content the editor cannot reproduce (#953 C5a)', () => {
  // A Handlebars block sitting bare in a list: the editor would wrap each tag
  // in a list item of its own, so it must never be given the chance to save.

  const UNSUPPORTED = '<p>Hi</p><ul><li>a</li>{{#if vip}}<li>b</li>{{/if}}</ul>';

  const LOCK_NOTE = 'This email has a structure the editor can’t edit yet. Edit its subject and headline here.';

  it('opens with the body locked and says why', () => {
    render(<TemplateEditor template={visualTpl({ content: UNSUPPORTED })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Email content')).toBeDisabled();
    expect(screen.getByText(LOCK_NOTE)).toBeInTheDocument();
    expect(screen.getByLabelText(/^subject$/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/^headline$/i)).not.toBeDisabled();
  });

  it('saves a subject change with the stored content unchanged, byte for byte', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    render(<TemplateEditor template={visualTpl({ content: UNSUPPORTED })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText(/^subject$/i));
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'New subject');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    expect(saveTemplate.mock.calls[0]![0]).toMatchObject({ subject: 'New subject', content: UNSUPPORTED });
  });

  it.each(['assignment.assigned', 'kincare.booking.confirm'])(
    'the loop seed %s opens editable, not locked',
    (key) => {
      render(<TemplateEditor template={visualTpl({ content: seedContent(key) })} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.getByLabelText('Email content')).not.toBeDisabled();
      expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    },
  );

  it('a new seed is the new baseline: the lock and the loop check follow it, not the first row', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'assignment.assigned' });
    const LOOPED = '<p>Your visits:</p><ul>{{#each visits}}<li>{{this.date}}</li>{{/each}}</ul>';
    const { rerender } = render(
      <TemplateEditor key="a" template={visualTpl({ content: UNSUPPORTED })} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByLabelText('Email content')).toBeDisabled();
    rerender(
      <TemplateEditor
        key="b"
        template={visualTpl({ templateId: 'assignment.assigned', content: LOOPED })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Email content')).not.toBeDisabled();
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    const edited = LOOPED.replace('{{this.date}}', '{{this.date}} (booked)');
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: edited } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    expect(saveTemplate.mock.calls[0]![0]).toMatchObject({ templateId: 'assignment.assigned', content: edited });
  });
});

describe('TemplateEditor: a repeating list cannot be lost or split on save (#953)', () => {
  const LOOP_ERROR =
    'This change would remove or split a repeating list ({{#each}}). Undo it, or edit the list items only.';

  const LOOPED = '<p>Your visits:</p><ul>{{#each visits}}<li>{{this.date}}</li>{{/each}}</ul>';

  it('refuses a save that drops the loop', async () => {
    render(<TemplateEditor template={visualTpl({ content: LOOPED })} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p>Your visits:</p><ul><li>x</li></ul>' } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(LOOP_ERROR)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('refuses a save that adds a lone closer (the loop would end early)', async () => {
    render(<TemplateEditor template={visualTpl({ content: LOOPED })} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email content'), {
      target: { value: LOOPED.replace('</li>', '</li><li>{{/each}}</li>') },
    });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(LOOP_ERROR)).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('lets an edit inside the loop through', async () => {
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    render(<TemplateEditor template={visualTpl({ content: LOOPED })} onClose={vi.fn()} onSaved={vi.fn()} />);
    const edited = LOOPED.replace('{{this.date}}', '{{this.date}} (booked)');
    fireEvent.change(screen.getByLabelText('Email content'), { target: { value: edited } });
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    expect(saveTemplate.mock.calls[0]![0]).toMatchObject({ content: edited });
  });
});

describe('TemplateEditor: a format this admin cannot edit (#953 C13)', () => {
  const foreign = () =>
    visualTpl({ format: 'blocks', subject: 'Stored subject', headline: 'Stored headline', content: '<p>x</p>' });

  it('opens read-only: subject and headline shown, no body editing, Save off, and a note', () => {
    render(<TemplateEditor template={foreign()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Stored subject');
    expect(screen.getByLabelText(/^subject$/i)).toBeDisabled();
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('Stored headline');
    expect(screen.getByLabelText(/^headline$/i)).toBeDisabled();
    expect(screen.queryByLabelText('Email content')).toBeNull();
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    expect(screen.queryByLabelText(/^html$/i)).toBeNull();
    expect(screen.getByRole('button', { name: /save template/i })).toBeDisabled();
    expect(screen.getByText(/can.t be edited here yet/i)).toBeInTheDocument();
  });

  it('still offers Delete, enabled: only editing is off', () => {
    render(<TemplateEditor template={foreign()} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });

  it('never calls saveTemplate', async () => {
    render(<TemplateEditor template={foreign()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(saveTemplate).not.toHaveBeenCalled();
    expect(previewEmailTemplate).not.toHaveBeenCalled();
  });
});

describe('TemplateEditor: old-format templates keep today’s editing (#953)', () => {
  it('an old-format template shows Body and HTML, and no Headline or visual editor', () => {
    render(<TemplateEditor template={tpl({ html: '<p>x</p>' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('Hi {{kinfolk_name}}');
    expect(screen.getByLabelText(/^html$/i)).toHaveValue('<p>x</p>');
    expect(screen.queryByLabelText(/^headline$/i)).toBeNull();
    expect(screen.queryByLabelText('Email content')).toBeNull();
  });
});
describe('TemplateEditor: converting an old-format template (#953)', () => {
  const OLD = () =>
    tpl({ templateId: 'auth.password.reset', subject: 'Reset', body: 'Hi {{displayName}}\n\nClick {{link}}', html: '<p>Hi</p>' });
  const ok = (over: Partial<{ subject: string; headline: string; content: string; warnings: string[] }> = {}) => ({
    ok: true as const,
    subject: 'Reset',
    headline: 'H',
    content: '<p>x</p>',
    warnings: [] as string[],
    ...over,
  });
  const LOOP_ERROR =
    'This change would remove or split a repeating list ({{#each}}). Undo it, or edit the list items only.';
  const LOCK_NOTE = 'This email has a structure the editor can’t edit yet. Edit its subject and headline here.';
  it('offers Convert on an old-format template, and not on a visual one', () => {
    const { unmount } = render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Old format')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeInTheDocument();
    unmount();
    render(<TemplateEditor template={visualTpl()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
  });
  it('does not offer Convert on a format this admin does not know', () => {
    render(<TemplateEditor template={visualTpl({ format: 'blocks' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
    expect(screen.queryByText('Old format')).toBeNull();
  });
  it('Convert is not offered while creating', () => {
    render(<TemplateEditor template={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
  });
  it('shows a busy Convert while the server converts', async () => {
    convertTemplateToVisual.mockReturnValue(new Promise(() => {}));
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    const busy = screen.getByRole('button', { name: 'Converting…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });
  it('shows old and converted side by side, and saves nothing until Save', async () => {
    convertTemplateToVisual.mockResolvedValue(ok({ headline: 'Reset your password', content: '<p>Hi {{displayName}}</p>' }));
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    const onSaved = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={onSaved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(convertTemplateToVisual).toHaveBeenCalledWith('auth.password.reset');
    expect(await screen.findByTitle('The old email')).toHaveAttribute('srcdoc', '<p>Hi</p>');
    expect(screen.getByRole('region', { name: 'Converted email' })).toBeInTheDocument();
    // The compare view replaces the form while it is up.
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Use the converted version' }));
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('Reset your password');
    expect(screen.getByLabelText('Email content')).toHaveValue('<p>Hi {{displayName}}</p>');
    expect(screen.getByLabelText('Email content')).not.toBeDisabled();
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    expect(screen.queryByLabelText(/^html$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
    expect(screen.getByText('Converted. Nothing is saved until you press Save template.')).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'visual', subject: 'Reset', headline: 'Reset your password', content: '<p>Hi {{displayName}}</p>' }),
      ),
    );
    const sent = saveTemplate.mock.calls[0]![0] as Record<string, unknown>;
    expect('body' in sent).toBe(false);
    expect('html' in sent).toBe(false);
    expect(onSaved).toHaveBeenCalledWith('auth.password.reset');
  });
  it('Save is off while the two versions are being compared', async () => {
    convertTemplateToVisual.mockResolvedValue(ok());
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await screen.findByRole('button', { name: 'Use the converted version' });
    expect(screen.getByRole('button', { name: /save template/i })).toBeDisabled();
  });
  it('takes the subject from the conversion', async () => {
    convertTemplateToVisual.mockResolvedValue(ok({ subject: 'Reset (converted)' }));
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Reset (converted)');
  });
  it('Keep the old format goes back to the untouched old fields', async () => {
    convertTemplateToVisual.mockResolvedValue(ok());
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep the old format' }));
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('Hi {{displayName}}\n\nClick {{link}}');
    expect(screen.getByLabelText(/^html$/i)).toHaveValue('<p>Hi</p>');
    expect(screen.queryByLabelText(/^headline$/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
    // Nothing was converted, so leaving does not ask.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('leaving after converting asks first; Leave closes without saving', async () => {
    convertTemplateToVisual.mockResolvedValue(ok());
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Email content')).toHaveValue('<p>x</p>');
    await userEvent.click(screen.getByText('Template bank'));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveTemplate).not.toHaveBeenCalled();
  });
  it('a saved conversion no longer asks before leaving', async () => {
    convertTemplateToVisual.mockResolvedValue(ok());
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /save template/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('a failed save after converting still asks before leaving', async () => {
    convertTemplateToVisual.mockResolvedValue(ok());
    saveTemplate.mockRejectedValue(new Error('offline'));
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('lists what the conversion could not keep, and still lets the operator save', async () => {
    const WARNING = 'Removed an image that is not from your Cloudinary library.';
    convertTemplateToVisual.mockResolvedValue(ok({ warnings: [WARNING] }));
    saveTemplate.mockResolvedValue({ templateId: 'auth.password.reset' });
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use the converted version' }));
    // The dropped image is never silent: the note stays above the editor.
    expect(screen.getByText(WARNING)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledWith(expect.objectContaining({ format: 'visual', content: '<p>x</p>' })));
  });
  it('an unreadable template opens in the editor with its plain text as paragraphs', async () => {
    convertTemplateToVisual.mockResolvedValue({
      ok: false,
      reason: 'unreadable',
      subject: 'Reset',
      body: 'Hi {{displayName}}\n\nClick {{link}}\nor copy it <here>',
    });
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByLabelText('Email content')).toHaveValue(
      '<p>Hi {{displayName}}</p><p>Click {{link}}<br>or copy it &lt;here&gt;</p>',
    );
    expect(screen.getByLabelText(/^headline$/i)).toHaveValue('');
    expect(
      screen.getByText('The old layout couldn’t be read, so its text is below. Add a headline and the formatting, then save.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^body$/i)).toBeNull();
    expect(saveTemplate).not.toHaveBeenCalled();
    // A blank headline is still the operator's to fill before Save goes through.
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText('Headline is required.')).toBeInTheDocument();
    expect(saveTemplate).not.toHaveBeenCalled();
    // And it is an unsaved conversion, so leaving asks.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('a failed convert shows the server’s words and keeps the old fields', async () => {
    const refusal = Object.assign(
      new Error('Image uploads are not configured on the server (CLOUDINARY_CLOUD_NAME).'),
      { code: 'functions/failed-precondition' },
    );
    convertTemplateToVisual.mockRejectedValue(refusal);
    const onClose = vi.fn();
    render(<TemplateEditor template={OLD()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(
      await screen.findByText('Image uploads are not configured on the server (CLOUDINARY_CLOUD_NAME).'),
    ).toBeInTheDocument();
    expect(screen.getByText('Couldn’t convert')).toBeInTheDocument();
    expect(screen.getByLabelText(/^body$/i)).toHaveValue('Hi {{displayName}}\n\nClick {{link}}');
    expect(screen.getByLabelText(/^html$/i)).toHaveValue('<p>Hi</p>');
    expect(screen.getByRole('button', { name: 'Convert' })).not.toBeDisabled();
    expect(saveTemplate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('a timed-out convert says so', async () => {
    convertTemplateToVisual.mockRejectedValue(new Error('convertTemplateToVisual took too long to respond.'));
    render(<TemplateEditor template={OLD()} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('convertTemplateToVisual took too long to respond.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^body$/i)).toBeInTheDocument();
  });
  it('with no notification sending it, the field list follows the converted content, not the old body', async () => {
    getNotificationMatrix.mockResolvedValue({ catalog: [], overrides: {}, ungated: [], businessAdminCount: null, businessAdminRosterPath: '', updatedAtMs: null });
    convertTemplateToVisual.mockResolvedValue(ok({ subject: 'Hello', headline: 'Hi {{kinName}}', content: '<p><a href="{{portalUrl}}">Open</a></p>' }));
    render(
      <TemplateEditor
        template={tpl({ templateId: 'custom.note', subject: 'Hello', body: 'Old {{oldOnly}}', html: '<p>Old {{oldOnly}}</p>' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
    await waitFor(() => expect(screen.getByLabelText('Email content')).toHaveAttribute('data-fields', 'kinName,portalUrl'));
  });
  describe('the real assignment.assigned, stored in the old format', () => {
    // The seed as it was stored before the seeds moved to the visual format
    // (git 5cc2c68^), and the content the converter made of it (the seed today).
    const OLD_TEXT =
      "Good news: {{kinName}}'s {{serviceType}} just landed on your schedule. Here are the days:\n\n" +
      '{{#each visits}}  {{this.weekday}}, {{this.date}} at {{this.time}}\n{{/each}}\n' +
      "Give the details a look so you're set before you head out.\n\nTribe Tails Pet Care. Your Kin's Favorite Auntie.";
    const OLD_HTML =
      '<!DOCTYPE html><html><head><style>.visits { list-style: none; }</style></head><body><div class="container">' +
      "<div class=\"header\"><h2>{{kinName}}'s KinCare is yours</h2></div><div class=\"content\">" +
      "<p>Good news: {{kinName}}'s {{serviceType}} just landed on your schedule. Here are the days:</p>" +
      '<ul class="visits">{{#each visits}}\n                <li>{{this.weekday}}, {{this.date}} at {{this.time}}</li>{{/each}}\n            </ul>' +
      "<p>Give the details a look so you're set before you head out.</p>" +
      '<p><a class="button" href="{{portalUrl}}">See your schedule</a></p></div>' +
      "<div class=\"footer\">Tribe Tails Pet Care. Your Kin's Favorite Auntie.</div></div></body></html>";
    const oldRow = () =>
      tpl({ templateId: 'assignment.assigned', subject: "{{kinName}}'s KinCare is yours", body: OLD_TEXT, html: OLD_HTML });
    const converted = () =>
      ok({ subject: "{{kinName}}'s KinCare is yours", headline: "{{kinName}}'s KinCare is yours", content: seedContent('assignment.assigned') });
    it('converts to an editable body, and an edit inside the loop saves with no loop error', async () => {
      convertTemplateToVisual.mockResolvedValue(converted());
      saveTemplate.mockResolvedValue({ templateId: 'assignment.assigned' });
      render(<TemplateEditor template={oldRow()} onClose={vi.fn()} onSaved={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
      expect(screen.getByLabelText('Email content')).not.toBeDisabled();
      expect(screen.queryByText(LOCK_NOTE)).toBeNull();
      const edited = seedContent('assignment.assigned').replace('{{this.time}}', '{{this.time}} (booked)');
      fireEvent.change(screen.getByLabelText('Email content'), { target: { value: edited } });
      await userEvent.click(screen.getByRole('button', { name: /save template/i }));
      await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(LOOP_ERROR)).toBeNull();
      expect(saveTemplate.mock.calls[0]![0]).toMatchObject({ templateId: 'assignment.assigned', format: 'visual', content: edited });
    });
    it('saves the converted loop unchanged when only the subject is touched', async () => {
      convertTemplateToVisual.mockResolvedValue(converted());
      saveTemplate.mockResolvedValue({ templateId: 'assignment.assigned' });
      render(<TemplateEditor template={oldRow()} onClose={vi.fn()} onSaved={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
      await userEvent.type(screen.getByLabelText(/^subject$/i), '!');
      await userEvent.click(screen.getByRole('button', { name: /save template/i }));
      await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(1));
      expect(saveTemplate.mock.calls[0]![0]).toMatchObject({ content: seedContent('assignment.assigned') });
    });
    it('still refuses a save that drops the converted loop', async () => {
      convertTemplateToVisual.mockResolvedValue(converted());
      render(<TemplateEditor template={oldRow()} onClose={vi.fn()} onSaved={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Use the converted version' }));
      fireEvent.change(screen.getByLabelText('Email content'), { target: { value: '<p>No list any more</p>' } });
      await userEvent.click(screen.getByRole('button', { name: /save template/i }));
      expect(await screen.findByText(LOOP_ERROR)).toBeInTheDocument();
      expect(saveTemplate).not.toHaveBeenCalled();
    });
  });
});
