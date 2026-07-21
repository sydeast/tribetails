// NOTE-48: per-admin daily call cap on the paid Anthropic `generate` endpoint.
//
// The endpoint is admin-only, so this is defense-in-depth, not access control:
// it bounds the blast radius of a runaway client loop or a leaked/compromised
// admin token, either of which could otherwise drive unbounded Anthropic spend.
// Model pinning (the other half of NOTE-48) caps the cost PER call; this caps
// the call COUNT per admin per UTC day. The counter lives in
// `generate_rate_limits/{uid}` and resets automatically at the day boundary.
//
// Fail-loud: a caller over the cap gets an explicit 429, never a silent drop.

const DEFAULT_DAILY_GENERATE_CAP = 200;

/** UTC day key (YYYY-MM-DD) for a millisecond timestamp. */
function dayKeyUtc(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Pure decision: given the stored counter doc (or undefined) and today's key,
 * decide whether this call is allowed and compute the next stored state. The
 * count only advances when the call is ALLOWED, so a blocked caller can never
 * push its own counter further past the cap. A stored doc from a previous day
 * resets to zero.
 *
 * @returns {{ allowed: boolean, priorCount: number, cap: number,
 *             nextState: { date: string, count: number } }}
 */
function evaluateGenerateRateLimit(existing, todayKey, cap = DEFAULT_DAILY_GENERATE_CAP) {
  const sameDay = !!existing && existing.date === todayKey;
  const priorCount = sameDay ? existing.count || 0 : 0;
  const allowed = priorCount < cap;
  return {
    allowed,
    priorCount,
    cap,
    nextState: { date: todayKey, count: priorCount + (allowed ? 1 : 0) },
  };
}

/**
 * Transactionally consume one unit of the caller's daily generate budget.
 * Throws an Error with `.status = 429` when the cap is exceeded; a rejected
 * call does NOT mutate the counter. Returns the decision on success.
 */
async function enforceGenerateRateLimit(db, uid, nowMs, cap = DEFAULT_DAILY_GENERATE_CAP) {
  const todayKey = dayKeyUtc(nowMs);
  const ref = db.collection('generate_rate_limits').doc(uid);
  const decision = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = evaluateGenerateRateLimit(snap.exists ? snap.data() : undefined, todayKey, cap);
    if (d.allowed) tx.set(ref, d.nextState, { merge: true });
    return d;
  });
  if (!decision.allowed) {
    const err = new Error('generate_rate_limit_exceeded');
    err.status = 429;
    throw err;
  }
  return decision;
}

module.exports = {
  DEFAULT_DAILY_GENERATE_CAP,
  dayKeyUtc,
  evaluateGenerateRateLimit,
  enforceGenerateRateLimit,
};
