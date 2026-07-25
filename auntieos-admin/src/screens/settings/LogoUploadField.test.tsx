// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const uploadBrandAsset = vi.fn();
const removeBrandAsset = vi.fn();

vi.mock('../../api/brandAsset', () => ({
  uploadBrandAsset: (...a: unknown[]) => uploadBrandAsset(...a),
  removeBrandAsset: (...a: unknown[]) => removeBrandAsset(...a),
}));

import { LogoUploadField } from './LogoUploadField';

const URL_A = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/a.png';

function renderField(over: Partial<Parameters<typeof LogoUploadField>[0]> = {}) {
  const onChanged = vi.fn();
  render(
    <LogoUploadField
      kind="portalLogo"
      label="Portal logo"
      help="This is the logo kinfolk see."
      logoUrl=""
      logoRemovedAt=""
      onChanged={onChanged}
      preview="portal"
      {...over}
    />,
  );
  return { onChanged };
}

const png = () => new File(['x'], 'logo.png', { type: 'image/png' });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the three empty-ish states read differently', () => {
  it('says a logo was never set on a fresh install', () => {
    renderField();
    expect(screen.getByText('No logo set yet')).toBeTruthy();
    expect(screen.getByText('Upload logo')).toBeTruthy();
  });

  it('says a logo was REMOVED, and when, after an operator cleared one', () => {
    // Both states are logoUrl === '' on the doc. Collapsing them would leave an
    // operator who just pressed Remove looking at the same panel a fresh
    // install shows, with no confirmation the removal landed.
    renderField({ logoRemovedAt: '2026-07-20T15:04:00.000Z' });
    expect(screen.getByText(/Logo removed/)).toBeTruthy();
    expect(screen.queryByText('No logo set yet')).toBeNull();
  });

  it('offers Replace and Remove once a logo is set', () => {
    renderField({ logoUrl: URL_A });
    expect(screen.getByText('Replace logo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeTruthy();
  });

  it('offers no Remove when there is nothing to remove', () => {
    renderField();
    expect(screen.queryByRole('button', { name: 'Remove logo' })).toBeNull();
  });
});

describe('a saved logo whose image will not load', () => {
  it('says so, instead of showing a broken image or claiming no logo is set', async () => {
    renderField({ logoUrl: URL_A });
    fireEvent.error(screen.getByAltText('Portal logo preview'));

    await waitFor(() => expect(screen.getByText('Saved, but this image will not load')).toBeTruthy());
    // Critically NOT the never-set copy, which would invite the operator to
    // conclude the upload silently failed and redo it.
    expect(screen.queryByText('No logo set yet')).toBeNull();
    // Remove stays available: it is the way out of this state.
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeTruthy();
  });
});

describe('upload', () => {
  it('uploads on selection and hands the confirmed result up', async () => {
    uploadBrandAsset.mockResolvedValue({ kind: 'portalLogo', logoUrl: URL_A, logoRemovedAt: '' });
    const { onChanged } = renderField();

    await userEvent.upload(screen.getByLabelText('Upload logo'), png());

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'portalLogo', logoUrl: URL_A, logoRemovedAt: '' }));
    expect(uploadBrandAsset.mock.calls[0]![0]).toMatchObject({ kind: 'portalLogo' });
  });

  it('surfaces a rejection verbatim and changes nothing', async () => {
    // The message is the pre-upload validator's, which names the real numbers.
    uploadBrandAsset.mockRejectedValue(new Error('That file is 12.0 MB. The limit is 5.0 MB, so nothing was uploaded.'));
    const { onChanged } = renderField({ logoUrl: URL_A });

    await userEvent.upload(screen.getByLabelText('Replace logo'), png());

    await waitFor(() => expect(screen.getByText(/That file is 12\.0 MB/)).toBeTruthy());
    // A rejected upload must never read as a removal.
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByAltText('Portal logo preview').getAttribute('src')).toBe(URL_A);
  });
});

describe('removal', () => {
  it('clears through the callable and folds the stamp up', async () => {
    removeBrandAsset.mockResolvedValue({ kind: 'portalLogo', logoUrl: '', logoRemovedAt: '2026-07-25T10:00:00.000Z' });
    const { onChanged } = renderField({ logoUrl: URL_A });

    await userEvent.click(screen.getByRole('button', { name: 'Remove logo' }));

    await waitFor(() => expect(removeBrandAsset).toHaveBeenCalledWith('portalLogo'));
    expect(onChanged).toHaveBeenCalledWith({ kind: 'portalLogo', logoUrl: '', logoRemovedAt: '2026-07-25T10:00:00.000Z' });
  });

  it('keeps the logo when the remove fails, and says why', async () => {
    removeBrandAsset.mockRejectedValue(new Error('Network unreachable'));
    const { onChanged } = renderField({ logoUrl: URL_A });

    await userEvent.click(screen.getByRole('button', { name: 'Remove logo' }));

    await waitFor(() => expect(screen.getByText(/Network unreachable/)).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByAltText('Portal logo preview')).toBeTruthy();
  });
});

describe('what the operator is told about the uploaded file', () => {
  it('states that removing does not delete the file from Cloudinary', () => {
    // The alternative is implying a deletion that does not happen.
    renderField({ logoUrl: URL_A });
    expect(screen.getByText(/stays in Cloudinary/)).toBeTruthy();
  });

  it('previews a portal logo on the portal background, not the admin surface', () => {
    // A white-ink transparent logo is invisible on the portal's cream header and
    // no validation can detect ink colour, so the preview has to show the real
    // background before the operator commits.
    const { container } = render(
      <LogoUploadField
        kind="portalLogo" label="Portal logo" help="h" logoUrl={URL_A} logoRemovedAt=""
        onChanged={vi.fn()} preview="portal"
      />,
    );
    expect(container.querySelector('.logoField__plate--portal')).not.toBeNull();
  });
});
