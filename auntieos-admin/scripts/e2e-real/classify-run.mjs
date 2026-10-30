/**
 * The verdict of a real-services run (#1196, D3-e in #1089).
 *
 * THE RULE (operator ruling D3, 2026-10-01). A failure caused by our
 * integration stops the release. A vendor outage only warns. A failure counts
 * as an outage only when the vendor call got a 5xx or timed out AND the
 * vendor's status page showed an incident at that moment. A 4xx, an auth error
 * or a payload error always stops.
 *
 * INPUTS.
 *   - `cypress/.real/results.json`: the run's results, written by the
 *     `after:run` hook in `cypress.real.config.ts` (trimmed to what is read here).
 *   - `cypress/.real/emulators.log`: the emulator output `run.sh` tees. Our
 *     functions log vendor failures there as one JSON object per line
 *     (`mytribe/functions/src/lib/logger.ts`), each with a `ts`.
 *   - the vendors' public status pages, asked once per vendor per run.
 *
 * OUTPUT. `cypress/.real/verdict.json`:
 *   { "verdict": "stop" | "warn" | "pass", "reasons": [string],
 *     "checkedAt": ISO, "cypressExit": number,
 *     "failures": [{ spec, test, error, window, vendorErrors, outcome, reason }],
 *     "statusPages": { vendor: { url, ok, reason?, incidents? } } }
 * Exit code: 1 on stop, 0 on warn and pass.
 *
 * EVERYTHING UNPROVEN STOPS. No results file, a spec that did not load, a
 * failure with no vendor error in its text or its spec's log window, a vendor
 * error with no status code or timeout we can read, a status page that does
 * not answer: each is `stop`. `warn` needs every vendor error attributed to
 * every failure to be a 5xx or timeout during a listed incident.
 *
 * SELF-CONTAINED ON PURPOSE, like cloudinary-cleanup.mjs: standard library
 * only, every path passed in, so the portal's run.sh (#1194) can use it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Status sources, verified by hand on 2026-10-23 (each answered 200 with JSON):
 *   - Stripe: status.stripe.com sends browsers on to www.stripestatus.com, an
 *     Atlassian Statuspage. status.stripe.com/current is a frozen 2024 payload
 *     and status.stripe.com/api/v2/* is a 404, so neither is used.
 *   - Twilio, Cloudinary: Statuspage at their status.* hosts.
 *   - smtp2go: status.smtp2go.com redirects to smtp2gostatus.com (Statuspage).
 *   - Google Calendar: Google Workspace's status dashboard feed.
 * Statuspage's `incidents.json` lists recent incidents including resolved
 * ones, so an incident that ended between the failure and this check still
 * counts if it covered the failure.
 */
export const VENDORS = {
  stripe: {
    match: /\bstripe|api\.stripe\.com/i,
    status: { kind: 'statuspage', url: 'https://www.stripestatus.com/api/v2/incidents.json' },
  },
  twilio: {
    match: /\btwilio\b|api\.twilio\.com/i,
    status: { kind: 'statuspage', url: 'https://status.twilio.com/api/v2/incidents.json' },
  },
  cloudinary: {
    match: /\bcloudinary\b|api\.cloudinary\.com/i,
    status: { kind: 'statuspage', url: 'https://status.cloudinary.com/api/v2/incidents.json' },
  },
  email: {
    match: /\bsmtp2go\b/i,
    status: { kind: 'statuspage', url: 'https://smtp2gostatus.com/api/v2/incidents.json' },
  },
  googleCalendar: {
    match: /google ?calendar|googleapis\.com\/calendar|oauth2\.googleapis\.com/i,
    status: { kind: 'google', url: 'https://www.google.com/appsstatus/dashboard/incidents.json', product: /calendar/i },
  },
};

