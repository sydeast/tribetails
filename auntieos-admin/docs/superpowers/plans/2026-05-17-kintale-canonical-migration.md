# KinTale Canonical Migration — MyTribe Pipeline Fix

> **HISTORICAL, written 2026-05-17. Shipped. Do not run this as a plan.**
> The repoint landed: `mytribe/functions/src/portal/getMyKinTales.ts:73` reads
> the canonical `kin_care_reports` collection. Read it for the field mapping.
> It predates the 2026-07-21 monorepo merge, so the standalone repo paths in it
> resolve to `mytribe/` and `auntieos-admin/` today.

**Goal:** Repoint all MyTribe Cloud Functions + triggers from the defunct `families/{kinfolkId}/kinTales/` collection to the canonical `kin_care_reports/` collection that AuntieOS now writes to, restoring kinfolk's ability to see KinTales.

**Architecture:** AuntieOS writes KinTales to the flat `kin_care_reports/{reportId}` collection with `kinfolkId` as a field (not a path segment). Media is uploaded to Cloudinary; metadata lives in the `media_files/{id}` collection. MyTribe's 8 functions + 2 triggers need to be repointed, and tests updated. AuntieOS models get `authorDisplayName`/`authorId` so reports are self-contained.

**Tech Stack:** TypeScript / Cloud Functions v2 (MyTribe), Kotlin / Compose (AuntieOS Android + Web), Firestore, Vitest (function tests), Cloudinary CDN for media

---

## Critical Field Mapping

| `kin_care_reports` field | Old `families/kinTales` field | Notes |
|---|---|---|
| `bodyCopy` | `body` | same content, different key |
| `mediaFileIds` | `mediaIds` | IDs into `media_files` collection (Cloudinary URLs) |
| `sentAt` (ISO string) | `sentAt` (Firestore Timestamp) | parse with `new Date(s).getTime()` |
| `kinfolkId` (doc field) | `{kinfolkId}` (path param) | equality filter in query |
| `sharedAsIds` | `sharedAsIds` | same meaning, written by createShareLink |
| `authorDisplayName` | `authorDisplayName` | **ADD to KinCareReport model (Tasks 1-2)** |
| `authorId` | _(implicit from auth)_ | **ADD to KinCareReport model (Tasks 1-2)** |

---

## File Map

**MyTribe** (`/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/`):
- Modify: `functions/src/portal/getMyKinTales.ts`
- Modify: `functions/src/portal/getMyKinTaleMedia.ts`
- Modify: `functions/src/portal/getKinTaleComments.ts`
- Modify: `functions/src/portal/kinTaleEngagement.ts`
- Modify: `functions/src/share/createShareLink.ts`
- Modify: `functions/src/public/addGuestKinTaleComment.ts`
- Modify: `functions/src/triggers/onKinTaleCreate.ts`
- Modify: `functions/src/triggers/onKinTaleCommentCreate.ts`
- Modify: `firestore.rules`
- Modify: `firestore.indexes.json`
- Modify: `functions/test/getMyKinTales.test.ts`
- Modify: `functions/test/getMyKinTaleMedia.test.ts`
- Modify: `functions/test/addKinTaleComment.test.ts`
- Modify: `functions/test/createShareLink.test.ts`
- Modify: `functions/test/addGuestKinTaleComment.test.ts`
- Modify: `functions/test/ingestKinTale.test.ts`
- Modify (or Create): `functions/test/onKinTaleCreate.test.ts`
- Modify (or Create): `functions/test/onKinTaleCommentCreate.test.ts`

**AuntieOS Android** (`/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android/`):
- Modify: `app/src/main/java/com/tribetails/auntieos/data/model/Models.kt` (line 306 — KinCareReport)
- Modify: `app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt` (createKinCareReport ≈ line 988)

**AuntieOS Web** (`/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web/`):
- Modify: `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt` (line 522 — KinCareReport)
- Modify: `composeApp/src/wasmJsMain/kotlin/com/tribetails/auntieos/web/data/FirestoreInterop.wasmJs.kt` (platformCreateKinTaleReport ≈ line 330)

---

## TRACK A — AuntieOS Model Changes (parallel with Track B)

### Task 1: Add authorDisplayName + authorId to Android KinCareReport

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt:306`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`
- Test: `android/app/src/test/java/com/tribetails/auntieos/` (existing test suite)

- [ ] **Step 1: Add fields to KinCareReport model**

