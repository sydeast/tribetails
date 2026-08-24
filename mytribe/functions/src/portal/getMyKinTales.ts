import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';
import { TaleThumb, MAX_THUMBS_PER_TALE, mediaDocToThumb } from '../lib/kinTaleThumbs';
import { isClientLocationSharingEnabled } from '../lib/locationSharing';

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

/** One care task the Auntie marked done during the visit. */
interface ChecklistItemDto {
  key: string;
  text: string;
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
   * When the Auntie arrived / departed, resolved from the `kin_care_sessions`
   * row this report's `sessionId` points at (task-25, P4) — NEVER from the
   * report's own `arrivedAt` copy, which is a one-time snapshot taken when the
   * draft was scaffolded and is never updated with `departedAt` at all by the
   * live compose path. See task-25-report.md Step 0.
   *
   * `null` means "not recorded" (no session, no session doc, or an unparseable
   * stored value) — never zero, never "now". A tale can have `arrivedAtIso`
   * with `departedAtIso: null` (visit still in progress when this report was
   * sent, or the field app never stamped a departure).
   */
  arrivedAtIso: string | null;
  departedAtIso: string | null;
  /**
   * Care tasks the Auntie's checklist recorded as DONE for this visit
   * (task-25, P4). CHECKED ITEMS ONLY: an item the Auntie's Android checklist
   * screen never rendered because it isn't in the visit's template, or one she
   * simply never tapped, has no entry here — and it is NEVER rendered as "not
   * done", because the capture UI cannot distinguish "explicitly marked not
   * done" from "never looked at" (see task-25-report.md). Omitted (not `[]`)
   * when nothing resolves, so an empty section never stands in for "all
   * done".
   */
  checklist?: ChecklistItemDto[];
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
  // ISSUE #519: the operator's "Let kinfolk see visit locations" switch, read
  // once per call so a `false` withholds the route from every tale in the page.
  // Absent reads as ON; see `lib/locationSharing.ts`.
  const shareLocations = await isClientLocationSharingEnabled(firestore);
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

  // Tales that predate task-24a's `thumbs` write-back have no stored field
  // yet; those (and only those) still need the old per-read media
  // resolution below. `Array.isArray` (not truthiness) is the "resolved"
  // test: a stored `thumbs: []` means "resolved, nothing renderable" and
  // must cost zero media reads, same as a fully-populated one.
  const fallbackIndices: number[] = [];

  // Parallel, per-tale-index side data for the batched lookups below
  // (sessions for visit times, templates for checklist labels) — gathered in
  // the same pass as `tales` so neither needs a second read of the report doc.
  const sessionIdByIndex: (string | null)[] = [];
  const templateIdByIndex: (string | null)[] = [];
  const checkedKeysByIndex: string[][] = [];

