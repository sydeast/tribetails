// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { TemplateSummary } from '../api/templates';
import type { TemplateChannels } from '../api/templateChannels';
import { ToastProvider } from '../components/Toast';

/**
 * #1935: the Text message and Push notification tabs of the template editor.
 * The email side of the screen is pinned in TemplateEditor.test.tsx; this file
 * is only the channel switch and the two panels behind it.
 */
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

const { getTemplateChannels, saveTemplateChannels } = vi.hoisted(() => ({
  getTemplateChannels: vi.fn(),
  saveTemplateChannels: vi.fn(),
}));
// `wordingErrorsFrom` is the real one, so the screen's reading of a refusal is
// the production reading and not a stub that agrees with itself.
vi.mock('../api/templateChannels', async () => {
  const actual = await vi.importActual<typeof import('../api/templateChannels')>('../api/templateChannels');
  return { getTemplateChannels, saveTemplateChannels, wordingErrorsFrom: actual.wordingErrorsFrom };
});

const { saveTemplate } = vi.hoisted(() => ({ saveTemplate: vi.fn() }));
vi.mock('../api/templatesWrite', () => ({
  saveTemplate,
  deleteTemplate: vi.fn(),
  previewEmailTemplate: vi.fn().mockResolvedValue({ subject: 'S', html: '<html></html>', text: 'T', issues: [] }),
  convertTemplateToVisual: vi.fn(),
  isLiveNotificationKeyWarning: () => false,
  isTemplateKeyTakenError: () => false,
}));
vi.mock('../api/myNotifications', () => ({
  getNotificationMatrix: vi.fn().mockResolvedValue({
    catalog: [],
    overrides: {},
    ungated: [],
    businessAdminCount: null,
    businessAdminRosterPath: '',
    updatedAtMs: null,
  }),
}));
vi.mock('../components/emailEditor/EmailContentEditor', () => ({
  EmailContentEditor: (p: { initialContent: string; onChange: (c: string) => void }) => (
    <textarea aria-label="Email content" defaultValue={p.initialContent} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));

import { TemplateEditor } from './TemplateEditor';

const KEY = 'kincare.booking.confirm';

function tpl(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    templateId: KEY,
    subject: 'Your booking is confirmed',
    body: '',
    html: null,
    title: 'Booking confirmed',
    description: null,
    tags: [],
    category: null,
    usageInstructions: '',
    sectionDefinitions: [],
    format: 'visual',
    headline: 'Confirmed',
    content: '<p>Hi</p>',
    ...over,
  };
}

function channels(over: Partial<TemplateChannels> = {}): TemplateChannels {
  return {
    templateId: KEY,
    notificationLabel: 'KinCare booking confirmed',
    fields: ['kinName', 'serviceType'],
    sms: { supported: true, set: true, text: 'Booked for {{kinName}}.', maxLength: 1600 },
    push: { supported: true, set: true, title: 'Booked', body: 'Tap to see it.', titleMaxLength: 100, bodyMaxLength: 500 },
    ...over,
  };
}

/** A refusal shaped like the SDK's: an Error carrying the server's `details`. */
function refusal(fieldErrors: Record<string, string>): Error {
  return Object.assign(new Error(Object.values(fieldErrors).join(' ')), {
    code: 'functions/invalid-argument',
    details: { reason: 'template-wording-refused', fieldErrors },
  });
}

const tab = (name: string) => screen.getByRole('tab', { name });
// The tab panel is named by its tab, so "Text message" labels the panel as
// well as the box inside it. The box is asked for as the textarea it is.
const SMS_BOX = { selector: 'textarea' } as const;
const findSmsBox = () => screen.findByLabelText('Text message', SMS_BOX);
const smsBox = () => screen.getByLabelText('Text message', SMS_BOX);
const querySmsBox = () => screen.queryByLabelText('Text message', SMS_BOX);
const panel = (channel: 'sms' | 'push' | 'email') =>
  document.getElementById(`template-channel-panel-${channel}`) as HTMLElement;

function open(template: TemplateSummary | null = tpl()) {
  return render(<TemplateEditor template={template} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />);
}

beforeEach(() => {
  getTemplateChannels.mockReset().mockResolvedValue(channels());
  saveTemplateChannels.mockReset();
  saveTemplate.mockReset();
});

describe('the channel switch', () => {
  it('does not ask for the text or push wording until one of those tabs is opened', async () => {
    open();
    expect(getTemplateChannels).not.toHaveBeenCalled();
    fireEvent.click(tab('Text message'));
    await waitFor(() => expect(getTemplateChannels).toHaveBeenCalledWith(KEY));
    fireEvent.click(tab('Push notification'));
    fireEvent.click(tab('Email'));
    // One read serves both tabs, however often they are switched.
    expect(getTemplateChannels).toHaveBeenCalledTimes(1);
  });

  it('shows one channel at a time and names the page for it', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Email template');
    expect(panel('email').hidden).toBe(false);

    fireEvent.click(tab('Text message'));
    expect(tab('Text message')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Text message template');
    expect(panel('email').hidden).toBe(true);
    expect(panel('sms').hidden).toBe(false);
    expect(panel('push').hidden).toBe(true);

    fireEvent.click(tab('Push notification'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Push notification template');
    expect(panel('sms').hidden).toBe(true);
    expect(panel('push').hidden).toBe(false);
  });

  it('keeps the email Save and Delete off the other two tabs, and Cancel on all three', () => {
    open();
    const names = () =>
      Array.from(document.querySelector('.den-heading-trailing')!.querySelectorAll('button')).map((b) =>
        b.textContent?.trim(),
      );
    expect(names()).toEqual(['Cancel', 'Delete', 'Save template']);
    fireEvent.click(tab('Text message'));
    expect(names()).toEqual(['Cancel']);
    fireEvent.click(tab('Email'));
    expect(names()).toEqual(['Cancel', 'Delete', 'Save template']);
  });

  it('keeps an email edit and a text draft through a round of tab switches', async () => {
    open();
    fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: 'Edited subject' } });
    fireEvent.click(tab('Text message'));
    const box = await findSmsBox();
    fireEvent.change(box, { target: { value: 'A draft.' } });
    fireEvent.click(tab('Push notification'));
    fireEvent.click(tab('Email'));
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Edited subject');
    fireEvent.click(tab('Text message'));
    expect(smsBox()).toHaveValue('A draft.');
  });

  it('a read-only email does not lock the text message', async () => {
    open(tpl({ format: 'something-newer' }));
    expect(screen.getByText(/can.t be edited here yet/i)).toBeInTheDocument();
    fireEvent.click(tab('Text message'));
    const box = await findSmsBox();
    expect(box).not.toBeDisabled();
  });
});

