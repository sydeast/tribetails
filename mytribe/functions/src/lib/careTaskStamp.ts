import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

/**
 * #2058: the care tasks a sent KinTale keeps as its own.
 *
 * OPERATOR RULING 2026-11-12, "STAMP AT SEND", reversing the 2026-08-23 ruling
 * on issue #397. A sent KinTale keeps its own copy of the care tasks: the
 * labels, which were done and for which Kin, and any note typed against one.
 * Editing a template or deleting it for good never changes a sent tale. Before
 * this, every reader (the household feed, both admin apps, the desktop console)
 * looked the labels up in `kintale_templates/{templateId}` at read time, so
 * deleting a template took "Care tasks done this visit" off every tale written
 * from it.
 *
 * THE FIELD is `careTasks` on the `kin_care_reports` doc, written by the server
 * only:
 *  - the send callable (`admin/kinTaleDrafts.ts#sendKinTaleReportHandler`), in
 *    the same transaction that marks the tale SENT;
 *  - `publishGeneratedDraft`, in the same `tx.set` that creates the sent tale;
 *  - `onKinTaleUpdate` / `onKinTaleCreate` ({@link syncCareTaskStamp}), as the
 *    backstop for an installed app that still flips SENT directly, and to keep
 *    the copy in step when a tick changes on a sent tale;
 *  - the backfill (`mytribe/scripts/backfillKinTaleCareTasks.ts`).
 *
 * PRESENCE MEANS STAMPED, the way a stored `thumbs: []` means "resolved,
 * nothing to show". A stamp with no done items is still a stamp: that tale had
 * nothing ticked when it was sent, and a reader must not go back to the
 * template to look for more.
 *
 * `items` is EVERY checklist item the template offered, with its scope, order
 * and conditions, not only the ticked ones. That is what lets a tick changed
 * after the send be labelled from the tale itself once the template is gone,
 * and what lets the admin apps rebuild the checklist a sent tale was written
 * against without reading the template at all.
 *
 * Pure apart from {@link syncCareTaskStamp}, and loaded with `await import()`
 * by every server caller so it adds nothing to a cold start.
 */

export const CARE_TASKS_FIELD = 'careTasks';
export const CARE_TASK_STAMP_VERSION = 1;

export interface StampCondition {
  source: string;
  op: string;
  value: string;
  attributeKey: string;
}

/** One checklist item as the template offered it when the tale was stamped. */
export interface StampItem {
  key: string;
  text: string;
  /** "PER_PET" or "PER_VISIT", as stored on the template. */
  scope: string;
  order: number;
  showWhenUnchecked: boolean;
  required: boolean;
  conditions: StampCondition[];
}

/** One care task done this visit, as the household is shown it. */
export interface StampDone {
  key: string;
  /** The Kin it was done for, or `''` for a once-per-visit task. */
  kinId: string;
  text: string;
  /** What the Auntie typed against it, trimmed. `''` when nothing. */
  note: string;
}

/**
 * Where `items` came from:
 *  - `template`: the tale's own `kintale_templates` doc;
 *  - `builtIn`: a blank `templateId`, the built-in Standard Visit;
 *  - `templateMissing`: the tale names a template that no longer exists, so
 *    nothing could be labelled (a send racing a delete; never the backfill,
 *    which reports these instead of stamping them).
 */
export type StampSource = 'template' | 'builtIn' | 'templateMissing';

export type StampedBy = 'send' | 'edit' | 'backstop' | 'backfill';

export interface CareTaskStamp {
  v: number;
  stampedAt: string;
  stampedBy: StampedBy;
  templateId: string;
  templateName: string;
  source: StampSource;
  checklistEnabled: boolean;
  items: StampItem[];
  done: StampDone[];
}

const BUILT_IN_NAME = 'Standard Visit';

function item(
  key: string,
  text: string,
  scope: 'PER_PET' | 'PER_VISIT',
  order: number,
  showWhenUnchecked = false,
  conditions: StampCondition[] = [],
): StampItem {
  return { key, text, scope, order, showWhenUnchecked, required: false, conditions };
}

function cond(source: string, op: string, value: string, attributeKey = ''): StampCondition {
  return { source, op, value, attributeKey };
}

