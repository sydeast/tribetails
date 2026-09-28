# Secrets

Server secrets, client build config (`VITE_*`), and what the release does when one is missing or unreadable. The ruling is D-2026-08-24-SECRET-MANAGER in `docs/DECISIONS.md`.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

## Secrets

Server secrets live in Google Secret Manager, never in the repo, never in
`.env`. Run from `mytribe/`, which prompts so the value stays out of your shell
history:

```bash
firebase functions:secrets:set SECRET_NAME --project auntieos-ttpc
```

**Setting a secret does nothing until a function declares it** in its
`secrets: [...]` array and is redeployed. This has already gone wrong: a setup
doc told the operator to set a `GOOGLE_CALENDAR_ID` no function ever read, so
the setup looked complete and did nothing. Add a test that reads the function's
`__endpoint` and asserts the name is declared.

**And setting a secret does nothing until the next deploy, every time, not just
the first.** These are gcfv2 functions, which pin the secret VERSION resolved at
deploy time. `functions:secrets:set` mints version N+1 and binds it to nothing;
the running function keeps reading version N until a deploy resolves the name
again. Rotating a value without redeploying leaves the old one live, and setting
a value for the first time leaves the runtime reading nothing at all. Release
step 5 checks for this now (see the deploy section).

By hand, **redeploy the functions that declare the secret, not the codebase.**
The version pin is per function, so `--only functions:mytribe` spends half an
hour and a fleet's worth of the 60-per-minute mutation budget to move one
binding. Get the names from the pairs listing below, then:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy \
  --only "functions:mytribe:NAME1,functions:mytribe:NAME2"
```

The `functions:mytribe:` prefix on each name is mandatory; a bare name matches
nothing and deploys nothing without saying so. Fall back to the whole codebase
only when the name cannot be attributed to a subset.

Two ways to read the declarations out of the built artifact rather than guessing
from source, which cannot see arrays built from spreads:

```bash
node scripts/declared-secrets.js                             # every declared name
node scripts/declared-secrets.js --by-function GOOGLE_OAUTH  # which function gets what
```

The first answers "will the deploy validate". The second answers the question an
operator actually arrives with, which is "I set it and the feature still fails,
so which function was supposed to receive it": a secret is mounted per function,
so the binding is a pair, and a name in the flat list can still be absent from
the one function that reads it. Neither can tell you whether the secret has a
VALUE or whether the DEPLOYED function carries the declaration; both live in the
project. For those: `gcloud secrets list` and
`gcloud functions describe <name> --gen2 --region us-central1`.

### Client build config (`VITE_*`) comes from the store too

`VITE_*` is different by mechanism, not by policy. Vite inlines
`import.meta.env.VITE_*` into the bundle at build time, so whatever the build
machine holds is what every browser downloads. That is a reason to put only
public client keys in these variables. It is not a reason to keep them on one
laptop, which is where they lived until 2026-08-24. Nothing in the repo listed
which variables existed either: `VITE_ADMIN_APPCHECK_SITE_KEY` appeared in
neither `.env.example`, so a fresh clone had no way to find out it existed.

They are declared in `scripts/client-secrets.mjs`, one row per variable per app,
and release step 0c fills them from Secret Manager before anything is built:

```bash
node scripts/client-secrets.mjs --list    # what each app declares
node scripts/client-secrets.mjs --check   # resolve it; refuse if one is empty
```

**Two namespaces, and they are not interchangeable.** `ADMIN_WEB_SENTRY_DSN` is
the name of the SECRET. `VITE_SENTRY_DSN` is the name of the BUILD variable the
app reads. `client-secrets.mjs` maps one to the other, and it is the only thing
that does. A secret created under a `VITE_`-prefixed name is a value nothing
ever fetches, which has already happened once: the admin App Check site key was
first stored as `VITE_ADMIN_APPCHECK_SITE_KEY` and had to be recreated as
`ADMIN_WEB_APPCHECK_SITE_KEY`. `--list` prints both columns, and every refusal
names both.

**To store a value**, once, per secret:

```bash
gcloud secrets create ADMIN_WEB_SENTRY_DSN --project auntieos-ttpc \
  --replication-policy=automatic
printf %s "<the value>" | gcloud secrets versions add ADMIN_WEB_SENTRY_DSN \
  --project auntieos-ttpc --data-file=-
