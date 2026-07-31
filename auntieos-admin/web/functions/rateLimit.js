// Fixed-window rate limiter keyed by the VERIFIED caller uid.
//
// The draft endpoints (writeDraft / getDraft / getTrainingDoc) used to carry a
// per-IP limiter that stored every request timestamp in an array on
// `n8nIpRateLimits/{ipHash}`. AO-33 flagged that array as unbounded, correctly:
// it grew for the life of the bucket doc. Moving those endpoints onto Firebase
// admin tokens removed the old limiter with the shared secret it protected, and
// a verified identity is NOT a substitute for a rate limit. Token verification
// answers "who is this"; a rate limit answers "how much may they do". A leaked
// admin token or a runaway client loop is exactly the case where the first
// question has a satisfying answer and the damage still happens.
//
// So: same protection, better shape.
//   - Keyed on uid, not IP. A caller cannot shed its budget by changing source
//     address, and an admin's own loop is capped rather than being spread over
//     however many egress IPs a proxy happens to use.
//   - Fixed-window COUNTER, not a timestamp list. The doc holds two numbers and
//     never grows, so the unbounded-array finding cannot recur here.
//
// This is deliberately not the same thing as `generateRateLimit.js`. That is a
// DAILY cap on paid Anthropic spend, and its bucket stores a `date` string.
// This is a per-minute BURST cap on cheap Firestore work. Different question,
// different bucket, different reset cadence; sharing one would make both wrong.
//
// The bucket collection is server-written only. It has no entry in
// firestore.rules, and rules deny anything unmatched, which is the same footing
// `generate_rate_limits` sits on.

/** Window index for a timestamp. Two calls share a window iff this matches. */
function windowKeyFor(nowMs, windowMs) {
  return Math.floor(nowMs / windowMs);
}

/**
 * Pure decision: given the stored bucket (or undefined) and the current window,
 * decide whether this call is allowed and compute the next stored state.
 *
 * The count advances ONLY when the call is allowed, so a caller already over
 * the cap cannot push its own counter further out by continuing to hammer, and
 * the bucket therefore always reflects served traffic rather than attempts. A
 * bucket from an earlier window resets to zero rather than being cleaned up.
 *
 * @returns {{ allowed: boolean, priorCount: number, cap: number,
 *             nextState: { window: number, count: number } }}
 */
function evaluateWindowedRateLimit(existing, windowKey, cap) {
  const sameWindow = !!existing && existing.window === windowKey;
  const priorCount = sameWindow ? existing.count || 0 : 0;
  const allowed = priorCount < cap;
  return {
    allowed,
    priorCount,
    cap,
    nextState: { window: windowKey, count: priorCount + (allowed ? 1 : 0) },
  };
}

/**
 * Transactionally consume one unit of `uid`'s budget in `collection`.
 *
 * Throws an Error with `.status = 429` when the cap is exceeded; a rejected
 * call does NOT mutate the counter. The read and the write share a transaction,
 * so two concurrent requests cannot both observe the same prior count and both
 * be allowed through the cap.
 */
async function enforceWindowedRateLimit(db, { collection, uid, nowMs, windowMs, cap }) {
  const key = windowKeyFor(nowMs, windowMs);
  const ref = db.collection(collection).doc(uid);
  const decision = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = evaluateWindowedRateLimit(snap.exists ? snap.data() : undefined, key, cap);
    if (d.allowed) tx.set(ref, { ...d.nextState, updatedAtMs: nowMs }, { merge: true });
    return d;
  });
  if (!decision.allowed) {
    const err = new Error('rate_limit_exceeded');
    err.status = 429;
    throw err;
  }
  return decision;
}

module.exports = {
  windowKeyFor,
  evaluateWindowedRateLimit,
  enforceWindowedRateLimit,
};
