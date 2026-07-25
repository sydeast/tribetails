import { call } from '../lib/fns';
import type { BroadcastCriteria } from './communicateWrite';

/**
 * Saved audience segments: a named, reusable kinfolk filter the operator builds
 * once and picks from every broadcast after.
 *
 * All three callables are deployed and admin-gated
 * (MyTribe `functions/src/admin/audienceSegments.ts`). Reads go through
 * `listAudienceSegments` rather than a Firestore listener on purpose: the
 * `audience_segments` collection has no client read rule, so a test admin can
 * never enumerate the operator's segments.
 *
 * The criteria shape is `communicateWrite.ts`'s `BroadcastCriteria`, which is
 * the same zod `CriteriaSchema` `broadcastMessage` validates. One shape,
 * defined once: a segment saved here has to be a segment that can be sent to.
 */

export interface AudienceSegment {
  id: string;
  name: string;
  criteria: BroadcastCriteria;
  /** The server's own `describeCriteria` one-liner. Rendered as the chip's second line. */
  description: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface ListResponse {
  ok: true;
  segments?: {
    id?: string;
    name?: string;
    criteria?: BroadcastCriteria;
    description?: string;
    createdAtMs?: number;
    updatedAtMs?: number;
  }[];
}

/**
 * Every saved segment, newest-updated first.
 *
 * Read defensively field by field rather than cast wholesale: this is a
 * callable response, so the shape is a promise rather than a proof, and a row
 * missing `updatedAtMs` would otherwise make the sort comparator return NaN and
 * scramble the whole list. A row with no `id` is dropped, since it could never
 * be picked or deleted.
 */
export async function listAudienceSegments(): Promise<AudienceSegment[]> {
  const res = await call<Record<string, never>, ListResponse>('listAudienceSegments', {});
  const rows = Array.isArray(res.segments) ? res.segments : [];
  return rows
    .filter((r): r is typeof r & { id: string } => typeof r.id === 'string' && r.id !== '')
    .map((r) => ({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : '',
      criteria: r.criteria ?? { kind: 'all' },
      description: typeof r.description === 'string' ? r.description : '',
      createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : 0,
      updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
    }))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export interface SaveAudienceSegmentArgs {
  /** Present to update in place, absent to create. A blank one is omitted rather than sent. */
  id?: string;
  name: string;
  criteria: BroadcastCriteria;
}

/** Creates or updates a segment. Returns the id, which is the new one on a create. */
export async function saveAudienceSegment(args: SaveAudienceSegmentArgs): Promise<string> {
  const id = (args.id ?? '').trim();
  const res = await call<{ id?: string; name: string; criteria: BroadcastCriteria }, { ok: true; id: string }>(
    'saveAudienceSegment',
    {
      // The server's zod requires `min(1)` on id when present, so a blank one
      // has to be absent rather than empty.
      ...(id !== '' ? { id } : {}),
      name: args.name.trim(),
      criteria: args.criteria,
    },
  );
  return res.id;
}

/** Deletes a segment. A missing one throws `not-found` rather than reporting a delete that did not happen. */
export async function deleteAudienceSegment(id: string): Promise<void> {
  await call<{ id: string }, { ok: true; id: string }>('deleteAudienceSegment', { id });
}
