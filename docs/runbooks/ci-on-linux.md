# Moving CI off the Mac and onto the media server

> **Retired. Do not follow this procedure.** The repo went public on
> 2026-09-11, GitHub-hosted runners became free, and the self-hosted runners
> were stopped that day. CI runs on GitHub-hosted `ubuntu-latest`. Do not
> register or start a self-hosted runner, and do not set the `CI_RUNNER`
> repository variable: every job still reads `vars.CI_RUNNER || 'ubuntu-latest'`,
> so setting it would move CI back onto a machine. The rest of this page is
> kept as the record of what was tried.

Written 2026-08-27, after two Cypress jobs were refused outright by GitHub over
billing. The target is `hanasamku2`, the media server: Debian, `x86_64`.

Nothing here has been executed. Registering a runner needs a token only the
operator can mint, so this is a procedure to follow rather than a change to
merge.

## Why bother

1. **It ends the GitHub-hosted dependency.** On 2026-08-27 both Cypress jobs
   failed in two seconds having run nothing, with GitHub's own annotation:
   *"The job was not started because recent account payments have failed or your
   spending limit needs to be increased."* This is the SECOND time. `ci.yml`'s
   own header records the first, when "three PRs sat with a red X against zero
   executed steps". The answer then was to move the rest of the jobs to
   self-hosted runners; the two Cypress jobs simply predated that decision and
   were still pinned to `ubuntu-latest`.
2. **The Mac gets its evenings back.** A full run is 13 jobs and roughly 39
   job-minutes, the longest single job 6 minutes. That load currently lands on
   the machine the operator is trying to work on.

## A correction, which matters more than the rest of this document

**Issue #620 is NOT fixed by moving CI, and the cause it states is wrong.**

#620 says three runners corrupt local Gradle builds by sharing `~/.gradle` with
them. That was true when #588 was written. It stopped being true on 2026-08-24,
when commit `55b30ae` ("Give every CI Gradle job a Gradle home of its own") gave
all three Gradle jobs their own `GRADLE_USER_HOME`. Verified rather than
assumed: every job in `ci.yml` that invokes `gradlew` carries that isolation
step, and there are exactly three.

So the `~/.gradle` corruption seen on 2026-08-26 was not written by CI. The
other Gradle writers on that machine are local builds, including this agent's
own runs across several worktrees at the default Gradle home on the afternoon
the cache broke. The fix is to isolate LOCAL builds, which is #620's own first
option, and it is needed whether or not CI ever moves.

Recorded here because the CI move was first argued on the strength of closing
#620, and it does not close it.

## Architecture, and why the Pi 5 is the wrong box

`hanasamku2` reports `x86_64`; `wallcalendar` (the Pi 5) reports `aarch64`.

**Checked on 2026-08-27 by fetching the artifacts, not by reading
documentation:**

| Tool the CI needs | linux arm64 | How it was checked |
|---|---|---|
| Node 22 | yes | `nodejs.org` arm64 tarball, 200 |
| Playwright Chromium 1.62 | yes | Playwright CDN `chromium-linux-arm64.zip`, 200 |
| Cypress 15.21.1 | yes | `cdn.cypress.io/desktop/15.21.1/linux-arm64/cypress.zip`, 200 |
| Java 17 and 21 | yes | Temurin publishes aarch64 |
| **`aapt2`** | **NO** | Google Maven serves `-linux.jar` (x86_64), `-osx.jar` and `-windows.jar`. Both `-linux-aarch64` and `-linux-arm64` return 404 |

`aapt2` is the Android resource compiler, so on the Pi these two jobs could not
run as written: `Android unit tests`, and the android target of
`Portal shared (jvm + android unit + js)`. The workarounds are a community-built
`aapt2` behind `android.aapt2FromMavenOverride`, or an x86_64 emulation layer.
Neither is worth adopting when an x86_64 machine is already available.

The Pi remains useful as a SECOND runner for the eleven jobs that do not touch
Android, if more parallelism is ever wanted. It is not needed for this.

## Disk, which is the real constraint on this machine

`hanasamku2` on 2026-08-27:

```
/dev/sda2       233G  215G  5.7G  98% /
/dev/sdb1        22T   21T  1.9T  92% /mnt/hana3
/dev/sdc1       3.7T  2.3T  1.5T  62% /media/hanasamku/easystore
```

**Nothing about this install may land on `/`.** 5.7 GB free is less than the
Android SDK alone, and a default runner install would put the workspace, the
Gradle caches, `~/.npm`, `~/.cache/ms-playwright` and `~/.cache/Cypress` all
under `$HOME` on that filesystem. The first Android job would fill it, and a full
root filesystem takes the media server down with it, not just CI.

Rough budget for two runners: Android SDK and platform tools ~12 GB, Gradle
caches 5 to 10 GB per runner, a `node_modules` tree per runner workspace at a
few GB, Playwright Chromium and the Cypress binary about 500 MB each, Firebase
emulator JARs a few hundred MB. Call it 40 to 60 GB, growing.

