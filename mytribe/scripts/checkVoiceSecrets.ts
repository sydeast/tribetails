/**
 * checkVoiceSecrets.ts
 *
 * Asks TWILIO whether the voice secrets actually work, rather than asking
 * Secret Manager whether they exist.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * On 2026-08-11 all four Voice SDK secrets were set, and every check in the
 * project passed:
 *
 *   `lib/declaredSecrets.ts`   asks "does the secret EXIST in Secret Manager".
 *                              Yes, all four.
 *   `mintVoiceAccessToken`     asked "is the value NON-BLANK". Yes, all four.
 *
 * And yet `TWIML_APP_SID` was 33 characters for an application that had never
 * been created, and the API key pair returned 401. The line between "configured"
 * and "working" was invisible, which is the same line the Studio flow's HTTP
 * widget sat on when it logged `success` for a 200 carrying the wrong answer.
 *
 * `mintVoiceAccessToken` now validates SHAPE on every call, which catches a
 * truncated paste. Shape cannot prove an id refers to a resource that exists,
 * or that a key still authenticates. Only Twilio can answer that, and not on
 * the hot path of a ringing phone. So this script does it as an operator step.
 *
 * ── IT NEVER PRINTS A SECRET ──────────────────────────────────────────────
 *
 * Values are read into memory and used, never echoed. Output is limited to the
 * secret's NAME, its length, its two-letter prefix, and the verdict. A safe
 * paste into a chat or an issue.
 *
 * Read-only. There is no --allow-prod, because it writes nothing.
 *
 *   npm run check:voice-secrets
 *   npm run check:voice-secrets -- --project auntieos-ttpc
 *
 * Exit code is 1 when any check fails, so CI or a release gate can use it.
 */
import { execFileSync } from 'node:child_process';

/** A two-letter prefix and 32 hex digits. 34 characters, always. */
const SID_PATTERN = /^[A-Z]{2}[0-9a-f]{32}$/;

export interface SecretSpec {
  name: string;
  /** Expected SID prefix, or null when the value is not a SID. */
  prefix: string | null;
  /** False when the feature degrades without it rather than failing. */
  required: boolean;
  purpose: string;
}

export const VOICE_SECRETS: readonly SecretSpec[] = [
  { name: 'TWILIO_ACCOUNT_SID', prefix: 'AC', required: true, purpose: 'the account tokens are minted against' },
  { name: 'TWILIO_API_KEY_SID', prefix: 'SK', required: true, purpose: 'signs the admin app voice token' },
  { name: 'TWILIO_API_KEY_SECRET', prefix: null, required: true, purpose: 'the other half of the signing key' },
  // Optional, matching mintVoiceAccessToken: it governs OUTBOUND calls from the
  // app, and the app places none. Absent means no outbound calling, not an outage.
  { name: 'TWIML_APP_SID', prefix: 'AP', required: false, purpose: 'runs when the admin app PLACES a call, which it does not do today' },
  { name: 'PUSH_CREDENTIAL_SID', prefix: 'CR', required: false, purpose: 'wakes the admin app for an incoming call' },
];

export type Verdict = 'ok' | 'missing' | 'malformed' | 'rejected';

export interface Finding {
  name: string;
  verdict: Verdict;
  /** Safe to print: never the value itself. */
  detail: string;
}

/**
 * Shape check. Pure, so the rule is testable without a Twilio account or a
 * gcloud login.
 */
export function checkShape(spec: SecretSpec, raw: string | null): Finding {
  if (raw === null) {
    return { name: spec.name, verdict: 'missing', detail: 'not found in Secret Manager' };
  }
  const value = raw.trim();
  if (!value) {
    return { name: spec.name, verdict: 'missing', detail: 'set, but empty' };
  }
  if (raw !== value) {
    // A trailing newline is the classic `echo` mistake and would be invisible.
    return {
      name: spec.name,
      verdict: 'malformed',
      detail: `has surrounding whitespace (${raw.length} bytes stored, ${value.length} after trim)`,
    };
  }
  if (spec.prefix) {
    if (!SID_PATTERN.test(value) || !value.startsWith(spec.prefix)) {
      return {
        name: spec.name,
        verdict: 'malformed',
        detail:
          `expected ${spec.prefix} + 32 hex (34 chars), got ${value.length} chars ` +
          `starting "${value.slice(0, 2)}"` +
          (value.length < 34 ? ' — looks like a truncated paste' : ''),
      };
    }
  }
  return { name: spec.name, verdict: 'ok', detail: `${value.length} chars, well formed` };
}

