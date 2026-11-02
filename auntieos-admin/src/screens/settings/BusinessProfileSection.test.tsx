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

// A stored name, because the name is required (#1409): a blank one keeps Save
// off and shows its own refusal line, which the cases below pin separately.
function settings(over: Partial<BusinessSettings> = {}): BusinessSettings {
  return { ...DEFAULT_BUSINESS_SETTINGS, businessName: 'Tribe Tails', timeZone: 'America/New_York', ...over };
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
    await user.clear(name);
    await user.type(name, '  Padded  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Padded' }));
  });

  describe('the business name is required (#1409)', () => {
    it('is the one required field, marked for assistive tech', () => {
      render(<BusinessProfileSection data={settings()} onSave={onSave} />);
      expect(screen.getByLabelText('Business name')).toHaveAttribute('aria-required', 'true');
      expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-required');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the refusal on open when the stored name is blank, and keeps Save off even after another field changes', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={settings({ businessName: '' })} onSave={onSave} />);
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the business name.');
      expect(screen.getByLabelText('Business name')).toHaveAttribute('aria-invalid', 'true');

      await user.type(screen.getByLabelText('Phone'), '555-0199');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).not.toHaveBeenCalled();

      // Filling the name in is what lights Save.
      await user.type(screen.getByLabelText('Business name'), 'Sunny Paws');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Sunny Paws', businessPhone: '555-0199' }));
    });

    it('clearing a saved name, or replacing it with spaces, blocks Save and says why', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={settings({ businessName: 'Old' })} onSave={onSave} />);
      const name = screen.getByLabelText('Business name');

      await user.clear(name);
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the business name.');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

      await user.type(name, '   ');
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the business name.');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).not.toHaveBeenCalled();

      await user.clear(name);
      await user.type(name, 'New');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
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

  describe('the privacy policy link (#1410)', () => {
    it('is one of the profile fields, blank until set, and saves a full https link trimmed', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={settings()} onSave={onSave} />);
      const link = screen.getByLabelText('Privacy policy link');
      expect(link).toHaveValue('');
      await user.type(link, '  https://example.com/privacy  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ privacyPolicyUrl: 'https://example.com/privacy' }));
    });

    it('blocks Save and says why while the link is not a full https link', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={settings()} onSave={onSave} />);
      const link = screen.getByLabelText('Privacy policy link');
      await user.type(link, 'http://example.com/privacy');
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a full https:// link.');
      expect(link).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).not.toHaveBeenCalled();

      // Fixing the scheme clears the refusal and lights Save again.
      await user.clear(link);
      await user.type(link, 'https://example.com/privacy');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('clearing a saved link is a real edit, written as blank', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={settings({ privacyPolicyUrl: 'https://example.com/privacy' })} onSave={onSave} />);
      await user.clear(screen.getByLabelText('Privacy policy link'));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ privacyPolicyUrl: '' }));
    });
  });

  describe('a business with no time zone saved (#1109)', () => {
    const unset = () => settings({ timeZone: '' });
    it('says so as something to fix, naming the zone everything reads meanwhile', () => {
      render(<BusinessProfileSection data={unset()} onSave={onSave} />);
      expect(screen.getByText('Set your business time zone')).toBeInTheDocument();
      expect(screen.getByText(/read in America\/Chicago until you pick one/)).toBeInTheDocument();
      expect(screen.getByLabelText('Business time zone')).toHaveValue('');
      // Not the "unusable zone" warning: nothing is wrong with a zone nobody chose.
      expect(screen.queryByText('This zone will not work')).toBeNull();
    });
    it('does not show the warning once a zone is saved', () => {
      render(<BusinessProfileSection data={settings()} onSave={onSave} />);
      expect(screen.queryByText('Set your business time zone')).toBeNull();
    });
    it('still saves another field, without writing a blank zone over the document', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={unset()} onSave={onSave} />);
      await user.type(screen.getByLabelText('Business name'), 'X');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0]![0]).not.toHaveProperty('timeZone');
    });
    it('saves the zone once one is picked', async () => {
      const user = userEvent.setup();
      render(<BusinessProfileSection data={unset()} onSave={onSave} />);
      await user.selectOptions(screen.getByLabelText('Business time zone'), 'America/Chicago');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'America/Chicago' }));
    });
  });
});
