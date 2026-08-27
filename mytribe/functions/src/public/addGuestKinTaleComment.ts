import { onRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';
import { z } from 'zod';
import type { RecaptchaEnterpriseServiceClient } from '@google-cloud/recaptcha-enterprise';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeRichText, sanitizePlainText } from '../lib/richText';

const GUEST_RATE_LIMIT_PER_HOUR = 5;
const GUEST_RATE_WINDOW_MS = 60 * 60 * 1000;

const RECAPTCHA_SITE_KEY = '6Leix-ksAAAAAFwAl_Ua0n6ZFyPR8PQCZxc2VRIg';
const RECAPTCHA_PROJECT_ID = 'auntieos-ttpc';
const RECAPTCHA_ACTION = 'guest_comment';
const RECAPTCHA_MIN_SCORE = 0.5;

// Lazy-init to keep cold-start fast for the (rare) malformed-body branch
// that rejects before ever needing to verify.
//
// The MODULE is loaded lazily too, and that is the expensive half. This is the
// only function in the codebase that verifies a reCAPTCHA, but the Functions
// runtime loads all of `index.js` on every cold start whatever the target is,
// so a file-scope import charged the reCAPTCHA client's gRPC/protobuf stack to
// all 227 of them. Constructing the client is what needs the module, so that is
// where it is fetched.
let recaptchaClient: RecaptchaEnterpriseServiceClient | null = null;
async function getRecaptchaClient(): Promise<RecaptchaEnterpriseServiceClient> {
  if (!recaptchaClient) {
    const { RecaptchaEnterpriseServiceClient: Client } = await import(
      '@google-cloud/recaptcha-enterprise'
    );
    recaptchaClient = new Client();
  }
  return recaptchaClient;
}

/**
 * Verifies a reCAPTCHA Enterprise token. Returns null if valid + score ≥ min;
 * returns a user-facing error string otherwise. Per fail-loud: every reject
 * path produces a specific reason the caller surfaces back to the UI.
 */
async function verifyRecaptcha(token: string): Promise<string | null> {
  try {
    const client = await getRecaptchaClient();
    const [assessment] = await client.createAssessment({
      parent: `projects/${RECAPTCHA_PROJECT_ID}`,
      assessment: {
        event: { token, siteKey: RECAPTCHA_SITE_KEY, expectedAction: RECAPTCHA_ACTION },
      },
    });
    const props = assessment.tokenProperties;
    if (!props?.valid) {
      return `reCAPTCHA token invalid (${props?.invalidReason ?? 'unknown'}).`;
    }
    if (props.action !== RECAPTCHA_ACTION) {
      return 'reCAPTCHA action mismatch.';
    }
    const score = assessment.riskAnalysis?.score ?? 0;
    if (score < RECAPTCHA_MIN_SCORE) {
      return `reCAPTCHA score too low (${score.toFixed(2)}); please try again from a less suspicious network.`;
    }
    return null;
  } catch (e) {
    return `reCAPTCHA verification failed: ${(e as Error).message}`;
  }
}

const Body = z.object({
  shareToken: z.string().min(1).max(200),
  taleId: z.string().min(1).max(200),
  guestName: z.string().min(1).max(120).refine((s) => s.trim().length > 0, {
    message: 'guestName cannot be whitespace-only',
  }),
  guestEmail: z.string().email().max(320),
  body: z.string().min(1).max(2000).refine((s) => s.trim().length > 0, {
    message: 'body cannot be whitespace-only',
  }),
  parentCommentId: z.string().min(1).max(200).optional(),
  recaptchaToken: z.string().min(1).max(5000).optional(),
  /**
   * When true, the handler skips reCAPTCHA verification. Used only by the
   * unit test harness, production callers must pass a valid token.
   */
  skipRecaptchaForTest: z.boolean().optional(),
});

function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

type ShareDoc = {
  tribeId?: string;
  sourceKinTaleId?: string;
  revoked?: boolean;
  expiresAt?: { toMillis: () => number } | Date | null;
  allowGuestComments?: boolean;
};

function isExpired(doc: ShareDoc): boolean {
  const exp = doc.expiresAt;
  if (!exp) return false;
  const ms =
    typeof (exp as { toMillis?: () => number }).toMillis === 'function'
      ? (exp as { toMillis: () => number }).toMillis()
      : (exp as Date).getTime?.();
  if (typeof ms !== 'number') return false;
  return Date.now() >= ms;
}

/**
 * Minimal req/res shape so the handler is unit-testable without spinning up
 * a real Express layer. The runtime `onRequest` wrapper hands us a
 * full Request/Response from Firebase Functions, which is a superset.
 */
export interface MinimalReq {
  method?: string;
  body?: unknown;
}
export interface MinimalRes {
  status(code: number): MinimalRes;
  json(payload: Record<string, unknown>): void;
}

/**
 * HTTP function (NOT callable) for unauthenticated viewers of a shared KinTale
 * to post a comment. Path: `families/{tribeId}/kinTales/{taleId}/comments`.
 *
 * Anti-abuse:
 * - shareToken must exist + not be revoked + not expired
 * - guestEmail hashed (sha256), never stored raw
 * - per-emailHash rate limit: 5 comments per rolling 60min
 * - reCAPTCHA Enterprise token VERIFIED server-side by `verifyRecaptcha` above:
 *   token validity, `action === RECAPTCHA_ACTION`, and a score floor of
 *   RECAPTCHA_MIN_SCORE. This line used to call that verification "a follow-up
 *   task", which the function directly above it already contradicted. The stale
 *   claim nearly bought a second reCAPTCHA integration on top of a working one
 *   (see the #397 comment sweep, #621 and #622).
 *
 * Fail-loud: every reject path returns a specific status code + message so the
 * client surfaces the cause to the user.
 */