Put the whole thing on a data mount. `/mnt/hana3` has 1.9 TB free and is the
obvious home; `easystore` would also do, though if it is USB-attached the Gradle
and npm caches will feel it. Then redirect every cache that would otherwise
default into `$HOME`, in the runner's own `.env`:

```
ANDROID_HOME=/mnt/hana3/ci/android-sdk
GRADLE_USER_HOME=/mnt/hana3/ci/runner-1/.gradle-home
NPM_CONFIG_CACHE=/mnt/hana3/ci/runner-1/.npm
PLAYWRIGHT_BROWSERS_PATH=/mnt/hana3/ci/playwright
CYPRESS_CACHE_FOLDER=/mnt/hana3/ci/cypress
XDG_CACHE_HOME=/mnt/hana3/ci/runner-1/.cache
```

`ANDROID_HOME`, Playwright and Cypress can be shared between runners; the Gradle
and npm caches should not be, for the reason #588 exists.

Check afterwards, and again after the first full run:

```bash
df -h / /mnt/hana3
```

RAM looks like roughly 16 GB (the `tmpfs` entries report 7.7 G, which is half).
That is comfortable for two runners and tight for three once Gradle daemons are
involved, so start with two.

## Procedure, on `hanasamku2`

### 1. Prerequisites

Less than expected. The workflow uses `actions/setup-node@v7` and
`actions/setup-java@v5`, and those actions download and install their own
toolchains on a self-hosted runner. **Do not apt-install Node or Java**; Debian
bookworm has no `openjdk-21` package and it does not need one.

```bash
sudo apt-get update
sudo apt-get install -y git curl tar
```

Two things do need attention:

- **Playwright's browser dependencies.** The admin e2e job runs
  `playwright install --with-deps chromium`, and `--with-deps` shells out to
  `apt-get`.

  **Install those libraries ONCE BY HAND. Do not give the runner user
  passwordless sudo.** A self-hosted runner executes whatever a branch tells it
  to, so passwordless sudo on this box turns any pull request into root on the
  machine holding 21 TB of media. That is a bad trade for skipping one manual
  step, and an earlier draft of this document recommended it without saying so.

  ```bash
  # Once, as a human. Then the job's --with-deps finds everything present.
  sudo npx playwright install-deps chromium
  ```

  If `--with-deps` still tries to escalate and fails, change the workflow step
  to plain `playwright install chromium`; the deps are already there.
- **The Android SDK.** `ci.yml`'s header says it outright: *"A self-hosted
  runner needs the SDKs the ubuntu images ship with. The Android jobs read
  `$ANDROID_HOME`; set it in the runner's own `.env`."* Install the command-line
  tools, accept the licences, and set `ANDROID_HOME` there. This is the only
  real setup burden in the whole exercise.

### 2. Register the runner

The token is minted in repository settings, under Actions, Runners, New
self-hosted runner. It expires quickly, so mint it immediately before this.

Install it on the data mount, not in `$HOME`. See the disk section above.

```bash
mkdir -p /mnt/hana3/ci/runner-1 && cd /mnt/hana3/ci/runner-1
# Use the download URL and checksum shown on that same settings page rather than
# a version pinned in a document, which goes stale.
./config.sh --url https://github.com/sydeast/tribetails \
            --token <TOKEN> \
            --name tribetails-linux-1 \
            --work /mnt/hana3/ci/runner-1/_work \
            --labels self-hosted,linux,x64
sudo ./svc.sh install
sudo ./svc.sh start
```

`--work` is the flag that keeps every checkout off `/`. Without it the runner
defaults to `_work` beside itself, which is fine here only because the runner
itself is already on the mount.

Installing it as a service is the part the Macs are missing: their runners die
on reboot and have to be restarted by hand, which has already cost a morning.

### 3. Run two or three runners, not one

Thirteen independent jobs behind one runner serialises the lot. Repeat step 2 in
a separate directory with `--name tribetails-linux-2`.

Each runner gets its own `GRADLE_USER_HOME` automatically: the workflow sets it
per job from `$GITHUB_WORKSPACE`, which is why nothing extra is needed here and
why CI was not the cause of #620.

### 4. Point the workflow at them

`ci.yml` reads `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`, so on an x86_64 box
this is a single repository variable and no code change at all. Set `CI_RUNNER`
to the new label.

Deleting that variable puts everything back on hosted runners, so this is not a
one-way door.

### 5. Verify before trusting it

Dispatch the workflow by hand (`gh workflow run ci.yml --ref main`) and read the
job list. Every job should report a runner name, and the two that were failing
in two seconds with no steps should now have steps. A job still reporting an
empty runner name is a labels mismatch, not a billing problem.

## What this does not fix

The GitHub billing state itself. Moving off hosted runners routes around it, and
anything that later needs a hosted runner will be refused the same way, with the
same two-second no-steps failure that looks nothing like a billing error. Worth
clearing regardless.
