/**
 * #593: the Cloudinary side of the asynchronous video location strip.
 *
 * Three operations, all authenticated with the account's api key + secret,
 * none of which any client holds:
 *
 *   1. `fetchVideoResource`  — Admin API. Given a public id, tells us the
 *      canonical `secure_url` and `format` of the STORED ORIGINAL. We never
 *      guess that URL: what the `media_files` doc holds may be a transformed
 *      delivery URL (the Android and desktop writers store `du_15.0,q_auto,f_auto`
 *      URLs, not `secure_url`), and downloading a derivative would strip the
 *      wrong bytes and then overwrite the original with them.
 *
 *   2. `overwriteVideoAsset` — Upload API, same public id, `overwrite=true`,
 *      `invalidate=true`. Cloudinary's own documented way to replace what is
 *      stored under a public id. This is what makes the fix close the issue:
 *      an eager derivative or an `explicit` call would leave the original
 *      exactly where it is, still reachable, still carrying coordinates.
 *
 *   3. `signUploadParams` — the classic sha1(sorted params + secret) recipe,
 *      the same one `cloudinary.ts` uses for the client-side signed uploads.
 */

import * as crypto from 'crypto';

/** Videos above this never reach the strip job: the clients cap uploads at
 *  50 MB, and a function that buffers an unbounded download is a memory bomb.
 *  A file over the cap is recorded as a failure, never silently skipped. */
export const MAX_STRIPPABLE_VIDEO_BYTES = 64 * 1024 * 1024;

export interface CloudinaryVideoResource {
  publicId: string;
  secureUrl: string;
  format: string;
  bytes: number;
  version: number;
}

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * sha1 over the params in alphabetical order, `k=v` joined by `&`, with the
 * api secret appended. Cloudinary recomputes this over the params it RECEIVES,
 * so the signed set and the posted set must match exactly.
 */
export function signUploadParams(params: Record<string, string>, apiSecret: string): string {
  const base =
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&') + apiSecret;
  return crypto.createHash('sha1').update(base).digest('hex');
}

/**
 * Recovers the public id of a Cloudinary video from a delivery URL.
 *
 * Needed because `media_files` rows written before #593 carry no
 * `cloudinaryPublicId` field on the web path — the public id survives only
 * inside the URL string. Handles both shapes we store:
 *
 *   .../video/upload/v1712345678/tribetails/kinfolk/abc/xy9.mp4   (secure_url)
 *   .../video/upload/du_15.0,q_auto,f_auto/tribetails/.../xy9.mp4 (delivery URL)
 *
 * A public id may contain slashes (ours always do — they are folder paths), so
 * everything after the transformation and version segments is the id, minus
 * the file extension. Returns null rather than guessing when the URL is not a
 * Cloudinary video upload URL at all.
 */
export function publicIdFromVideoUrl(url: string, cloudName: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'res.cloudinary.com') return null;
  const marker = `/${cloudName}/video/upload/`;
  const at = parsed.pathname.indexOf(marker);
  if (at !== 0) return null;
  const segments = parsed.pathname.slice(marker.length).split('/').filter((s) => s !== '');
  let i = 0;
  // Leading transformation segments. A transformation segment is a comma-joined
  // list of `xx_value` components; a folder name is not. Being conservative
  // here matters more than being clever: a folder wrongly eaten as a
  // transformation produces a wrong public id, and the job would then overwrite
  // a DIFFERENT asset. So a segment only counts as a transformation when every
  // one of its comma-separated parts looks like `letters_value`.
  while (i < segments.length && isTransformationSegment(segments[i])) i += 1;
  // Optional version segment.
  if (i < segments.length && /^v\d+$/.test(segments[i])) i += 1;
  const rest = segments.slice(i);
  if (rest.length === 0) return null;
  const last = rest[rest.length - 1];
  const dot = last.lastIndexOf('.');
  rest[rest.length - 1] = dot > 0 ? last.slice(0, dot) : last;
  const publicId = rest.join('/');
  return publicId === '' ? null : publicId;
}

/**
 * True when a video delivery URL carries transformation segments.
 *
 * The three `media_files` writers do NOT agree about what `storageUrl` holds.
 * The web admin stores Cloudinary's raw `secure_url`; Android and the desktop
 * uploader store a TRANSFORMED delivery URL (`du_15.0,q_auto,f_auto`), which is
 * what enforces the 15-second clip cap and the delivery optimisation at view
 * time. So the strip job must not blanket-replace `storageUrl` with the new
 * original's URL: on an Android row that would quietly turn a capped, optimised
 * clip into the full-length unoptimised original.
 */