describe('reading the wording', () => {
  it('shows a loading cue until the wording arrives', async () => {
    let resolve!: (c: TemplateChannels) => void;
    getTemplateChannels.mockReturnValue(new Promise<TemplateChannels>((r) => (resolve = r)));
    open();
    fireEvent.click(tab('Text message'));
    expect(within(panel('sms')).getByRole('status')).toHaveTextContent('Loading…');
    resolve(channels());
    expect(await findSmsBox()).toHaveValue('Booked for {{kinName}}.');
    expect(within(panel('sms')).queryByRole('status')).toBeNull();
  });

  it('shows the stored text message with its count against the server limit', async () => {
    open();
    fireEvent.click(tab('Text message'));
    expect(await findSmsBox()).toHaveValue('Booked for {{kinName}}.');
    expect(within(panel('sms')).getByText('23 of 1600 characters')).toBeInTheDocument();
  });

  it('says how many texts the message sends as, and updates while typing', async () => {
    open();
    fireEvent.click(tab('Text message'));
    const box = await findSmsBox();
    expect(screen.getByTestId('template-channel-sms-segments')).toHaveTextContent('Sends as 1 text.');
    fireEvent.change(box, { target: { value: 'a'.repeat(200) } });
    expect(screen.getByTestId('template-channel-sms-segments')).toHaveTextContent('Sends as 2 texts.');
    fireEvent.change(box, { target: { value: 'See you soon 🐾' } });
    expect(screen.getByTestId('template-channel-sms-segments')).toHaveTextContent(
      'Sends as 1 text. An emoji or special character makes each text shorter.',
    );
    fireEvent.change(box, { target: { value: '  ' } });
    expect(screen.queryByTestId('template-channel-sms-segments')).toBeNull();
  });

  it('half-written push wording opens to be finished, not as "Not set"', async () => {
    getTemplateChannels.mockResolvedValue(
      channels({
        push: { supported: true, set: false, title: 'Booked', body: '', titleMaxLength: 100, bodyMaxLength: 500 },
      }),
    );
    open();
    fireEvent.click(tab('Push notification'));
    expect(await screen.findByLabelText('Title')).toHaveValue('Booked');
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.queryByTestId('template-channel-push-notset')).toBeNull();
  });

  it('shows the stored push title and message', async () => {
    open();
    fireEvent.click(tab('Push notification'));
    expect(await screen.findByLabelText('Title')).toHaveValue('Booked');
    expect(screen.getByLabelText('Message')).toHaveValue('Tap to see it.');
    expect(within(panel('push')).getByText('6 of 100 characters')).toBeInTheDocument();
    expect(within(panel('push')).getByText('14 of 500 characters')).toBeInTheDocument();
  });

  it('a failed read says so and can be tried again', async () => {
    getTemplateChannels.mockRejectedValueOnce(new Error('The server could not be reached. Try again in a moment.'));
    open();
    fireEvent.click(tab('Text message'));
    expect(await within(panel('sms')).findByText(/could not be reached/)).toBeInTheDocument();
    fireEvent.click(within(panel('sms')).getByRole('button', { name: 'Try again' }));
    expect(await findSmsBox()).toHaveValue('Booked for {{kinName}}.');
    expect(getTemplateChannels).toHaveBeenCalledTimes(2);
  });

  it('never prints a stored key or a developer word for a channel', async () => {
    open();
    fireEvent.click(tab('Text message'));
    await findSmsBox();
    fireEvent.click(tab('Push notification'));
    for (const el of [panel('sms'), panel('push'), document.querySelector('.template-editor__strip')!]) {
      expect(el.textContent).not.toMatch(/\bsms\b|smsTemplates|pushTemplates|handlebars|kincare\.booking/i);
      expect(el.textContent).not.toContain('—');
    }
  });
});

