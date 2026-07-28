/**
 * Outbound response validation for callables (ADR-0001 decision 1, step W3-1).
 *
 * Request shapes have been machine-frozen since 2026-07-21
 * (`test/callableContract.test.ts`); response shapes had NO machine guard at
 * all. `CALLABLE_CONTRACT.md` called itself their "review anchor", and review
 * discipline is exactly what ADR-0001 measured as having drifted. This module
 * is the runtime half of making the server zod schema the authority for BOTH
 * directions: every invoice-surface handler now parses what it is about to
 * return through a schema colocated with it.
 *
 * THE FAILURE MODE IS LOG-LOUD-AND-RETURN, NOT THROW, AND THAT IS A MONEY
 * RULING RATHER THAN A TASTE ONE.
 *
 * The response is built AFTER the write commits. On this surface the writes
 * are non-idempotent and carry no client request id: `createInvoice` mints a
 * fresh doc id per call, `recordPayment` appends a fresh ledger row,
 * `markInvoicePaid` appends to the `payments` subcollection. Throwing on a bad
 * response would therefore report a COMMITTED money write as a failure, and
 * every client in this repo renders a failure as a retry affordance, so the
 * operator records the payment twice. That converts a description bug into a
 * double-collection, which is strictly worse than the bug it would be
 * reporting.
 *
 * It refuses nothing and it hides nothing:
 *   - `severity: 'error'` on a structured log line naming the failing field
 *     PATHS, so a Logs Explorer filter on `jsonPayload.event` finds it.
 *   - A Sentry exception with a real stack, in the same feed a thrown
 *     `internal` would have landed in. Detection is not what throwing buys.
 * A drift here is a deploy-time bug: it fires on the FIRST call in production,
 * on every call after it, and it is in the error feed within seconds. Refusing
 * the caller adds nothing to that and costs a duplicate write.
 *
 * THE VALUE IS RETURNED UNCHANGED: the ORIGINAL object, never
 * `safeParse`'s output. A zod object STRIPS unknown keys, so returning the
 * parse result would let this guard silently delete a field from a live money
 * response the moment a schema fell behind the handler. W3-1 is a guard, not a
 * redesign: nothing that reaches the wire is altered by adding it. The schemas
 * are `.strict()` for the opposite reason. An ADDED response field must be
 * reported rather than absorbed, because ADR-0001 decision 2 generates client
 * types from these schemas and a permissive schema generates a type that lies.
 *
 * NO VALUES ARE EVER LOGGED. Invoice responses carry household names, client
 * names and addresses; the report is field paths and zod issue codes only.
 */
import { z } from 'zod';
import { logEvent } from './logger';
import { captureFunctionError } from './sentry';

/** The one log event name for every response-contract failure. */
export const RESPONSE_CONTRACT_EVENT = 'callable.response.contractViolation';

/** The machine-readable code on the log line, for alerting. */
export const RESPONSE_CONTRACT_CODE = 'response_contract_violation';

/**
 * Cap on reported issues. A malformed list response can produce one issue per
 * element; the full count is reported alongside, so the cap truncates the
 * report without hiding the scale.
 */
export const MAX_REPORTED_ISSUES = 10;

/** One refused field, as it appears in the log and in Sentry. Paths, never values. */
export interface ResponseContractViolation {
  /** Dotted path, `[]`-indexed for arrays. `(root)` when the whole value is wrong. */
  path: string;
  /** The zod issue code, e.g. `invalid_type`, `unrecognized_keys`. */
  code: string;
  message: string;
}

/** Field paths and issue codes only. Never the offending value (PII). */
function violationsOf(error: z.ZodError): ResponseContractViolation[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Validates a handler's return value against its own response schema and
 * returns it UNCHANGED.
 *
 * Generic over the value, not the schema, so the handler's declared return
 * type still does the compile-time work and this call is transparent at the
 * call site: `return validateResponse('createInvoice', Result, { ... })`.
 */
export function validateResponse<T>(fn: string, schema: z.ZodType, value: T): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // EVERYTHING IN HERE IS BEST-EFFORT, and the try/catch is the log-and-return
    // ruling taken seriously rather than a swallow. A guard that can itself
    // fail the call it guards has re-created the failure mode the ruling
    // rejected: a money write that committed, reported as a failure, only
    // now triggered by the reporting transport (a Sentry init that never took
    // the DSN, a capture that throws) instead of by the shape. There is no
    // safe place to escalate to: the write is already durable.
    try {
      const violations = violationsOf(parsed.error);
      const issueCount = parsed.error.issues.length;
      const summary = violations.map((v) => `${v.path}: ${v.code}`).join(', ');
      logEvent({
        severity: 'error',
        function: fn,
        event: RESPONSE_CONTRACT_EVENT,
        errorCode: RESPONSE_CONTRACT_CODE,
        errorMessage: `${fn} returned a value its own response schema refuses`,
        extra: { violations, issueCount },
      });
      // An exception rather than a message capture: the stack points straight
      // at the handler that built the wrong shape, which is the whole question
      // a reader of this alert has.
      captureFunctionError(new Error(`${fn} response contract violation: ${summary}`), {
        function: fn,
        violations,
        issueCount,
      });
    } catch {
      // console.error directly: `logEvent` is the thing that may have failed.
      console.error(`[${RESPONSE_CONTRACT_EVENT}] ${fn}: reporting failed`);
    }
  }
  return value;
}
