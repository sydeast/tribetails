// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BUSINESS_SETTINGS, mergeBusinessSettings, type BusinessSettings } from '../../api/settings';
import { PhoneLineSection } from './PhoneLineSection';

/**
 * ISSUE #397: the operator's on/off switch for the press-3 live transfer.
 *
 * The rule underneath the state cases is that ABSENT IS ON. The live connect
 * path has been in the deployed handler since PR #351 and no settings document
 * has ever carried this field, so a panel that read a missing field as "off"
 * would tell the operator she had switched off something she never touched, and
 * the switch would disagree with the phone.
 *
 * The rule underneath the copy cases is that this panel promises nothing it
 * cannot know. The Twilio voice credentials are placeholders and the business
 * number's forwarding is not set up, so "on" means the greeting offers the
 * transfer, never that a caller gets through. The disclosure is asserted here
 * rather than left to review, because a screen quietly claiming a working phone
 * line is the exact failure the twilioVoice rewrite exists to stop repeating.
 */
function settings(over: Partial<BusinessSettings> = {}): BusinessSettings {
  return { ...DEFAULT_BUSINESS_SETTINGS, ...over };
}

/** Plays the shell's role: `Settings.tsx`'s `persist` feeds a save back through `data`. */
function Harness({
  initial,
  onSave,
}: {
  initial: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}) {
  const [data, setData] = useState(initial);
  return (
    <PhoneLineSection
      data={data}
      onSave={async (patch) => {
        await onSave(patch);
        setData((d) => ({ ...d, ...patch }));
      }}
    />
  );
}

describe('PhoneLineSection', () => {
  it('a document with NO field shows the transfer as on', () => {
    // The state every existing settings doc is in.
    const decoded = mergeBusinessSettings({});
    render(<PhoneLineSection data={decoded} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: /reach me live/i })).toBeChecked();
  });

  it('an explicit false shows the transfer as off', () => {
    render(<PhoneLineSection data={settings({ voiceLiveTransferEnabled: false })} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: /reach me live/i })).not.toBeChecked();
  });

  it('turning it OFF saves exactly that one field', async () => {
    // A panel that patched a whole settings object would clobber whatever a
    // sibling section had just saved. One field, one write.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: /reach me live/i }));
    expect(onSave).toHaveBeenCalledWith({ voiceLiveTransferEnabled: false });
  });

  it('turning it back ON saves true', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={settings({ voiceLiveTransferEnabled: false })} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: /reach me live/i }));
    expect(onSave).toHaveBeenCalledWith({ voiceLiveTransferEnabled: true });
  });

  it('the explanatory copy CHANGES with the switch, so it never describes the wrong line', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={settings()} onSave={onSave} />);
    expect(screen.getByText(/press 3 to talk to me right now/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: /reach me live/i }));
    expect(screen.queryByText(/press 3 to talk to me right now/i)).not.toBeInTheDocument();
    expect(screen.getByText(/offered a voicemail and nothing else/i)).toBeInTheDocument();
  });

  it('DISCLOSES that the transfer is unproven, rather than claiming it works', () => {
    // The whole point of the banner. The credentials are placeholders and the
    // number's forwarding is not configured, so an "on" switch must not read as
    // "callers can reach me".
    render(<PhoneLineSection data={settings()} onSave={vi.fn()} />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/not been tested on a real call/i);
    expect(banner).toHaveTextContent(/forwarding/i);
    expect(banner).toHaveTextContent(/voicemail as the reliable path/i);
  });

  it('the ON copy describes what is OFFERED, and promises no connection', () => {
    // "rings the AuntieOS app" is what the handler does. Anything of the shape
    // "the first to answer takes the call" would be a claim about an untested
    // path, which is what the banner exists to refuse.
    render(<PhoneLineSection data={settings()} onSave={vi.fn()} />);
    expect(screen.getByText(/rings the AuntieOS app/i)).toBeInTheDocument();
    expect(screen.queryByText(/takes the call/i)).not.toBeInTheDocument();
  });

  it('turned OFF, the disclosure is gone, because nothing is being offered', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: /reach me live/i }));
    expect(screen.queryByText(/not been tested on a real call/i)).not.toBeInTheDocument();
  });

  it('a FAILED save leaves the switch where it was, and says why', async () => {
    // Fail-loud, and no optimistic flip: a switch showing "off" over a save
    // that never landed is a phone the operator believes is silent and is not.
    const onSave = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<Harness initial={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: /reach me live/i }));
    expect(screen.getByRole('switch', { name: /reach me live/i })).toBeChecked();
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('names no phone number anywhere, so this screen cannot repoint the line', () => {
    // ISSUE #397 requirement, asserted rather than assumed: the transfer rings
    // a Twilio client identity, and there is deliberately no destination field
    // that could send the business line to somebody's personal phone.
    const { container } = render(<PhoneLineSection data={settings()} onSave={vi.fn()} />);
    expect(container.querySelectorAll('input[type="tel"]')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.textContent ?? '').not.toMatch(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/);
  });
});