describe('a channel with no wording', () => {
  it('not set, and the notification can send it: offers to add it', async () => {
    getTemplateChannels.mockResolvedValue(
      channels({ sms: { supported: true, set: false, text: '', maxLength: 1600 } }),
    );
    open();
    fireEvent.click(tab('Text message'));
    const notSet = await screen.findByTestId('template-channel-sms-notset');
    expect(notSet).toHaveTextContent('Not set');
    expect(querySmsBox()).toBeNull();
    fireEvent.click(within(notSet).getByRole('button', { name: 'Add text message' }));
    expect(smsBox()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save text message' })).toBeInTheDocument();
  });

  it('no notification sends this template: says why and offers nothing to add', async () => {
    getTemplateChannels.mockResolvedValue(
      channels({
        notificationLabel: null,
        fields: [],
        sms: { supported: false, set: false, text: '', maxLength: 1600 },
        push: { supported: false, set: false, title: '', body: '', titleMaxLength: 100, bodyMaxLength: 500 },
      }),
    );
    open();
    fireEvent.click(tab('Text message'));
    const sms = await screen.findByTestId('template-channel-sms-notset');
    expect(sms).toHaveTextContent('Not set');
    expect(sms).toHaveTextContent('No notification sends this template, so it has no text message.');
    expect(within(sms).queryByRole('button')).toBeNull();
    fireEvent.click(tab('Push notification'));
    const push = screen.getByTestId('template-channel-push-notset');
    expect(push).toHaveTextContent('No notification sends this template, so it has no push notification.');
    expect(within(push).queryByRole('button')).toBeNull();
  });

  it('a notification that is not sent this way: says so and offers nothing to add', async () => {
    getTemplateChannels.mockResolvedValue(
      channels({ push: { supported: false, set: false, title: '', body: '', titleMaxLength: 100, bodyMaxLength: 500 } }),
    );
    open();
    fireEvent.click(tab('Push notification'));
    const push = await screen.findByTestId('template-channel-push-notset');
    expect(push).toHaveTextContent('This notification is not sent as a push notification.');
    expect(within(push).queryByRole('button')).toBeNull();
  });

  it('a new template asks to be saved first and never calls the server', () => {
    open(null);
    fireEvent.click(tab('Text message'));
    expect(screen.getByTestId('template-channel-sms-notset')).toHaveTextContent('Save this template first.');
    fireEvent.click(tab('Push notification'));
    expect(screen.getByTestId('template-channel-push-notset')).toHaveTextContent('Save this template first.');
    expect(getTemplateChannels).not.toHaveBeenCalled();
  });
});

describe('saving the wording', () => {
  it('HAPPY: saves only the text message, shows the saving state, then the saved copy', async () => {
    let resolve!: (c: TemplateChannels) => void;
    saveTemplateChannels.mockReturnValue(new Promise<TemplateChannels>((r) => (resolve = r)));
    open();
    fireEvent.click(tab('Text message'));
    fireEvent.change(await findSmsBox(), { target: { value: '  New words.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save text message' }));

    expect(saveTemplateChannels).toHaveBeenCalledWith({ templateId: KEY, sms: { text: '  New words.  ' } });
    const busy = screen.getByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(smsBox()).toBeDisabled();

    resolve(channels({ sms: { supported: true, set: true, text: 'New words.', maxLength: 1600 } }));
    expect(await screen.findByText('Text message saved.')).toBeInTheDocument();
    expect(smsBox()).toHaveValue('New words.');
    expect(smsBox()).not.toBeDisabled();
    // The email was never part of it.
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('HAPPY: saves only the push notification and leaves a text draft alone', async () => {
    saveTemplateChannels.mockResolvedValue(
      channels({ push: { supported: true, set: true, title: 'All set', body: 'See you soon.', titleMaxLength: 100, bodyMaxLength: 500 } }),
    );
    open();
    fireEvent.click(tab('Text message'));
    fireEvent.change(await findSmsBox(), { target: { value: 'Unsaved draft.' } });
    fireEvent.click(tab('Push notification'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'All set' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'See you soon.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save push notification' }));

    await screen.findByText('Push notification saved.');
    expect(saveTemplateChannels).toHaveBeenCalledWith({
      templateId: KEY,
      push: { title: 'All set', body: 'See you soon.' },
    });
    expect(smsBox()).toHaveValue('Unsaved draft.');
  });

  it('SAD: an empty text message is caught at the field without a round trip', async () => {
    open();
    fireEvent.click(tab('Text message'));
    const box = await findSmsBox();
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save text message' }));
    expect(within(panel('sms')).getByRole('alert')).toHaveTextContent('Text message cannot be empty.');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box.getAttribute('aria-describedby')).toContain('template-channel-smsText-error');
    expect(saveTemplateChannels).not.toHaveBeenCalled();
  });

  it('SAD: a push title over the server limit is caught with both numbers', async () => {
    open();
    fireEvent.click(tab('Push notification'));
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save push notification' }));
    expect(within(panel('push')).getByRole('alert')).toHaveTextContent('Title is 101 characters. The limit is 100.');
    expect(saveTemplateChannels).not.toHaveBeenCalled();
  });

  it('SAD: a server refusal lands beside each field it names, and typing clears it', async () => {
    saveTemplateChannels.mockRejectedValue(
      refusal({
        pushTitle: '{{nope}} is not a field this notification fills in. You can use {{kinName}}, {{serviceType}}.',
        pushBody: 'Use two curly brackets around a field, like {{kinName}}, not three.',
      }),
    );
    open();
    fireEvent.click(tab('Push notification'));
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Hi {{nope}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save push notification' }));

    const title = await screen.findByText(/\{\{nope\}\} is not a field this notification fills in/);
    expect(title).toHaveAttribute('id', 'template-channel-pushTitle-error');
    expect(screen.getByText(/two curly brackets/)).toHaveAttribute('id', 'template-channel-pushBody-error');
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true');
    // The save button is usable again: the refusal is not a stuck spinner.
    expect(screen.getByRole('button', { name: 'Save push notification' })).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Hi' } });
    expect(screen.queryByText(/\{\{nope\}\} is not a field/)).toBeNull();
    expect(screen.getByText(/two curly brackets/)).toBeInTheDocument();
  });

  it('ERROR: a failure that names no field shows by the Save button and keeps the draft', async () => {
    saveTemplateChannels.mockRejectedValue(
      Object.assign(new Error('Your account is not allowed to do this.'), { code: 'functions/permission-denied' }),
    );
    open();
    fireEvent.click(tab('Text message'));
    fireEvent.change(await findSmsBox(), { target: { value: 'Kept.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save text message' }));
    expect(await within(panel('sms')).findByRole('alert')).toHaveTextContent('Your account is not allowed to do this.');
    expect(smsBox()).toHaveValue('Kept.');
    expect(screen.queryByText('Text message saved.')).toBeNull();
  });

  it('a field chip drops its name into the box the operator was last in', async () => {
    open();
    fireEvent.click(tab('Push notification'));
    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    const chips = within(panel('push')).getByRole('group', { name: 'Fields you can use' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['+{{kinName}}', '+{{serviceType}}']);

    // Nothing focused yet: it goes on the end of the message.
    fireEvent.click(within(chips).getByRole('button', { name: /kinName/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('Tap to see it.{{kinName}}');

    title.focus();
    title.setSelectionRange(0, 0);
    fireEvent.click(within(chips).getByRole('button', { name: /serviceType/ }));
    expect(title).toHaveValue('{{serviceType}}Booked');
  });
});