const STATUS_PATTERNS = [
  /\bHTTP[ /]?(?:1\.1 |2 )?\(?([1-5]\d\d)\b/i,
  /["']?(?:statusCode|status_code|http_code|httpStatus|status)["']?\s*[:=]\s*["']?([1-5]\d\d)\b/i,
  /\bstatus(?: code)? ([1-5]\d\d)\b/i,
  /\brefused[^:\n]*:\s*([1-5]\d\d)\b/i,
];

/** Network and client timeouts. Cypress's own retry and task timeouts are excluded below. */
const TIMEOUT_PATTERN =
  /\b(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ConnectTimeoutError|TimeoutError|request timed out|timed out)\b/i;
const CYPRESS_TIMEOUT = /Timed out retrying|cy\.\w+\([^)]*\) timed out|timed out waiting for/i;

const STACK_FRAME = /^\s*at\s|webpack:\/\/|\.cy\.[jt]sx?\b/;

const AUTH_PATTERN = /\b(unauthori[sz]ed|authenticat\w* (failed|error)|invalid api key|invalid_api_key|permission denied|forbidden)\b/i;

/**
 * Vendor errors named in [text], one per line that names a vendor.
 * Each is `{ vendor, status, timeout, auth, ts, text }`; `status` is a number or null.
 */
export function extractVendorErrors(text, ts = null) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    // Stack frames name spec files (`invoice-paid-stripe.cy.ts`), not vendor errors.
    if (STACK_FRAME.test(line)) continue;
    for (const [vendor, def] of Object.entries(VENDORS)) {
      if (!def.match.test(line)) continue;
      let status = null;
      for (const p of STATUS_PATTERNS) {
        const m = line.match(p);
        if (m) {
          status = Number(m[1]);
          break;
        }
      }
      const timeout = !CYPRESS_TIMEOUT.test(line) && TIMEOUT_PATTERN.test(line);
      const auth = AUTH_PATTERN.test(line);
      out.push({ vendor, status, timeout, auth, ts, text: line.trim().slice(0, 500) });
    }
  }
  return out;
}

/** True when this vendor error could be an outage: a 5xx or a timeout, and nothing that says we sent something wrong. */
export function isOutageShaped(e) {
  if (e.auth) return false;
  if (e.status !== null && e.status < 500) return false;
  return (e.status !== null && e.status >= 500) || e.timeout;
}

/** Plain-language reason a vendor error stops on its own. */
function stopReason(e) {
  if (e.auth) return `${e.vendor} refused our credentials`;
  if (e.status !== null && e.status < 500) return `${e.vendor} answered ${e.status}: our request`;
  return `${e.vendor} error with no status code or timeout to read`;
}

/**
 * Structured log lines from the emulator log, parsed. Only warn and above,
 * because those are where our functions report a vendor failing.
 */
export function parseLogLines(logText) {
  const out = [];
  for (const raw of String(logText ?? '').split('\n')) {
    const start = raw.indexOf('{"');
    if (start < 0) continue;
    let obj;
    try {
      obj = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || !/^(warn|error|critical)$/.test(String(obj.severity))) continue;
    const ts = Date.parse(obj.ts);
    out.push({ ts: Number.isFinite(ts) ? ts : null, text: JSON.stringify(obj) });
  }
  return out;
}

/**
 * The failures in a Cypress results object (`after:run` shape, or the
 * `{ status: 'failed', message }` shape when Cypress could not run at all).
 */
