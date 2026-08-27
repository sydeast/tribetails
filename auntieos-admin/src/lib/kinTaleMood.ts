import type { KinTaleTemplate } from './kinTale/model';

/**
 * PER-PET MOOD, decode + resolve. The read half of `KinCareReport`'s
 * `petMoodSelections`, which until now no web surface rendered at all.
 *
 * THE SHAPE, read off the writers rather than guessed. Android's
 * `Models.kt:874` declares `var petMoodSelections: Map<String, String>` with
 * the comment "Pet mood per kin (kinId -> moodOption.key from the active
 * template)", and `KinTaleReportViewModel.setMoodForKin` is what writes it. So
 * the stored value is a KEY, never a label: `{ "kin1": "happy" }`. The label
 * and the emoji live on the TEMPLATE's `moodOptions`, and have to be joined
 * back on at read time.
 *
 * DECODE IS DEFENSIVE for the same reason `kinTaleChecklist.ts#decodeFieldResponses`
 * is: `KinTaleEntry` is a CAST over raw Firestore data, not a validation of it.
 * A hand-edited doc, or an older writer, can put a number or a nested object
 * where a mood key belongs, and `.trim()` on that throws through React's error
 * boundary and blanks the whole detail screen. Non-string and empty values are
 * dropped rather than coerced. Same rule the portal's own read already applies
 * (`MyTribe/functions/src/portal/getMyKinTales.ts:205-213`: "only surface a
 * string->string map").
 *
 * AN UNRESOLVED MOOD KEY RENDERS AS THE RAW KEY, not dropped and not blanked.
 * This is deliberate and it is NOT the convention checklist labels follow.
 * A checklist key with no item behind it has nothing truthful to show, so
 * `getMyKinTales.ts` drops the row. A mood key is different: the key itself IS
 * a legible word the auntie chose (`happy`, `relaxed`), so showing it is honest
 * rather than fabricated. The desktop console's read view already made this
 * exact call and documents it in place ("When a selected mood key has no
 * matching option, the raw key shows (visible, not fabricated) rather than
 * being dropped", `web/composeApp/.../KinTaleReportScreen.kt:335`), and prod
 * has a live instance of it: `test-kinfolk-001-report-1` stores `relaxed`,
 * which is not one of the eight options the default template ships.
 */
export interface PetMoodRow {
  /** The kin this mood was recorded against. Resolve the name at the call site. */
  kinId: string;
  /** The stored `moodOption.key`, kept so the caller can key a list on it. */
  moodKey: string;
  /** `"😊 Happy"` for a resolved option, the bare key otherwise. Never blank. */
  label: string;
  /** False when no template option matched, i.e. `label` is the raw key. */
  resolved: boolean;
}

/**
 * Narrows raw `petMoodSelections` to the string->string map it is supposed to
 * be. Anything else in the map is dropped, not coerced.
 */
export function decodePetMoodSelections(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [kinId, mood] of Object.entries(raw as Record<string, unknown>)) {
    if (kinId.trim() === '') continue;
    if (typeof mood !== 'string') continue;
    if (mood.trim() === '') continue;
    out[kinId] = mood;
  }
  return out;
}

/**
 * The rows a "Pet mood" panel should draw for one report, or `[]` for no panel.
 *
 * Returns `[]` when the template has `petMoodEnabled` off. A template is the
 * authority on which sections a recap even has, and every composer already
 * gates the mood section on this flag (Android `KinTaleReportScreen.kt:295`,
 * desktop `KinTaleComposeScreen.kt`), so a recap captured under a template with
 * moods turned off must not grow a mood section on the read side. Stale
 * selections left behind by an earlier template are not evidence the section
 * belongs; they are exactly what the flag says to stop showing.
 *
 * Order is the map's own insertion order, matching what both Kotlin read views
 * do with the same map. The mood OPTIONS carry an `order`, but a selection map
 * keyed by kin does not: sorting by mood order would shuffle the pets.
 */
export function petMoodRows(raw: unknown, template: KinTaleTemplate): PetMoodRow[] {
  if (!template.petMoodEnabled) return [];
  const byKey = new Map(template.moodOptions.map((o) => [o.key, o]));
  const rows: PetMoodRow[] = [];
  for (const [kinId, moodKey] of Object.entries(decodePetMoodSelections(raw))) {
    const option = byKey.get(moodKey);
    // `${emoji} ${label}`.trim() collapses to just the label when a template
    // author left the emoji blank, and to just the emoji when they left the
    // label blank. Never a lone space, and never a fabricated stand-in.
    const joined = option ? `${option.emoji} ${option.label}`.trim() : '';
    rows.push({
      kinId,
      moodKey,
      label: joined !== '' ? joined : moodKey,
      resolved: option !== undefined && joined !== '',
    });
  }
  return rows;
}