```

Unlike a function secret, no redeploy pins a version here: the next release
reads `latest` at build time, so a rotated value ships with the next build and
nothing has to be rebound.

**Precedence**, which is Vite's own and not something the release invents:

| rank | source | who sets it |
| --- | --- | --- |
| 1 | `process.env` | an explicit inline override, and how CI passes a repo secret in |
| 2 | `<app>/.env.production.local` | the release, from Secret Manager |
| 3 | `<app>/.env.local`, `<app>/.env` | you, on your own machine |

Rank 2 is written at step 0c and removed when the release finishes, and only a
production build reads it. `vite` dev and vitest never do. So the store wins a
release build while local development keeps working with no gcloud, no
credentials and no network.

### What stops a release and what only gets named

A release **refuses** when a REQUIRED variable resolves to nothing, when its
stored secret exists and the latest version is empty, or when Secret Manager
never answered for it at all (see the timeout paragraph below). It names the
variable, the secret and the command that fixes it. Two are required today:
`ADMIN_WEB_APPCHECK_SITE_KEY` and `PORTAL_WEB_MAPBOX_PUBLIC_TOKEN`. Both back a
feature that is live and that fails invisibly without them: App Check reads
`unconfigured`, and the visit route silently drops to the SVG polyline.

Everything else is **named and shipped**. Both Sentry DSNs are optional, and
that is a deliberate reading of the actual state rather than an oversight:
checked on 2026-08-24, `auntieos-admin/.env` and `mytribe/web/.env.local` both
carry an empty `VITE_SENTRY_DSN` and no other source has one. Web Sentry has
never been switched on for either app, `lib/sentry.ts` treats a blank DSN as an
ordinary state, and nothing depends on it. A release that refused would be
blocking on a capability the product does not use, which is the same defect as a
missing gate pointed the other way. So every release warns about them, by name,
and ships. Turning Sentry on is a decision worth making; it is not this script's
to force.

`RELEASE_SKIP_CLIENT_SECRETS=1` skips the check entirely if you know what is
missing.

**Every gcloud call in this step carries a 30-second timeout.** On 2026-09-13
release step 0c sat silent for 16 minutes: a gcloud child had one socket in
SYN_SENT to Google over IPv6 (a VPN was installed; IPv4 answered instantly),
and nothing printed, so the hang read as an auth prompt (#839). It now prints a
line per secret as it fetches, and `CLIENT_SECRETS_GCLOUD_TIMEOUT_MS` (a
positive integer, milliseconds) overrides the default on a network known to be
slower. Whether it is the LIST call or one secret's ACCESS call that times out,
every affected variable is marked **unreadable, never missing**: reporting it
as missing would tell you to create a secret that may already exist. A
REQUIRED value that is unreadable refuses with its own exit code, 4, and
release.sh says the store did not answer rather than "has no value". An
OPTIONAL value that is unreadable warns instead, the same call the declaration
already makes for a value confirmed absent. Either way the advice is the same
IPv4/IPv6 check, never `gcloud secrets create`:

```bash
curl -4 -sS -o /dev/null -w '%{http_code}\n' https://secretmanager.googleapis.com
curl -6 -sS -o /dev/null -w '%{http_code}\n' https://secretmanager.googleapis.com
```

After the first secret's ACCESS call times out, the rest are marked unreadable
without being spawned: a dead route stays dead for the whole run, so the worst
case is one 30-second wait, not one per secret.

**"Could not be read" is not "is missing", so check which one you got
before creating anything (#850).** When gcloud is not installed, has no
credentials, or lists nothing at all, the step still takes values from the
apps' own `.env` files, but a required value that is not there either is
reported as `could not be read`, with the reason (`gcloud is not installed`,
`no usable credentials` plus gcloud's own line, or `listed no secrets at all`).
It refuses with exit 4. The advice is the auth check, never
`gcloud secrets create`:

```bash
gcloud auth list
gcloud secrets list --project auntieos-ttpc --limit 1
```

If the first shows no active account or the second errors or prints nothing,
the fix is signing this machine in (`gcloud auth login`), and the secrets are
probably fine. Only `REFUSED: the web apps declare client build config that has
no value ... is missing` means the store answered and does not hold the value,
and only that message prints `gcloud secrets create`. The nightly preflight
printed `is missing` on 2026-09-12, 13 and 14 for three secrets that all
existed, because its runner had no Google credentials, and they were
re-created for nothing.

**A release does not build from your `.env` when the store cannot be read.**
The `.env` fallback above applies to `node scripts/client-secrets.mjs --check`
only. Release step 0c runs `--write`, and there a required value that only a
local `.env` holds is refused with exit 4, `REFUSED: Secret Manager could not
confirm these REQUIRED values`, because the store never confirmed it. Optional
values held locally warn. Sign in and re-run, or, if you have checked the local
values and mean to ship them, `RELEASE_SKIP_CLIENT_SECRETS=1 npm run deploy`.

**A secret the store listed but would not hand over** is `could not be read`
too, with gcloud's reason and advice for that secret, never
`gcloud secrets create`: `PERMISSION_DENIED` names
`roles/secretmanager.secretAccessor` and
`gcloud secrets get-iam-policy <name> --project auntieos-ttpc`; a disabled or
destroyed latest version (`FAILED_PRECONDITION`) points at
`gcloud secrets versions list <name> --project auntieos-ttpc` and adding a
version; `NOT_FOUND` means it has no versions or was deleted between the two
calls. Any account email in gcloud's text is printed as `<account>`.

Two names are deliberately outside all of this, and **neither is in Secret
Manager, so do not go looking for them there**. `VITE_SENTRY_RELEASE` is derived:
step 0c sets it to the commit being released, because a release tag maintained by
hand names the last release someone remembered to edit it for. There is no
secret behind it and nothing to create. `VITE_APPCHECK_DEBUG_TOKEN` is
per-developer and bypasses App Check attestation. It is the one genuinely
sensitive name in the set, it stays in your own `.env.local`, and it must never
be stored centrally or set in CI.

**One trap on the Mapbox token.** `PORTAL_WEB_MAPBOX_PUBLIC_TOKEN` must hold the
**URL-restricted** `web-maps-public` token, not the `MAPBOX_PUBLIC_TOKEN` sitting
in `~/.gradle/gradle.properties`. That one is the **unrestricted mobile** token,
and the #520 design says in as many words why there are two: Mapbox validates URL
restrictions from a browser `Referer` and answers a mobile SDK request `403`, so
one restricted token cannot serve all three surfaces. The split is also what
bounds the damage. This variable is compiled into a bundle any browser can read,
so putting the unrestricted token here publishes a credential whose only
protection was that it was not published.

CI previews get these from **repo secrets named after the Secret Manager
secrets** (`.github/workflows/preview.yml`), because a GitHub runner has no
gcloud and a fork PR must never be handed credentials. An unset repo secret
builds the preview anyway and the job warns which values were empty.

```bash
gh secret set PORTAL_WEB_MAPBOX_PUBLIC_TOKEN --repo sydeast/tribetails
```

The `AIzaSy...` values in the repo are Firebase Web API keys, public by design.
Access is controlled by Firestore rules and App Check.
