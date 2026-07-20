import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

export type BankScope = 'PER_PET' | 'PER_VISIT';
export interface ChecklistBankItem {
  id: string;
  text: string;
  scope: BankScope;
}

/**
 * Run-4 #7b: five starter care-checklist items that always seed the bank so the
 * KinTale checklist editor's "Add from bank" picker is never empty, even before an
 * admin saves their own. Union'd with the persisted `checklist_bank` collection (the
 * "Save to bank" action writes there), deduped by normalized text. Mirrors the
 * hybrid source in listCategories, so no separate seed step is required.
 */
export const DEFAULT_CHECKLIST_BANK: ChecklistBankItem[] = [
  { id: 'fresh-water-provided', text: 'Fresh water provided', scope: 'PER_PET' },
  { id: 'fed-per-schedule', text: 'Fed per feeding schedule', scope: 'PER_PET' },
  { id: 'walk-potty-break', text: 'Walk / potty break', scope: 'PER_PET' },
  { id: 'medication-administered', text: 'Medication administered', scope: 'PER_PET' },
  { id: 'home-secured-on-departure', text: 'Home secured on departure', scope: 'PER_VISIT' },
];

const norm = (s: string): string => s.trim().toLowerCase();

/** Stable, collision-resistant doc id from an item's text. */
export function slugForBankItem(text: string): string {
  return (
    norm(text)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

/**
 * Pure: union the code defaults with the persisted bank, dedup by normalized text
 * (a persisted item overrides the default's casing/scope), sort case-insensitively
 * by text. Blank persisted items are ignored (no fabricated entries).
 */
export function mergeChecklistBank(persisted: ChecklistBankItem[]): ChecklistBankItem[] {
  const byKey = new Map<string, ChecklistBankItem>();
  for (const d of DEFAULT_CHECKLIST_BANK) byKey.set(norm(d.text), d);
  for (const p of persisted) {
    if (!p.text || !p.text.trim()) continue;
    byKey.set(norm(p.text), p);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }),
  );
}

export async function listChecklistBankHandler(
  req: CallableRequest<unknown>,
): Promise<{ items: ChecklistBankItem[]; schemaVersion: number }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection('checklist_bank').get();
  const persisted: ChecklistBankItem[] = snap.docs.map((d) => {
    const data = d.data() as { text?: unknown; scope?: unknown };
    return {
      id: d.id,
      text: typeof data.text === 'string' ? data.text : '',
      scope: data.scope === 'PER_VISIT' ? 'PER_VISIT' : 'PER_PET',
    };
  });
  const items = mergeChecklistBank(persisted);

  logEvent({
    severity: 'info',
    function: 'listChecklistBank',
    event: 'admin.checklistBank.listed',
    uid: req.auth.uid,
    extra: { count: items.length, persisted: persisted.length },
  });
  return { items, schemaVersion: 1 };
}

const SaveArgs = z.object({
  text: z.string().trim().min(1).max(200),
  scope: z.enum(['PER_PET', 'PER_VISIT']).default('PER_PET'),
});

export async function saveChecklistBankItemHandler(
  req: CallableRequest<unknown>,
): Promise<{ id: string; text: string; scope: BankScope }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = SaveArgs.parse(req.data);

  const text = args.text.trim();
  const id = slugForBankItem(text);
  const ref = db().doc(`checklist_bank/${id}`);
  const snap = await ref.get();
  const isCreate = !snap.exists;

  await ref.set(
    {
      text,
      scope: args.scope,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
      ...(isCreate ? { createdAt: FieldValue.serverTimestamp(), createdBy: uid } : {}),
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'saveChecklistBankItem',
    event: 'admin.checklistBank.saved',
    uid,
    extra: { id, scope: args.scope, isCreate },
  });
  return { id, text, scope: args.scope };
}

export const listChecklistBank = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listChecklistBank', listChecklistBankHandler),
);

export const saveChecklistBankItem = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveChecklistBankItem', saveChecklistBankItemHandler),
);