/**
 * The built-in Standard Visit checklist, conditions included, mirroring
 * Android's `DefaultKinTaleTemplate` (`KinTaleTemplateEngine.kt`) and the admin
 * web port of it (`auntieos-admin/src/lib/kinTale/model.ts`
 * `DEFAULT_KINTALE_TEMPLATE`) key for key. These are the keys a blank
 * `templateId` is written with on Android and admin web.
 */
export const BUILT_IN_ITEMS: readonly StampItem[] = [
  item('peed', 'Peed', 'PER_PET', 0, true),
  item('pooed', 'Pooed', 'PER_PET', 1, true),
  item('fed', 'Fed', 'PER_PET', 2),
  item('fresh_water', 'Fresh water provided', 'PER_PET', 3),
  item('meds_given', 'Medications given', 'PER_PET', 4, false, [
    cond('KIN_ATTRIBUTE', 'EXISTS', '', 'medicationHealthNotes'),
  ]),
  item('played', 'Played', 'PER_PET', 5),
  item('litter_scooped', 'Litter box scooped', 'PER_PET', 6, false, [cond('KIN_SPECIES', 'EQUALS', 'Cat')]),
  item('walk_water_refill', 'Water refilled after walk', 'PER_PET', 7, false, [
    cond('SERVICE_TYPE', 'CONTAINS', 'walk'),
  ]),
  item('trash_taken_out', 'Trash taken out', 'PER_VISIT', 8),
  item('lights_off', 'Lights turned off', 'PER_VISIT', 9),
];

/**
 * The desktop console's built-in uses different keys for some items
 * (`KinTaleModels.kt` `DefaultKinTaleTemplate`). A tale the desktop wrote
 * against the built-in ticks these, and before #2058 the household feed dropped
 * them because the server only knew the Android keys. They are added to a
 * built-in stamp only when the tale answered them, so an Android or web tale's
 * copy carries exactly the Standard Visit list it was written against.
 */
export const DESKTOP_BUILT_IN_ONLY_ITEMS: readonly StampItem[] = [
  item('water', 'Fresh water provided', 'PER_PET', 3),
  item('meds', 'Medications given', 'PER_PET', 4),
  item('play', 'Playtime provided', 'PER_PET', 5),
  item('secure', 'House / yard secure', 'PER_VISIT', 10),
  item('locked', 'All doors locked', 'PER_VISIT', 11),
  item('alarm', 'Alarm system set', 'PER_VISIT', 12),
  item('mail', 'Mail / packages collected', 'PER_VISIT', 13),
  item('plants', 'Plants watered', 'PER_VISIT', 14),
  item('trash', 'Trash taken out', 'PER_VISIT', 15),
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseCondition(raw: unknown): StampCondition | null {
  const o = asRecord(raw);
  if (!o) return null;
  return {
    source: str(o['source']),
    op: str(o['op']),
    value: str(o['value']),
    attributeKey: str(o['attributeKey']),
  };
}

function parseItem(raw: unknown, index: number): StampItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  const key = str(o['key']).trim();
  const text = str(o['text']);
  if (key === '' || text.trim() === '') return null;
  const scope = str(o['scope']).trim();
  return {
    key,
    text,
    // The Kotlin data-class default, so a partial doc reads the way the apps read it.
    scope: scope === '' ? 'PER_PET' : scope,
    order: typeof o['order'] === 'number' && Number.isFinite(o['order']) ? (o['order'] as number) : index,
    showWhenUnchecked: o['showWhenUnchecked'] === true,
    required: o['required'] === true,
    conditions: Array.isArray(o['conditions'])
      ? (o['conditions'] as unknown[]).map(parseCondition).filter((c): c is StampCondition => c !== null)
      : [],
  };
}

/** A template doc's `checklistItems`, unlabelled or keyless rows dropped. */
export function parseTemplateItems(template: unknown): StampItem[] {
  const o = asRecord(template);
  if (!o || !Array.isArray(o['checklistItems'])) return [];
  return (o['checklistItems'] as unknown[])
    .map((raw, i) => parseItem(raw, i))
    .filter((i): i is StampItem => i !== null);
}

interface Answer {
  fieldKey: string;
  kinId: string;
  done: boolean;
  note: string;
}

/**
 * The tale's `fieldResponses` map, read off each value's own `fieldKey` and
 * `kinId` (never the map key), the way every reader has always read it.
 */
