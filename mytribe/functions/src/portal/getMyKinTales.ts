import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';

interface GetMyKinTalesRequest {
  kinfolkId?: string;
  /** Pagination cursor, `sentAtMs` of the last item from the previous page. */
  before?: number;
  /** Page size; default 20, max 50. */
  limit?: number;
}

interface RoutePointDto {
  lat: number;
  lng: number;
  /** Optional epoch millis. Absent means UI degrades to plain polyline. */
  t?: number;
}

interface GpsSummaryDto {
  distanceMeters?: number;
  durationSeconds?: number;
}

/** Same shape getMyKinTaleMedia's MediaItem already returns. */
interface TaleThumb {
  id: string;
  url: string;
  contentType: string | null;
}

interface KinTaleDto {
  id: string;
  /** Auntie-authored cover headline. Empty string when none was set. */
  title: string;
  body: string;
  authorDisplayName: string;
  mediaIds: string[];
  sentAtMs: number | null;
  shared: boolean;
  gpsRoute?: RoutePointDto[];
  gpsSummary?: GpsSummaryDto;
  /** Per-kin mood selections (kinId -> moodKey). Omitted when none recorded. */
  petMoods?: Record<string, string>;
  /**
   * Preview media for the feed card's thumbnail strip: at most the first 8
   * of `mediaIds`, resolved and returned inline so the card doesn't need a
   * getMyKinTaleMedia round trip just to show a photo. Videos are included
   * (not filtered to images) — the client decides how to draw a tile from
   * `contentType`. A media doc that's missing or has no `storageUrl` is
   * simply absent here, never a placeholder. `mediaIds` stays the true
   * count; `thumbs` is only ever a preview of it.
   */
  thumbs: TaleThumb[];
}

interface GetMyKinTalesResult {
  tales: KinTaleDto[];
  hasMore: boolean;
}

/**
 * Returns most-recent-first kinTales for the signed-in kinfolk.
 *
 * Source: `kin_care_reports` flat collection (AuntieOS writes directly).
 * Filter: kinfolkId == kinfolkId AND sentAt > '' (excludes DRAFTs).
 * Pagination: opaque `before` cursor = last sentAtMs epoch millis.
 *
 * READ-ONLY. AuntieOS owns the writes.
 */