In `android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, find `data class KinCareReport(` at line ~306. Add two fields after `var kinfolkName: String = "":

```kotlin
data class KinCareReport(
    @DocumentId val id: String = "",
    var sessionId: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var authorId: String = "",            // ← ADD
    var authorDisplayName: String = "",   // ← ADD
    var kinIds: List<String> = emptyList(),
    // ... rest of fields unchanged
```

- [ ] **Step 2: Populate authorId + authorDisplayName at write time**

In `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, find `fun createKinCareReport` (≈ line 987). The function receives a `KinCareReport report`. Before `docRef.set(newReport)`, populate the author fields:

```kotlin
suspend fun createKinCareReport(report: KinCareReport): Result<String> = runCatching {
    ensureAuthenticated()
    val docRef = firestore.collection("kin_care_reports").document()
    val timestamp = getCurrentTimestamp()
    val currentUser = auth.currentUser
    val newReport = report.copy(
        id = docRef.id,
        authorId = currentUser?.uid ?: "",
        authorDisplayName = currentUser?.displayName ?: "Auntie",
        createdAt = timestamp,
        updatedAt = timestamp
    )
    docRef.set(newReport).await()
    // ... rest unchanged
```

- [ ] **Step 3: Run Android tests**

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android
./gradlew :app:testDebugUnitTest --tests "*KinCare*" --tests "*KinTale*" 2>&1 | tail -20
```

Expected: All KinCare/KinTale tests pass.

- [ ] **Step 4: Full Android test suite**

```bash
./gradlew :app:testDebugUnitTest 2>&1 | tail -10
```

Expected: No new failures.

---

### Task 2: Add authorDisplayName + authorId to Web KinCareReport

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:522`
- Modify: `web/composeApp/src/wasmJsMain/kotlin/com/tribetails/auntieos/web/data/FirestoreInterop.wasmJs.kt`

- [ ] **Step 1: Add fields to web KinCareReport model**

In `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt`, find `data class KinCareReport(` at line ~522. Add two fields after `val kinfolkName: String = "":

```kotlin
data class KinCareReport(
    val _id: String = "",
    val sessionId: String = "",
    val kinfolkId: String = "",
    val kinfolkName: String = "",
    val authorId: String = "",           // ← ADD
    val authorDisplayName: String = "",  // ← ADD
    val kinIds: List<String> = emptyList(),
    // ... rest of fields unchanged
```

- [ ] **Step 2: Populate author fields at write time**

In `web/composeApp/src/wasmJsMain/kotlin/com/tribetails/auntieos/web/data/FirestoreInterop.wasmJs.kt`, find `platformCreateKinTaleReport` (≈ line 330). The `report` param already has `kinfolkId`. Populate author fields from the current auth session before writing:

```kotlin
internal actual suspend fun platformCreateKinTaleReport(report: KinCareReport): WriteResult<String> {
    val now = nowIsoUtc()
    val currentUser = AuthClient.currentUser()   // use existing AuthClient/AuthInterop
    val stamped = report.copy(
        authorId = currentUser?.uid ?: "",
        authorDisplayName = currentUser?.displayName ?: "Auntie",
        createdAt = now,
        updatedAt = now
    )
    return awaitWrite { cb -> jsAddDoc("kin_care_reports", jsonOut.encodeToString(stamped), cb) }
}
```

> **Note:** If `AuthClient.currentUser()` is not available in this file, check `web/composeApp/src/wasmJsMain/kotlin/com/tribetails/auntieos/web/data/` for the pattern used elsewhere. Use whatever auth accessor already exists.

- [ ] **Step 3: Run web compile check**

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web
./gradlew :composeApp:compileKotlinWasmJs 2>&1 | grep -E "error:|Error" | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Run web tests**

```bash
./gradlew :composeApp:jvmTest 2>&1 | tail -10
```

Expected: All tests pass.

---

## TRACK B — MyTribe Functions Migration (critical path)

### Task 3: Repoint getMyKinTales to kin_care_reports

**Files:**
- Modify: `functions/src/portal/getMyKinTales.ts`
- Modify: `functions/test/getMyKinTales.test.ts`

- [ ] **Step 1: Write the failing test first**

Replace the test file `functions/test/getMyKinTales.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

describe('getMyKinTalesHandler', () => {
  it('rejects unauth', async () => {
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    await expect(
      getMyKinTalesHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('queries kin_care_reports by kinfolkId and maps fields', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        'kin_care_reports': [
          {
            id: 'r1',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'Fluffy had a great day!',
              authorDisplayName: 'TiTi',
              mediaFileIds: ['mf1', 'mf2'],
              sentAt: '2026-01-15T12:00:00.000Z',
              status: 'SENT',
              sharedAsIds: ['sh1'],
            },
          },
          {
            id: 'r2',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'Short visit.',
              authorDisplayName: null,
              mediaFileIds: [],
              sentAt: '2026-01-10T09:00:00.000Z',
              status: 'SENT',
              sharedAsIds: [],
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3', limit: 50 },
      auth: { uid: 'u1' },
    } as any);

    expect(res.tales).toHaveLength(2);
    expect(res.tales[0].id).toBe('r1');
    expect(res.tales[0].body).toBe('Fluffy had a great day!');
    expect(res.tales[0].authorDisplayName).toBe('TiTi');
    expect(res.tales[0].mediaIds).toEqual(['mf1', 'mf2']);
    expect(res.tales[0].sentAtMs).toBe(new Date('2026-01-15T12:00:00.000Z').getTime());
    expect(res.tales[0].shared).toBe(true);
    expect(res.tales[1].shared).toBe(false);
    expect(res.hasMore).toBe(false);
  });

  it('falls back to "Auntie" when authorDisplayName missing', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        'kin_care_reports': [
          {
            id: 'r1',
            data: {
              kinfolkId: 'fam3',
              bodyCopy: 'visit',
              sentAt: '2026-01-15T12:00:00.000Z',
              status: 'SENT',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
    const res = await getMyKinTalesHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.tales[0].authorDisplayName).toBe('Auntie');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions
npx vitest run test/getMyKinTales.test.ts 2>&1 | tail -20
```

Expected: FAIL — tests query wrong collection path.

- [ ] **Step 3: Rewrite getMyKinTales.ts**

Replace `functions/src/portal/getMyKinTales.ts` with:

```typescript
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';

interface GetMyKinTalesRequest {
  kinfolkId?: string;
  /** Pagination cursor — `sentAtMs` of the last item. Converted to ISO for Firestore cursor. */
  before?: number;
  limit?: number;
}

interface RoutePointDto { lat: number; lng: number; t?: number; }
interface GpsSummaryDto { distanceMeters?: number; durationSeconds?: number; }

interface KinTaleDto {
  id: string;
  body: string;
  authorDisplayName: string | null;
  mediaIds: string[];
  sentAtMs: number | null;
  shared: boolean;
  gpsRoute?: RoutePointDto[];
  gpsSummary?: GpsSummaryDto;
}

interface GetMyKinTalesResult { tales: KinTaleDto[]; hasMore: boolean; }

function isoToMillis(iso: unknown): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export async function getMyKinTalesHandler(
  req: CallableRequest<GetMyKinTalesRequest>,
): Promise<GetMyKinTalesResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId);
  const limit = clamp(req.data?.limit ?? 20, 1, 50);

  // kin_care_reports is a flat collection; kinfolkId is a doc field.
  // sentAt is an ISO string — lexicographic order matches chronological for UTC ISO 8601.
  // sentAt > '' excludes DRAFT reports (sentAt == '').
  let q = db()
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
    const sharedIds = (data['sharedAsIds'] ?? []) as string[];

    const dto: KinTaleDto = {
      id: d.id,
      body: typeof data['bodyCopy'] === 'string' ? (data['bodyCopy'] as string) : '',
      authorDisplayName:
        typeof data['authorDisplayName'] === 'string' && (data['authorDisplayName'] as string).length > 0
          ? (data['authorDisplayName'] as string)
          : 'Auntie',
      mediaIds: Array.isArray(data['mediaFileIds']) ? (data['mediaFileIds'] as string[]) : [],
      sentAtMs: isoToMillis(data['sentAt']),
      shared: Array.isArray(sharedIds) && sharedIds.length > 0,
    };

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
      if (typeof s['distanceMeters']  === 'number') out.distanceMeters  = s['distanceMeters']  as number;
      if (typeof s['durationSeconds'] === 'number') out.durationSeconds = s['durationSeconds'] as number;
      if (out.distanceMeters !== undefined || out.durationSeconds !== undefined) dto.gpsSummary = out;
    }
    return dto;
  });

  logEvent({
    severity: 'info',
    function: 'getMyKinTales',
    event: 'portal.kintales.resolved',
    uid,
    extra: { kinfolkId, count: tales.length, hasMore },
  });

  return { tales, hasMore };
}

export const getMyKinTales = onCall(
  { region: 'us-central1', cors: true, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyKinTales', getMyKinTalesHandler),
);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/getMyKinTales.test.ts 2>&1 | tail -10
```

Expected: 3/3 PASS.

---

### Task 4: Repoint getMyKinTaleMedia to media_files (Cloudinary)

**Files:**
- Modify: `functions/src/portal/getMyKinTaleMedia.ts`
- Modify: `functions/test/getMyKinTaleMedia.test.ts`

- [ ] **Step 1: Write failing tests**

Replace `functions/test/getMyKinTaleMedia.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

describe('getMyKinTaleMediaHandler', () => {
  it('rejects unauth', async () => {
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    await expect(
      getMyKinTaleMediaHandler({ data: { taleId: 't1' }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns empty array when no mediaFileIds', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': { kinfolkId: 'fam3', mediaFileIds: [] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    const res = await getMyKinTaleMediaHandler({
      data: { taleId: 't1', kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.media).toEqual([]);
  });

  it('reads media_files docs and returns storageUrl as CDN url', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': {
          kinfolkId: 'fam3',
          mediaFileIds: ['mf1', 'mf2'],
        },
        'media_files/mf1': { storageUrl: 'https://res.cloudinary.com/AuntieOS_Media/image/upload/q_auto/img1.jpg', mimeType: 'image/jpeg' },
        'media_files/mf2': { storageUrl: 'https://res.cloudinary.com/AuntieOS_Media/video/upload/q_auto/clip1.mp4', mimeType: 'video/mp4' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    const res = await getMyKinTaleMediaHandler({
      data: { taleId: 't1', kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.media).toHaveLength(2);
    expect(res.media[0].id).toBe('mf1');
    expect(res.media[0].url).toBe('https://res.cloudinary.com/AuntieOS_Media/image/upload/q_auto/img1.jpg');
    expect(res.media[0].contentType).toBe('image/jpeg');
    expect(res.media[1].contentType).toBe('video/mp4');
  });

  it('throws not-found when kinfolkId mismatch', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': { kinfolkId: 'other_fam', mediaFileIds: ['mf1'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    await expect(
      getMyKinTaleMediaHandler({
        data: { taleId: 't1', kinfolkId: 'fam3' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('skips media_files doc that is missing storageUrl', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_reports/t1': { kinfolkId: 'fam3', mediaFileIds: ['mf1', 'mf_bad'] },
        'media_files/mf1': { storageUrl: 'https://res.cloudinary.com/AuntieOS_Media/image/upload/q_auto/img1.jpg', mimeType: 'image/jpeg' },
        'media_files/mf_bad': { storageUrl: '', mimeType: 'image/jpeg' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinTaleMediaHandler } = await import('../src/portal/getMyKinTaleMedia');
    const res = await getMyKinTaleMediaHandler({
      data: { taleId: 't1', kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.media).toHaveLength(1);
    expect(res.media[0].id).toBe('mf1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/getMyKinTaleMedia.test.ts 2>&1 | tail -20
```

Expected: FAIL — reads from wrong collection.

- [ ] **Step 3: Rewrite getMyKinTaleMedia.ts**

Replace `functions/src/portal/getMyKinTaleMedia.ts` with:

```typescript
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';

const Args = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
});

interface MediaItem { id: string; url: string; contentType: string | null; }
interface GetMediaResult { taleId: string; media: MediaItem[]; }

/**
 * Returns Cloudinary CDN URLs for a KinTale's mediaFileIds.
 * Source: kin_care_reports/{taleId}.mediaFileIds → media_files/{id}.storageUrl
 * (Cloudinary CDN, no signing required — URLs are public.)
 */
export async function getMyKinTaleMediaHandler(
  req: CallableRequest<unknown>,
): Promise<GetMediaResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId);

  const taleSnap = await db().doc(`kin_care_reports/${args.taleId}`).get();
  if (!taleSnap.exists) throw new HttpsError('not-found', 'KinTale not found.');
  const taleData = taleSnap.data() as Record<string, unknown>;
  if (taleData['kinfolkId'] !== kinfolkId) throw new HttpsError('not-found', 'KinTale not found.');

  const mediaFileIds = Array.isArray(taleData['mediaFileIds'])
    ? (taleData['mediaFileIds'] as string[])
    : [];
  if (mediaFileIds.length === 0) return { taleId: args.taleId, media: [] };

  const mediaItems: MediaItem[] = await Promise.all(
    mediaFileIds.map(async (id) => {
      const snap = await db().doc(`media_files/${id}`).get();
      if (!snap.exists) return null;
      const d = snap.data() as Record<string, unknown>;
      const url = typeof d['storageUrl'] === 'string' ? (d['storageUrl'] as string) : '';
      if (!url) return null;
      return {
        id,
        url,
        contentType: typeof d['mimeType'] === 'string' ? (d['mimeType'] as string) : null,
      };
    }),
  ).then((items) => items.filter((m): m is MediaItem => m !== null));

  logEvent({
    severity: 'info',
    function: 'getMyKinTaleMedia',
    event: 'portal.kintale.media.resolved',
    uid,
    extra: { kinfolkId, taleId: args.taleId, count: mediaItems.length },
  });

  return { taleId: args.taleId, media: mediaItems };
}

export const getMyKinTaleMedia = onCall(
  { region: 'us-central1', cors: true, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyKinTaleMedia', getMyKinTaleMediaHandler),
);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/getMyKinTaleMedia.test.ts 2>&1 | tail -10
```

Expected: 5/5 PASS.

---

### Task 5: Repoint getKinTaleComments + addKinTaleComment (kinTaleEngagement)

**Files:**
- Modify: `functions/src/portal/getKinTaleComments.ts`
- Modify: `functions/src/portal/kinTaleEngagement.ts`
- Modify: `functions/test/addKinTaleComment.test.ts`

- [ ] **Step 1: Write failing tests for addKinTaleComment**

Replace `functions/test/addKinTaleComment.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { addKinTaleCommentHandler } from '../src/portal/kinTaleEngagement';

function req(data: unknown, uid = 'u1', admin = false): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: admin ? ({ admin: true } as any) : ({} as any) },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('addKinTaleComment — kin_care_reports path', () => {
  it('HAPPY kinfolk top-level: writes to kin_care_reports comments', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addKinTaleCommentHandler(req({ taleId: 't1', body: 'nice tale!' }));
    expect(res.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection === 'kin_care_reports/t1/comments');
    expect(add).toBeDefined();
    expect(add?.data.authorRole).toBe('kinfolk');
    expect(add?.data.parentCommentId).toBeNull();
    expect(add?.data.body).toBe('nice tale!');
  });

  it('HAPPY kinfolk reply: writes parentCommentId', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale' },
        'kin_care_reports/t1/comments/parentC': { body: 'parent' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addKinTaleCommentHandler(
      req({ taleId: 't1', body: 'replying', parentCommentId: 'parentC' }),
    );
    expect(res.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection === 'kin_care_reports/t1/comments');
    expect(add?.data.parentCommentId).toBe('parentC');
  });

  it('SAD: missing parent throws not-found', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(req({ taleId: 't1', body: 'reply', parentCommentId: 'ghost' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HAPPY admin: writes with authorRole=admin, accepts explicit kinfolkId', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/admin1': { kinfolkIds: [] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addKinTaleCommentHandler(
      req({ taleId: 't1', body: 'admin note', kinfolkId: 'f1' }, 'admin1', true),
    );
    expect(res.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection === 'kin_care_reports/t1/comments');
    expect(add?.data.authorRole).toBe('admin');
  });

  it('SAD: admin without kinfolkId throws invalid-argument', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(req({ taleId: 't1', body: 'no kinfolk' }, 'admin1', true)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/addKinTaleComment.test.ts 2>&1 | tail -20
```

Expected: FAIL — collection path mismatch.

- [ ] **Step 3: Rewrite getKinTaleComments.ts**

Replace `functions/src/portal/getKinTaleComments.ts` with:

```typescript
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';

const Args = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
});

type CommentDoc = {
  authorRole?: string;
  authorUid?: string | null;
  guestName?: string | null;
  body?: string;
  parentCommentId?: string | null;
  createdAtMs?: number;
};

export async function getKinTaleCommentsHandler(
  req: CallableRequest<unknown>,
): Promise<{ comments: Array<Record<string, unknown>> }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);
  const isAdmin = req.auth?.token?.admin === true;

  let kinfolkId: string;
  if (isAdmin) {
    if (!args.kinfolkId) throw new HttpsError('invalid-argument', 'kinfolkId required for admin.');
    kinfolkId = args.kinfolkId;
  } else {
    ({ kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId));
  }

  const taleSnap = await db().doc(`kin_care_reports/${args.taleId}`).get();
  if (!taleSnap.exists || taleSnap.data()?.['kinfolkId'] !== kinfolkId) {
    throw new HttpsError('not-found', 'kinTale not found');
  }

  const snap = await db()
    .collection(`kin_care_reports/${args.taleId}/comments`)
    .orderBy('createdAtMs', 'asc')
    .get();

  const comments = snap.docs.map((d) => {
    const data = d.data() as CommentDoc;
    return {
      id: d.id,
      authorRole: data.authorRole ?? 'kinfolk',
      authorUid: data.authorUid ?? null,
      guestName: data.guestName ?? null,
      body: data.body ?? '',
      parentCommentId: data.parentCommentId ?? null,
      createdAtMs: data.createdAtMs ?? null,
    };
  });
  return { comments };
}

export const getKinTaleComments = onCall(
  { region: 'us-central1', cors: true, secrets: ['SENTRY_DSN'] },
  wrapCallable('getKinTaleComments', getKinTaleCommentsHandler),
);
```

- [ ] **Step 4: Rewrite kinTaleEngagement.ts (addKinTaleComment)**

Replace the `ensureTaleExists` and `ensureParentCommentExists` helpers and the write paths inside `functions/src/portal/kinTaleEngagement.ts`:

```typescript
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';

const Body = z.string().min(1).max(2000).refine((s) => s.trim().length > 0, {
  message: 'body cannot be whitespace-only',
});

const CommentArgs = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
  body: Body,
  parentCommentId: z.string().min(1).max(200).optional(),
});

async function resolveKinfolkId(uid: string, requested: string | undefined): Promise<string> {
  const clientSnap = await db().collection('clients').doc(uid).get();
  const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowed.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');
  const kinfolkId = requested ?? allowed[0];
  if (!allowed.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');
  return kinfolkId;
}

async function ensureTaleExists(taleId: string, kinfolkId: string): Promise<void> {
  const snap = await db().doc(`kin_care_reports/${taleId}`).get();
  if (!snap.exists || snap.data()?.['kinfolkId'] !== kinfolkId) {
    throw new HttpsError('not-found', 'kinTale not found');
  }
}

async function ensureParentCommentExists(taleId: string, parentCommentId: string): Promise<void> {
  const snap = await db().doc(`kin_care_reports/${taleId}/comments/${parentCommentId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'parent comment not found');
}

export async function addKinTaleCommentHandler(
  req: CallableRequest<unknown>,
): Promise<{ commentId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = CommentArgs.parse(req.data);
  const isAdmin = req.auth?.token?.admin === true;

  let kinfolkId: string;
  if (isAdmin) {
    if (!args.kinfolkId) throw new HttpsError('invalid-argument', 'kinfolkId required for admin comments.');
    kinfolkId = args.kinfolkId;
  } else {
    kinfolkId = await resolveKinfolkId(uid, args.kinfolkId);
  }

  await ensureTaleExists(args.taleId, kinfolkId);
  if (args.parentCommentId) {
    await ensureParentCommentExists(args.taleId, args.parentCommentId);
  }

  const ref = await db()
    .collection(`kin_care_reports/${args.taleId}/comments`)
    .add({
      authorUid: uid,
      authorRole: isAdmin ? 'admin' : 'kinfolk',
      body: args.body.trim(),
      parentCommentId: args.parentCommentId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    });

  logEvent({
    severity: 'info',
    function: 'addKinTaleComment',
    event: 'portal.kintale.comment.added',
    uid,
    extra: { taleId: args.taleId, commentId: ref.id },
  });

  return { commentId: ref.id };
}

export const addKinTaleComment = onCall(
  { region: 'us-central1', cors: true, secrets: ['SENTRY_DSN'] },
  wrapCallable('addKinTaleComment', addKinTaleCommentHandler),
);
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run test/addKinTaleComment.test.ts 2>&1 | tail -10
```

Expected: 5/5 PASS.

---

### Task 6: Repoint createShareLink + addGuestKinTaleComment

**Files:**
- Modify: `functions/src/share/createShareLink.ts`
- Modify: `functions/src/public/addGuestKinTaleComment.ts`
- Modify: `functions/test/createShareLink.test.ts`
- Modify: `functions/test/addGuestKinTaleComment.test.ts`

- [ ] **Step 1: Read current createShareLink test**

```bash
cat /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/test/createShareLink.test.ts | head -80
```

- [ ] **Step 2: Update createShareLink.ts**

In `functions/src/share/createShareLink.ts`, change the tale lookup from `families/${args.familyId}/kinTales/${args.kinTaleId}` to `kin_care_reports/${args.kinTaleId}`, and add a kinfolkId ownership check. Replace the file with:

```typescript
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { SHARE_DEFAULT_TTL_DAYS } from '../lib/schema';

const Args = z.object({
  familyId: z.string().min(1),
  kinTaleId: z.string().min(1),
  includePhotos: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  passcode: z.string().min(4).max(8).optional(),
});

export async function createShareLinkHandler(req: CallableRequest<unknown>): Promise<{ shareId: string; shareUrl: string }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);
  const caller = await loadMember(args.familyId, req.auth.uid);
  requirePrimary(caller);

  // KinTale now lives in kin_care_reports (flat collection, kinfolkId is a field).
  const taleSnap = await db().doc(`kin_care_reports/${args.kinTaleId}`).get();
  if (!taleSnap.exists) throw new HttpsError('not-found', 'kinTale not found');
  const tale = taleSnap.data() as { bodyCopy?: string; mediaFileIds?: string[]; authorDisplayName?: string; kinfolkId?: string };
  if (tale.kinfolkId !== args.familyId) throw new HttpsError('not-found', 'kinTale not found');

  const days = args.expiresInDays ?? SHARE_DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + days * 86400 * 1000);

  // Photos are served as Cloudinary CDN URLs (no signing needed).
  const photos: string[] = [];
  if (args.includePhotos && tale.mediaFileIds?.length) {
    for (const id of tale.mediaFileIds) {
      const m = await db().doc(`media_files/${id}`).get();
      if (!m.exists) continue;
      const md = m.data() as { storageUrl?: string };
      if (md.storageUrl) photos.push(md.storageUrl);
    }
  }

  const passcodeHash = args.passcode ? await argon2.hash(args.passcode) : undefined;
  const ref = await db().collection('sharedKinTales').add({
    tribeId: args.familyId,
    sourceKinTaleId: args.kinTaleId,
    scrubbedPayload: {
      authorDisplayName: tale.authorDisplayName ?? 'Auntie',
      body: tale.bodyCopy ?? '',
      photos,
    },
    includePhotos: args.includePhotos,
    expiresAt,
    passcodeHash: passcodeHash ?? null,
    revoked: false,
    createdBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Record that this KinTale has been shared.
  await db().doc(`kin_care_reports/${args.kinTaleId}`).update({
    sharedAsIds: FieldValue.arrayUnion(ref.id),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.CONTENT_SHARE_LINK_CREATED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    familyId: args.familyId,
    payload: { shareId: ref.id, kinTaleId: args.kinTaleId, includePhotos: args.includePhotos, hasPasscode: !!args.passcode },
  });

  const shareUrl = `${process.env.SHARE_LINK_BASE_URL}/${ref.id}`;
  return { shareId: ref.id, shareUrl };
}

export const createShareLink = onCall(
  { region: 'us-central1', cors: true, secrets: ['TRIBE_PIN_PEPPER', 'SENTRY_DSN'] },
  wrapCallable('createShareLink', createShareLinkHandler),
);
```

- [ ] **Step 3: Update addGuestKinTaleComment.ts — change comment write path**

In `functions/src/public/addGuestKinTaleComment.ts`, find the two collection references at ≈ lines 212 and 221 that write to `families/${tribeId}/kinTales/${args.taleId}/comments`. Change both to `kin_care_reports/${args.taleId}/comments`:

Line ≈212:
```typescript
// BEFORE:
.doc(`families/${tribeId}/kinTales/${args.taleId}/comments/${args.parentCommentId}`)
// AFTER:
.doc(`kin_care_reports/${args.taleId}/comments/${args.parentCommentId}`)
```

Line ≈221:
```typescript
// BEFORE:
.collection(`families/${tribeId}/kinTales/${args.taleId}/comments`)
// AFTER:
.collection(`kin_care_reports/${args.taleId}/comments`)
```

- [ ] **Step 4: Update createShareLink tests to use kin_care_reports**

In `functions/test/createShareLink.test.ts`, find all occurrences of `families/` + kinTales and replace doc paths. For example:

Change:
```typescript
'families/f1/kinTales/t1': { body: 'tale body', mediaIds: [], authorDisplayName: 'TiTi' }
```
To:
```typescript
'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body', mediaFileIds: [], authorDisplayName: 'TiTi' }
```

Also change any assertion that checks for `families/f1/kinTales/t1` update to `kin_care_reports/t1`.

- [ ] **Step 5: Update addGuestKinTaleComment tests**

In `functions/test/addGuestKinTaleComment.test.ts`, change doc paths from `families/${tribeId}/kinTales/${taleId}/comments/...` to `kin_care_reports/${taleId}/comments/...`.

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/createShareLink.test.ts test/addGuestKinTaleComment.test.ts 2>&1 | tail -20
```

