import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { signCloudinaryFolderUpload, assertCloudinaryUrlInFolder } from '../src/lib/cloudinary';

describe('signCloudinaryFolderUpload', () => {
  it('produces a deterministic sha1 signature matching the Cloudinary recipe', () => {
    const result = signCloudinaryFolderUpload({
      cloudName: 'demo',
      apiKey: 'key123',
      apiSecret: 'secret456',
      folder: 'tribetails/kinfolks/kf1/kin/dog1',
    });
    expect(result.cloudName).toBe('demo');
    expect(result.apiKey).toBe('key123');
    expect(result.folder).toBe('tribetails/kinfolks/kf1/kin/dog1');
    expect(result.allowedFormats).toBe('jpg,png,webp,gif');
    expect(result.signature).toMatch(/^[a-f0-9]{40}$/); // sha1 hex digest length
  });

  it('binds allowed_formats into the signature so Cloudinary itself enforces it', () => {
    // Cloudinary's classic signature only covers signed body params, not the
    // resource_type segment of the upload URL — this is what stops a client
    // from POSTing a validly-signed folder+timestamp to /raw/upload instead
    // of /image/upload to smuggle in a non-image file.
    const withDefault = signCloudinaryFolderUpload({
      cloudName: 'demo', apiKey: 'key123', apiSecret: 'secret456', folder: 'a',
    });
    const manualSignatureWithoutFormats = crypto
      .createHash('sha1')
      .update(`folder=a&timestamp=${withDefault.timestamp}secret456`)
      .digest('hex');
    expect(withDefault.signature).not.toBe(manualSignatureWithoutFormats);
  });

  it('changes the signature when the folder changes (folder-scoping actually matters)', () => {
    const base = { cloudName: 'demo', apiKey: 'key123', apiSecret: 'secret456' };
    const a = signCloudinaryFolderUpload({ ...base, folder: 'a' });
    const b = signCloudinaryFolderUpload({ ...base, folder: 'b' });
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('assertCloudinaryUrlInFolder', () => {
  const cloudName = 'demo';
  const folder = 'tribetails/kinfolks/kf1/kin/dog1';
  const goodUrl = `https://res.cloudinary.com/${cloudName}/image/upload/v1234/${folder}/photo.jpg`;

  it('accepts a well-formed URL inside the signed folder for our account', () => {
    expect(() => assertCloudinaryUrlInFolder(goodUrl, cloudName, folder)).not.toThrow();
  });

  it('rejects a non-Cloudinary host (e.g. an attacker-controlled URL)', () => {
    expect(() =>
      assertCloudinaryUrlInFolder('https://evil.example/photo.jpg', cloudName, folder),
    ).toThrow(/not a Cloudinary asset/);
  });

  it('rejects http (non-https)', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `http://res.cloudinary.com/${cloudName}/image/upload/v1/${folder}/photo.jpg`,
        cloudName,
        folder,
      ),
    ).toThrow(/not a Cloudinary asset/);
  });

  it('rejects a URL belonging to a DIFFERENT Cloudinary account (cloud name mismatch)', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `https://res.cloudinary.com/someone-elses-cloud/image/upload/v1/${folder}/photo.jpg`,
        cloudName,
        folder,
      ),
    ).toThrow(/does not match this Cloudinary account/);
  });

  it('rejects a URL in a DIFFERENT folder within the same account (cross-kin write attempt)', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `https://res.cloudinary.com/${cloudName}/image/upload/v1/tribetails/kinfolks/kf1/kin/OTHER_DOG/photo.jpg`,
        cloudName,
        folder,
      ),
    ).toThrow(/outside the signed folder/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertCloudinaryUrlInFolder('not a url', cloudName, folder)).toThrow(/Malformed/);
  });

  it('rejects a raw/upload URL — resource_type is not covered by the signature, so this must be enforced here too', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `https://res.cloudinary.com/${cloudName}/raw/upload/v1234/${folder}/malware.exe`,
        cloudName,
        folder,
      ),
    ).toThrow(/not an image asset/);
  });

  it('rejects a video/upload URL for the same reason', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `https://res.cloudinary.com/${cloudName}/video/upload/v1234/${folder}/clip.mp4`,
        cloudName,
        folder,
      ),
    ).toThrow(/not an image asset/);
  });

  it('rejects a look-alike subdomain of the asset host', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `https://xres.cloudinary.com/${cloudName}/image/upload/v1234/${folder}/photo.jpg`,
        cloudName,
        folder,
      ),
    ).toThrow(/not a Cloudinary asset/);
  });

  it('rejects a userinfo-smuggling URL (https://res.cloudinary.com@evil.example/...)', () => {
    expect(() =>
      assertCloudinaryUrlInFolder(
        `https://res.cloudinary.com@evil.example/${cloudName}/image/upload/v1/${folder}/photo.jpg`,
        cloudName,
        folder,
      ),
    ).toThrow(/not a Cloudinary asset/);
  });
});
