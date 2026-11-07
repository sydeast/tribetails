// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BUSINESS_ENTITY_ID } from '../api/mediaUpload';

const { uploadMediaFile } = vi.hoisted(() => ({ uploadMediaFile: vi.fn() }));
vi.mock('../api/mediaUpload', async () => {
  const actual = await vi.importActual<typeof import('../api/mediaUpload')>('../api/mediaUpload');
  return { ...actual, uploadMediaFile };
});

import { MediaUploadDialog, type KinfolkOption, type KinOption } from './MediaUploadDialog';

const HOUSEHOLDS: KinfolkOption[] = [
  { id: 'kf1', label: 'The Alvarez Household' },
  { id: 'kf2', label: 'The Chen Household' },
];

const KIN: KinOption[] = [
  { id: 'pet_biscuit', label: 'Biscuit', kinfolkId: 'kf1' },
  { id: 'pet_gravy', label: 'Gravy', kinfolkId: 'kf1' },
  { id: 'pet_mochi', label: 'Mochi', kinfolkId: 'kf2' },
];
function photoFile(): File {
  return new File(['bytes'], 'biscuit.jpg', { type: 'image/jpeg' });
}

beforeEach(() => {
  uploadMediaFile.mockReset();
});

describe('MediaUploadDialog', () => {
  it('defaults to the KINFOLK target with NO household pre-selected (#1604)', () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByLabelText('Target type')).toHaveValue('KINFOLK');
    expect(screen.getByLabelText('Household')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose a household' })).toBeInTheDocument();
  });
  it('refuses a household upload until a household is chosen, then lets it through (#1604)', async () => {
    uploadMediaFile.mockResolvedValue('newMedia2');
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a household before uploading.');
    expect(uploadMediaFile).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf2');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalledTimes(1));
    expect(uploadMediaFile).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'KINFOLK', entityId: 'kf2' }));
  });

  it('shows "no households" when the roster is empty, rather than a blank/broken select', () => {
    render(<MediaUploadDialog kinfolkOptions={[]} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/no households on file/i);
    expect(screen.queryByLabelText('Household')).toBeNull();
  });

  it('switching to KIN swaps in a household picker and a kin picker, with no typed id (#1588)', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={KIN} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'KIN');
    expect(screen.queryByLabelText('Kin ID')).toBeNull();
    expect(screen.getByLabelText('Kin\u2019s household')).toHaveValue('');
    expect(screen.getByLabelText('Kin')).toBeDisabled();
    expect(screen.queryByText(/no picker for kin/i)).toBeNull();
  });
  it('the kin picker lists only the chosen household\u2019s kin, and clears when the household changes', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={KIN} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'KIN');
    await userEvent.selectOptions(screen.getByLabelText('Kin\u2019s household'), 'kf1');
    const kinSelect = screen.getByLabelText('Kin');
    expect(kinSelect).toBeEnabled();
    expect(within(kinSelect).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a kin',
      'Biscuit',
      'Gravy',
    ]);
    await userEvent.selectOptions(kinSelect, 'pet_gravy');
    await userEvent.selectOptions(screen.getByLabelText('Kin\u2019s household'), 'kf2');
    expect(screen.getByLabelText('Kin')).toHaveValue('');
    expect(within(screen.getByLabelText('Kin')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a kin',
      'Mochi',
    ]);
  });
  it('uploads a KIN target with the kin id as entityId and its household as kinfolkId', async () => {
    uploadMediaFile.mockResolvedValue('newMedia9');
    const onUploaded = vi.fn();
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={KIN} onClose={vi.fn()} onUploaded={onUploaded} />);
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'KIN');
    await userEvent.selectOptions(screen.getByLabelText('Kin\u2019s household'), 'kf2');
    await userEvent.selectOptions(screen.getByLabelText('Kin'), 'pet_mochi');
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalledTimes(1));
    expect(uploadMediaFile).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'KIN', entityId: 'pet_mochi', kinfolkId: 'kf2' }),
    );
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
  });
  it('refuses a KIN upload with no kin chosen, naming what is missing, and clears the message once chosen', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={KIN} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'KIN');
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a household, then a kin.');
    expect(uploadMediaFile).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText('Kin\u2019s household'), 'kf1');
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a kin before uploading.');
    await userEvent.selectOptions(screen.getByLabelText('Kin'), 'pet_biscuit');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops the missing-target message when the target type changes (#1588)', async () => {
    render(<MediaUploadDialog kinfolkOptions={[]} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    // #1604 named the household for the Household target, which no longer preselects one.
    expect(screen.getByText('Choose a household before uploading.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'BUSINESS');
    expect(screen.queryByText('Choose a household before uploading.')).toBeNull();
  });
  it('says so when the chosen household has no kin, and while the kin stream is loading or failed', async () => {
    const { rerender } = render(
      <MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={[]} onClose={vi.fn()} onUploaded={vi.fn()} />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'KIN');
    await userEvent.selectOptions(screen.getByLabelText('Kin\u2019s household'), 'kf1');
    expect(screen.getByText('No kin on this household yet.')).toBeInTheDocument();
    rerender(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={[]} kinLoading onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByText('Loading kin\u2026')).toBeInTheDocument();
    expect(screen.queryByText('No kin on this household yet.')).toBeNull();
    rerender(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} kinOptions={[]} kinError="offline" onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/offline/);
  });
  it('switching to BUSINESS shows the fixed, read-only business_settings target', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'BUSINESS');
    const targetIdInput = screen.getByLabelText('Target ID');
    expect(targetIdInput).toHaveValue(BUSINESS_ENTITY_ID);
    expect(targetIdInput).toBeDisabled();
    expect(screen.getByText(/company media, not tied to any household/i)).toBeInTheDocument();
  });

  it('labels the BUSINESS option as the "no household" choice, not a wire-format leak, so an operator can upload media unrelated to any kinfolk', () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByRole('option', { name: /company \(no household\)/i })).toBeInTheDocument();
  });

  it('uploads a BUSINESS target with no kinfolk selected at all, never blocked on the household roster', async () => {
    uploadMediaFile.mockResolvedValue('newMedia1');
    const onUploaded = vi.fn();
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={onUploaded} />);

    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'BUSINESS');
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalledTimes(1));
    const [call] = uploadMediaFile.mock.calls[0] as [{ entityType: string; entityId: string }];
    expect(call.entityType).toBe('BUSINESS');
    expect(call.entityId).toBe(BUSINESS_ENTITY_ID);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
  });

  it('uploads a BUSINESS target even when the household roster is empty (Company never depends on a roster)', async () => {
    uploadMediaFile.mockResolvedValue('newMedia1');
    render(<MediaUploadDialog kinfolkOptions={[]} onClose={vi.fn()} onUploaded={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'BUSINESS');
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalledTimes(1));
  });

  it('blocks Upload with a visible error when no file is chosen yet', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByText(/choose a photo or video/i)).toBeInTheDocument();
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });

  it('blocks Upload with a visible error when the household roster is empty (no valid target)', async () => {
    render(<MediaUploadDialog kinfolkOptions={[]} onClose={vi.fn()} onUploaded={vi.fn()} />);
    const input = screen.getByLabelText('Photo or video');
    await userEvent.upload(input, photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByText(/choose a household before uploading/i)).toBeInTheDocument();
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });

  it('uploads with the selected household as entityId, and reports success via onUploaded', async () => {
    uploadMediaFile.mockResolvedValue('newMedia1');
    const onUploaded = vi.fn();
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={onUploaded} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf2');
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalledTimes(1));
    const [call] = uploadMediaFile.mock.calls[0] as [
      { entityType: string; entityId: string; file: File; onStage?: unknown },
    ];
    expect(call.entityType).toBe('KINFOLK');
    expect(call.entityId).toBe('kf2');
    expect(call.file.name).toBe('biscuit.jpg');
    expect(typeof call.onStage).toBe('function');

    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
  });

  it('shows the real pipeline stage (never a fabricated percentage) while busy, and disables Cancel', async () => {
    let resolveUpload!: (v: string) => void;
    uploadMediaFile.mockImplementation(
      ({ onStage }: { onStage?: (s: 'signing' | 'uploading' | 'saving') => void }) =>
        new Promise<string>((resolve) => {
          onStage?.('signing');
          resolveUpload = resolve;
        }),
    );
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');

    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));

    // The label appears twice while busy (the live stage line AND the busy
    // button's own label swap), so assert via getAllByText rather than the
    // single-match findByText/getByText, which would throw on ambiguity.
    await waitFor(() => expect(screen.getAllByText(/requesting upload permission/i).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /requesting upload permission/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByLabelText('Target type')).toBeDisabled();

    resolveUpload('newMedia1');
    await waitFor(() => expect(screen.queryAllByText(/requesting upload permission/i)).toHaveLength(0));
  });

  it('fails loud on a rejected upload: names the failure, keeps the dialog open, never calls onUploaded', async () => {
    uploadMediaFile.mockRejectedValue(new Error('Cloudinary upload failed (HTTP 401)'));
    const onUploaded = vi.fn();
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={onUploaded} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');

    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }));

    expect(await screen.findByText(/upload failed:.*401/i)).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^upload$/i })).toBeEnabled();
  });

  it('calls onClose (discarding the pick) when Cancel is clicked while idle', async () => {
    const onClose = vi.fn();
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={onClose} onUploaded={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });
});
/**
 * #397 S1. The two things web had and Android did not have to think about: a
 * target settled by the route, and a file that never should have been sent.
 */
