# Notification Template Ingest — Phase 1 Implementation Plan

> **HISTORICAL, written 2026-05-16. Shipped. Do not run this as a plan.**
> The 34 unchecked boxes below are not open work; the outputs already exist as
> `mytribe/scripts/seedNotificationTemplates.ts`,
> `mytribe/functions/src/notifications/templateParsers.ts` and 44 template dirs
> under `mytribe/seeds/notificationTemplates/`.
>
> Four things in the pre-flight section have expired:
> - **The paths are gone.** Both absolute checkouts it names predate the
>   2026-07-21 monorepo merge. MyTribe is the `mytribe/` prefix of this repo.
> - **`git` IS used.** This repo is under git with CI
>   (`.github/workflows/ci.yml`); the workflow is branch per task, never commit
>   on `main`, land through a PR.
> - **34 catalog keys is now 43** in
>   `mytribe/functions/src/notifications/catalog.ts`.
> - The source template tree it copies from no longer exists outside the repo.

**Goal:** Seed 34 catalog-keyed notification templates × 3 channels (email/sms/push) into Firestore so the MyTribe dispatcher can render Handlebars output for every catalog key with authored on-disk content.

**Architecture:** Move 34 template dirs from `AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates/{key_underscored}/` → `MyTribe/seeds/notificationTemplates/{key.dotted}/`, extract two pure TS parsers (`parseEmailTxt`, `parsePushTxt`) into `functions/src/notifications/templateParsers.ts` so vitest covers them under the existing functions test config, then build `MyTribe/scripts/seedNotificationTemplates.ts` that imports the parsers + the catalog and performs 102 idempotent `.set()` writes (with `--dry-run` and `--key` flags) under a fail-loud summary.

**Tech Stack:** TypeScript 5, ts-node (script execution), firebase-admin 12, vitest 1.x (under `functions/`), node:fs, Handlebars (already used by dispatcher — not invoked by this script).

**Test infra deviation from spec:** spec lists tests at `MyTribe/scripts/__tests__/seedNotificationTemplates.test.ts`. We instead place parser tests at `MyTribe/functions/test/notifications/templateParsers.test.ts` so they run under the existing `functions/vitest.config.ts` (`include: ['test/**/*.test.ts']`) — no new vitest config needed. The seed script imports the parsers from `../functions/src/notifications/templateParsers`. This satisfies the spec's intent (pure parsers testable in isolation) while staying inside the project's existing test layout.

---

## Pre-flight context (read once before Task 1)

- Working directory for all commands below: `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe`. Treat as `$MYTRIBE` throughout.
- Source dirs live outside MyTribe at `/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates/{key_underscored}/`. Treat as `$AUNTIEOS_TPL` throughout.
- 34 catalog keys are authoritative (per `functions/src/notifications/catalog.ts`). Key map (underscored → dotted) below is canonical — copy it verbatim into Task 1.
- `auth.password.reset` is the only catalog key with **no** disk dir (Firebase Auth Console handles it). Script must log-warn-skip, not throw.
- `git` is not used on this project — skip all `git add`/`git commit` steps. Manual file moves only.

### Canonical key map (34 entries, used by Task 1)

```
account_welcome_business        → account.welcome.business
account_welcome_kinfolk         → account.welcome.kinfolk
auth_account_locked             → auth.account.locked
auth_failedLogin_attempts       → auth.failedLogin.attempts
invoice_charge_failed           → invoice.charge.failed
invoice_new                     → invoice.new
invoice_overdue                 → invoice.overdue
invoice_payment_applied         → invoice.payment.applied
invoice_reminder                → invoice.reminder
invoice_updated                 → invoice.updated
kincare_auntie_arrived          → kincare.auntie.arrived
kincare_auntie_departed         → kincare.auntie.departed
kincare_auntie_on_my_way        → kincare.auntie.on_my_way
kincare_booking_cancel          → kincare.booking.cancel
kincare_booking_confirm         → kincare.booking.confirm
kincare_changed                 → kincare.changed
kincare_note_kinfolk            → kincare.note.kinfolk
kincare_report_sent             → kincare.report.sent
kincare_requested               → kincare.requested
kincare_unavailable             → kincare.unavailable
kincare_upcoming_reminder       → kincare.upcoming.reminder
kintale_comment_added           → kintale.comment.added
kintale_published               → kintale.published
marketing_optin                 → marketing.optin
newsletter_announcement         → newsletter.announcement
pet_marked_inactive             → pet.marked.inactive
pets_updated                    → pets.updated
profile_updated                 → profile.updated
quote_accepted                  → quote.accepted
quote_denied                    → quote.denied
rating_submitted_bad            → rating.submitted.bad
rating_submitted_good           → rating.submitted.good
schedule_upcoming_digest        → schedule.upcoming.digest
survey_event                    → survey.event
```

