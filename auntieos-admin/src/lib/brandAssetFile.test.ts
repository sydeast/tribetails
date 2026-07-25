import { describe, expect, it, vi } from 'vitest';
import {
  checkBrandAssetMeta,
  checkBrandAssetFile,
  MAX_BRAND_ASSET_BYTES,
  MIN_BRAND_ASSET_PX,
  MAX_BRAND_ASSET_PX,
  ACCEPTED_BRAND_ASSET_TYPES,
  type ImageDecoder,
} from './brandAssetFile';

/** A stand-in for a real File; only `type`/`size` are read before the decode. */
function file(type: string, size: number): File {
  return { type, size, name: 'logo' } as unknown as File;
}

const decodes = (width: number, height: number): ImageDecoder => vi.fn().mockResolvedValue({ width, height });

describe('the limits themselves', () => {
  it('pins the values the server also hard-codes', () => {
    // Duplicated in mytribe/functions/src/lib/brandAsset.ts because the two
    // trees are separate packages. Pinned on both sides so a drift fails a
    // build rather than surfacing to an operator as a rejected upload.
    expect(MAX_BRAND_ASSET_BYTES).toBe(5_000_000);
    expect(MIN_BRAND_ASSET_PX).toBe(48);
    expect(MAX_BRAND_ASSET_PX).toBe(4000);
  });

  it('does NOT accept SVG', () => {
    // Two independent reasons, either sufficient: the deployed signer signs
    // allowed_formats without it, and an SVG is a script-bearing document that
    // would render on the client-facing portal.
    expect(ACCEPTED_BRAND_ASSET_TYPES).not.toContain('image/svg+xml');
    expect([...ACCEPTED_BRAND_ASSET_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});

describe('type and size, checked with no decode and no network', () => {
  it('accepts each permitted type', () => {
    for (const t of ACCEPTED_BRAND_ASSET_TYPES) {
      expect(checkBrandAssetMeta(file(t, 1000))).toBeNull();
    }
  });

  it('rejects a PDF, and names what it got', () => {
    const r = checkBrandAssetMeta(file('application/pdf', 1000));
    expect(r?.reason).toContain('application/pdf');
    expect(r?.reason).toContain('PNG, JPEG, or WebP');
  });

  it('rejects an SVG at the door', () => {
    expect(checkBrandAssetMeta(file('image/svg+xml', 1000))).not.toBeNull();
  });

  it('handles a file the browser could not type at all', () => {
    expect(checkBrandAssetMeta(file('', 1000))?.reason).toContain('unrecognised type');
  });

  it('rejects an oversize file, naming BOTH the size and the limit', () => {
    // The operator-facing point of this task: this verdict is reachable before
    // any upload starts, so a 12 MB phone photo costs zero network.
    const r = checkBrandAssetMeta(file('image/png', 12_000_000));
    expect(r?.reason).toContain('12.0 MB');
    expect(r?.reason).toContain('5.0 MB');
    expect(r?.reason).toContain('nothing was uploaded');
  });

  it('accepts a file exactly at the cap, and rejects one byte over', () => {
    expect(checkBrandAssetMeta(file('image/png', MAX_BRAND_ASSET_BYTES))).toBeNull();
    expect(checkBrandAssetMeta(file('image/png', MAX_BRAND_ASSET_BYTES + 1))).not.toBeNull();
  });

  it('rejects an empty file rather than uploading zero bytes', () => {
    expect(checkBrandAssetMeta(file('image/png', 0))?.reason).toContain('empty');
  });
});

describe('dimensions', () => {
  it('accepts a sensible logo and reports its size back', async () => {
    const res = await checkBrandAssetFile(file('image/png', 40_000), decodes(512, 200));
    expect(res).toEqual({ ok: true, width: 512, height: 200 });
  });

  it('rejects a favicon-sized image, naming the actual dimensions', async () => {
    const res = await checkBrandAssetFile(file('image/png', 900), decodes(32, 32));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('32x32');
    expect(res.ok === false && res.reason).toContain('48px');
  });

  it('rejects a camera original', async () => {
    const res = await checkBrandAssetFile(file('image/jpeg', 900_000), decodes(6000, 4000));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('6000x4000');
  });

  it('accepts the exact boundaries on both ends', async () => {
    expect((await checkBrandAssetFile(file('image/png', 900), decodes(48, 48))).ok).toBe(true);
    expect((await checkBrandAssetFile(file('image/png', 900), decodes(4000, 4000))).ok).toBe(true);
  });

  it('rejects a file that will not decode, rather than uploading it hopefully', async () => {
    // A browser that cannot read the bytes is strong evidence they are not the
    // type the file claims. Waving it through would upload successfully and
    // then render as a broken logo on the client-facing portal.
    const boom: ImageDecoder = vi.fn().mockRejectedValue(new Error('bad'));
    const res = await checkBrandAssetFile(file('image/png', 900), boom);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('could not be read as an image');
  });

  it('never decodes a file that already failed type or size', async () => {
    // The ordering is the feature: no decode, and (in the caller) no network,
    // for a file that was never going to be accepted.
    const decode = decodes(512, 512);
    await checkBrandAssetFile(file('image/png', 9_000_000), decode);
    await checkBrandAssetFile(file('application/pdf', 10), decode);
    expect(decode).not.toHaveBeenCalled();
  });
});