  const tales: KinTaleDto[] = docs.map((d, taleIndex) => {
    const data = d.data() as Record<string, unknown>;
    const storedThumbs = data['thumbs'];
    if (!Array.isArray(storedThumbs)) fallbackIndices.push(taleIndex);

    const sessionIdRaw = data['sessionId'];
    sessionIdByIndex.push(typeof sessionIdRaw === 'string' && sessionIdRaw.length > 0 ? sessionIdRaw : null);

    const templateIdRaw = data['templateId'];
    templateIdByIndex.push(typeof templateIdRaw === 'string' && templateIdRaw.length > 0 ? templateIdRaw : null);

    // `fieldResponses`: a map keyed "kinId|fieldKey" -> { fieldKey, kinId,
    // boolValue, ... }, written by the live operator Android app's checklist
    // screen (`KinTaleReportScreen.kt#setChecklistResponse`). Only
    // `boolValue === true` counts as "checked" here; see the checklist
    // resolution pass below for why `false` is deliberately excluded, not
    // rendered as "not done".
    const checkedKeys: string[] = [];
    const fieldResponses = data['fieldResponses'];
    if (fieldResponses && typeof fieldResponses === 'object' && !Array.isArray(fieldResponses)) {
      for (const resp of Object.values(fieldResponses as Record<string, unknown>)) {
        if (!resp || typeof resp !== 'object') continue;
        const r = resp as Record<string, unknown>;
        if (r['boolValue'] === true && typeof r['fieldKey'] === 'string' && r['fieldKey'].length > 0) {
          checkedKeys.push(r['fieldKey']);
        }
      }
    }
    checkedKeysByIndex.push(checkedKeys);

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
      // Resolved fallback tales get [] here, filled in below.
      thumbs: Array.isArray(storedThumbs) ? (storedThumbs as TaleThumb[]) : [],
      // Filled in below by resolveVisitTimes, once sessions are batch-fetched.
      arrivedAtIso: null,
      departedAtIso: null,
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

    // ISSUE #519: `gpsRoute` is the only coordinate-bearing field on a KinTale.
    // The `gpsSummary` below carries distance and duration only, so it is not
    // gated: the switch withholds WHERE a visit went, not that it happened.
    const route = data['gpsRoute'];
    if (shareLocations && Array.isArray(route)) {
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

  await resolveFallbackThumbs(firestore, tales, fallbackIndices);
  await resolveVisitTimes(firestore, tales, sessionIdByIndex);
  await resolveChecklists(firestore, tales, checkedKeysByIndex, templateIdByIndex);

  logEvent({
    severity: 'info',
    function: 'getMyKinTales',
    event: 'portal.kintales.resolved',
    uid,
    extra: { kinfolkId, count: tales.length, hasMore, fallbackCount: fallbackIndices.length },
  });

  return { tales, hasMore };
}

/**
 * Task-24a: resolves `thumbs` the OLD way — up to `MAX_THUMBS_PER_TALE`
 * `media_files` docs per tale, one batched `getAll` across the whole page —
 * but ONLY for tales in `fallbackIndices`: the ones with no stored `thumbs`
 * field, i.e. written before the create/update triggers started denormalizing
 * it. A tale that already carries `thumbs` (including a stored `[]`) never
 * reaches this function; that's the entire read-cost fix, so a later
 * refactor that widens `fallbackIndices` back to "every tale" would silently
 * undo it — see `getMyKinTalesHandler thumbs` tests for the read-count guard.
 *
 * Self-healing: the next `onKinTaleUpdate` for a fallback tale stamps
 * `thumbs` for good (`maintainThumbs`, `../lib/kinTaleThumbs.ts`), so this
 * path only ever runs for the shrinking set of tales nothing has touched
 * since this shipped. There's no Firestore query for "how many still lack
 * `thumbs`" (Firestore can't index field-absence), but every fallback read
 * logs `portal.kintales.resolved` with `fallbackCount` on it, which is how an
 * operator can watch that population converge toward zero, and a one-off
 * admin script (paginated scan filtering `thumbs === undefined` client-side,
 * same page-and-cursor shape as `aiBackfillTaleTitles`) gives an exact count
 * on demand.
 */
async function resolveFallbackThumbs(
  firestore: FirebaseFirestore.Firestore,
  tales: KinTaleDto[],
  fallbackIndices: number[],
): Promise<void> {
  if (fallbackIndices.length === 0) return;

  const refs: { taleIndex: number; ref: FirebaseFirestore.DocumentReference }[] = [];
  fallbackIndices.forEach((taleIndex) => {
    tales[taleIndex]!.mediaIds.slice(0, MAX_THUMBS_PER_TALE).forEach((id) => {
      refs.push({ taleIndex, ref: firestore.doc(`media_files/${id}`) });
    });
  });
  if (refs.length === 0) return;

  const snaps = await firestore.getAll(...refs.map((r) => r.ref));
  snaps.forEach((snap, i) => {
    const thumb = mediaDocToThumb(snap.id, snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
    if (thumb) tales[refs[i]!.taleIndex]!.thumbs.push(thumb);
  });
}

/**
 * Visit times (task-25, P4): `arrivedAt`/`departedAt` on the `kin_care_sessions`
 * row each report's `sessionId` points at, batch-fetched once per page and
 * never trusted unparsed — a stored value that fails `Date.parse` (a known
 * legacy shape: `bookingFormat.ts` documents bare `departedAt: "6pm"` rows)
 * degrades to `null`, same as "field absent". Missing `sessionId`, or a
 * `sessionId` whose session doc no longer exists, also leaves both fields
 * `null` — never a thrown error, never a fabricated time.
 */
async function resolveVisitTimes(
  firestore: FirebaseFirestore.Firestore,
  tales: KinTaleDto[],
  sessionIdByIndex: (string | null)[],
): Promise<void> {
  const uniqueSessionIds = Array.from(
    new Set(sessionIdByIndex.filter((id): id is string => id !== null)),
  );
  if (uniqueSessionIds.length === 0) return;

  const snaps = await firestore.getAll(
    ...uniqueSessionIds.map((id) => firestore.doc(`kin_care_sessions/${id}`)),
  );
  const sessionDataById = new Map<string, Record<string, unknown>>();
  snaps.forEach((snap, i) => {
    if (snap.exists) sessionDataById.set(uniqueSessionIds[i]!, snap.data() as Record<string, unknown>);
  });

  tales.forEach((tale, taleIndex) => {
    const sessionId = sessionIdByIndex[taleIndex];
    if (sessionId === null) return;
    const sessionData = sessionDataById.get(sessionId);
    if (!sessionData) return;
    tale.arrivedAtIso = parseStoredInstant(sessionData['arrivedAt']);
    tale.departedAtIso = parseStoredInstant(sessionData['departedAt']);
  });
}

/** A stored free-text instant, canonicalized to ISO, or `null` when absent/unparseable. */
function parseStoredInstant(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const ms = new Date(v).getTime();
  return isNaN(ms) ? null : new Date(ms).toISOString();
}

/** One checklist item as stored on a `kintale_templates` doc (or the built-in default below). */
interface TemplateChecklistItem {
  key: string;
  text: string;
  order: number;
}

/**
 * The built-in default template's checklist items, mirroring
 * `auntieos-admin/android/.../ui/kintales/KinTaleTemplateEngine.kt`'s
 * `DefaultKinTaleTemplate.template.checklistItems` field-for-field (keys and
 * order included). This is the template a report uses when its `templateId`
 * is blank (`scaffoldReport` on the field app only stamps a real id for a
 * NON-default template). Deliberately NOT the same list as
 * `auntieos-admin/src/lib/kinTale/model.ts`'s `DEFAULT_KINTALE_TEMPLATE` —
 * that TS constant's keys (`water`, `meds`, `play`, ...) were confirmed to
 * NOT match the Android keys real fieldResponses are written with; using it
 * here would silently resolve zero items. See task-25-report.md Step 0.
 */
const DEFAULT_TEMPLATE_CHECKLIST_ITEMS: TemplateChecklistItem[] = [
  { key: 'peed', text: 'Peed', order: 0 },
  { key: 'pooed', text: 'Pooed', order: 1 },
  { key: 'fed', text: 'Fed', order: 2 },
  { key: 'fresh_water', text: 'Fresh water provided', order: 3 },
  { key: 'meds_given', text: 'Medications given', order: 4 },
  { key: 'played', text: 'Played', order: 5 },
  { key: 'litter_scooped', text: 'Litter box scooped', order: 6 },
  { key: 'walk_water_refill', text: 'Water refilled after walk', order: 7 },
  { key: 'trash_taken_out', text: 'Trash taken out', order: 8 },
  { key: 'lights_off', text: 'Lights turned off', order: 9 },
];

/**
 * The task checklist (task-25, P4). CHECKED ITEMS ONLY — deliberately does
 * NOT attempt to render "not done": the live capture UI
 * (`KinTaleReportViewModel.setChecklistResponse`, Android) only writes a
 * `fieldResponses` entry when the Auntie taps an item, so an item with no
 * entry is indistinguishable between "explicitly left undone" and "never
 * shown to her because a condition didn't apply" (e.g. a diabetic-only
 * medication item on a non-diabetic pet). Answering that would require
 * porting the template CONDITION engine (`KinTaleConditionEngine.kt` /
 * `KinTaleTemplateEngine.kt`) — a second concern, out of scope here; see
 * task-25-report.md. Only `boolValue === true` is a real claim, matching the
 * one existing sent-report renderer, `SentChecklistResolver.kt:46`
 * (`checked = report.fieldResponses.values.filter { it.boolValue == true }`).
 *
 * Labels/order come from the report's own `templateId` (or the built-in
 * default when blank) — a checked key that isn't in THAT template (wrong
 * template, or the template/key has since changed) cannot be labeled, so it
 * is dropped rather than shown with a fabricated or blank label.
 */
async function resolveChecklists(
  firestore: FirebaseFirestore.Firestore,
  tales: KinTaleDto[],
  checkedKeysByIndex: string[][],
  templateIdByIndex: (string | null)[],
): Promise<void> {
  const uniqueTemplateIds = Array.from(
    new Set(templateIdByIndex.filter((id): id is string => id !== null)),
  );

  const itemsByTemplateId = new Map<string, TemplateChecklistItem[]>();
  if (uniqueTemplateIds.length > 0) {
    const snaps = await firestore.getAll(
      ...uniqueTemplateIds.map((id) => firestore.doc(`kintale_templates/${id}`)),
    );
    snaps.forEach((snap, i) => {
      if (snap.exists) {
        itemsByTemplateId.set(uniqueTemplateIds[i]!, parseTemplateChecklistItems(snap.data()));
      }
    });
  }

  tales.forEach((tale, taleIndex) => {
    const checkedKeys = checkedKeysByIndex[taleIndex] ?? [];
    if (checkedKeys.length === 0) return;

    const templateId = templateIdByIndex[taleIndex];
    const items = templateId === null
      ? DEFAULT_TEMPLATE_CHECKLIST_ITEMS
      : (itemsByTemplateId.get(templateId) ?? []);
    if (items.length === 0) return;

    const itemByKey = new Map(items.map((item) => [item.key, item]));
    const seenKeys = new Set<string>();
    const resolved: TemplateChecklistItem[] = [];
    for (const key of checkedKeys) {
      if (seenKeys.has(key)) continue;
      const item = itemByKey.get(key);
      if (!item) continue;
      seenKeys.add(key);
      resolved.push(item);
    }
    if (resolved.length === 0) return;

    resolved.sort((a, b) => a.order - b.order);
    tale.checklist = resolved.map((item) => ({ key: item.key, text: item.text }));
  });
}

function parseTemplateChecklistItems(data: unknown): TemplateChecklistItem[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as Record<string, unknown>)['checklistItems'];
  if (!Array.isArray(raw)) return [];
  const items: TemplateChecklistItem[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const key = typeof e['key'] === 'string' ? e['key'] : '';
    const text = typeof e['text'] === 'string' ? e['text'] : '';
    if (key.length === 0 || text.length === 0) return;
    const order = typeof e['order'] === 'number' ? e['order'] : index;
    items.push({ key, text, order });
  });
  return items;
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
