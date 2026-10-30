import { defineConfig } from 'cypress';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import seed, { upsert, remove } from './e2e/seed';

/**
 * Cypress config for the REAL-SERVICES run (#1089, operator ruling D3,
 * 2026-10-01). `npm run e2e:real` starts it through `scripts/e2e-real/run.sh`;
 * never start it any other way, because that script is what writes the
 * functions secrets file and refuses an unsafe one.
 *
 * WHAT IS DIFFERENT FROM `cypress.config.ts`. That config is the PR-time suite:
 * auth and Firestore emulators only, callables pinned at a dead port and
 * answered by `cy.intercept`. Here the functions emulator serves the real
 * `mytribe/functions` build, so a callable runs its real handler and its real
 * triggers, and a vendor call (Stripe test mode and the rest) really leaves
 * the machine. Specs live in `cypress/e2e-real/`, so neither suite collects the
 * other's files.
 *
 * TESTS STILL DRIVE AND ASSERT FROM THE UI (2026-09-01 ruling, restated for
 * this run in D3-c). The tasks below set up fixtures, and read the emulator log
 * for the support file's harness condition (our functions' error lines), the
 * server-side twin of the `console.error` signal. No spec asserts on the log.
 */

const PORT = 5174;

/** Written by `run.sh`. Absent when someone ran `cypress open` by hand: every vendor then reads as not configured. */
const REAL_DIR = 'cypress/.real';
const VENDORS_FILE = `${REAL_DIR}/vendors.json`;

/**
 * Which vendors have credentials in this run, as booleans only, never a value.
 * Specs read it synchronously through `Cypress.expose` and skip with a named
 * reason when their vendor is missing.
 */
function vendorAvailability(): Record<string, boolean> {
  if (!existsSync(VENDORS_FILE)) return {};
  const parsed = JSON.parse(readFileSync(VENDORS_FILE, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v === true]));
}

/** The emulator log `run.sh` tees. Empty string when the run was not started by it. */
const SERVER_LOG = process.env.E2E_SERVER_LOG ?? '';

function serverLogSince(since: number): string {
  if (SERVER_LOG === '' || !existsSync(SERVER_LOG)) return '';
  return readFileSync(SERVER_LOG).subarray(since).toString('utf8');
}

/**
 * Structured error lines our own functions wrote (`lib/logger.ts`'s
 * `logEvent`, which prints one JSON object per line). The D3-e verdict rule
 * counts any of these during a test as OUR integration breaking.
 */
function structuredErrors(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /"severity":"(error|critical)"/.test(line));
}

let seeded: Promise<void> | null = null;

/** The auth emulator `run.sh` boots (same port as `e2e/seed.ts`). */
const AUTH_EMULATOR = 'http://127.0.0.1:9399';

/**
 * Cloudinary credentials for this run, or a refusal. Read from the same
 * variables the preflight writes into the functions secrets file, so a spec
 * and the functions it drives talk to the same account. Only called by a spec
 * that has already checked `vendorConfigured('cloudinary')`.
 */
function cloudinaryCredentials(): { cloudName: string; apiKey: string; apiSecret: string } {
  const cloudName = process.env.E2E_CLOUDINARY_CLOUD_NAME ?? '';
  const apiKey = process.env.E2E_CLOUDINARY_API_KEY ?? '';
  const apiSecret = process.env.E2E_CLOUDINARY_API_SECRET ?? '';
  if (cloudName === '' || apiKey === '' || apiSecret === '') {
    throw new Error(
      'E2E_CLOUDINARY_CLOUD_NAME, E2E_CLOUDINARY_API_KEY and E2E_CLOUDINARY_API_SECRET must all be set; refusing to call Cloudinary',
    );
  }
  return { cloudName, apiKey, apiSecret };
}

/** Every Cloudinary upload this suite makes lands under this folder (D3, Cloudinary row). */
const CLOUDINARY_E2E_FOLDER = 'e2e';

/** Cloudinary's signature recipe: sha1 of the params sorted by name, joined with `&`, then the secret. */
function cloudinarySignature(params: Record<string, string>, apiSecret: string): string {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(`${base}${apiSecret}`).digest('hex');
}