Expected: All PASS.

---

### Task 7: Repoint Firestore Triggers

**Files:**
- Modify: `functions/src/triggers/onKinTaleCreate.ts`
- Modify: `functions/src/triggers/onKinTaleCommentCreate.ts`
- Create: `functions/test/onKinTaleCreate.test.ts`
- Create: `functions/test/onKinTaleCommentCreate.test.ts`

- [ ] **Step 1: Write trigger tests**

Create `functions/test/onKinTaleCreate.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: Function) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));

import { onKinTaleCreateHandler } from '../src/triggers/onKinTaleCreate';

describe('onKinTaleCreate trigger', () => {
  it('reads kinfolkId from doc data and dispatches kintale.published', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler({
      params: { reportId: 'r1' },
      data: {
        data: () => ({
          kinfolkId: 'fam3',
          bodyCopy: 'Great visit!',
          authorDisplayName: 'TiTi',
        }),
      },
    } as any);

    expect(mocks.resolveUid).toHaveBeenCalledWith('fam3');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.published',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam3', taleId: 'r1' }),
      }),
    );
  });

  it('skips dispatch when kinfolkId missing from doc', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler({
      params: { reportId: 'r1' },
      data: { data: () => ({ bodyCopy: 'tale' }) }, // no kinfolkId
    } as any);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
```