export async function addGuestKinTaleCommentHandler(
  req: MinimalReq,
  res: MinimalRes,
): Promise<void> {
  initSentry();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  let args: z.infer<typeof Body>;
  try {
    args = Body.parse(req.body);
  } catch (err) {
    res.status(400).json({ error: 'Invalid arguments.', detail: (err as Error).message });
    return;
  }

  // Unauthenticated write path — the highest-risk surface for injected markup,
  // since anyone with the share link can post without an account.
  const commentBody = sanitizeRichText(args.body);
  // A name is never allowed to carry even the rich-text subset — a guest
  // must not be able to render as a live link or bolded text anywhere.
  const guestName = sanitizePlainText(args.guestName);
  if (commentBody.length === 0) {
    res.status(400).json({ error: 'body cannot be whitespace-only.' });
    return;
  }
  if (guestName.length === 0) {
    res.status(400).json({ error: 'guestName cannot be whitespace-only.' });
    return;
  }

  const shareSnap = await db().doc(`sharedKinTales/${args.shareToken}`).get();
  if (!shareSnap.exists) {
    res.status(404).json({ error: 'Share link not found.' });
    return;
  }
  const share = shareSnap.data() as ShareDoc;
  if (share.revoked) {
    res.status(403).json({ error: 'Share link revoked.' });
    return;
  }
  if (isExpired(share)) {
    res.status(403).json({ error: 'Share link expired.' });
    return;
  }
  if (share.allowGuestComments === false) {
    res.status(403).json({ error: 'Comments disabled for this share link.' });
    return;
  }
  if (share.sourceKinTaleId !== args.taleId) {
    res.status(400).json({ error: 'taleId does not match share link.' });
    return;
  }
  const tribeId = share.tribeId;
  if (!tribeId) {
    res.status(500).json({ error: 'Share link malformed (missing tribeId).' });
    return;
  }

  // reCAPTCHA Enterprise verification. Skipped only by the unit-test harness.
  if (!args.skipRecaptchaForTest) {
    if (!args.recaptchaToken) {
      res.status(400).json({ error: 'reCAPTCHA token required.' });
      return;
    }
    const recaptchaErr = await verifyRecaptcha(args.recaptchaToken);
    if (recaptchaErr) {
      res.status(403).json({ error: recaptchaErr });
      return;
    }
  }

  // Parent-comment existence is independent of the rate counter; check it first
  // so we don't burn a rate slot on a request that will 404 anyway.
  if (args.parentCommentId) {
    const parentSnap = await db()
      .doc(`kin_care_reports/${args.taleId}/comments/${args.parentCommentId}`)
      .get();
    if (!parentSnap.exists) {
      res.status(404).json({ error: 'Parent comment not found.' });
      return;
    }
  }

  // WARNING-23/26: the rate counter was read then written in two separate ops, so
  // N concurrent requests all read the same pre-increment count and each passed
  // the 5/hour cap — the limit was bypassable by firing requests in parallel.
  // Do the read-check-increment ATOMICALLY in a transaction so concurrent guests
  // contend on the same counter doc and only GUEST_RATE_LIMIT_PER_HOUR succeed.
  const emailHash = hashEmail(args.guestEmail);
  const rateRef = db().doc(`guestCommentRateLimits/${emailHash}`);
  const nowMs = Date.now();
  const windowStart = nowMs - GUEST_RATE_WINDOW_MS;
  type RateBucket = { count: number; firstAtMs: number };
  const overLimit = await db().runTransaction(async (tx) => {
    const rateSnap = await tx.get(rateRef);
    const bucket: RateBucket = rateSnap.exists
      ? (rateSnap.data() as RateBucket)
      : { count: 0, firstAtMs: nowMs };
    let nextCount: number;
    let nextFirstAtMs: number;
    if (bucket.firstAtMs < windowStart) {
      nextCount = 1;
      nextFirstAtMs = nowMs;
    } else {
      nextCount = bucket.count + 1;
      nextFirstAtMs = bucket.firstAtMs;
    }
    if (nextCount > GUEST_RATE_LIMIT_PER_HOUR) {
      // Over the cap: do NOT write, signal the caller to 429.
      return true;
    }
    tx.set(
      rateRef,
      { count: nextCount, firstAtMs: nextFirstAtMs, updatedAtMs: nowMs },
      { merge: true },
    );
    return false;
  });
  if (overLimit) {
    res.status(429).json({
      error: "You've reached the comment limit. Try again later.",
    });
    return;
  }

  const commentRef = await db()
    .collection(`kin_care_reports/${args.taleId}/comments`)
    .add({
      authorUid: null,
      authorRole: 'guest',
      body: commentBody,
      guestName,
      guestEmailHash: emailHash,
      parentCommentId: args.parentCommentId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
    });

  logEvent({
    severity: 'info',
    function: 'addGuestKinTaleComment',
    event: 'portal.kintale.comment.added.guest',
    uid: 'guest',
    extra: {
      tribeId,
      taleId: args.taleId,
      commentId: commentRef.id,
      parentCommentId: args.parentCommentId ?? null,
    },
  });

  res.status(200).json({ commentId: commentRef.id });
}

export const addGuestKinTaleComment = onRequest(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  async (req, res) => {
    const adapter: MinimalRes = {
      status(code: number) {
        res.status(code);
        return adapter;
      },
      json(payload: Record<string, unknown>) {
        res.json(payload);
      },
    };
    await addGuestKinTaleCommentHandler({ method: req.method, body: req.body }, adapter);
  },
);
