/**
 * #593. The Cloudinary side of the video location strip.
 *
 * The one thing that CANNOT be tested here is that Cloudinary really replaces
 * the stored original when it receives these params — that needs live
 * credentials this repo does not hold. What IS tested is everything up to the
 * wire: the exact param set, that it is signed with the documented recipe, and
 * that dropping any one of the params that make the overwrite an OVERWRITE
 * changes the signature. See the PR body for the manual check that closes the
 * remaining gap.
 */

import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  downloadAsset,
  fetchVideoResource,
  hasTransformation,
  MAX_STRIPPABLE_VIDEO_BYTES,
  overwriteVideoAsset,
  publicIdFromVideoUrl,
  signUploadParams,
} from '../src/lib/cloudinaryVideoAsset';

const CREDS = { cloudName: 'tribetails', apiKey: 'key-123', apiSecret: 'shh-secret' };

describe('signUploadParams', () => {
  it('matches Cloudinary\'s classic recipe: sha1(sorted k=v joined by & + secret)', () => {
    const params = { public_id: 'a/b', timestamp: '1700000000', overwrite: 'true' };
    const expected = crypto
      .createHash('sha1')
      .update('overwrite=true&public_id=a/b&timestamp=1700000000shh-secret')
      .digest('hex');
    expect(signUploadParams(params, 'shh-secret')).toBe(expected);
  });

  it('sorts alphabetically regardless of insertion order', () => {
    const a = signUploadParams({ b: '2', a: '1' }, 's');
    const b = signUploadParams({ a: '1', b: '2' }, 's');
    expect(a).toBe(b);
  });
});

describe('publicIdFromVideoUrl', () => {
  // Needed because `media_files` rows written by the web admin before #593
  // carry no cloudinaryPublicId field: the id survives only inside the URL.
  it('reads it out of a plain secure_url with a version segment', () => {
    expect(
      publicIdFromVideoUrl(
        'https://res.cloudinary.com/tribetails/video/upload/v1712345678/tribetails/kinfolk/abc/xy9.mp4',
        'tribetails',
      ),
    ).toBe('tribetails/kinfolk/abc/xy9');
  });

  it('reads it out of a transformed delivery URL, which is what Android stores', () => {
    expect(
      publicIdFromVideoUrl(
        'https://res.cloudinary.com/tribetails/video/upload/du_15.0,q_auto,f_auto/tribetails/visit_log/s1/clip.mp4',
        'tribetails',
      ),
    ).toBe('tribetails/visit_log/s1/clip');
  });

  it('handles a transformation AND a version together', () => {
    expect(
      publicIdFromVideoUrl(
        'https://res.cloudinary.com/tribetails/video/upload/q_auto/v1712345678/tribetails/kin/k1/v.mp4',
        'tribetails',
      ),
    ).toBe('tribetails/kin/k1/v');
  });

  it('keeps a folder that merely looks transformation-ish', () => {
    // A folder wrongly eaten as a transformation yields the WRONG public id,
    // and the job would then overwrite a different asset. So a segment only
    // counts as a transformation when every comma-part matches `xx_value`.
    expect(
      publicIdFromVideoUrl(
        'https://res.cloudinary.com/tribetails/video/upload/tribetails/business/business_settings/v.mp4',
        'tribetails',
      ),
    ).toBe('tribetails/business/business_settings/v');
  });

  it('refuses another cloud account', () => {
    expect(
      publicIdFromVideoUrl('https://res.cloudinary.com/someone-else/video/upload/v1/a.mp4', 'tribetails'),
    ).toBeNull();
  });

  it('refuses a non-Cloudinary host', () => {
    expect(publicIdFromVideoUrl('https://evil.example.com/tribetails/video/upload/a.mp4', 'tribetails')).toBeNull();
  });

  it('refuses an image URL: this job only ever overwrites videos', () => {
    expect(
      publicIdFromVideoUrl('https://res.cloudinary.com/tribetails/image/upload/v1/a.jpg', 'tribetails'),
    ).toBeNull();
  });

  it('refuses a malformed URL rather than guessing', () => {
    expect(publicIdFromVideoUrl('not a url', 'tribetails')).toBeNull();
    expect(publicIdFromVideoUrl('', 'tribetails')).toBeNull();
  });
});