**Note:** key with three dots (`kincare.auntie.on_my_way`) keeps the underscore in `on_my_way` because that token is one catalog segment — confirmed by `grep -n "key: '" functions/src/notifications/catalog.ts | grep "on_my_way"`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `MyTribe/seeds/notificationTemplates/{key.dotted}/` (×34) | Create (via move) | On-disk template source (4 files per dir: `email.html`, `email.txt`, `sms.txt`, `push.txt`) |
| `AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates/` | Delete after move | Removed once new location verified |
| `MyTribe/functions/src/notifications/templateParsers.ts` | Create | Pure functions `parseEmailTxt`, `parsePushTxt` — no I/O, no Firestore |
| `MyTribe/functions/test/notifications/templateParsers.test.ts` | Create | vitest unit tests for both parsers |
| `MyTribe/scripts/seedNotificationTemplates.ts` | Create | CLI entry point, dir iteration, validation, Firestore writes |
| `MyTribe/functions/package.json` | Modify | Add `seed:notif-templates` npm script next to existing `seed:emails` |

---

## Task 1: Move 34 template dirs into MyTribe seeds with dotted-key names

**Files:**
- Source: `$AUNTIEOS_TPL/{key_underscored}/` (×34)
- Destination: `$MYTRIBE/seeds/notificationTemplates/{key.dotted}/` (×34)

- [ ] **Step 1: Create destination root**

Run:
```bash
mkdir -p /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/seeds/notificationTemplates
```

- [ ] **Step 2: Move + rename all 34 dirs in one shell loop**

Run from `/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS`:
```bash
SRC="Tribe_Tails_Pet_Care_Complete_Templates"
DST="/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/seeds/notificationTemplates"
declare -A MAP=(
  [account_welcome_business]=account.welcome.business
  [account_welcome_kinfolk]=account.welcome.kinfolk
  [auth_account_locked]=auth.account.locked
  [auth_failedLogin_attempts]=auth.failedLogin.attempts
  [invoice_charge_failed]=invoice.charge.failed
  [invoice_new]=invoice.new
  [invoice_overdue]=invoice.overdue
  [invoice_payment_applied]=invoice.payment.applied
  [invoice_reminder]=invoice.reminder
  [invoice_updated]=invoice.updated
  [kincare_auntie_arrived]=kincare.auntie.arrived
  [kincare_auntie_departed]=kincare.auntie.departed
  [kincare_auntie_on_my_way]=kincare.auntie.on_my_way
  [kincare_booking_cancel]=kincare.booking.cancel
  [kincare_booking_confirm]=kincare.booking.confirm
  [kincare_changed]=kincare.changed
  [kincare_note_kinfolk]=kincare.note.kinfolk
  [kincare_report_sent]=kincare.report.sent
  [kincare_requested]=kincare.requested
  [kincare_unavailable]=kincare.unavailable
  [kincare_upcoming_reminder]=kincare.upcoming.reminder
  [kintale_comment_added]=kintale.comment.added
  [kintale_published]=kintale.published
  [marketing_optin]=marketing.optin
  [newsletter_announcement]=newsletter.announcement
  [pet_marked_inactive]=pet.marked.inactive
  [pets_updated]=pets.updated
  [profile_updated]=profile.updated
  [quote_accepted]=quote.accepted
  [quote_denied]=quote.denied
  [rating_submitted_bad]=rating.submitted.bad
  [rating_submitted_good]=rating.submitted.good
  [schedule_upcoming_digest]=schedule.upcoming.digest
  [survey_event]=survey.event
)
for u in "${!MAP[@]}"; do
  d="${MAP[$u]}"
  mv "$SRC/$u" "$DST/$d" || { echo "FAILED on $u → $d"; exit 1; }
done
```