Create `functions/test/onKinTaleCommentCreate.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: Function) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));

import { onKinTaleCommentCreateHandler } from '../src/triggers/onKinTaleCommentCreate';

describe('onKinTaleCommentCreate trigger', () => {
  it('reads kinfolkId from parent report and dispatches kintale.comment.added', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': { kinfolkId: 'fam3' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'c1' },
      data: {
        data: () => ({ authorUid: 'admin1', authorRole: 'admin', body: 'Great job!' }),
      },
    } as any);

    expect(mocks.resolveUid).toHaveBeenCalledWith('fam3');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.comment.added',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam3', taleId: 'r1', commentId: 'c1' }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/onKinTaleCreate.test.ts test/onKinTaleCommentCreate.test.ts 2>&1 | tail -20
```

Expected: FAIL — handlers not exported / wrong paths.

- [ ] **Step 3: Rewrite onKinTaleCreate.ts**

Replace `functions/src/triggers/onKinTaleCreate.ts` with:

```typescript
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

type KinCareReportDoc = {
  kinfolkId?: string;
  authorDisplayName?: string;
  bodyCopy?: string;
};

/**
 * Watches `kin_care_reports/{reportId}` (canonical KinTale collection).
 * kinfolkId is a field on the doc, not a path parameter.
 * Fires `kintale.published` via the notification catalog.
 */
export async function onKinTaleCreateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const report = event.data?.data() as KinCareReportDoc | undefined;
  const kinfolkId = report?.kinfolkId;

  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCreate',
      event: 'trigger.kintale.missing_kinfolk_id',
      extra: { reportId },
    });
    return;
  }

  const recipientUid = await resolveKinfolkUid(kinfolkId);
  try {
    await enqueueNotification({
      key: 'kintale.published',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId,
        taleId: reportId,
        authorDisplayName: report?.authorDisplayName ?? null,
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCreate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, taleId: reportId, err: (err as Error)?.message },
    });
  }
}

export const onKinTaleCreate = onDocumentCreated(
  {
    document: 'kin_care_reports/{reportId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleCreate', onKinTaleCreateHandler),
);
```