describe('MediaUploadDialog, fixed target (#397 S1)', () => {
  const TARGET = { entityType: 'KIN' as const, entityId: 'pet_abc123', label: 'Kin' };
  it('asks NOTHING about the target: no type select, no household picker, no id field', () => {
    render(<MediaUploadDialog fixedTarget={TARGET} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.queryByLabelText('Target type')).toBeNull();
    expect(screen.queryByLabelText('Household')).toBeNull();
    expect(screen.queryByLabelText('Kin ID')).toBeNull();
  });
  it('STATES where the file is going, rather than silently assuming it', () => {
    render(<MediaUploadDialog fixedTarget={TARGET} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(document.querySelector('.media-upload__fixed-target')).toHaveTextContent('Uploading to Kin');
  });
  it('uploads to the fixed entity, with the route-derived type', async () => {
    uploadMediaFile.mockResolvedValue('new-doc-1');
    const onUploaded = vi.fn();
    render(<MediaUploadDialog fixedTarget={TARGET} onClose={vi.fn()} onUploaded={onUploaded} />);
    await userEvent.upload(screen.getByLabelText('Photo or video'), photoFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(uploadMediaFile).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'KIN', entityId: 'pet_abc123' }),
    );
  });
  it('needs no kinfolkOptions at all, and does not claim the roster is empty', () => {
    render(<MediaUploadDialog fixedTarget={TARGET} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.queryByText(/no households on file/i)).toBeNull();
  });
});
describe('MediaUploadDialog, file validation (#397 S1)', () => {
  /** `accept` is a picker hint only; these are files that reach the input anyway. */
  function fileOf(name: string, type: string, size: number): File {
    const f = new File(['x'], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  }
  it('refuses a file over 50MB at PICK time, before any sign or upload', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.upload(
      screen.getByLabelText('Photo or video'),
      fileOf('huge.mp4', 'video/mp4', 50 * 1024 * 1024 + 1),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/huge\.mp4/);
    expect(screen.getByRole('alert')).toHaveTextContent(/50MB/);
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });
  it('does not HOLD a refused file, so pressing Upload cannot send it anyway', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.upload(
      screen.getByLabelText('Photo or video'),
      fileOf('huge.mp4', 'video/mp4', 50 * 1024 * 1024 + 1),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });
  /**
   * `userEvent.upload` HONOURS the input's `accept` attribute and silently drops
   * a non-matching file, so it cannot reproduce the case this check exists for.
   * Real browsers do not offer that protection: the picker's "All files" option
   * and every drag-and-drop path hand the input whatever was chosen. `fireEvent`
   * is what puts the test on the same footing as the operator.
   */
  function dropFileOnInput(input: HTMLElement, f: File) {
    fireEvent.change(input, { target: { files: [f] } });
  }
  it('refuses a non-media file that walked past the `accept` hint', () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    dropFileOnInput(screen.getByLabelText('Photo or video'), fileOf('invoice.pdf', 'application/pdf', 900));
    expect(screen.getByRole('alert')).toHaveTextContent(/not a photo or a video/i);
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });
  it('refuses a zero-byte file rather than sending it to Cloudinary to fail there', () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    dropFileOnInput(screen.getByLabelText('Photo or video'), fileOf('still-syncing.jpg', 'image/jpeg', 0));
    expect(screen.getByRole('alert')).toHaveTextContent(/empty/i);
    expect(uploadMediaFile).not.toHaveBeenCalled();
  });
  it('clears the refusal once an acceptable file is chosen', async () => {
    uploadMediaFile.mockResolvedValue('new-doc-1');
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    const input = screen.getByLabelText('Photo or video');
    dropFileOnInput(input, fileOf('invoice.pdf', 'application/pdf', 900));
    expect(screen.getByRole('alert')).toHaveTextContent(/not a photo or a video/i);
    // Same channel as the refused pick above: once fireEvent has replaced the
    // input's FileList, userEvent.upload no longer drives this element.
    dropFileOnInput(input, photoFile());
    expect(screen.queryByText(/not a photo or a video/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalled());
  });
  it('states the cap up front, so the limit is not learned by hitting it', () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByText(/Photos and videos up to 50MB/i)).toBeInTheDocument();
  });
});