Expected stdout: empty. Expected exit: 0.

- [ ] **Step 3: Verify 34 dirs landed with 4 files each**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/seeds/notificationTemplates && \
  COUNT=$(ls -1 | wc -l | tr -d ' ') && \
  echo "dirs: $COUNT" && \
  for d in */; do
    n=$(ls -1 "$d" | wc -l | tr -d ' ')
    if [ "$n" != "4" ]; then echo "MISSING in $d (n=$n)"; fi
  done
```

Expected stdout: `dirs: 34` and **no** `MISSING` lines.

- [ ] **Step 4: Verify the source dir is empty, then remove it**

Run:
```bash
ls /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates/ && \
  rmdir /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates
```

Expected stdout: empty `ls` (no files left), then `rmdir` succeeds silently.

If `ls` shows leftover files: **STOP**. Some key was missed in the map — re-investigate before deleting.

---

## Task 2: TDD `parseEmailTxt`

**Files:**
- Create: `MyTribe/functions/src/notifications/templateParsers.ts`
- Test:   `MyTribe/functions/test/notifications/templateParsers.test.ts`

- [ ] **Step 1: Create test dir + write failing test**

```bash
mkdir -p /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/test/notifications
```

Create `MyTribe/functions/test/notifications/templateParsers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseEmailTxt } from '../../src/notifications/templateParsers';

