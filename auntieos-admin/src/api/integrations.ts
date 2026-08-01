import { call } from '../lib/fns';

/**
 * Settings > Integrations, as the admin reaches it.
 *
 * ONE CALLABLE, `getIntegrationsHealth`, admin-gated in
 * `mytribe/functions/src/admin/getIntegrationsHealth.ts`. See
 * `mytribe/functions/CALLABLE_CONTRACT.md`; the response shape is frozen in
 * `test/callableContract.test.ts`, so a rename there fails a test rather than
 * this file quietly.
 *
 * THE SERVER IS THE ONLY SOURCE, and this file adds nothing to it. A browser
 * cannot see a Cloud Functions secret, so anything decided here would be a
 * guess: that is exactly how android went on reporting a retired service as
 * healthy for a year. The status, the summary and the remediation all arrive
 * decided.
 *
 * NO SECRET VALUE EVER ARRIVES HERE. Per secret the response carries booleans
 * and a character count, and there is a server test that serialises the whole
 * response and refuses any value or 4-character prefix of one. Nothing in this
 * file should ever grow a field for a value.
 *
 * FAIL LOUD, no mapping. `remediation` carries the exact
 * `firebase functions:secrets:set` command; a friendly summary in its place
 * would delete the only text that says what to do next.
 */

/** What the operator's situation is. `unknown` means the check could not be made. */
export type IntegrationStatus = 'working' | 'configured' | 'missing' | 'unknown';

/**
 * What a probe found. `none` means no free check exists for this service, and
 * `detail` says why rather than leaving a blank that reads as a failure.
 */
export type LivenessOutcome = 'none' | 'pass' | 'fail' | 'error';

/** One credential. Booleans and a length, by construction. */
export interface IntegrationSecret {
  name: string;
  required: boolean;
  purpose: string;
  /** Some deployed function binds this name. Meaningless when `declaredKnown` is false. */
  declared: boolean;
  /** The name reached the function that answered. */
  resolves: boolean;
  /** Characters, 0 when absent. A count, never a sample. */
  length: number;
}

export interface IntegrationLiveness {
  outcome: LivenessOutcome;
  detail: string;
}

export interface IntegrationHealth {
  key: string;
  name: string;
  purpose: string;
  status: IntegrationStatus;
  summary: string;
  secrets: IntegrationSecret[];
  liveness: IntegrationLiveness;
  /** The exact operator step, with the command. Empty when nothing is owed. */
  remediation: string;
  /** A console step this repo cannot take for them. Empty when there is none. */
  externalStep: string;
  /** The Settings section that owns this one's flow, e.g. `googleCalendar`. */
  ownedBySection: string;
}

export interface IntegrationsHealthResult {
  checkedAt: string;
  /** False when the server could not read which secrets are declared anywhere. */
  declaredKnown: boolean;
  /** Empty when `declaredKnown`. Otherwise why not. */
  declaredError: string;
  integrations: IntegrationHealth[];
}

export async function getIntegrationsHealth(): Promise<IntegrationsHealthResult> {
  return call<Record<string, never>, IntegrationsHealthResult>('getIntegrationsHealth', {});
}

/** The pill's words, per status. One map, so the two clients read the same. */
export const STATUS_LABEL: Record<IntegrationStatus, string> = {
  working: 'Working',
  configured: 'Set up, not verified',
  missing: 'Missing',
  unknown: 'Could not check',
};

/**
 * The pill's tone. `unknown` is WARNING, never success and never neutral: a
 * check that could not be made must not sit quietly beside checks that passed.
 */
export const STATUS_TONE: Record<IntegrationStatus, 'success' | 'warning' | 'error'> = {
  working: 'success',
  configured: 'warning',
  missing: 'error',
  unknown: 'warning',
};
