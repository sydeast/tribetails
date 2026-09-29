// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * #957: the Email frame section. Asserted on what reaches the callables, not
 * on labels alone: a field wired to nothing would pass a render-only test.
 */
const api = vi.hoisted(() => ({
  getEmailFrame: vi.fn(),
  saveEmailFrame: vi.fn(),
  resetEmailFrame: vi.fn(),
  previewEmailFrame: vi.fn(),
  uploadEmailImage: vi.fn(),
}));
vi.mock('../../api/emailFrame', async (orig) => ({
  ...(await orig<typeof import('../../api/emailFrame')>()),
  getEmailFrame: api.getEmailFrame,
  saveEmailFrame: api.saveEmailFrame,
  resetEmailFrame: api.resetEmailFrame,
  previewEmailFrame: api.previewEmailFrame,
}));
vi.mock('../../api/emailImageUpload', () => ({ uploadEmailImage: api.uploadEmailImage }));

import { EmailFrameSection } from './EmailFrameSection';

const DEFAULTS = {
  pageBackground: '#fbfbf9',
  cardBackground: '#ffffff',
  textColor: '#11131f',
  headlineColor: '#11131f',
  accentColor: '#df8431',
  buttonTextColor: '#ffffff',
  calloutBackground: '#fff5f5',
  footerBackground: '#11131f',
  footerTextColor: '#fbfbf9',
  headerText: '',
  footerText: "Tribe Tails Pet Care. Your Kin's Favorite Auntie.",
  logoUrl: '',
};

function state(stored: Record<string, string> = {}, updatedAt: string | null = null) {
  return { stored, defaults: DEFAULTS, updatedAt, updatedBy: updatedAt ? 'owner@x.test' : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.previewEmailFrame.mockResolvedValue({ subject: 'Your visit is booked', html: '<p>rendered</p>', text: 'T' });
});

describe('Email frame section', () => {
  it('shows stored values as values and defaults as placeholders', async () => {
    api.getEmailFrame.mockResolvedValue(state({ accentColor: '#123456' }));
    render(<EmailFrameSection />);
    const accent = await screen.findByLabelText('Accent hex');
    expect(accent).toHaveValue('#123456');
    const text = screen.getByLabelText('Text hex');
    expect(text).toHaveValue('');
    expect(text).toHaveAttribute('placeholder', '#11131f');
    const footer = screen.getByRole('textbox', { name: 'Footer line' });
    expect(footer).toHaveValue('');
    expect(footer).toHaveAttribute('placeholder', DEFAULTS.footerText);
    expect(screen.getByText('Using the default frame')).toBeInTheDocument();
  });

  it('renders the server preview for the loaded frame, with a loading cue first', async () => {
    api.getEmailFrame.mockResolvedValue(state());
    render(<EmailFrameSection />);
    expect(await screen.findByText('Updating preview…')).toBeInTheDocument();
    await waitFor(() => expect(api.previewEmailFrame).toHaveBeenCalledWith({}));
    await waitFor(() => expect(screen.getByTitle('The email as it will be sent')).toHaveAttribute('srcdoc', '<p>rendered</p>'));
  });

  it('Save sends only the changed fields, and a cleared field as null', async () => {
    api.getEmailFrame.mockResolvedValue(state({ accentColor: '#123456', footerText: 'Old line' }));
    api.saveEmailFrame.mockResolvedValue(state({ footerText: 'New line' }, '2026-09-28T02:00:00.000Z'));
    const user = userEvent.setup();
    render(<EmailFrameSection />);
    const footer = await screen.findByRole('textbox', { name: 'Footer line' });
    await user.clear(footer);
    await user.type(footer, 'New line');
    const accentRow = screen.getByLabelText('Accent hex').closest('li')!;
    await user.click(within(accentRow).getByRole('button', { name: 'Default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveEmailFrame).toHaveBeenCalledWith({ footerText: 'New line', accentColor: null }));
    expect(await screen.findByText('Saved. The next email sent uses it.')).toBeInTheDocument();
  });

  it('Save stays off until something changes, and while a field is invalid', async () => {
    api.getEmailFrame.mockResolvedValue(state());
    const user = userEvent.setup();
    render(<EmailFrameSection />);
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Accent hex'), 'orange');
    expect(screen.getByRole('alert')).toHaveTextContent('Use a color like #df8431.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a save failure and keeps the draft', async () => {
    api.getEmailFrame.mockResolvedValue(state());
    api.saveEmailFrame.mockRejectedValue(new Error('The logo must be an image uploaded to the business library.'));
    const user = userEvent.setup();
    render(<EmailFrameSection />);
    const header = await screen.findByRole('textbox', { name: 'Header line' });
    await user.type(header, 'Tribe Tails');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The logo must be an image uploaded to the business library.')).toBeInTheDocument();
    expect(header).toHaveValue('Tribe Tails');
  });

  it('Reset asks first, then resets every field through the callable', async () => {
    api.getEmailFrame.mockResolvedValue(state({ accentColor: '#123456' }, '2026-09-28T01:00:00.000Z'));
    api.resetEmailFrame.mockResolvedValue(state({}, '2026-09-28T02:00:00.000Z'));
    const user = userEvent.setup();
    render(<EmailFrameSection />);
    await user.click(await screen.findByRole('button', { name: 'Reset to default' }));
    expect(api.resetEmailFrame).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(api.resetEmailFrame).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Back to the default frame.')).toBeInTheDocument();
    expect(screen.getByLabelText('Accent hex')).toHaveValue('');
  });

  it('Reset is off when nothing is stored', async () => {
    api.getEmailFrame.mockResolvedValue(state());
    render(<EmailFrameSection />);
    expect(await screen.findByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('a logo upload goes into the draft and is saved as logoUrl', async () => {
    const url = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png';
    api.getEmailFrame.mockResolvedValue(state());
    api.uploadEmailImage.mockResolvedValue(url);
    api.saveEmailFrame.mockResolvedValue(state({ logoUrl: url }, '2026-09-28T02:00:00.000Z'));
    const user = userEvent.setup();
    render(<EmailFrameSection />);
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    await user.upload(await screen.findByLabelText('Choose a logo image'), file);
    expect(await screen.findByAltText('Email logo')).toHaveAttribute('src', url);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveEmailFrame).toHaveBeenCalledWith({ logoUrl: url }));
  });

  it('a failed load offers a retry', async () => {
    api.getEmailFrame.mockRejectedValueOnce(new Error('permission-denied')).mockResolvedValue(state());
    const user = userEvent.setup();
    render(<EmailFrameSection />);
    expect(await screen.findByText(/Couldn't read the email frame/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByLabelText('Accent hex')).toBeInTheDocument();
  });
});
