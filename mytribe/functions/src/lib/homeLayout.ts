/**
 * #1987: when a stored Kinfolk portal Home layout IS the default.
 *
 * `mytribePortal.home.sections` is the operator's Home layout: the order of the
 * sections, which are shown, and how many rows each lists. An empty list has
 * always meant "the default". The editors, though, write every row as soon as
 * one value is touched, so a layout with every section on, in the standard
 * order, with no limits was stored as four explicit rows and then read
 * everywhere as "custom": the admin chip said Custom and the portal dropped its
 * two columns. Putting the values back could not undo it.
 *
 * A layout equal to the default is the default. This is the one test for that,
 * used by the save (which stores such a layout as the empty list) and by
 * `getMyHome` (which answers with the empty list for a document stored before
 * the save did this).
 *
 * Deliberately exact. Only the four known sections, each once, in the standard
 * order, each on, each with no limit, count. A list with any other row (an id
 * this file does not know, a legacy `roster` row, a repeat, a blank id) is left
 * exactly as it is: collapsing it would throw away a row the operator can see
 * and may want.
 *
 * The same four ids are listed in the admin web (`HOME_SECTION_CATALOG`,
 * `auntieos-admin/src/lib/settingsFormat.ts`), admin Android
 * (`HomeLayoutConfig.kt`), the desktop console (`MyTribeSettingsPanel.kt`) and
 * both portal clients. None of them share a source tree with this one. A change
 * to one list is a change to all of them.
 */
export const DEFAULT_HOME_SECTION_IDS: readonly string[] = [
  'liveVisit',
  'upNext',
  'tales',
  'quickStart',
];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * True for the empty list and for the four default rows written out in full.
 * A row with no `enabled` is on and a row with no `limit` has none, the same
 * defaults `getMyHome` decodes with.
 */
export function isDefaultHomeLayout(sections: unknown): boolean {
  if (!Array.isArray(sections)) return false;
  if (sections.length === 0) return true;
  if (sections.length !== DEFAULT_HOME_SECTION_IDS.length) return false;
  return sections.every((row, i) => {
    if (!isPlainObject(row)) return false;
    if (row['id'] !== DEFAULT_HOME_SECTION_IDS[i]) return false;
    const enabled = 'enabled' in row ? row['enabled'] : true;
    const limit = 'limit' in row ? row['limit'] : 0;
    return enabled === true && limit === 0;
  });
}

/**
 * The settings patch as it should be stored: the same patch, with a Home layout
 * equal to the default replaced by the empty list. Nothing else is touched, and
 * the patch passed in is not changed.
 */
export function withDefaultHomeLayoutCollapsed(
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const portal = changes['mytribePortal'];
  if (!isPlainObject(portal)) return changes;
  const home = portal['home'];
  if (!isPlainObject(home)) return changes;
  const sections = home['sections'];
  if (!Array.isArray(sections) || sections.length === 0 || !isDefaultHomeLayout(sections)) {
    return changes;
  }
  return { ...changes, mytribePortal: { ...portal, home: { ...home, sections: [] } } };
}