describe('parseEmailTxt', () => {
  it('parses subject + single-line body', () => {
    const raw = 'Subject: Hello {{name}}\n\nBody line 1';
    expect(parseEmailTxt(raw)).toEqual({
      subject: 'Hello {{name}}',
      body: 'Body line 1',
    });
  });

  it('preserves multi-line body verbatim including internal blank lines', () => {
    const raw = 'Subject: S\n\nLine 1\n\nLine 3\nLine 4';
    expect(parseEmailTxt(raw)).toEqual({
      subject: 'S',
      body: 'Line 1\n\nLine 3\nLine 4',
    });
  });

  it('throws when first line lacks "Subject: " prefix', () => {
    expect(() => parseEmailTxt('No prefix here\n\nbody')).toThrow(/Subject:/);
  });

  it('throws when body is empty (no \\n\\n separator)', () => {
    expect(() => parseEmailTxt('Subject: Only')).toThrow(/body/i);
  });

  it('throws when body after separator is whitespace-only', () => {
    expect(() => parseEmailTxt('Subject: S\n\n   \n  ')).toThrow(/body/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npm test -- templateParsers
```

Expected: FAIL — `Cannot find module '../../src/notifications/templateParsers'` (or similar resolution error).

- [ ] **Step 3: Create parser file with `parseEmailTxt` implementation**

Create `MyTribe/functions/src/notifications/templateParsers.ts`:

```ts
/**
 * Pure parsers for on-disk notification template files.
 * No I/O, no Firestore. Tested in isolation under functions vitest config.
 */

export interface EmailTxtParsed {
  subject: string;
  body: string;
}

export function parseEmailTxt(raw: string): EmailTxtParsed {
  const firstNewline = raw.indexOf('\n');
  const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
  if (!firstLine.startsWith('Subject: ')) {
    throw new Error(`parseEmailTxt: first line must start with "Subject: ", got: ${JSON.stringify(firstLine)}`);
  }
  const subject = firstLine.slice('Subject: '.length).trim();
  const sepIdx = raw.indexOf('\n\n');
  if (sepIdx === -1) {
    throw new Error('parseEmailTxt: missing "\\n\\n" separator — body is empty');
  }
  const body = raw.slice(sepIdx + 2);
  if (body.trim().length === 0) {
    throw new Error('parseEmailTxt: body is empty (whitespace only after separator)');
  }
  return { subject, body };
}
```

- [ ] **Step 4: Run test, verify all 5 pass**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npm test -- templateParsers
```

Expected: `5 passed`.

---

## Task 3: TDD `parsePushTxt`

**Files:**
- Modify: `MyTribe/functions/src/notifications/templateParsers.ts`
- Modify: `MyTribe/functions/test/notifications/templateParsers.test.ts`

- [ ] **Step 1: Append failing tests for `parsePushTxt`**

Append to `MyTribe/functions/test/notifications/templateParsers.test.ts` (above the final `});` of describe block? — no, add a sibling describe). Replace file contents by appending this block at the very end of the file:

```ts
import { parsePushTxt } from '../../src/notifications/templateParsers';

describe('parsePushTxt', () => {
  it('splits at first period: title (trimmed, no period) + body (trimmed)', () => {
    expect(parsePushTxt('Booking confirmed. Tap to see details.')).toEqual({
      title: 'Booking confirmed',
      body: 'Tap to see details.',
    });
  });

  it('handles leading/trailing whitespace via raw.trim()', () => {
    expect(parsePushTxt('  Booking confirmed. Tap to see details.  ')).toEqual({
      title: 'Booking confirmed',
      body: 'Tap to see details.',
    });
  });

  it('splits at FIRST period even when body contains more', () => {
    expect(parsePushTxt('Title. Body has. Multiple periods.')).toEqual({
      title: 'Title',
      body: 'Body has. Multiple periods.',
    });
  });

  it('throws when input has no period', () => {
    expect(() => parsePushTxt('No period here')).toThrow(/period/i);
  });

  it('throws when body after period is empty', () => {
    expect(() => parsePushTxt('Title only.')).toThrow(/body/i);
  });

  it('throws when body after period is whitespace-only', () => {
    expect(() => parsePushTxt('Title.   ')).toThrow(/body/i);
  });
});
```

- [ ] **Step 2: Run tests, verify push tests fail (email tests still pass)**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npm test -- templateParsers
```

Expected: `parseEmailTxt` 5 pass, `parsePushTxt` 6 fail with `parsePushTxt is not a function` (or import error).

- [ ] **Step 3: Add `parsePushTxt` to parser module**

Append to `MyTribe/functions/src/notifications/templateParsers.ts`:

```ts
export interface PushTxtParsed {
  title: string;
  body: string;
}

export function parsePushTxt(raw: string): PushTxtParsed {
  const trimmed = raw.trim();
  const periodIdx = trimmed.indexOf('.');
  if (periodIdx === -1) {
    throw new Error(`parsePushTxt: no period found in input: ${JSON.stringify(trimmed)}`);
  }
  const title = trimmed.slice(0, periodIdx).trim();
  const body = trimmed.slice(periodIdx + 1).trim();
  if (body.length === 0) {
    throw new Error('parsePushTxt: body is empty after first period');
  }
  return { title, body };
}
```

- [ ] **Step 4: Run all parser tests, verify 11 pass**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npm test -- templateParsers
```

Expected: `11 passed`.

- [ ] **Step 5: Run the full functions test suite to confirm no regressions**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npm test
```

Expected: previously-passing tests stay green, total count = prior + 11.

---

## Task 4: Seed script — CLI scaffold, catalog load, dir iteration (no Firestore yet)

**Files:**
- Create: `MyTribe/scripts/seedNotificationTemplates.ts`

- [ ] **Step 1: Create the script with CLI parsing + catalog import + dir scan + dry-run print path only**

Create `MyTribe/scripts/seedNotificationTemplates.ts`:

```ts
import * as admin from 'firebase-admin';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { listNotificationKeys } from '../functions/src/notifications/catalog';
import { parseEmailTxt, parsePushTxt } from '../functions/src/notifications/templateParsers';

interface Args {
  dryRun: boolean;
  onlyKey: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, onlyKey: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--key') {
      const v = argv[i + 1];
      if (!v) throw new Error('--key requires a value');
      args.onlyKey = v;
      i += 1;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

interface PlannedWrite {
  key: string;
  emailDoc: { subject: string; body: string; html: string };
  smsDoc: { text: string };
  pushDoc: { title: string; body: string };
}

function loadDir(dir: string, key: string): PlannedWrite {
  const need = ['email.html', 'email.txt', 'sms.txt', 'push.txt'];
  for (const f of need) {
    if (!existsSync(join(dir, f))) {
      throw new Error(`seedNotificationTemplates: ${key}: missing required file ${f} in ${dir}`);
    }
  }
  const emailHtml = readFileSync(join(dir, 'email.html'), 'utf8');
  const emailTxt = readFileSync(join(dir, 'email.txt'), 'utf8');
  const smsTxt = readFileSync(join(dir, 'sms.txt'), 'utf8');
  const pushTxt = readFileSync(join(dir, 'push.txt'), 'utf8');

  const { subject, body } = parseEmailTxt(emailTxt);
  const { title, body: pushBody } = parsePushTxt(pushTxt);
  const smsText = smsTxt.trim();
  if (smsText.length === 0) {
    throw new Error(`seedNotificationTemplates: ${key}: sms.txt is empty`);
  }

  return {
    key,
    emailDoc: { subject, body, html: emailHtml },
    smsDoc: { text: smsText },
    pushDoc: { title, body: pushBody },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seedsRoot = resolve(__dirname, '..', 'seeds', 'notificationTemplates');
  const catalogKeys = new Set(listNotificationKeys());

  const dirNames = readdirSync(seedsRoot).filter((n) =>
    statSync(join(seedsRoot, n)).isDirectory(),
  );

  let processed = 0;
  let skipped = 0;
  const skippedKeys: string[] = [];

  for (const dirName of dirNames) {
    if (!catalogKeys.has(dirName)) {
      throw new Error(`seedNotificationTemplates: dir ${dirName} is not a catalog key`);
    }
    if (args.onlyKey && dirName !== args.onlyKey) continue;
    const planned = loadDir(join(seedsRoot, dirName), dirName);
    console.log(`[plan] ${dirName}: email(subject=${JSON.stringify(planned.emailDoc.subject)}), sms(${planned.smsDoc.text.length}ch), push(title=${JSON.stringify(planned.pushDoc.title)})`);
    processed += 1;
  }

  for (const k of catalogKeys) {
    const hasDir = dirNames.includes(k);
    if (!hasDir) {
      console.warn(`[skip] catalog key '${k}' has no on-disk template dir`);
      skippedKeys.push(k);
      skipped += 1;
    }
  }

  console.log(`\nsummary: processed=${processed} skipped=${skipped} dryRun=${args.dryRun}`);
  if (skippedKeys.length > 0) {
    console.log(`skipped catalog keys: ${skippedKeys.join(', ')}`);
  }

  if (args.dryRun) {
    console.log('dry-run complete — no Firestore writes');
    return;
  }

  // Firestore writes wired in Task 5
  throw new Error('Firestore write path not yet implemented — re-run with --dry-run');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run script with `--dry-run` to exercise the load + plan path against all 34 dirs**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npx ts-node --project ../scripts/tsconfig.json ../scripts/seedNotificationTemplates.ts --dry-run
```

Expected stdout:
- 34 lines starting with `[plan] <key>: email(subject=...), sms(<n>ch), push(title=...)`
- 1 line `[skip] catalog key 'auth.password.reset' has no on-disk template dir`
- `summary: processed=34 skipped=1 dryRun=true`
- `skipped catalog keys: auth.password.reset`
- `dry-run complete — no Firestore writes`
- Exit code 0

If any `[plan]` line is missing, or any parser throws, **STOP** and inspect that file before continuing — fail-loud policy: do not patch the parser around bad content; investigate.

- [ ] **Step 3: Run with `--key kincare.booking.confirm` to confirm single-key path**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npx ts-node --project ../scripts/tsconfig.json ../scripts/seedNotificationTemplates.ts --dry-run --key kincare.booking.confirm
```

Expected stdout:
- 1 `[plan]` line for `kincare.booking.confirm`
- All other catalog keys (33 + `auth.password.reset`) listed under `[skip]` lines — wait, no: `--key` filters the processing loop but the skipped-keys loop runs over the full catalog. Reconsider: with `--key` set, the skip warnings would fire for every other key, which is noise. **Fix before running.**

- [ ] **Step 4: Refine `--key` so it suppresses the skipped-catalog-keys warning loop**

Edit `MyTribe/scripts/seedNotificationTemplates.ts`. Find:

```ts
  for (const k of catalogKeys) {
    const hasDir = dirNames.includes(k);
    if (!hasDir) {
      console.warn(`[skip] catalog key '${k}' has no on-disk template dir`);
      skippedKeys.push(k);
      skipped += 1;
    }
  }
```

Replace with:

```ts
  if (args.onlyKey === null) {
    for (const k of catalogKeys) {
      const hasDir = dirNames.includes(k);
      if (!hasDir) {
        console.warn(`[skip] catalog key '${k}' has no on-disk template dir`);
        skippedKeys.push(k);
        skipped += 1;
      }
    }
  }
```

- [ ] **Step 5: Re-run Step 3 command**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npx ts-node --project ../scripts/tsconfig.json ../scripts/seedNotificationTemplates.ts --dry-run --key kincare.booking.confirm
```

Expected stdout:
- 1 `[plan]` line for `kincare.booking.confirm`
- **no** `[skip]` lines
- `summary: processed=1 skipped=0 dryRun=true`
- `dry-run complete — no Firestore writes`
- Exit code 0

- [ ] **Step 6: Re-run full `--dry-run` from Step 2 to confirm refactor still passes the all-keys case**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npx ts-node --project ../scripts/tsconfig.json ../scripts/seedNotificationTemplates.ts --dry-run
```

Expected: same as Step 2 (34 `[plan]`, 1 `[skip]`, `processed=34 skipped=1`).

---

## Task 5: Wire Firestore writes (3 docs per processed key)

**Files:**
- Modify: `MyTribe/scripts/seedNotificationTemplates.ts`

- [ ] **Step 1: Replace the placeholder `throw` with admin init + write loop**

Edit `MyTribe/scripts/seedNotificationTemplates.ts`. Find:

```ts
  if (args.dryRun) {
    console.log('dry-run complete — no Firestore writes');
    return;
  }

  // Firestore writes wired in Task 5
  throw new Error('Firestore write path not yet implemented — re-run with --dry-run');
}
```

Replace with:

```ts
  if (args.dryRun) {
    console.log('dry-run complete — no Firestore writes');
    return;
  }

  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = admin.firestore();
  const stamp = (): admin.firestore.FieldValue => admin.firestore.FieldValue.serverTimestamp();

  let seeded = 0;
  let errors = 0;
  const errorKeys: string[] = [];

  for (const dirName of dirNames) {
    if (args.onlyKey && dirName !== args.onlyKey) continue;
    try {
      const planned = loadDir(join(seedsRoot, dirName), dirName);
      await db.doc(`emailTemplates/${dirName}`).set({
        subject: planned.emailDoc.subject,
        body: planned.emailDoc.body,
        html: planned.emailDoc.html,
        updatedAt: stamp(),
      });
      await db.doc(`smsTemplates/${dirName}`).set({
        text: planned.smsDoc.text,
        updatedAt: stamp(),
      });
      await db.doc(`pushTemplates/${dirName}`).set({
        title: planned.pushDoc.title,
        body: planned.pushDoc.body,
        updatedAt: stamp(),
      });
      seeded += 1;
      console.log(`[seeded] ${dirName} (email + sms + push)`);
    } catch (err) {
      errors += 1;
      errorKeys.push(dirName);
      console.error(`[error] ${dirName}: ${(err as Error).message}`);
      throw err;
    }
  }

  console.log(`\nfinal: seeded=${seeded} skipped=${skipped} errors=${errors}`);
  if (errors > 0) {
    console.log(`error keys: ${errorKeys.join(', ')}`);
    process.exit(1);
  }
}
```

Note the fail-loud `throw err` inside the catch — this aborts the batch on the first failure, matching the spec's "abort remaining batch (no silent partial seed)". The `errorKeys` track exists for the summary if you later switch to a continue-on-error mode, but for Phase 1 the throw stops execution.

- [ ] **Step 2: Smoke-test the no-flag failure path (no creds set → expect Firestore to surface auth error)**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  unset GOOGLE_APPLICATION_CREDENTIALS GCLOUD_PROJECT && \
  npx ts-node --project ../scripts/tsconfig.json ../scripts/seedNotificationTemplates.ts --key kincare.booking.confirm
```

Expected: process aborts loudly with an admin-SDK auth error (e.g. `Could not load the default credentials`). Exit code 1.

If it silently succeeds, **STOP** — something is mis-pointing at a local emulator. Investigate before proceeding to Step 3.

- [ ] **Step 3: Lint-check the script compiles under transpile-only ts-node**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npx tsc --noEmit -p ../scripts/tsconfig.json
```

Expected: no output (clean compile) or only the existing `scripts/tsconfig.json` `include` warning. If new errors appear that reference `seedNotificationTemplates.ts`, fix before continuing.

---

## Task 6: Add npm script handle

**Files:**
- Modify: `MyTribe/functions/package.json`

- [ ] **Step 1: Add `seed:notif-templates` next to existing `seed:emails`**

Edit `MyTribe/functions/package.json`. Find:

```json
    "seed:emails": "ts-node --project ../scripts/tsconfig.json ../scripts/seedEmailTemplates.ts"
```

Replace with:

```json
    "seed:emails": "ts-node --project ../scripts/tsconfig.json ../scripts/seedEmailTemplates.ts",
    "seed:notif-templates": "ts-node --project ../scripts/tsconfig.json ../scripts/seedNotificationTemplates.ts"
```

- [ ] **Step 2: Verify both npm-script invocations resolve**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npm run seed:notif-templates -- --dry-run --key kincare.booking.confirm
```

Expected: same single-key dry-run output as Task 4 Step 5. Exit code 0.

---

## Task 7: Final all-keys dry-run sanity pass

**Files:** (none — verification only)

- [ ] **Step 1: Run full dry-run via npm script**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  npm run seed:notif-templates -- --dry-run | tee /tmp/seed-notif-dryrun.log
```

Expected last lines of stdout:
```
summary: processed=34 skipped=1 dryRun=true
skipped catalog keys: auth.password.reset
dry-run complete — no Firestore writes
```

- [ ] **Step 2: Grep the log to confirm every catalog key (minus `auth.password.reset`) appears in a `[plan]` line**

Run:
```bash
grep -c '^\[plan\]' /tmp/seed-notif-dryrun.log
```

Expected stdout: `34`.

- [ ] **Step 3: Confirm functions test suite still green**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npm test
```

Expected: all tests pass, including the new 11 parser tests.

---

## Task 8: Production ingest (operator-gated — pause for explicit approval)

**Files:** (none — deployment action only)

- [ ] **Step 1: Confirm with the user that they want to write to prod Firestore**

Pause. Ask the user: "Dry-run is clean — 34 keys, 102 planned writes. Ready to write to prod Firestore (`auntieos-ttpc`)? Confirm before I run the unflagged command."

Do not proceed without explicit confirmation. Per `feedback_no_assumptions`: never assume infrastructure.

- [ ] **Step 2: Locate service-account creds**

Run:
```bash
ls -la /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json
```

Expected: file exists, readable. If missing, **STOP** and ask the user where the prod service-account JSON lives — do not fabricate or use a different cred.

- [ ] **Step 3: Run single-key prod write as a canary**

Run (one line):
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  GOOGLE_APPLICATION_CREDENTIALS=/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json \
  GCLOUD_PROJECT=auntieos-ttpc \
  npm run seed:notif-templates -- --key kincare.booking.confirm --allow-prod
```

Expected stdout:
```
[plan] kincare.booking.confirm: email(subject="It is official: I have {{kinName}} on my books"), sms(<n>ch), push(title="It is official: I have {{kinName}} on my books")
[seeded] kincare.booking.confirm (email + sms + push)

final: seeded=1 skipped=0 errors=0
```

Exit code 0.

- [ ] **Step 4: Verify the three docs landed in Firestore**

Use the Firebase MCP tool `firestore_get_document` (or the Firestore Console) to confirm these three paths exist with current `updatedAt`:
- `emailTemplates/kincare.booking.confirm`
- `smsTemplates/kincare.booking.confirm`
- `pushTemplates/kincare.booking.confirm`

If any of the three is missing, **STOP** — investigate before running the full batch.

- [ ] **Step 5: Run the full batch (102 writes across 34 keys)**

Run:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && \
  GOOGLE_APPLICATION_CREDENTIALS=/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json \
  GCLOUD_PROJECT=auntieos-ttpc \
  npm run seed:notif-templates -- --allow-prod 2>&1 | tee /tmp/seed-notif-prod.log
```

Expected last lines:
```
final: seeded=34 skipped=1 errors=0
```

Exit code 0. The `[seeded]` lines should number 34 (including the canary key — `.set()` is idempotent, re-writing is safe and re-stamps `updatedAt`).

If any `[error]` line appears, the script will have aborted. Read the error, fix the underlying file, and re-run — the previously-seeded keys remain in Firestore from the partial run (idempotent, so safe to re-run).

- [ ] **Step 6: Spot-verify three random catalog keys ended up in Firestore**

Use Firebase MCP `firestore_get_document` against three keys you didn't write in the canary, e.g.:
- `pushTemplates/marketing.optin`
- `emailTemplates/invoice.overdue`
- `smsTemplates/quote.accepted`

Confirm each doc exists with non-empty fields and a recent `updatedAt`.

- [ ] **Step 7: Update handoff + memory**

Write the prod-ingest result to the active handoff doc (most-recent `HANDOFF_*.md` at AuntieOS root per `reference_handoff_doc`) — `seeded=34 skipped=1 (auth.password.reset)`, and update `project_notification_template_ingest.md` memory: mark Phase 1 closed, note Phase 2 (trigger parity audit) as next.

---

## Out of scope (deferred — do not implement in this plan)

- Phase 2 trigger parity audit (grep MyTribe enqueue sites vs catalog keys → gap list → new spec)
- Operator UI for template editing (Firestore Console suffices)
- `notificationTemplateBindings` overrides
- `auth.password.reset` catalog row: mark external in Phase 2 (Firebase Auth Console handles)
- Migrating existing 9 `seedEmailTemplates` ops templates into the new layout (different schema — separate concern)

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — Move (Task 1) · Seed script CLI+behavior (Tasks 4 + 5) · `parseEmailTxt` (Task 2) · `parsePushTxt` (Task 3) · tests (Tasks 2 + 3) · data flow (Task 7 + Task 8) · error handling (Task 5 catch+throw, Task 4 dir-validation throws, Task 8 canary gate) · out-of-scope (preserved verbatim).
- **Test location deviation** vs spec is documented in the header rationale.
- **Type consistency:** `EmailTxtParsed{subject,body}` and `PushTxtParsed{title,body}` are the only exported parser types — both used unchanged by `loadDir` and the Firestore write payloads in Task 5. Document field names (`subject/body/html/text/title`) match the dispatcher reader contract verbatim per spec.
- **No placeholders:** every code/command step contains the full literal content; the `--key` refinement quirk is caught and fixed inside Task 4 rather than left as a TODO.