export function collectFailures(results, logLines) {
  const failures = [];
  const runErrors = [];
  if (!results || typeof results !== 'object') {
    runErrors.push('Cypress produced no results');
    return { failures, runErrors };
  }
  if (results.status === 'failed') {
    runErrors.push(`Cypress could not run: ${results.message ?? 'no message'}`);
    return { failures, runErrors };
  }
  if (!Array.isArray(results.runs)) {
    runErrors.push('Cypress results have no runs');
    return { failures, runErrors };
  }
  for (const run of results.runs) {
    const spec = run?.spec?.relative ?? run?.spec?.name ?? 'unknown spec';
    if (run?.error) runErrors.push(`${spec}: ${String(run.error).split('\n')[0]}`);
    const start = Date.parse(run?.stats?.startedAt);
    const end = Date.parse(run?.stats?.endedAt);
    const window = Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
    for (const t of run?.tests ?? []) {
      if (t?.state !== 'failed') continue;
      const error = String(t.displayError ?? '');
      const vendorErrors = extractVendorErrors(error, null);
      if (window) {
        for (const line of logLines) {
          if (line.ts === null || line.ts < window.start || line.ts > window.end) continue;
          vendorErrors.push(...extractVendorErrors(line.text, line.ts));
        }
      }
      failures.push({
        spec,
        test: Array.isArray(t.title) ? t.title.join(' > ') : String(t.title ?? ''),
        error: error.split('\n').slice(0, 6).join('\n'),
        window: window ? { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() } : null,
        windowMs: window,
        vendorErrors,
      });
    }
  }
  return { failures, runErrors };
}

