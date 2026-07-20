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
   * O-3 App Check L1 telemetry (docs/O3_APP_CHECK_RULING_2026-07-13.md, D2):
   * top-level (not nested under `extra`) so Logs Explorer can filter
   * `jsonPayload.appCheck`/`jsonPayload.origin` directly. 'valid' when
   * `req.app` is populated (a verified App Check token was present),
   * 'absent' otherwise — indistinguishable from "invalid" until enforcement
   * is on, which is sufficient for the monitor-only grace period.
   */
  appCheck?: 'valid' | 'absent';
  origin?: string;
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
