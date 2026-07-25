import type { BroadcastChannel, BroadcastCriteria } from '../api/communicateWrite';

/**
 * The broadcast form's rules: when a segment can be saved, when a broadcast can
 * be sent, and which audience field goes on the wire.
 *
 * Every rule here mirrors `broadcastMessage`'s zod `Args` and
 * `saveAudienceSegment`'s `SaveArgs`. Nothing is stricter than the server, on
 * purpose: a client rule the server does not enforce blocks a send the server
 * would happily have accepted, and the operator has no way to find out why.
 */

/** Why this segment cannot be saved yet, or null. First blocking reason wins. */
export function segmentSaveBlocker(name: string, criteria: BroadcastCriteria): string | null {
  if (name.trim() === '') return 'Name this segment first.';
  if (criteria.kind === 'status' && criteria.statuses.filter((s) => s.trim() !== '').length === 0) {
    return 'Choose at least one status.';
  }
  if (criteria.kind === 'tags' && criteria.tags.filter((t) => t.trim() !== '').length === 0) {
    return 'Choose at least one tag.';
  }
  return null;
}

/**
 * Channels whose delivery has a title slot the server insists on filling.
 * Email uses the subject as the subject line; in-app uses it as the
 * notification title. Text has no subject line at all, and push falls back to
 * "Tribe Tails" server-side, so neither is gated here for the same reason the
 * server does not gate them.
 */
const SUBJECT_CHANNELS: readonly BroadcastChannel[] = ['email', 'inapp'];

/** Why this broadcast cannot be sent yet, or null. Audience validity is checked separately. */
export function broadcastBlocker(channels: BroadcastChannel[], subject: string, body: string): string | null {
  if (channels.length === 0) return 'Pick at least one channel.';
  if (channels.some((c) => SUBJECT_CHANNELS.includes(c)) && subject.trim() === '') {
    return 'Add a subject. It is the title for email and in-app.';
  }
  if (body.trim() === '') return 'Write a message first.';
  return null;
}

/**
 * The audience half of the `broadcastMessage` payload: a saved `segmentId` OR
 * inline `criteria`, never both.
 *
 * They are mutually exclusive because the server resolves `segmentId` by
 * loading the stored criteria; sending both would mean shipping two answers to
 * one question and letting the handler's precedence decide which audience gets
 * the message.
 *
 * `null` means the form does not yet describe a valid audience, e.g. "By
 * status" chosen with no statuses typed. It is never a `{ kind: 'all' }`
 * fallback, which would silently broadcast to every household on the roster.
 */
export function broadcastAudienceArgs(
  selectedSegmentId: string | null,
  adhocCriteria: BroadcastCriteria | null,
): { segmentId: string } | { criteria: BroadcastCriteria } | null {
  if (selectedSegmentId !== null && selectedSegmentId !== '') return { segmentId: selectedSegmentId };
  if (adhocCriteria !== null) return { criteria: adhocCriteria };
  return null;
}
