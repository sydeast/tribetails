import { humanizeKey } from './notificationsFeed';

/**
 * Template Routing in the operator's words (#1592). Display only: the catalog
 * key and the template id are still what the screen stores, sends and matches
 * on; the operator reads the notification's name and the template's title.
 * Android (`ui/admin/TemplateRoutingWords.kt`) and the desktop console
 * (`screens/admin/TemplateRoutingWords.kt`) say the same words.
 */

/** What a row needs to be named: the catalog's own label, unless it is a legacy stray. */
export interface NameableCatalogRow {
  key: string;
  label: string;
  source: string;
}

/**
 * A notification's name: the catalog label, else the key as words, never the
 * key itself. A legacy key's label is the server's sentence "Not in the
 * catalog, nothing dispatches it", which is not a name, so it reads as words.
 */
export function catalogKeyName(row: NameableCatalogRow): string {
  const key = row.key.trim();
  const label = row.label.trim();
  if (row.source !== 'legacy' && label !== '' && label !== key) return label;
  return humanizeKey(key) || 'Notification';
}

/** The name for a key the screen holds on its own (a notice, the editor), looked up in the rows. */
export function catalogKeyNameFor(key: string, rows: readonly NameableCatalogRow[]): string {
  const row = rows.find((r) => r.key === key);
  return row ? catalogKeyName(row) : humanizeKey(key) || 'Notification';
}

/**
 * What a Template Bank doc is called: its title, else what the doc holds (the
 * visual headline, then the subject), never its id. `listTemplates` answers a
 * doc with no title with its id (`title: data.title ?? d.id`), so a title equal
 * to the id is no title at all.
 */
export function bankTemplateName(t: {
  templateId: string;
  title?: string | null;
  headline?: string | null;
  subject?: string | null;
}): string {
  const id = t.templateId.trim();
  for (const candidate of [t.title, t.headline, t.subject]) {
    const text = (candidate ?? '').trim();
    if (text !== '' && text !== id) return text;
  }
  return 'Untitled template';
}

/**
 * The template a row sends, named. `knownToExist` is the server's word that a
 * name-matched default is in the bank (`hasDefaultTemplate`): it reads "its own
 * template" when the loaded bank cannot name it. Otherwise an id the bank does
 * not hold is "a template not in the bank", and before the bank loads (or when
 * it failed) the row says "its template". Never the id.
 */
export function routedTemplateName(
  templateId: string,
  namesById: ReadonlyMap<string, string>,
  bankLoaded: boolean,
  knownToExist = false,
): string {
  const named = namesById.get(templateId);
  if (named !== undefined) return named;
  if (knownToExist) return 'its own template';
  return bankLoaded ? 'a template not in the bank' : 'its template';
}