- [ ] **Step 4: Rewrite onKinTaleCommentCreate.ts**

Replace `functions/src/triggers/onKinTaleCommentCreate.ts` with:

```typescript
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { db } from '../lib/firestoreAdmin';

type CommentDoc = {
  authorUid?: string;
  authorRole?: string;
  body?: string;
};

/**
 * Watches `kin_care_reports/{reportId}/comments/{commentId}`.
 * Reads kinfolkId from the parent report doc.
 * Fires `kintale.comment.added` (batched 5min via catalog).
 */
export async function onKinTaleCommentCreateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const commentId = event.params.commentId as string;
  const comment = event.data?.data() as CommentDoc | undefined;
  if (!comment) return;

  // kinfolkId lives on the parent report, not the comment.
  const reportSnap = await db().doc(`kin_care_reports/${reportId}`).get();
  const kinfolkId = (reportSnap.data() as { kinfolkId?: string } | undefined)?.kinfolkId;
  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCommentCreate',
      event: 'trigger.comment.missing_kinfolk_id',
      extra: { reportId, commentId },
    });
    return;
  }

  const recipientUid = await resolveKinfolkUid(kinfolkId);
  try {
    await enqueueNotification({
      key: 'kintale.comment.added',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId,
        taleId: reportId,
        commentId,
        authorUid: comment.authorUid ?? null,
        authorRole: comment.authorRole ?? null,
        preview: (comment.body ?? '').slice(0, 200),
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCommentCreate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, taleId: reportId, commentId, err: (err as Error)?.message },
    });
  }
}

export const onKinTaleCommentCreate = onDocumentCreated(
  {
    document: 'kin_care_reports/{reportId}/comments/{commentId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleCommentCreate', onKinTaleCommentCreateHandler),
);
```