function answersOf(fieldResponses: unknown): Answer[] {
  const map = asRecord(fieldResponses);
  if (!map) return [];
  const out: Answer[] = [];
  for (const raw of Object.values(map)) {
    const r = asRecord(raw);
    if (!r) continue;
    const fieldKey = str(r['fieldKey']).trim();
    if (fieldKey === '') continue;
    out.push({
      fieldKey,
      kinId: str(r['kinId']).trim(),
      done: r['boolValue'] === true,
      note: str(r['stringValue']).trim(),
    });
  }
  return out;
}

/**
 * The care tasks done, labelled from `items`. CHECKED ITEMS ONLY, as the
 * household has always been shown them (issue #397 ruling 2026-08-26): an item
 * with no tick is not claimed either way. A ticked key `items` does not hold
 * cannot be labelled and is left out rather than shown with a made-up label.
 * Ordered by the item's order, then by Kin, so the copy is the same however
 * the map was written.
 */
export function doneFrom(items: readonly StampItem[], fieldResponses: unknown): StampDone[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const seen = new Set<string>();
  const done: Array<StampDone & { order: number }> = [];
  for (const a of answersOf(fieldResponses)) {
    if (!a.done) continue;
    const it = byKey.get(a.fieldKey);
    if (!it) continue;
    const id = `${a.kinId}|${a.fieldKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    done.push({ key: it.key, kinId: a.kinId, text: it.text, note: a.note, order: it.order });
  }
  done.sort((x, y) => x.order - y.order || (x.kinId < y.kinId ? -1 : x.kinId > y.kinId ? 1 : 0));
  return done.map(({ order: _order, ...d }) => d);
}

export interface BuildStampInput {
  /** The tale's own `templateId`; `''` means the built-in. */
  templateId: string;
  /** The template doc's data, or null when it does not exist. Ignored for the built-in. */
  template: Record<string, unknown> | null;
  fieldResponses: unknown;
  now: string;
  by: StampedBy;
}

/** The copy of the care tasks a tale keeps from now on. */
export function buildCareTaskStamp(input: BuildStampInput): CareTaskStamp {
  const templateId = input.templateId.trim();
  let source: StampSource;
  let items: StampItem[];
  let templateName: string;
  let checklistEnabled: boolean;
  if (templateId === '') {
    source = 'builtIn';
    const answered = new Set(answersOf(input.fieldResponses).map((a) => a.fieldKey));
    items = [...BUILT_IN_ITEMS, ...DESKTOP_BUILT_IN_ONLY_ITEMS.filter((i) => answered.has(i.key))].map((i) => ({
      ...i,
      conditions: i.conditions.map((c) => ({ ...c })),
    }));
    templateName = BUILT_IN_NAME;
    checklistEnabled = true;
  } else if (input.template) {
    source = 'template';
    items = parseTemplateItems(input.template);
    templateName = str(input.template['name']);
    checklistEnabled = input.template['checklistEnabled'] !== false;
  } else {
    source = 'templateMissing';
    items = [];
    templateName = '';
    checklistEnabled = true;
  }
  return {
    v: CARE_TASK_STAMP_VERSION,
    stampedAt: input.now,
    stampedBy: input.by,
    templateId,
    templateName,
    source,
    checklistEnabled,
    items,
    done: doneFrom(items, input.fieldResponses),
  };
}

function parseDone(raw: unknown): StampDone | null {
  const o = asRecord(raw);
  if (!o) return null;
  const key = str(o['key']).trim();
  const text = str(o['text']);
  if (key === '' || text.trim() === '') return null;
  return { key, kinId: str(o['kinId']), text, note: str(o['note']) };
}

/**
 * The stamp stored on a tale, or null when it has none. A value that is not a
 * stamp this code understands (no `v`, a newer version) reads as null, so the
 * reader falls back to what it did before rather than trusting a shape it does
 * not know.
 */
export function readCareTaskStamp(raw: unknown): CareTaskStamp | null {
  const o = asRecord(raw);
  if (!o || o['v'] !== CARE_TASK_STAMP_VERSION) return null;
  if (!Array.isArray(o['items']) || !Array.isArray(o['done'])) return null;
  const sourceRaw = str(o['source']);
  const source: StampSource =
    sourceRaw === 'builtIn' || sourceRaw === 'templateMissing' ? sourceRaw : 'template';
  const byRaw = str(o['stampedBy']);
  const stampedBy: StampedBy =
    byRaw === 'edit' || byRaw === 'backstop' || byRaw === 'backfill' ? byRaw : 'send';
  return {
    v: CARE_TASK_STAMP_VERSION,
    stampedAt: str(o['stampedAt']),
    stampedBy,
    templateId: str(o['templateId']),
    templateName: str(o['templateName']),
    source,
    checklistEnabled: o['checklistEnabled'] !== false,
    items: (o['items'] as unknown[]).map((r, i) => parseItem(r, i)).filter((i): i is StampItem => i !== null),
    done: (o['done'] as unknown[]).map(parseDone).filter((d): d is StampDone => d !== null),
  };
}

/** The household feed's flat list: each task once, in the template's order. */
export function checklistFromStamp(stamp: CareTaskStamp): Array<{ key: string; text: string }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; text: string }> = [];
  for (const d of stamp.done) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push({ key: d.key, text: d.text });
  }
  return out;
}

/**
 * Whether a tale has reached the household. The feed lists a tale by a
 * non-blank `sentAt` (`lib/sentKinTales.ts`); the apps by `status == SENT`.
 * Either one counts, so a migrated row that carries only one of them is not
 * missed.
 */
export function isSentKinTale(data: Record<string, unknown>): boolean {
  if (str(data['status']).trim().toUpperCase() === 'SENT') return true;
  const sentAt = data['sentAt'];
  if (typeof sentAt === 'string') return sentAt.trim() !== '';
  return sentAt !== null && sentAt !== undefined;
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    const o = asRecord(x);
    return o ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x;
  });
}

/** True when the two `done` lists differ. */
export function doneDiffers(a: readonly StampDone[], b: readonly StampDone[]): boolean {
  return stableJson(a) !== stableJson(b);
}

/**
 * What a write to a stored tale means for its copy of the care tasks:
 *  - `null`: leave it alone;
 *  - a stamp: write this one.
 *
 * Only a SENT tale has a copy. One without a stamp (sent by an installed app
 * that still writes SENT itself, or sent before #2058) gets one from its
 * template, unless that template is gone, in which case nothing is written and
 * the backfill reports the tale. One with a stamp only changes when a tick or a
 * note changed, and then it is relabelled from its OWN items, never the
 * template, so editing or deleting a template never reaches it.
 */
export function plannedStamp(
  data: Record<string, unknown>,
  template: Record<string, unknown> | null,
  now: string,
): CareTaskStamp | null {
  if (!isSentKinTale(data)) return null;
  const existing = readCareTaskStamp(data[CARE_TASKS_FIELD]);
  if (existing) {
    const done = doneFrom(existing.items, data['fieldResponses']);
    if (!doneDiffers(done, existing.done)) return null;
    return { ...existing, stampedAt: now, stampedBy: 'edit', done };
  }
  const templateId = str(data['templateId']).trim();
  if (templateId !== '' && template === null) return null;
  return buildCareTaskStamp({ templateId, template, fieldResponses: data['fieldResponses'], now, by: 'backstop' });
}

/**
 * Trigger side: bring one tale's copy of its care tasks in step with the
 * stored tale, in a transaction, so two edits landing close together cannot
 * leave the older answer on top. Writes only `careTasks` (and nothing at all
 * when nothing changed), so the trigger it re-enters finds the copy already
 * current and stops.
 */
export async function syncCareTaskStamp(
  firestore: Firestore,
  ref: DocumentReference,
): Promise<'unchanged' | 'stamped'> {
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'unchanged' as const;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (!isSentKinTale(data)) return 'unchanged' as const;
    let template: Record<string, unknown> | null = null;
    const hasStamp = readCareTaskStamp(data[CARE_TASKS_FIELD]) !== null;
    const templateId = str(data['templateId']).trim();
    if (!hasStamp && templateId !== '') {
      const tplSnap = await tx.get(firestore.collection('kintale_templates').doc(templateId));
      template = tplSnap.exists ? ((tplSnap.data() ?? {}) as Record<string, unknown>) : null;
    }
    const next = plannedStamp(data, template, new Date().toISOString());
    if (next === null) return 'unchanged' as const;
    tx.update(ref, { [CARE_TASKS_FIELD]: next });
    return 'stamped' as const;
  });
}