describe('hasTransformation', () => {
  // The three media_files writers disagree about what storageUrl holds, and the
  // strip job must not replace a TRANSFORMED URL with the original's: Android
  // and desktop store `du_15.0,...`, and that transformation is what enforces
  // the 15-second clip cap and the delivery optimisation at view time.
  it('sees the Android/desktop delivery transformation', () => {
    expect(
      hasTransformation(
        'https://res.cloudinary.com/tribetails/video/upload/du_15.0,q_auto,f_auto/tribetails/visit_log/s1/clip.mp4',
        'tribetails',
      ),
    ).toBe(true);
  });
  it('sees a plain secure_url with only a version as untransformed', () => {
    expect(
      hasTransformation(
        'https://res.cloudinary.com/tribetails/video/upload/v1712345678/tribetails/kinfolk/abc/xy9.mp4',
        'tribetails',
      ),
    ).toBe(false);
  });
  it('does not mistake a folder for a transformation', () => {
    expect(
      hasTransformation(
        'https://res.cloudinary.com/tribetails/video/upload/tribetails/business/business_settings/v.mp4',
        'tribetails',
      ),
    ).toBe(false);
  });
  it('treats a blank or foreign URL as untransformed rather than throwing', () => {
    expect(hasTransformation('', 'tribetails')).toBe(false);
    expect(hasTransformation('not a url', 'tribetails')).toBe(false);
    expect(hasTransformation('https://elsewhere.example/x.mp4', 'tribetails')).toBe(false);
  });
});
describe('fetchVideoResource', () => {
  it('reads the STORED ORIGINAL\'s secure_url from the Admin API, not the doc\'s URL', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ secure_url: 'https://res.cloudinary.com/tribetails/video/upload/v9/a/b.mp4', format: 'mp4', bytes: 42, version: 9 }),
        { status: 200 },
      ),
    );
    const res = await fetchVideoResource(CREDS, 'a/b', fetchImpl as unknown as typeof fetch);
    expect(res.secureUrl).toBe('https://res.cloudinary.com/tribetails/video/upload/v9/a/b.mp4');
    expect(res.format).toBe('mp4');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/tribetails/resources/video/upload/a/b');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('key-123:shh-secret').toString('base64')}`,
    );
  });

  it('throws on a non-200 rather than returning a blank url', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(fetchVideoResource(CREDS, 'a/b', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });
});

describe('downloadAsset', () => {
  it('refuses a file bigger than the strip limit, by declared length', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('x', { status: 200, headers: { 'content-length': String(MAX_STRIPPABLE_VIDEO_BYTES + 1) } }),
    );
    await expect(downloadAsset('https://x/y', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/over the/);
  });

  it('refuses a file bigger than the limit even when the header lied', async () => {
    const big = Buffer.alloc(2048);
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
    await expect(downloadAsset('https://x/y', fetchImpl as unknown as typeof fetch, 1024)).rejects.toThrow(/over the/);
  });
});

describe('overwriteVideoAsset', () => {
  async function capture(): Promise<{ form: FormData; url: string }> {
    let captured: { form: FormData; url: string } | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { form: init.body as FormData, url };
      return new Response(
        JSON.stringify({ secure_url: 'https://res.cloudinary.com/tribetails/video/upload/v10/a/b.mp4', version: 10, bytes: 7 }),
        { status: 200 },
      );
    });
    await overwriteVideoAsset(CREDS, 'a/b', Buffer.from('bytes'), 'clip.mp4', fetchImpl as unknown as typeof fetch);
    return captured as unknown as { form: FormData; url: string };
  }

  it('posts to the VIDEO upload endpoint', async () => {
    const { url } = await capture();
    expect(url).toBe('https://api.cloudinary.com/v1_1/tribetails/video/upload');
  });

  it('pins the same public_id and asks for overwrite + invalidate', async () => {
    // These three together are what make this replace the stored original
    // rather than add a derivative beside it. An eager transformation or an
    // `explicit` call would leave the coordinate-bearing original reachable,
    // which does not close #593.
    const { form } = await capture();
    expect(form.get('public_id')).toBe('a/b');
    expect(form.get('overwrite')).toBe('true');
    expect(form.get('invalidate')).toBe('true');
  });

  it('clears the pending-strip tag, so the Cloudinary-side list is a live inventory', async () => {
    const { form } = await capture();
    expect(form.get('tags')).toBe('');
  });

  it('signs EXACTLY the params it posts, and no others', async () => {
    const { form } = await capture();
    const posted: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (k === 'file' || k === 'api_key' || k === 'signature') continue;
      posted[k] = String(v);
    }
    expect(Object.keys(posted).sort()).toEqual(['invalidate', 'overwrite', 'public_id', 'tags', 'timestamp']);
    expect(form.get('signature')).toBe(signUploadParams(posted, CREDS.apiSecret));
  });

  it('changes the signature when overwrite is dropped from the signed set', async () => {
    // The #590 discipline: prove the param is load-bearing in the signature, so
    // a client (or a future edit) cannot quietly stop sending it.
    const { form } = await capture();
    const posted: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (k === 'file' || k === 'api_key' || k === 'signature') continue;
      posted[k] = String(v);
    }
    const withoutOverwrite = { ...posted };
    delete withoutOverwrite.overwrite;
    expect(signUploadParams(withoutOverwrite, CREDS.apiSecret)).not.toBe(form.get('signature'));

    const withoutInvalidate = { ...posted };
    delete withoutInvalidate.invalidate;
    expect(signUploadParams(withoutInvalidate, CREDS.apiSecret)).not.toBe(form.get('signature'));

    const withoutPublicId = { ...posted };
    delete withoutPublicId.public_id;
    expect(signUploadParams(withoutPublicId, CREDS.apiSecret)).not.toBe(form.get('signature'));
  });

  it('surfaces Cloudinary\'s own error message on a rejection', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid Signature' } }), { status: 401 }),
    );
    await expect(
      overwriteVideoAsset(CREDS, 'a/b', Buffer.from('x'), 'c.mp4', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/Invalid Signature/);
  });
});