- [ ] **Step 5: Run trigger tests**

```bash
npx vitest run test/onKinTaleCreate.test.ts test/onKinTaleCommentCreate.test.ts 2>&1 | tail -10
```

Expected: All PASS.

---

## TRACK C — Firestore Rules + Index (parallel with Tracks A+B)

### Task 8: Add comments subcollection rule + composite index

**Files:**
- Modify: `firestore.rules`
- Modify: `firestore.indexes.json`

- [ ] **Step 1: Add comments subcollection rule to firestore.rules**

Find the existing `kin_care_reports` block in `firestore.rules`:

```
match /kin_care_reports/{reportId} {
  allow read: if isAuntie()
              || (isKinfolk() && resource.data.kinfolkId == request.auth.token.kinfolkId);
  allow write: if isAuntie();
}
```

Replace it with (adds comments subcollection for direct client reads):

```
match /kin_care_reports/{reportId} {
  allow read: if isAuntie()
              || (isKinfolk() && resource.data.kinfolkId == request.auth.token.kinfolkId);
  allow write: if isAuntie();

  // Comments served server-side via callable (getKinTaleComments / addKinTaleComment).
  // Rule kept for future direct-read access and share viewer.
  match /comments/{commentId} {
    allow read: if isAuntie()
                || (isKinfolk()
                    && get(/databases/$(database)/documents/kin_care_reports/$(reportId)).data.kinfolkId
                       == request.auth.token.kinfolkId);
    allow write: if false;
  }
}
```

