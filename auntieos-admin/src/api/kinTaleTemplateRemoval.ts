import { doc } from 'firebase/firestore';
import { call } from '../lib/fns';
import { db } from '../lib/firebase';
import { deleteDoc } from '../lib/firestoreWrite';
/**
 * #1591: the one place a KinTale template is taken out of service.
 *
 * WHAT IS DECIDED AND WHAT IS NOT. The operator has not ruled on what "remove"
 * means: hard delete behind a usage warning, archive, or both. Everything every
 * option needs lives here and is built: the server's usage count
 * (`getKinTaleTemplateUsage`), the sentence that names what breaks
 * (`removalImpact`), and ONE entry point (`removeKinTaleTemplate`) that the
 * screens call. No screen shows a Delete control yet, because which button it
 * is, and what it does, is the ruling.
 *
 * When the ruling lands, only this file's `RemovalMode` and the body of
 * `removeKinTaleTemplate` change; the Android (`AuntieRepository`) and desktop
 * (`FirestoreClient`) twins get the same one-function edit.
 */
export interface KinTaleTemplateUsage {
  templateId: string;
  /** False when the template is already gone (a stale id). */
  exists: boolean;
  name: string;
  isDefault: boolean;
  isActive: boolean;
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
 * What will stop working, in the operator's words, one line each. Empty when
 * nothing depends on the template. These are the consequences of the doc being
 * gone, which is what `'delete'` does; the household feed
 * (`getMyKinTales.resolveChecklists`) drops a checklist whose template is missing.
 * An archive mode would keep the doc, and would need its own, shorter lines.
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
  if (usage.isDefault) {
    lines.push(
      usage.otherActiveTemplateCount > 0
        ? 'It is the default template. Visits with no matching service type lose their default until another template is made the default.'
        : 'It is the default template and the only active one. Visits fall back to the built-in Standard Visit.',
    );
  }
  return lines;
}
/**
 * Only `'delete'` exists. `'archive'` joins the union when the operator rules it
 * in; callers pass the mode, so no screen has to change.
 */
export type RemovalMode = 'delete';
/** The entry point every KinTale template screen calls to take a template out of service. */
export async function removeKinTaleTemplate(templateId: string, mode: RemovalMode = 'delete'): Promise<void> {
  const id = templateId.trim();
  if (id === '') throw new Error('removeKinTaleTemplate: a template id is required');
  switch (mode) {
    case 'delete':
      await deleteDoc(doc(db, 'kintale_templates', id));
      return;
  }
}
