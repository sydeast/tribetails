// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignedImageUpload } from './SignedImageUpload';
import type { SignedUploadParams } from './SignedImageUpload';

/**
 * Minimal fake XMLHttpRequest: SignedImageUpload uses XHR (not fetch) so it
 * can observe `upload.onprogress`. Each test constructs one, drives the
 * real component through a real file-input change via user-event, then
 * resolves/rejects the most recently constructed fake XHR by hand to
 * control exactly which upload stage fails.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = '';
  url = '';
  status = 200;
  responseText = '';
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sentBody: FormData | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: FormData) {
    this.sentBody = body;
    FakeXHR.instances.push(this);
  }

  respondSuccess(secureUrl: string) {
    this.status = 200;
    this.responseText = JSON.stringify({ secure_url: secureUrl });
    this.onload?.();
  }

  respondServerError(message: string) {
    this.status = 400;
    this.responseText = JSON.stringify({ error: { message } });
    this.onload?.();
  }

  fail() {
    this.onerror?.();
  }
}

const VALID_FILE = new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' });
const SIGNED: SignedUploadParams = {
  cloudName: 'demo',
  apiKey: 'key123',
  timestamp: 1700000000,
  signature: 'sig',
  folder: 'tribetails/kinfolks/uid/avatars',
  allowedFormats: 'jpg,png,webp,gif',
  transformation: 'fl_force_strip',
};

async function selectFile(input: HTMLInputElement, file: File) {
  await userEvent.upload(input, file);
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SignedImageUpload', () => {
  it('validates the selected file before doing anything else', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();

    const { container } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    expect(validate).toHaveBeenCalledTimes(1);
    const [passedFile] = validate.mock.calls[0] as [{ size: number; type: string }];
    expect(passedFile.type).toBe('image/jpeg');
    await waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
  });

  it('rejects an invalid file, shows the validation message, and never calls sign', async () => {
    const validate = vi.fn().mockReturnValue('Photos need to be 2MB or smaller.');
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();
    const onError = vi.fn();

    const { container, findByText } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} onError={onError} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await findByText('Photos need to be 2MB or smaller.');
    expect(sign).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Photos need to be 2MB or smaller.');
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('runs sign -> Cloudinary POST -> confirm in order and reports the confirmed URL', async () => {
    const calls: string[] = [];
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockImplementation(async () => {
      calls.push('sign');
      return SIGNED;
    });
    const confirm = vi.fn().mockImplementation(async (secureUrl: string) => {
      calls.push('confirm');
      return `${secureUrl}?confirmed=1`;
    });
    const onUploaded = vi.fn();

    const { container } = render(
      <SignedImageUpload sign={sign} validate={validate} confirm={confirm} onUploaded={onUploaded} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    calls.push('post');
    FakeXHR.instances[0]?.respondSuccess('https://res.cloudinary.com/demo/image/upload/v1/photo.jpg');

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['sign', 'post', 'confirm']);
    expect(confirm).toHaveBeenCalledWith('https://res.cloudinary.com/demo/image/upload/v1/photo.jpg');
    expect(onUploaded).toHaveBeenCalledWith('https://res.cloudinary.com/demo/image/upload/v1/photo.jpg?confirmed=1');
  });

  it('skips confirm and uses the Cloudinary secure_url directly when no confirm step is given (avatar shape)', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();

    const { container } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0]?.respondSuccess('https://res.cloudinary.com/demo/image/upload/v1/avatar.jpg');

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('https://res.cloudinary.com/demo/image/upload/v1/avatar.jpg'));
  });

  // #583. The signer folds `transformation=fl_force_strip` into the signature
  // base, which makes posting it mandatory: a form without it is an Invalid
  // Signature, not an unstripped upload. This asserts the field is genuinely in
  // the multipart body that goes to Cloudinary, since that is the only place
  // the strip can actually take effect.
  it('#583 posts the signed transformation, so the stored original carries no EXIF GPS', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();
    const { container } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const body = FakeXHR.instances[0]?.sentBody as FormData;
    expect(body.get('transformation')).toBe('fl_force_strip');
    // and the rest of the signed set is still there, unchanged.
    expect(body.get('folder')).toBe('tribetails/kinfolks/uid/avatars');
    expect(body.get('allowed_formats')).toBe('jpg,png,webp,gif');
    expect(body.get('signature')).toBe('sig');
  });
  it('#583 posts NO transformation field when the signer signed none', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue({ ...SIGNED, transformation: '' });
    const onUploaded = vi.fn();
    const { container } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    expect((FakeXHR.instances[0]?.sentBody as FormData).get('transformation')).toBeNull();
  });
  it('surfaces a distinct error when the sign callable fails, without ever POSTing to Cloudinary', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockRejectedValue(new Error("Photo uploads aren't available right now. Try again later."));
    const onUploaded = vi.fn();
    const onError = vi.fn();

    const { container, findByText } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} onError={onError} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await findByText("Photo uploads aren't available right now. Try again later.");
    expect(onError).toHaveBeenCalledWith("Photo uploads aren't available right now. Try again later.");
    expect(onUploaded).not.toHaveBeenCalled();
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('surfaces a distinct error when the Cloudinary POST fails over the network', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();
    const onError = vi.fn();

    const { container, findByText } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} onError={onError} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0]?.fail();

    await findByText('Network error. Check your connection and try again.');
    expect(onError).toHaveBeenCalledWith('Network error. Check your connection and try again.');
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('surfaces a distinct error when Cloudinary itself rejects the upload', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();
    const onError = vi.fn();

    const { container, findByText } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} onError={onError} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0]?.respondServerError('Invalid signature.');

    await findByText('Invalid signature.');
    expect(onError).toHaveBeenCalledWith('Invalid signature.');
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('surfaces a distinct error when the confirm callable fails, after a successful Cloudinary POST', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const confirm = vi.fn().mockRejectedValue(new Error('Kin not found.'));
    const onUploaded = vi.fn();
    const onError = vi.fn();

    const { container, findByText } = render(
      <SignedImageUpload sign={sign} validate={validate} confirm={confirm} onUploaded={onUploaded} onError={onError} imageUrl="" fallback="M" />,
    );
    await selectFile(getFileInput(container), VALID_FILE);

    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0]?.respondSuccess('https://res.cloudinary.com/demo/image/upload/v1/kin.jpg');

    await findByText('Kin not found.');
    expect(confirm).toHaveBeenCalledWith('https://res.cloudinary.com/demo/image/upload/v1/kin.jpg');
    expect(onUploaded).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Kin not found.');
  });

  it('selecting a file via drag-and-drop runs the same flow as the file picker', async () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();

    const { container } = render(
      <SignedImageUpload sign={sign} validate={validate} onUploaded={onUploaded} imageUrl="" fallback="M" />,
    );
    const dropzone = container.querySelector('.siu-avatar');
    if (!dropzone) throw new Error('dropzone not found');

    const dataTransfer = { files: [VALID_FILE] } as unknown as DataTransfer;
    dropzone.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
    );

    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
  });

  it('shows the caller-supplied fallback, not a dead glyph, when the current imageUrl fails to load (S9)', () => {
    const validate = vi.fn().mockReturnValue(null);
    const sign = vi.fn().mockResolvedValue(SIGNED);
    const onUploaded = vi.fn();

    const { container, getByText } = render(
      <SignedImageUpload
        sign={sign}
        validate={validate}
        onUploaded={onUploaded}
        imageUrl="https://res.cloudinary.com/demo/image/upload/v1/gone.jpg"
        fallback="M"
      />,
    );
    const img = container.querySelector('img.siu-img');
    expect(img).not.toBeNull();

    // See FallbackImage.test.tsx for why fireEvent.error is a genuine
    // exercise of the onError handler in jsdom, not a vacuous pass.
    fireEvent.error(img!);

    expect(container.querySelector('img')).toBeNull();
    expect(getByText('M')).toBeTruthy();
  });
});
