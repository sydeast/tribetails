// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BUSINESS_SETTINGS, type BusinessSettings } from '../../api/settings';
import { BusinessProfileSection } from './BusinessProfileSection';

/**
 * ISSUE #709: the time zone picker used to be `TimeZoneSection`, its own
 * panel with its own Save/Cancel. These cases carry that coverage forward
 * onto the merged panel, plus the cases that pin the merge itself: one patch,
 * one dirty check, one Save button gated on both halves.
 */

const onSave = vi.fn();

beforeEach(() => {
  onSave.mockReset().mockResolvedValue(undefined);
});

function settings(over: Partial<BusinessSettings> = {}): BusinessSettings {
  return { ...DEFAULT_BUSINESS_SETTINGS, ...over };
}

describe('BusinessProfileSection', () => {
  it('sends nothing until something changes', () => {
    render(<BusinessProfileSection data={settings()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves an edited text field alongside the unchanged time zone', async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSection data={settings({ businessName: 'Old' })} onSave={onSave} />);

    const name = screen.getByLabelText('Business name');
    await user.clear(name);
    await user.type(name, 'New Name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'New Name', timeZone: 'America/New_York' }),
    );
  });

  it('saves the picked zone alongside the unedited text fields', async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSection data={settings()} onSave={onSave} />);

    await user.selectOptions(screen.getByLabelText('Business time zone'), 'America/Chicago');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'America/Chicago' }));
  });

  it('offers a stored zone the runtime does not know, and warns instead of saving it silently', () => {
    render(<BusinessProfileSection data={settings({ timeZone: 'Mars/Olympus' })} onSave={onSave} />);
    expect(screen.getByLabelText('Business time zone')).toHaveValue('Mars/Olympus');
    expect(screen.getByText(/the phone line answers as open around the clock/)).toBeInTheDocument();
  });

  it('blocks the whole panel Save while the loaded zone is unusable, even once another field changes', async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSection data={settings({ timeZone: 'Mars/Olympus' })} onSave={onSave} />);

    await user.type(screen.getByLabelText('Business name'), 'X');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Cancel reverts both the text fields and the time zone together', async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSection data={settings({ businessName: 'Original' })} onSave={onSave} />);

    const name = screen.getByLabelText('Business name');
    await user.clear(name);
    await user.type(name, 'Changed');
    await user.selectOptions(screen.getByLabelText('Business time zone'), 'America/Chicago');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Business name')).toHaveValue('Original');
    expect(screen.getByLabelText('Business time zone')).toHaveValue('America/New_York');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('trims saved text values', async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSection data={settings()} onSave={onSave} />);
    const name = screen.getByLabelText('Business name');
    await user.type(name, '  Padded  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Padded' }));
  });

  it('shows a fail-loud error and keeps the field dirty when the save rejects', async () => {
    const user = userEvent.setup();
    onSave.mockRejectedValue(new Error('permission-denied'));
    render(<BusinessProfileSection data={settings()} onSave={onSave} />);
    await user.type(screen.getByLabelText('Business name'), 'X');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('permission-denied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
