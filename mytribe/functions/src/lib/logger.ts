type Severity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogFields {
  severity: Severity;
  function: string;
  event: string;
  requestId?: string;
  clientRequestId?: string;
  uid?: string;
  familyId?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /**
   * O-3 App Check telemetry (docs/O3_APP_CHECK_RULING_2026-07-13.md, D2):
   * top-level (not nested under `extra`) so Logs Explorer can filter
   * `jsonPayload.appCheck`/`jsonPayload.origin` directly.
   *
   * 'valid' when `req.app` is populated, which the platform does only after
   * the Admin SDK has verified the token. 'invalid' when a token rode along
   * and failed that verification. 'absent' when none was sent. L1 shipped
   * without the middle case and it mattered: a client whose attestation is
   * broken and a client that does not attest yet are different problems, and
   * the grace-period metric is where that difference has to show.
   */
  appCheck?: 'valid' | 'invalid' | 'absent';
  origin?: string;
  /**
   * #557 session-revocation check, top-level for the same reason `appCheck` is:
   * enforcing it fleet-wide was a cost decision, and the cost is a Logs
   * Explorer aggregation over `jsonPayload.authCheck` / `jsonPayload.authCheckMs`
   * — not a number anyone could honestly guess up front. 'skipped' =
   * unauthenticated call, 'hit'/'miss' = the per-instance TTL cache, 'error' =
   * the Identity Toolkit lookup failed and the call was let through, 'revoked'
   * = the call was refused because the session was over, 'not-run' = the App
   * Check gate above it (#556) refused first, so no lookup was reached.
   */
  authCheck?: 'not-run' | 'skipped' | 'hit' | 'miss' | 'error' | 'revoked';
  authCheckMs?: number;
  extra?: Record<string, unknown>;
}

export function logEvent(fields: LogFields): void {
  const payload = { ts: new Date().toISOString(), ...fields };
  const line = JSON.stringify(payload);
  if (fields.severity === 'error' || fields.severity === 'critical') {
    console.error(line);
  } else {
    console.log(line);
  }
}