/** Fetches JSON with a deadline. Never throws: `{ ok, body?, reason? }`. */
async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, reason: 'answer was not JSON' };
    }
  } catch (err) {
    return { ok: false, reason: controller.signal.aborted ? `no answer in ${timeoutMs}ms` : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A vendor's incidents as `{ name, start, end, url }` with epoch-ms times
 * (`end` null while open), or `{ ok: false, reason }`.
 */
export async function vendorIncidents(vendor, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const src = VENDORS[vendor].status;
  const r = await fetchJson(src.url, fetchImpl, timeoutMs);
  if (!r.ok) return { url: src.url, ok: false, reason: r.reason };
  try {
    if (src.kind === 'statuspage') {
      if (!Array.isArray(r.body?.incidents)) throw new Error('no incidents list');
      const incidents = r.body.incidents.map((i) => ({
        name: String(i.name ?? ''),
        start: Date.parse(i.started_at ?? i.created_at),
        end: i.resolved_at ? Date.parse(i.resolved_at) : null,
        url: i.shortlink ?? null,
      }));
      return { url: src.url, ok: true, incidents: incidents.filter((i) => Number.isFinite(i.start)) };
    }
    if (!Array.isArray(r.body)) throw new Error('no incidents list');
    const incidents = r.body
      .filter((i) => src.product.test(`${i.service_name ?? ''} ${(i.affected_products ?? []).map((p) => p.title).join(' ')}`))
      .map((i) => ({
        name: String(i.external_desc ?? i.service_name ?? '').slice(0, 200),
        start: Date.parse(i.begin),
        end: i.end ? Date.parse(i.end) : null,
        url: i.uri ? `https://www.google.com/appsstatus/dashboard/${i.uri}` : null,
      }));
    return { url: src.url, ok: true, incidents: incidents.filter((i) => Number.isFinite(i.start)) };
  } catch (err) {
    return { url: src.url, ok: false, reason: `unreadable answer: ${err.message}` };
  }
}

/** The incident covering any moment of [from, to], or null. Open incidents run to [now]. */
export function coveringIncident(incidents, from, to, now) {
  return incidents.find((i) => i.start <= to && (i.end ?? now) >= from) ?? null;
}

/**
 * The verdict. Pure apart from [fetchImpl], which is only called for vendors
 * that have an outage-shaped error.
 */
export async function classify({ results, logText = '', cypressExit = 0, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 10_000 }) {
  const logLines = parseLogLines(logText);
  const { failures, runErrors } = collectFailures(results, logLines);
  const reasons = [...runErrors.map((r) => `stop: ${r}`)];
  const statusPages = {};
  const pageCache = new Map();
  async function page(vendor) {
    if (!pageCache.has(vendor)) pageCache.set(vendor, vendorIncidents(vendor, { fetchImpl, timeoutMs }));
    const p = await pageCache.get(vendor);
    statusPages[vendor] = p.ok
      ? { url: p.url, ok: true, incidents: p.incidents.map((i) => ({ ...i, start: new Date(i.start).toISOString(), end: i.end === null ? null : new Date(i.end).toISOString() })) }
      : { url: p.url, ok: false, reason: p.reason };
    return p;
  }

  for (const f of failures) {
    const label = `${f.spec} > ${f.test}`;
    if (f.vendorErrors.length === 0) {
      f.outcome = 'stop';
      f.reason = 'no vendor error in the failure or its spec’s log window: our integration';
    } else {
      const blocking = f.vendorErrors.find((e) => !isOutageShaped(e));
      if (blocking) {
        f.outcome = 'stop';
        f.reason = stopReason(blocking);
      } else {
        f.outcome = 'warn';
        const covered = [];
        for (const e of f.vendorErrors) {
          const p = await page(e.vendor);
          if (!p.ok) {
            f.outcome = 'stop';
            f.reason = `${e.vendor} status page did not answer (${p.reason}); an outage cannot be shown`;
            break;
          }
          const from = e.ts ?? f.windowMs?.start ?? now;
          const to = e.ts ?? f.windowMs?.end ?? now;
          const incident = coveringIncident(p.incidents, from, to, now);
          const what = e.status !== null ? `${e.status}` : 'timeout';
          if (!incident) {
            f.outcome = 'stop';
            f.reason = `${e.vendor} ${what} with no incident on its status page at that time`;
            break;
          }
          covered.push(`${e.vendor} ${what} during "${incident.name}"`);
        }
        if (f.outcome === 'warn') f.reason = `vendor outage: ${[...new Set(covered)].join('; ')}`;
      }
    }
    reasons.push(`${f.outcome}: ${label}: ${f.reason}`);
  }

  if (failures.length === 0 && runErrors.length === 0 && cypressExit !== 0) {
    reasons.push(`stop: Cypress exited ${cypressExit} with no failed test in its results`);
  }

  const stop = reasons.some((r) => r.startsWith('stop:'));
  const warn = !stop && failures.some((f) => f.outcome === 'warn');
  const verdict = stop ? 'stop' : warn ? 'warn' : 'pass';
  if (verdict === 'pass') reasons.push(`pass: ${results?.totalPassed ?? 0} passed, ${results?.totalPending ?? 0} pending, none failed`);

  return {
    verdict,
    reasons,
    checkedAt: new Date(now).toISOString(),
    cypressExit,
    failures: failures.map(({ windowMs: _w, ...rest }) => rest),
    statusPages,
  };
}

function arg(name, argv) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** CLI: `classify-run.mjs --results <json> --log <file> --out <json> --cypress-exit <n>` */
async function main(argv) {
  const resultsPath = arg('results', argv);
  const logPath = arg('log', argv);
  const outPath = arg('out', argv);
  const cypressExit = Number(arg('cypress-exit', argv) ?? '0');
  if (!resultsPath || !logPath || !outPath) {
    console.error('usage: classify-run.mjs --results <json> --log <file> --out <json> --cypress-exit <n>');
    return 2;
  }
  let results = null;
  if (existsSync(resultsPath)) {
    try {
      results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    } catch {
      results = null;
    }
  }
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const verdict = await classify({ results, logText, cypressExit: Number.isFinite(cypressExit) ? cypressExit : 1 });
  writeFileSync(outPath, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`== e2e-real: verdict ${verdict.verdict.toUpperCase()} (${outPath})`);
  if (verdict.verdict === 'warn') {
    const bar = '!'.repeat(72);
    console.log(bar);
    console.log('WARNING: the run failed on a vendor outage, not on our integration.');
    console.log('The release may go ahead. Each failure and the incident it fell inside:');
    for (const r of verdict.reasons) console.log(`  ${r}`);
    console.log(bar);
  } else {
    for (const r of verdict.reasons) console.log(`  ${r}`);
  }
  return verdict.verdict === 'stop' ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
