import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import {
  signCloudinaryFolderUpload,
  assertCloudinaryUrlInFolder,
  scopeCloudinaryFolder,
  E2E_PROJECT_ID,
} from '../src/lib/cloudinary';

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
  // ── #583: photo location metadata is stripped at upload ──────────────────
  //
  // Portal photos go straight from the client to api.cloudinary.com, so the
  // signature is the only lever on what gets stored. These pin that the strip
  // instruction is genuinely IN the signature base — not merely a constant
  // returned next to it — by recomputing sha1 by hand from the exact string
  // Cloudinary will rebuild from the params it receives.
  it('#583 signs transformation=fl_force_strip, so the STORED ORIGINAL keeps no EXIF GPS', () => {
    const result = signCloudinaryFolderUpload({
      cloudName: 'demo', apiKey: 'key123', apiSecret: 'secret456', folder: 'a',
    });
    expect(result.transformation).toBe('fl_force_strip');
    // Cloudinary sorts signed params alphabetically:
    // allowed_formats < folder < timestamp < transformation.
    const expected = crypto
      .createHash('sha1')
      .update(
        `allowed_formats=jpg,png,webp,gif&folder=a&timestamp=${result.timestamp}` +
        `&transformation=fl_force_strip` +
        `secret456`,
      )
      .digest('hex');
    expect(result.signature).toBe(expected);
  });
  it('#583 the strip is load-bearing: dropping it from the base changes the signature', () => {
    // If a client omitted `transformation` from the upload POST, Cloudinary
    // would rebuild THIS base and reject the upload. That refusal is the
    // enforcement — the photo cannot be stored unstripped.
    const result = signCloudinaryFolderUpload({
      cloudName: 'demo', apiKey: 'key123', apiSecret: 'secret456', folder: 'a',
    });
    const withoutStrip = crypto
      .createHash('sha1')
      .update(`allowed_formats=jpg,png,webp,gif&folder=a&timestamp=${result.timestamp}secret456`)
      .digest('hex');
    expect(result.signature).not.toBe(withoutStrip);
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

// #1202. Under the real-services Cypress project id every signed folder gains an
// `e2e/` prefix so the #1196 cleanup sees what a spec uploaded. Anywhere else
// nothing changes.
describe('#1202 e2e/ folder scoping', () => {
  const saved = {
    g: process.env['GCLOUD_PROJECT'],
    c: process.env['GOOGLE_CLOUD_PROJECT'],
    f: process.env['FIREBASE_CONFIG'],
  };
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  beforeEach(() => {
    delete process.env['GCLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['FIREBASE_CONFIG'];
  });
  afterEach(() => {
    restore('GCLOUD_PROJECT', saved.g);
    restore('GOOGLE_CLOUD_PROJECT', saved.c);
    restore('FIREBASE_CONFIG', saved.f);
  });
  const base = { cloudName: 'demo', apiKey: 'key123', apiSecret: 'secret456', folder: 'tribetails/kinfolks/u1/avatars' };
  const sigFor = (folder: string, ts: number) =>
    crypto
      .createHash('sha1')
      .update(`allowed_formats=jpg,png,webp,gif&folder=${folder}&timestamp=${ts}&transformation=fl_force_strip` + 'secret456')
      .digest('hex');
  it('the e2e project id is the one the real-services run starts the emulators under', () => {
    expect(E2E_PROJECT_ID).toBe('demo-auntieos-e2e');
  });
  it('leaves the folder alone under any other project', () => {
    process.env['GCLOUD_PROJECT'] = 'mytribe-prod';
    const r = signCloudinaryFolderUpload(base);
    expect(r.folder).toBe(base.folder);
    expect(r.signature).toBe(sigFor(base.folder, r.timestamp));
  });
  it('leaves the folder alone when no project id is set', () => {
    expect(signCloudinaryFolderUpload(base).folder).toBe(base.folder);
  });
  it('prefixes e2e/ under demo-auntieos-e2e, and signs the prefixed folder', () => {
    process.env['GCLOUD_PROJECT'] = E2E_PROJECT_ID;
    const r = signCloudinaryFolderUpload(base);
    expect(r.folder).toBe(`e2e/${base.folder}`);
    expect(r.signature).toBe(sigFor(`e2e/${base.folder}`, r.timestamp));
    expect(r.signature).not.toBe(sigFor(base.folder, r.timestamp));
  });
  it('reads the project id from FIREBASE_CONFIG when GCLOUD_PROJECT is absent', () => {
    process.env['FIREBASE_CONFIG'] = JSON.stringify({ projectId: E2E_PROJECT_ID });
    expect(signCloudinaryFolderUpload(base).folder).toBe(`e2e/${base.folder}`);
  });
  it('ignores a malformed FIREBASE_CONFIG', () => {
    process.env['FIREBASE_CONFIG'] = '{not json';
    expect(signCloudinaryFolderUpload(base).folder).toBe(base.folder);
  });
  it('never double-prefixes', () => {
    expect(scopeCloudinaryFolder('e2e/a/b', { GCLOUD_PROJECT: E2E_PROJECT_ID })).toBe('e2e/a/b');
    expect(scopeCloudinaryFolder('a/b', { GCLOUD_PROJECT: E2E_PROJECT_ID })).toBe('e2e/a/b');
    expect(scopeCloudinaryFolder('a/b', { GCLOUD_PROJECT: 'x' })).toBe('a/b');
  });
  describe('assertCloudinaryUrlInFolder under the e2e project', () => {
    const folder = 'tribetails/kinfolks/kf1/kin/dog1';
    beforeEach(() => {
      process.env['GCLOUD_PROJECT'] = E2E_PROJECT_ID;
    });
    it('accepts a URL inside the prefixed folder', () => {
      const url = `https://res.cloudinary.com/demo/image/upload/v1/e2e/${folder}/p.jpg`;
      expect(() => assertCloudinaryUrlInFolder(url, 'demo', folder)).not.toThrow();
    });
    it('refuses a URL in the unprefixed folder, so a stray upload cannot be confirmed', () => {
      const url = `https://res.cloudinary.com/demo/image/upload/v1/${folder}/p.jpg`;
      expect(() => assertCloudinaryUrlInFolder(url, 'demo', folder)).toThrow(/outside the signed folder/);
    });
  });
  it('outside the e2e project a prefixed URL is still checked against the bare folder', () => {
    process.env['GCLOUD_PROJECT'] = 'mytribe-prod';
    const folder = 'tribetails/kinfolks/kf1/kin/dog1';
    const url = `https://res.cloudinary.com/demo/image/upload/v1/${folder}/p.jpg`;
    expect(() => assertCloudinaryUrlInFolder(url, 'demo', folder)).not.toThrow();
  });
});