export async function getMyKinTalesHandler(
  req: CallableRequest<GetMyKinTalesRequest>,
): Promise<GetMyKinTalesResult> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyKinTales');

  // Wasm/JS clients can serialize limit as a double (20.0); Firestore requires int.
  const limit = clamp(Math.trunc(Number(req.data?.limit ?? 20)) || 20, 1, 50);
  let q = firestore
    .collection('kin_care_reports')
    .where('kinfolkId', '==', kinfolkId)
    .where('sentAt', '>', '')
    .orderBy('sentAt', 'desc')
    .limit(limit + 1);

  if (typeof req.data?.before === 'number') {
    q = q.startAfter(new Date(req.data.before).toISOString());
  }

  const snap = await q.get();
  const docs = snap.docs.slice(0, limit);
  const hasMore = snap.docs.length > limit;

  const tales: KinTaleDto[] = docs.map((d) => {
    const data = d.data() as Record<string, unknown>;

    const sentAtRaw = data['sentAt'];
    let sentAtMs: number | null = null;
    if (typeof sentAtRaw === 'string' && sentAtRaw.length > 0) {
      const ms = new Date(sentAtRaw).getTime();
      if (!isNaN(ms)) sentAtMs = ms;
    }

    const sharedIds = (data['sharedAsIds'] ?? []) as string[];
    const rawAuthor = data['authorDisplayName'];
    const authorDisplayName =
      typeof rawAuthor === 'string' && rawAuthor.length > 0 ? rawAuthor : 'Auntie';

    const dto: KinTaleDto = {
      id: d.id,
      title: typeof data['title'] === 'string' ? (data['title'] as string) : '',
      body: typeof data['bodyCopy'] === 'string' ? (data['bodyCopy'] as string) : '',
      authorDisplayName,
      mediaIds: Array.isArray(data['mediaFileIds']) ? (data['mediaFileIds'] as string[]) : [],
      sentAtMs,
      shared: Array.isArray(sharedIds) && sharedIds.length > 0,
      thumbs: [], // filled in below, after every tale's candidate ids are known.
    };

    // Pet mood: only surface a string->string map. Omit when absent or malformed,
    // never fabricate. Non-string values are dropped, not coerced.
    const rawMoods = data['petMoodSelections'];
    if (rawMoods && typeof rawMoods === 'object' && !Array.isArray(rawMoods)) {
      const moods: Record<string, string> = {};
      for (const [kinId, mood] of Object.entries(rawMoods as Record<string, unknown>)) {
        if (typeof mood === 'string' && mood.length > 0) moods[kinId] = mood;
      }
      if (Object.keys(moods).length > 0) dto.petMoods = moods;
    }

    const route = data['gpsRoute'];
    if (Array.isArray(route)) {
      dto.gpsRoute = (route as Array<Record<string, unknown>>)
        .filter((p) => typeof p['lat'] === 'number' && typeof p['lng'] === 'number')
        .map((p) => {
          const out: RoutePointDto = { lat: p['lat'] as number, lng: p['lng'] as number };
          if (typeof p['t'] === 'number') out.t = p['t'] as number;
          return out;
        });
    }

    const summary = data['gpsSummary'];
    if (summary && typeof summary === 'object') {
      const s = summary as Record<string, unknown>;
      const out: GpsSummaryDto = {};
      if (typeof s['distanceMeters'] === 'number') out.distanceMeters = s['distanceMeters'] as number;
      if (typeof s['durationSeconds'] === 'number') out.durationSeconds = s['durationSeconds'] as number;
      if (out.distanceMeters !== undefined || out.durationSeconds !== undefined) dto.gpsSummary = out;
    }

    return dto;
  });

  await resolveThumbs(firestore, tales);

  logEvent({
    severity: 'info',
    function: 'getMyKinTales',
    event: 'portal.kintales.resolved',
    uid,
    extra: { kinfolkId, count: tales.length, hasMore },
  });

  return { tales, hasMore };
}

const MAX_THUMBS_PER_TALE = 8;

/**
 * Fills each tale's `thumbs` in place from its first `MAX_THUMBS_PER_TALE`
 * `mediaIds`, resolved in one batched `getAll` across the whole page instead
 * of a `getMyKinTaleMedia` round trip per card. A media doc that doesn't
 * exist, or has no `storageUrl`, is dropped — never a placeholder — so a
 * tale's `thumbs` can end up shorter than its candidate slice.
 *
 * Read cost: this is `min(mediaIds.length, 8)` extra `media_files` reads per
 * tale, on top of the page's own `kin_care_reports` reads. Worst case (every
 * tale has >= 8 media) on a full default page is 20 tales x 8 = 160 extra
 * reads; on the max page size (50) it's 400. See task-24-report.md for the
 * call this makes given that number.
 */
async function resolveThumbs(firestore: FirebaseFirestore.Firestore, tales: KinTaleDto[]): Promise<void> {
  const refs: { taleIndex: number; ref: FirebaseFirestore.DocumentReference }[] = [];
  tales.forEach((t, taleIndex) => {
    t.mediaIds.slice(0, MAX_THUMBS_PER_TALE).forEach((id) => {
      refs.push({ taleIndex, ref: firestore.doc(`media_files/${id}`) });
    });
  });
  if (refs.length === 0) return;

  const snaps = await firestore.getAll(...refs.map((r) => r.ref));
  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    const d = snap.data() as Record<string, unknown>;
    const url = typeof d['storageUrl'] === 'string' ? (d['storageUrl'] as string) : '';
    if (!url) return;
    tales[refs[i]!.taleIndex]!.thumbs.push({
      id: snap.id,
      url,
      contentType: typeof d['mimeType'] === 'string' ? (d['mimeType'] as string) : null,
    });
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const getMyKinTales = onCall(
  // Portal feed read.
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('getMyKinTales', getMyKinTalesHandler),
);