function readSecret(name: string, project: string): string | null {
  try {
    return execFileSync(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', '--secret', name, '--project', project],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
}

async function twilioStatus(url: string, user: string, pass: string): Promise<number> {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    return res.status;
  } catch {
    return 0;
  }
}

export function parseProject(argv: string[]): string {
  const i = argv.indexOf('--project');
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error('--project requires a value');
    return v;
  }
  return process.env.GCLOUD_PROJECT || 'auntieos-ttpc';
}

export async function main(argv: string[]): Promise<void> {
  const project = parseProject(argv);
  console.log(`Checking Twilio voice secrets in ${project}\n`);

  const values = new Map<string, string | null>();
  const findings: Finding[] = [];
  for (const spec of VOICE_SECRETS) {
    const raw = readSecret(spec.name, project);
    values.set(spec.name, raw === null ? null : raw.trim());
    findings.push(checkShape(spec, raw));
  }

  for (const f of findings) {
    const spec = VOICE_SECRETS.find((s) => s.name === f.name)!;
    const mark = f.verdict === 'ok' ? 'ok  ' : spec.required ? 'FAIL' : 'warn';
    console.log(`  ${mark}  ${f.name.padEnd(24)} ${f.detail}`);
  }

  // The live half. Skipped when the shape is already wrong, because a
  // malformed id produces a 404 that says nothing new.
  const account = values.get('TWILIO_ACCOUNT_SID');
  const keySid = values.get('TWILIO_API_KEY_SID');
  const keySecret = values.get('TWILIO_API_KEY_SECRET');
  const app = values.get('TWIML_APP_SID');
  const push = values.get('PUSH_CREDENTIAL_SID');
  const shapeOk = (name: string) => findings.find((f) => f.name === name)?.verdict === 'ok';

  console.log('\n  Against Twilio:');

  if (shapeOk('TWILIO_ACCOUNT_SID') && shapeOk('TWILIO_API_KEY_SID') && shapeOk('TWILIO_API_KEY_SECRET')) {
    const status = await twilioStatus(
      `https://api.twilio.com/2010-04-01/Accounts/${account}.json`,
      keySid!,
      keySecret!,
    );
    const ok = status === 200;
    if (!ok) {
      findings.push({
        name: 'TWILIO_API_KEY_SID',
        verdict: 'rejected',
        detail: `Twilio rejected the key pair (HTTP ${status}). An API key secret is shown once at creation; if it was not captured, create a new key.`,
      });
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  api key authenticates       HTTP ${status}`);
  } else {
    console.log('  skip  api key authenticates       (shape failed)');
  }

  // The remaining lookups need account credentials, which is the auth token.
  const authToken = readSecret('TWILIO_AUTH_TOKEN', project)?.trim() ?? '';
  if (authToken && shapeOk('TWIML_APP_SID')) {
    const status = await twilioStatus(
      `https://api.twilio.com/2010-04-01/Accounts/${account}/Applications/${app}.json`,
      account!,
      authToken,
    );
    const ok = status === 200;
    if (!ok) {
      findings.push({
        name: 'TWIML_APP_SID',
        verdict: 'rejected',
        detail: `no such TwiML Application (HTTP ${status}). Create one at Console > Voice > TwiML Apps.`,
      });
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  twiml app exists            HTTP ${status}`);
  } else {
    console.log('  skip  twiml app exists            (shape failed or no auth token)');
  }

  if (authToken && push && shapeOk('PUSH_CREDENTIAL_SID')) {
    const status = await twilioStatus(`https://chat.twilio.com/v2/Credentials/${push}`, account!, authToken);
    const ok = status === 200;
    if (!ok) {
      findings.push({
        name: 'PUSH_CREDENTIAL_SID',
        verdict: 'rejected',
        detail: `no such push credential (HTTP ${status}).`,
      });
    }
    console.log(`  ${ok ? 'ok  ' : 'warn'}  push credential exists      HTTP ${status}`);
  } else {
    console.log('  skip  push credential exists      (absent or shape failed)');
  }

  const blocking = findings.filter((f) => {
    if (f.verdict === 'ok') return false;
    return VOICE_SECRETS.find((s) => s.name === f.name)?.required ?? false;
  });

  console.log('');
  if (blocking.length === 0) {
    console.log('Voice calling is configured.');
    return;
  }
  console.log(`${blocking.length} problem${blocking.length === 1 ? '' : 's'} blocking voice calling:`);
  for (const f of blocking) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}

/* c8 ignore start -- entrypoint guard, exercised by running the script */
if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
/* c8 ignore stop */
