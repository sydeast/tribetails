import { doc } from 'firebase/firestore';
import { call } from '../lib/fns';
import { db } from '../lib/firebase';
import { deleteDoc, updateDoc } from '../lib/firestoreWrite';

/**
 * #1591: the one place a KinTale template is taken out of service, and put back.
 *
 * OPERATOR RULING, 2026-11-05 docket: "both". Remove moves a template to an
 * archive: the doc stays, so it is restorable, but it is hidden from the
 * template list and never picked for a new KinTale (`pickTemplateForService`
 * skips it). KinTales already written from it keep reading it. Deleting for
 * good happens only from inside the archive, behind a warning that says how
 * many KinTales used it. Removal stays owner-only: the `kintale_templates`
 * write rule is `isOwner()`, and its delete rule also requires `archived ==
 * true`, so no client can delete a template that was never archived.
 *
 * Android (`AuntieRepository.removeKinTaleTemplate`) and the desktop console
 * (`FirestoreClient.removeKinTaleTemplate`) take the same three modes.
 */

export interface KinTaleTemplateUsage {
  templateId: string;
  /** False when the template is already gone (a stale id). */
  exists: boolean;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  /** True when the template sits in the archive. */
  archived?: boolean;
  /** KinTales, sent or draft, written from this template. */
  kintaleCount: number;
  /** Other active templates a service type could fall back to. */
  otherActiveTemplateCount: number;
}

/** getKinTaleTemplateUsage (owner): what uses this template, for a confirm that names what breaks. */
export async function getKinTaleTemplateUsage(templateId: string): Promise<KinTaleTemplateUsage> {
  return call<{ templateId: string }, KinTaleTemplateUsage>('getKinTaleTemplateUsage', { templateId });
}

/**
 * What stops working once the doc is gone, one line each, for the delete-for-good
 * confirm. Empty when nothing depends on it. The household feed
 * (`getMyKinTales.resolveChecklists`) drops the checklist of a KinTale whose
 * template is missing. The template is already archived by then, so it is no
 * longer anyone's default for new KinTales.
 */
export function removalImpact(usage: KinTaleTemplateUsage): string[] {
  const lines: string[] = [];
  if (usage.kintaleCount > 0) {
    const n = usage.kintaleCount;
    lines.push(
      `${n} KinTale${n === 1 ? ' was' : 's were'} written from it. ` +
        `${n === 1 ? 'Its' : 'Their'} ticked checklist items stop showing to the household, ` +
        `because the household feed reads the labels from the template.`,
    );
  }
  return lines;
}

/** The line the delete-for-good confirm leads with: how many KinTales used it. */
export function deleteHeadline(usage: KinTaleTemplateUsage): string {
  const n = usage.kintaleCount;
  if (n === 0) return 'No KinTale was written from this template.';
  return `${n} KinTale${n === 1 ? ' was' : 's were'} written from this template.`;
}

/**
 * What moving a template to the archive does, for the Remove confirm. Nothing
 * breaks: the doc stays, so written KinTales keep their checklist labels.
 */
export function archiveImpact(template: { isDefault: boolean }): string[] {
  const lines = [
    'New KinTales stop using it. KinTales already written from it keep it.',
    'You can restore it from the archive, or delete it for good there.',
  ];
  if (template.isDefault) {
    lines.push('It is the default template, so visits with no matching service type use the built-in Standard Visit until it is restored or another template is made the default.');
  }
  return lines;
}

/**
 * Whether restoring [template] must drop its default flag: another live
 * template became the default while it sat in the archive, and there is only
 * ever one default.
 */
export function restoreClearsDefault(
  template: { _id: string; isDefault: boolean },
  others: ReadonlyArray<{ _id: string; isDefault: boolean; archived?: boolean | undefined }>,
): boolean {
  return template.isDefault && others.some((o) => o._id !== template._id && o.isDefault && o.archived !== true);
}

export type RemovalMode = 'archive' | 'restore' | 'delete';

export interface RemovalOptions {
  /** For `restore`: also clear `isDefault` (see `restoreClearsDefault`). */
  clearDefault?: boolean;
  /** Injected for tests. */
  now?: () => Date;
}

/** The entry point every KinTale template screen calls to archive, restore or delete a template. */
export async function removeKinTaleTemplate(
  templateId: string,
  mode: RemovalMode,
  options: RemovalOptions = {},
): Promise<void> {
  const id = templateId.trim();
  if (id === '') throw new Error('removeKinTaleTemplate: a template id is required');
  const ref = doc(db, 'kintale_templates', id);
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  switch (mode) {
    case 'archive':
      await updateDoc(ref, { archived: true, archivedAt: nowIso, updatedAt: nowIso });
      return;
    case 'restore':
      await updateDoc(ref, {
        archived: false,
        archivedAt: '',
        updatedAt: nowIso,
        ...(options.clearDefault === true ? { isDefault: false } : {}),
      });
      return;
    case 'delete':
      // The rules refuse this unless the doc is archived.
      await deleteDoc(ref);
      return;
  }
}
