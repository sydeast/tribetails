// Input validation for the draft endpoints.
//
// `writeDraft` took a caller-supplied `docId` and spread a caller-supplied
// `draft` object straight into `set(..., { merge: true })`. Two problems, both
// reachable by any admin token:
//
// 1. PATH ESCAPE. `collection('generated_drafts').doc(id)` treats `id` as a
//    PATH, not a name. An id of `a/b/c` resolves to
//    `generated_drafts/a/b/c` — a document in a subcollection nobody intended
//    to exist, invisible to every query that reads the collection. The reads
//    have the same hole via their `id` query param.
//
// 2. UNBOUNDED PAYLOAD. Any shape, any size, any key. Including keys that
//    collide with the fields the handler itself writes.
//
// What this does NOT do is restrict `draft` to an allowlist of known fields.
// The tempting version of this file enumerates what `generateAuntieCopy`
// writes (communication_type, generated_copy, kinfolk_id, …) and rejects the
// rest. That would be a guess about every caller of an endpoint whose callers
// live outside this repo, and guessing about those callers is what broke these
// endpoints in the first place. So the rules here are STRUCTURAL: shape, size,
// and the reserved namespace. A caller sending a field we have never heard of
// is not doing anything wrong.

// Firestore's own limit is 1500 bytes; ids are also rejected for path segments.
const MAX_DOC_ID_BYTES = 1500;
// A draft is text plus metadata. 100 KB leaves plenty of headroom under the
// 1 MiB document ceiling while bounding what one call can push.
const MAX_DRAFT_BYTES = 100 * 1024;
const MAX_DRAFT_KEYS = 64;
const MAX_DRAFT_DEPTH = 8;

/**
 * @returns {string|null} error message, or null when the id is usable.
 */
function validateDocId(id) {
  if (typeof id !== 'string' || id === '') return 'docId must be a non-empty string';
  if (Buffer.byteLength(id, 'utf8') > MAX_DOC_ID_BYTES) {
    return `docId must be at most ${MAX_DOC_ID_BYTES} bytes`;
  }
  // The path escape. A name, not a path.
  if (id.includes('/')) return 'docId must not contain "/"';
  // Firestore rejects these outright; catching them here makes the 400 explicit
  // rather than a 500 from the SDK.
  if (id === '.' || id === '..') return 'docId must not be "." or ".."';
  if (/^__.*__$/.test(id)) return 'docId must not match the reserved __*__ pattern';
  return null;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Depth guard: a deeply nested payload is a cheap way to make writes expensive. */
function exceedsDepth(value, depth) {
  if (depth > MAX_DRAFT_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => exceedsDepth(v, depth + 1));
  if (isPlainObject(value)) return Object.values(value).some((v) => exceedsDepth(v, depth + 1));
  return false;
}

/**
 * @returns {string|null} error message, or null when the payload is usable.
 */
function validateDraftPayload(draft) {
  if (!isPlainObject(draft)) return 'draft (object) required in body';

  const keys = Object.keys(draft);
  if (keys.length === 0) return 'draft must not be empty';
  if (keys.length > MAX_DRAFT_KEYS) return `draft must have at most ${MAX_DRAFT_KEYS} keys`;

  for (const key of keys) {
    // `_writtenAt` is the handler's own bookkeeping. Reserving the whole
    // underscore namespace keeps a caller from forging any field the server
    // writes about the write itself, now or later.
    if (key.startsWith('_')) return `draft key "${key}" is reserved (leading underscore)`;
    if (key.includes('.')) return `draft key "${key}" must not contain "."`;
    if (key === '') return 'draft keys must not be empty';
  }

  if (exceedsDepth(draft, 1)) return `draft must not nest deeper than ${MAX_DRAFT_DEPTH} levels`;

  // Size last: it is the most expensive check, and a payload that fails the
  // cheap structural rules never reaches it.
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
  } catch {
    // Circular structures cannot be stored either.
    return 'draft must be JSON-serialisable';
  }
  if (bytes > MAX_DRAFT_BYTES) return `draft must be at most ${MAX_DRAFT_BYTES} bytes`;

  return null;
}

module.exports = {
  MAX_DOC_ID_BYTES,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_KEYS,
  MAX_DRAFT_DEPTH,
  validateDocId,
  validateDraftPayload,
};