export function hasTransformation(url: string, cloudName: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const marker = `/${cloudName}/video/upload/`;
  if (parsed.pathname.indexOf(marker) !== 0) return false;
  const segments = parsed.pathname.slice(marker.length).split('/').filter((s) => s !== '');
  return segments.length > 0 && isTransformationSegment(segments[0]);
}

function isTransformationSegment(segment: string): boolean {
  const parts = segment.split(',');
  return parts.every((p) => /^[a-z]{1,3}_[A-Za-z0-9_.:%\-[\]]+$/.test(p));
}

type FetchLike = typeof fetch;

function basicAuth(creds: CloudinaryCredentials): string {
  return `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64')}`;
}

/** Admin API read of the stored original. Throws on any non-200. */
export async function fetchVideoResource(
  creds: CloudinaryCredentials,
  publicId: string,
  fetchImpl: FetchLike = fetch,
): Promise<CloudinaryVideoResource> {
  const url =
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/resources/video/upload/` +
    publicId.split('/').map(encodeURIComponent).join('/');
  const resp = await fetchImpl(url, { method: 'GET', headers: { Authorization: basicAuth(creds) } });
  if (resp.status !== 200) {
    throw new Error(`Cloudinary resources GET returned HTTP ${resp.status} for ${publicId}`);
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const secureUrl = typeof body.secure_url === 'string' ? body.secure_url : '';
  const format = typeof body.format === 'string' ? body.format : '';
  if (secureUrl === '') throw new Error(`Cloudinary resource ${publicId} has no secure_url.`);
  return {
    publicId,
    secureUrl,
    format,
    bytes: typeof body.bytes === 'number' ? body.bytes : 0,
    version: typeof body.version === 'number' ? body.version : 0,
  };
}

/** Downloads an asset's bytes, refusing anything over the cap. */
export async function downloadAsset(
  url: string,
  fetchImpl: FetchLike = fetch,
  maxBytes: number = MAX_STRIPPABLE_VIDEO_BYTES,
): Promise<Buffer> {
  const resp = await fetchImpl(url, { method: 'GET' });
  if (resp.status !== 200) throw new Error(`Asset download returned HTTP ${resp.status}`);
  const declared = Number(resp.headers?.get?.('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Asset is ${declared} bytes, over the ${maxBytes} byte strip limit.`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`Asset is ${buf.length} bytes, over the ${maxBytes} byte strip limit.`);
  }
  return buf;
}

export interface OverwriteResult {
  secureUrl: string;
  version: number;
  bytes: number;
}

/**
 * Replaces the stored original under `publicId` with `body`.
 *
 * `overwrite=true` + the same public id is Cloudinary's documented way to make
 * a new file the asset; `invalidate=true` purges the CDN copies of the old
 * one. `tags` is posted explicitly (blank clears): the pending-strip tag the
 * upload signer put on the asset comes off here, so the tag list at Cloudinary
 * is a live inventory of videos that have NOT been stripped.
 */
export async function overwriteVideoAsset(
  creds: CloudinaryCredentials,
  publicId: string,
  body: Buffer,
  filename: string,
  fetchImpl: FetchLike = fetch,
): Promise<OverwriteResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed: Record<string, string> = {
    invalidate: 'true',
    overwrite: 'true',
    public_id: publicId,
    tags: '',
    timestamp: String(timestamp),
  };
  const signature = signUploadParams(signed, creds.apiSecret);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(body)]), filename);
  form.append('api_key', creds.apiKey);
  for (const [k, v] of Object.entries(signed)) form.append(k, v);
  form.append('signature', signature);

  const resp = await fetchImpl(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/video/upload`,
    { method: 'POST', body: form },
  );
  const parsed = (await resp.json()) as Record<string, unknown>;
  if (resp.status !== 200) {
    const message =
      typeof (parsed?.error as Record<string, unknown>)?.message === 'string'
        ? ((parsed.error as Record<string, unknown>).message as string)
        : `HTTP ${resp.status}`;
    throw new Error(`Cloudinary overwrite failed: ${message}`);
  }
  const secureUrl = typeof parsed.secure_url === 'string' ? parsed.secure_url : '';
  if (secureUrl === '') throw new Error('Cloudinary overwrite returned no secure_url.');
  return {
    secureUrl,
    version: typeof parsed.version === 'number' ? parsed.version : 0,
    bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
  };
}