export default defineConfig({
  projectId: '2khvut',
  expose: { E2E_VENDORS: vendorAvailability() },
  e2e: {
    baseUrl: `http://127.0.0.1:${PORT}`,
    specPattern: 'cypress/e2e-real/**/*.cy.ts',
    supportFile: 'cypress/support/e2e-real.ts',
    fixturesFolder: false,
    screenshotsFolder: 'cypress/.artifacts/real/screenshots',
    videosFolder: 'cypress/.artifacts/real/videos',
    downloadsFolder: 'cypress/.artifacts/real/downloads',
    video: false,
    screenshotOnRunFailure: true,
    // Same posture as the PR-time suite: a retry turns a flake into a green.
    retries: 0,
    experimentalRunAllSpecs: false,
    // A real callable cold-starts inside the emulator on its first call, which
    // the PR-time stubs never had to wait for.
    defaultCommandTimeout: 15_000,
    setupNodeEvents(on) {
      on('task', {
        /** Seeds the emulator once per run (`e2e/seed.ts`, `E2E_PROJECT_ID` from run.sh). */
        async seedOnce() {
          seeded ??= seed();
          await seeded;
          return null;
        },
        /** See `cypress.config.ts`'s `upsertDoc`; same contract, same Timestamp handling. */
        async upsertDoc({
          collection,
          id,
          doc,
          timestampFields,
        }: {
          collection: string;
          id: string;
          doc: Record<string, unknown>;
          timestampFields?: string[];
        }) {
          const prepared = { ...doc };
          for (const field of timestampFields ?? []) {
            if (field in prepared) prepared[field] = new Date(String(prepared[field]));
          }
          await upsert(collection, id, prepared);
          return null;
        },
        async deleteDoc({ collection, id }: { collection: string; id: string }) {
          await remove(collection, id);
          return null;
        },
        /**
         * The auth emulator's uid for [email]. The seed creates the fixture
         * admin with a uid the emulator picks, and a spec that has to clean up
         * a document keyed by it (`staff/{uid}`) needs that uid. Owner bearer,
         * the same surface `e2e/seed.ts`'s `setPassword` uses.
         */
        async authUid({ email }: { email: string }) {
          const res = await fetch(`${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:lookup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
            body: JSON.stringify({ email: [email] }),
          });
          const json = (await res.json()) as { users?: Array<{ localId?: string }> };
          const uid = json.users?.[0]?.localId;
          if (!res.ok || !uid) throw new Error(`authUid: no auth-emulator account for ${email}`);
          return uid;
        },
        /**
         * Signs one Cloudinary upload into the suite's `e2e/` folder.
         *
         * WHY A TASK SIGNS IT. The admin signs through `/api/cloudinary/sign-upload`,
         * a hosting rewrite to `signCloudinaryUpload` in the admin's own
         * functions codebase (`auntieos-admin/web/functions`). This run serves
         * `mytribe/functions` only, and vite has no such rewrite, so nothing
         * would answer it (#1201 tracks serving it). The spec answers that one
         * request with this signature; the upload itself, the Firestore writes
         * that follow and the image the screen loads are all real. The params
         * signed are exactly the ones `uploadToCloudinary` posts (folder,
         * timestamp, transformation), so Cloudinary verifies the signature the
         * way it would verify the real signer's.
         */
        cloudinarySignUpload({ subfolder }: { subfolder: string }) {
          const { cloudName, apiKey, apiSecret } = cloudinaryCredentials();
          const folder = `${CLOUDINARY_E2E_FOLDER}/${subfolder}`;
          const timestamp = String(Math.floor(Date.now() / 1000));
          const transformation = 'fl_force_strip';
          const signature = cloudinarySignature({ folder, timestamp, transformation }, apiSecret);
          return { cloudName, apiKey, timestamp: Number(timestamp), signature, folder, transformation };
        },
        /**
         * Destroys one asset this suite uploaded. Refuses anything outside the
         * `e2e/` folder, so a wrong id can never reach the operator's library.
         */
        async cloudinaryDestroy({ publicId }: { publicId: string }) {
          if (!publicId.startsWith(`${CLOUDINARY_E2E_FOLDER}/`)) {
            throw new Error(`cloudinaryDestroy: refusing ${publicId}, which is outside ${CLOUDINARY_E2E_FOLDER}/`);
          }
          const { cloudName, apiKey, apiSecret } = cloudinaryCredentials();
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = cloudinarySignature({ public_id: publicId, timestamp }, apiSecret);
          const body = new URLSearchParams({ public_id: publicId, timestamp, api_key: apiKey, signature });
          const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });
          const json = (await res.json().catch(() => ({}))) as { result?: string };
          if (!res.ok || (json.result !== 'ok' && json.result !== 'not found')) {
            throw new Error(`cloudinaryDestroy: ${res.status} ${JSON.stringify(json)}`);
          }
          return json.result;
        },
        /** Byte offset of the emulator log now, so a test reads only its own lines. */
        serverLogOffset() {
          if (SERVER_LOG === '' || !existsSync(SERVER_LOG)) return 0;
          return statSync(SERVER_LOG).size;
        },
        /** Our functions' structured error lines since [since]. */
        serverErrorsSince({ since }: { since: number }) {
          return structuredErrors(serverLogSince(since));
        },
        /**
         * Mints a Stripe TEST-MODE Checkout Session for an invoice, the way
         * `payInvoice` would for a household that opened the pay page and left
         * it open. Fixture setup for the admin-side Stripe path, which has no
         * admin control that mints one. Refuses anything but a test key.
         */
        async stripeTestCheckoutSession({ invoiceId, amountCents }: { invoiceId: string; amountCents: number }) {
          const key = process.env.STRIPE_TEST_SECRET_KEY ?? '';
          if (!/^(sk_test_|rk_test_)/.test(key)) {
            throw new Error('STRIPE_TEST_SECRET_KEY is not a test-mode secret key; refusing to call Stripe');
          }
          const body = new URLSearchParams({
            mode: 'payment',
            success_url: 'http://127.0.0.1:5174/e2e-stripe-success',
            cancel_url: 'http://127.0.0.1:5174/e2e-stripe-cancel',
            'line_items[0][quantity]': '1',
            'line_items[0][price_data][currency]': 'usd',
            'line_items[0][price_data][unit_amount]': String(amountCents),
            'line_items[0][price_data][product_data][name]': `e2e invoice ${invoiceId}`,
            'metadata[invoiceId]': invoiceId,
            'metadata[source]': 'auntieos-admin e2e-real',
          });
          const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });
          const json = (await res.json()) as { id?: string; error?: { message?: string } };
          if (!res.ok || typeof json.id !== 'string') {
            throw new Error(`Stripe refused the fixture session: ${res.status} ${json.error?.message ?? ''}`);
          }
          return json.id;
        },
      });
    },
  },
});
