// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BUSINESS_ENTITY_ID } from '../api/mediaUpload';

const { uploadMediaFile } = vi.hoisted(() => ({ uploadMediaFile: vi.fn() }));
vi.mock('../api/mediaUpload', async () => {
  const actual = await vi.importActual<typeof import('../api/mediaUpload')>('../api/mediaUpload');
  return { ...actual, uploadMediaFile };
});

import { MediaUploadDialog, type KinfolkOption } from './MediaUploadDialog';

const HOUSEHOLDS: KinfolkOption[] = [
  { id: 'kf1', label: 'The Alvarez Household' },
  { id: 'kf2', label: 'The Chen Household' },
];

function photoFile(): File {
  return new File(['bytes'], 'biscuit.jpg', { type: 'image/jpeg' });
}

beforeEach(() => {
  uploadMediaFile.mockReset();
});

describe('MediaUploadDialog', () => {
  it('defaults to the KINFOLK target with the first household pre-selected', () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByLabelText('Target type')).toHaveValue('KINFOLK');
    expect(screen.getByLabelText('Household')).toHaveValue('kf1');
  });

  it('shows "no households" when the roster is empty, rather than a blank/broken select', () => {
    render(<MediaUploadDialog kinfolkOptions={[]} onClose={vi.fn()} onUploaded={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/no households on file/i);
    expect(screen.queryByLabelText('Household')).toBeNull();
  });

  it('switching to KIN swaps in a free-text Kin ID field', async () => {
    render(<MediaUploadDialog kinfolkOptions={HOUSEHOLDS} onClose={vi.fn()} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Target type'), 'KIN');
    expect(screen.getByLabelText('Kin ID')).toBeInTheDocument();
    expect(screen.queryByLabelText('Household')).toBeNull();
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
    expect(await screen.findByText(/choose a target/i)).toBeInTheDocument();
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
