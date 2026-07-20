import { z } from 'zod';

/**
 * Stage 2 step 6 (Communicate broadcast) - audience segment criteria.
 *
 * A segment is a saved, reusable filter over the `kinfolk` collection (the CRM
 * household records, NOT the auth `clients` collection). Criteria are kept
 * deliberately small and concrete - everything here maps to a real Kinfolk
 * field, so the resolver never invents data:
 *
 *   - all     -> every active kinfolk (archived excluded)
 *   - status  -> kinfolk whose `status` is in the chosen list
 *   - tags    -> kinfolk carrying the chosen tags ('any' = at least one,
 *                'all' = every chosen tag)
 *
 * Matching runs IN MEMORY over the fetched kinfolk set (a CRM-sized collection),
 * which keeps the query index-free and lets `tags` support both match modes
 * without a composite index. The Zod schema is the single source of truth for
 * the wire shape and is reused by both saveAudienceSegment and broadcastMessage.
 */

export const ARCHIVED_STATUS = 'archived';

export const CriteriaSchema = z
  .object({
    kind: z.enum(['all', 'status', 'tags']),
    // status kind
    statuses: z.array(z.string().min(1).max(40)).max(20).optional(),
    // tags kind
    tags: z.array(z.string().min(1).max(60)).max(50).optional(),
    tagMatch: z.enum(['any', 'all']).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'status') {
      const list = (val.statuses ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
      if (list.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['statuses'], message: 'status segment needs at least one status' });
      }
    }
    if (val.kind === 'tags') {
      const list = (val.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
      if (list.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: 'tag segment needs at least one tag' });
      }
    }
  });

export type Criteria = z.infer<typeof CriteriaSchema>;

/** Minimal kinfolk shape the resolver reads. Mirrors the Kinfolk Firestore doc. */
export interface KinfolkLike {
  id: string;
  status?: string;
  tags?: string[];
  email?: string;
  phoneNumber?: string;
  /** Auth uid of the linked MyTribe install; '' when not onboarded. */
  uid?: string;
}

/**
 * Pure predicate: does this kinfolk match the criteria? Archived kinfolk are
 * never matched (a broadcast must never reach an archived household), regardless
 * of kind. Case-insensitive on status; tags compared verbatim (tags are
 * admin-authored, exact). Pure + unit-tested.
 */
export function matchesCriteria(k: KinfolkLike, criteria: Criteria): boolean {
  const status = (k.status ?? '').trim().toLowerCase();
  if (status === ARCHIVED_STATUS) return false;

  switch (criteria.kind) {
    case 'all':
      return true;
    case 'status': {
      const wanted = (criteria.statuses ?? []).map((s) => s.trim().toLowerCase());
      return wanted.includes(status);
    }
    case 'tags': {
      const wanted = (criteria.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
      const have = new Set((k.tags ?? []).map((t) => t.trim()));
      if (wanted.length === 0) return false;
      return (criteria.tagMatch ?? 'any') === 'all'
        ? wanted.every((t) => have.has(t))
        : wanted.some((t) => have.has(t));
    }
    default: {
      const exhaustive: never = criteria.kind;
      throw new Error(`matchesCriteria: unknown kind '${String(exhaustive)}'`);
    }
  }
}

/** Filters a kinfolk list down to the recipients a segment resolves to. Pure. */
export function resolveRecipientsFromKinfolk(all: KinfolkLike[], criteria: Criteria): KinfolkLike[] {
  return all.filter((k) => matchesCriteria(k, criteria));
}

/**
 * Human-readable one-liner for a segment criteria (audit + UI echo). Pure.
 */
export function describeCriteria(criteria: Criteria): string {
  switch (criteria.kind) {
    case 'all':
      return 'All active kinfolk';
    case 'status':
      return `Status: ${(criteria.statuses ?? []).join(', ')}`;
    case 'tags':
      return `Tags (${criteria.tagMatch ?? 'any'}): ${(criteria.tags ?? []).join(', ')}`;
    default:
      return 'Unknown segment';
  }
}