- [ ] **Step 2: Add composite index for getMyKinTales query**

In `firestore.indexes.json`, add to the `"indexes"` array:

```json
{
  "collectionGroup": "kin_care_reports",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "kinfolkId", "order": "ASCENDING" },
    { "fieldPath": "sentAt", "order": "DESCENDING" }
  ]
}
```

- [ ] **Step 3: Validate rules syntax**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe
cat firestore.rules | grep -c "match /"
```

Expected: No syntax errors visible, match count reasonable.

---

## Task 9: Deprecate ingestKinTale + full test run

**Files:**
- Modify: `functions/test/ingestKinTale.test.ts`
- No source change (ingestKinTale.ts can stay, it's just orphaned)

- [ ] **Step 1: Mark ingestKinTale test as deprecated**

In `functions/test/ingestKinTale.test.ts`, add a comment at the top:

```typescript
// DEPRECATED 2026-05-17: AuntieOS no longer calls ingestKinTale.
// AuntieOS writes directly to kin_care_reports. This test kept to avoid
// regressions if the callable is ever called by legacy clients.
// When the old callable is formally removed, delete this test file.
```

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions
npm test 2>&1 | tail -15
```

Expected: All tests pass (331+ prior + new trigger tests). Zero failures.

---

## Task 10: Deploy

**Prerequisites:** Tasks 3–9 complete, all tests green.

> **Note:** This task requires operator shell access. Run these commands in terminal. No `!` prefix needed if running directly.

- [ ] **Step 1: Deploy MyTribe functions**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe
firebase deploy --only functions --project auntieos-ttpc 2>&1 | tail -20
```

Expected: All functions deploy successfully, no errors.

- [ ] **Step 2: Deploy Firestore indexes**

```bash
firebase deploy --only firestore:indexes --project auntieos-ttpc 2>&1 | tail -10
```

Expected: Index build triggered. Note: composite index build takes ~1–5 minutes to complete in console.

- [ ] **Step 3: Deploy Firestore rules**

```bash
firebase deploy --only firestore:rules --project auntieos-ttpc 2>&1 | tail -10
```

Expected: Rules deployed.

- [ ] **Step 4: Smoke test — verify MyTribe KinTale feed loads**

Sign in to MyTribe at `https://kinfolk.tribetails.com`. Navigate to KinTales tab. Verify at least one KinTale appears (should show 83 migrated reports now visible).

---

## Self-Review

**Spec coverage check:**
- ✅ `getMyKinTales` → `kin_care_reports` (Task 3)
- ✅ `getMyKinTaleMedia` → `media_files` Cloudinary (Task 4)
- ✅ `getKinTaleComments` → `kin_care_reports/comments` (Task 5)
- ✅ `addKinTaleComment` → `kin_care_reports/comments` (Task 5)
- ✅ `createShareLink` → `kin_care_reports` (Task 6)
- ✅ `addGuestKinTaleComment` → `kin_care_reports/comments` (Task 6)
- ✅ `onKinTaleCreate` trigger → `kin_care_reports/{reportId}` (Task 7)
- ✅ `onKinTaleCommentCreate` trigger → `kin_care_reports/{reportId}/comments/{commentId}` (Task 7)
- ✅ Firestore rules comments subcoll (Task 8)
- ✅ Composite index (Task 8)
- ✅ AuntieOS authorDisplayName field (Tasks 1–2)

**Type consistency check:**
- `taleId` always refers to the doc ID in `kin_care_reports`
- `kinfolkId` always the kinfolk family ID (field on `kin_care_reports` doc)
- `mediaFileIds` / `mediaIds` distinction: Firestore stores `mediaFileIds`; DTO returns field as `mediaIds`
- `bodyCopy` (Firestore) → `body` (DTO) consistently in Tasks 3, 6, 7

**Placeholder scan:** No TBDs or "implement later" present. All code blocks complete.
