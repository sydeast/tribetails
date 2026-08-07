# Mock Review: Eight Accepted Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight UI gaps the 2026-08-06 mock review verified as genuinely unbuilt on `auntie.tribetails.com`, standardizing list screens on cards.

**Architecture:** Nine PRs, one concern each, ordered so structural primitives land before their consumers. Two new shared primitives (`DenBreadcrumbs`, `MergePreview`) go into `src/components/DenScreenKit.tsx` and its Android twin, because five and three screens respectively consume them. One backend change extends `scheduleMarketingBlast` to accept the audience language the admin already speaks; one adds an admin-wide invites read. Everything else is local screen work.

**Tech Stack:** React 19 + Vite + TanStack Router + TypeScript (`src/`), Vitest + Testing Library + Playwright, Jetpack Compose (`android/`), Firebase Cloud Functions with Zod (`mytribe/functions/`).

## Global Constraints

Copied verbatim from `auntieos-admin/CLAUDE.md`. Every task's requirements implicitly include this section.

- **"A feature is DONE only as a full vertical slice, delivered on EVERY platform: backend (MyTribe Cloud Function) + validation + frontend wiring + routes + component + error handling + tests (unit, integration, e2e, happy + sad + negative + error) on the React admin (`src/`) AND ANDROID."** Desktop parity is paused; the wasm admin is superseded. Neither is a delivery target.
- **"A missing callable means BUILD the callable. It is NEVER a reason to stop, defer, or ship frontend-only. There is NO 'gate dark / Not-wired banner' option for our own code."**
- **Fail loud, never fake.** Priority order: works correctly, then fails visibly with a clear error, then silent degradation (NEVER). No `?? 0` fallbacks that turn an unread failure into a confident zero.
- **Design authority, in this order:** `page-specs/*.md` (gitignored, main checkout only, use absolute paths), then `ui-ideas/*.html`. Anything under `ui-ideas/WrongUIDesigns-UpdateKill/` is REJECTED. A filename carrying a directive (`...-cardsShouldOpenDisplayingFullerDetails.html`) means that directive is part of the spec. `visual/mockups/` is never a design source.
- **RULING R1:** a KinCare session covers every Kin in the home. All Kin is the DEFAULT, taking zero interaction on every surface; narrowing is an explicit opt-in behind a "Choose specific Kin" control.
- **Primary permissions ruling:** a PRIMARY kinfolk's entitlements are inherent to the role and CANNOT be toggled. No surface may render them as switches. The admin never mints a SECONDARY invite.
- One concern per PR. No stacked PRs: a stacked PR merges into its own base, not `main`. Branch from fresh `main` per task.
- Let each merge's CI settle before merging the next; back-to-back merges leave a `cancelled` e2e verdict the release gate refuses.
- Commands: `npm test` (vitest), `npm run typecheck`, `npm run e2e`, `npm run visual:react`, `npm run visual:react:verify`.

## Decisions of record

Every item in this plan was ruled on by the operator on 2026-08-06, verbatim below. Nothing here is inferred, and
nothing was scheduled without a ruling. Where a verdict overrode a recommendation of mine, that is noted, because the
next reader should not "correct" it back.

**Wave 1, the eight from the layout review.** Build all eight, standardizing list screens on cards.

```
01 BUILD  Live preview pane            05 BUILD  Bookings status sections
02 BUILD  Marketing Blasts / scheduled 06 BUILD  Inbox grouping + mark all read
03 BUILD  Global invites screen        07 BUILD  Breadcrumbs + real URLs
04 CARDS  One rule for list shape      08 BUILD  Collapse KinTale template items
```

**Wave 2, the mock-source sweep.** Twelve build, one denied, one handed back.

```
A1  BUILD   Schedule hour grid          A9   MOVE    Move ANDROID-STYLE-MOCKS to mytribe
A2  BUILD   Four unshipped keyframes    A10  FIX     Correct the visual manifest
A3  BUILD   Web GPS route view          A11a BUILD   Vet bank doors
A4  BUILD   Adopt the mocks' ease curve A11b BUILD   Kin profile resolves household vet
A5  LEAVE   Grain overlay               A12  REMOCK  Operator supplies the seven
A6  BUILD   Status LED component
A7  BUILD   cchip / pip / pawtag
A8  BUILD   Sticky preview columns
```

**Wave 3, the portal.** All build.

```
P1 BUILD  Surface enRoute as its own timeline step
P2 BUILD  Share dialog: expiry, passcode, revoke
P3 BUILD  Photo-first KinTale cards
P4 BUILD  KinTale visit facts: times, route, task checklist
P5 BUILD  Track the mock sources in git
P6 BUILD  Guard SHARE_LINK_BASE_URL and cut over to the SSR page
P7 BUILD  Per-key notification toggles
P8 BUILD  (settled by ruling) one kinfolk, one tribe, so gate the picker to operators
```

**Wave 3, the open queue.** All build.

```
U1 BUILD  Kinfolk can update their payment method
U2 BUILD  Surface household contacts on the Tribe tab
U3 BUILD  Portal visual manifest, and re-mock Messages
U4 PR20   Correct the two stale refund comments
U5 BUILD  Split generated contracts per app
U6 BUILD  Capture the Stripe fee in the webhook
U7 BUILD  Tip line on portal Stripe checkout
U8 BUILD  Three payment CTAs on the portal invoice, "for now but build out for
          other more payment options"
```

**Verdicts that overrode a recommendation.** I advised LEAVE on both; the operator chose BUILD. Do not revert either
on the grounds that a comment in this plan once argued against them.

- **U5**, splitting the generated contracts per app. I judged it not worth a build change, since the types erase at
  runtime and leak nothing.
- **U7**, a tip line on Stripe checkout. I judged tips to belong on the Venmo and PayPal rails, where the payer types
  a free amount. The operator wants tipping available on the card rail too.

**Standing rulings that constrain this plan**, all operator, all 2026-08-06 unless dated otherwise:

- **No refunds, ever.** Account balance is the only destination for money owed back. Extends the 2026-07-20 ruling
  quoted at `mytribe/functions/src/portal/redeemCredit.ts:55`.
- **Money over the invoice total is not an error.** Usually a tip; genuine excess becomes credit against the next
  invoice. The three-way split at `mytribe/functions/src/lib/paymentMoney.ts:42` is correct and stays.
- **The fee is known at record time.** She reads the real split off the processor's site and enters amount, gross tip
  and fee in one record. Do not build an attach-the-fee-later flow.
- **Fees are admin knowledge.** Kinfolk never see them. `getMyInvoices.ts` correctly does not select the field.
- **One kinfolk, one tribe.**
- **The portal is not live to kinfolk yet.** Affects severity, never correctness.

---

## Sequencing

### PR21 runs before everything, including Wave 1

**Correction to an earlier draft of this plan.** PR21 (track the mock sources in git) is filed under Wave 3 because
that is the sweep that found it, but it is a **global blocker, not a Wave 3 task.** Execute it first, before PR1.

Subagents work in git worktrees. `.gitignore:19` currently hides all 29 admin mocks and 3 portal mocks, so a worktree
contains none of them. This plan cites `ui-ideas/*.html` as design authority in 97 places, and six Wave 1 PRs name a
mock as their spec. Every one of those subagents would build against a folder that does not exist in its checkout, and
the failure is silent: the mock is not wrong, it is absent.

Read PR21 as **PR0**. The wave it sits in records where it was found, not when to run it.

### What the waves are, and are not

They are groupings by origin, not phases. Wave 2 does not wait for Wave 1 to finish, and Wave 3 does not wait for
Wave 2. After PR21 lands, any PR whose own dependencies are met can start, and several can run in parallel.

- **Wave 1**, the eight items from the layout review.
- **Wave 2**, the mock-source sweep of `ui-ideas` and `ANDROID-STYLE-MOCKS`.
- **Wave 3**, the MyTribe portal and the payment queue.

The real ordering is the dependency list below, not the wave numbers. Only these constraints bind:

```
PR21  before everything                     mocks unreadable in a worktree until it lands
PR1   before PR2, PR5                       routes must exist before breadcrumbs and invites use them
PR9   after PR3, PR8                        all three edit Templates and Form Schemas
PR12  before PR15, PR17                     land the ease token before adding animations to recheck
PR15  after PR7                             expand lands on the Inbox that PR7 rewrites
PR16  before PR18                           both edit KinTaleDetail.tsx
PR18  before PR25, or PR25 extracts first   they share the route renderer
PR29  before PR31                           the webhook must split tip from amount before tips arrive
PR30  before PR31                           the registry decides how the Stripe button is configured
```

Everything not named there is independent.

```
WAVE 1  the eight accepted items
PR1   Item 7a   real routes for sub-views          (no deps, unblocks 7b + 3)
PR2   Item 7b   DenBreadcrumbs primitive + apply   (needs PR1's routes)
PR3   Item 1    MergePreview primitive + 3 screens (no deps, highest value)
PR4   Item 2    scheduled marketing blast          (backend + UI)
PR5   Item 3    global invites screen              (backend + UI, needs PR1)
PR6   Item 5    bookings status sections           (no deps)
PR7   Item 6    inbox status grouping + mark all read
PR8   Item 8    collapse KinTale template items    (no deps)
PR9   Item 4    standardize list screens on cards  (last: touches screens 3/8 also touch)

WAVE 2  the sweep
PR10  A11b      kin profile resolves household vet (correctness, run it FIRST)
PR11  A11a      vet bank doors: Settings + picker
PR12  A4        adopt the mocks' ease curve        (one token, before new animations)
PR13  A6        status LED component
PR14  A7        cchip / pip / pawtag
PR15  A2        indet + wag + expand               (after PR7: expand touches Inbox)
PR16  A8        sticky preview columns             (before PR18: both touch KinTaleDetail)
PR17  A1        Schedule hour grid                 (largest in either wave)
PR18  A3        web GPS route view + the flow keyframe
PR19  A9 + A10  mock-source hygiene                (no app code)
```

**PR10 runs first in wave 2, and arguably before parts of wave 1.** It decides which vet a sitter reads in an
emergency. Everything else in either wave is layout, motion, or navigation.

**PR12 before PR15 and PR17.** The ease token changes how every existing animation feels, so land it while there are
few animations to recheck, and any animation added afterwards inherits the right curve for free.

**Ordering constraints, all conflict avoidance:**
- PR9 restyles Templates and Form Schemas; PR3 and PR8 also edit those files.
- PR15's `expand` lands on Inbox, which PR7 rewrites. PR15 after PR7.
- PR16 and PR18 both edit `KinTaleDetail.tsx`. PR16 first.
- PR3 already makes the template editor's preview sticky. PR16 covers only the KinTale composer, the KinTale report, and invites.

**Denied, recorded so it is not re-proposed:** A5, the grain overlay. Operator verdict 2026-08-06: LEAVE. The
`.mesh` and blob layers under it shipped in the July restoration as `.orb`; grain itself is a fixed full-viewport
layer for 5% noise and the 2026-07-25 audit already declined to fight for it. Do not add it back without a new ruling.

**Not our work:** A12, re-mocking the seven `pendingRemock` screens. Operator verdict: REMOCK, meaning the operator
will supply them. Until each arrives, `CLAUDE.md`'s rule holds and no mockup is invented. Track in
`docs/punchlists/PUNCHLIST_2026-07-31-remaining.md` (F1 to F5), and when one lands, move it from `pendingRemock` into
`screens` in `web/visual/manifest.json` and capture its golden.

---

## PR1 · Item 7a: real routes for Directory sub-views

The router already declares the routes. Directory renders the profile as in-place state instead of navigating, so the URL stays `/directory` three levels deep, browser Back exits the screen, and no household is linkable.

**Files:**
- Modify: `src/screens/Directory.tsx` (replace `view`/`selected` state with navigation)
- Modify: `src/screens/KinfolkProfile.tsx` (replace `setView('members')` with a `Link`)
- Modify: `src/routes/DirectoryProfileView.tsx`, `src/routes/HouseholdMembersView.tsx`
- Test: `src/screens/Directory.test.tsx`, `src/screens/KinfolkProfile.test.tsx`
- Test: `e2e/tests/directory-deeplink.spec.ts` (create)
- Android: `android/app/src/main/java/com/tribetails/auntieos/ui/screens/DirectoryScreen.kt` (back stack entry per level)

**Interfaces:**
- Consumes: the existing `directoryProfileRoute` (`directory/$kinfolkId`) and `householdMembersRoute` (`household-members/$kinfolkId`) from `src/router.tsx`.
- Produces: `/directory/{kinfolkId}` and `/household-members/{kinfolkId}` as real, reloadable, linkable URLs. PR2 and PR5 depend on these paths existing.

- [ ] **Step 1: Write the failing test**

```tsx
// src/screens/Directory.test.tsx
it('navigates to the profile route instead of swapping in-place state', async () => {
  const navigate = vi.fn();
  vi.mocked(useNavigate).mockReturnValue(navigate);
  render(<Directory />);
  await userEvent.click(await screen.findByRole('button', { name: /Sandy Demo/ }));
  expect(navigate).toHaveBeenCalledWith({
    to: '/directory/$kinfolkId',
    params: { kinfolkId: 'demo-family-001' },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/screens/Directory.test.tsx -t "navigates to the profile route"`
Expected: FAIL. The card's click handler calls `setSelected`, so `navigate` is never called.

- [ ] **Step 3: Replace the in-place view state with navigation**

```tsx
// src/screens/Directory.tsx
const navigate = useNavigate();
// was: onSelect={(id) => setSelected(id)}
onSelect={(kinfolkId) => navigate({ to: '/directory/$kinfolkId', params: { kinfolkId } })}
```

Delete the `selected` state, the `view` state, and the conditional that rendered `<KinfolkProfile>` inline. `DirectoryProfileView` already mounts it from the route param.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/screens/Directory.test.tsx`
Expected: PASS.

- [ ] **Step 5: Do the same for the Members link**

```tsx
// src/screens/KinfolkProfile.tsx
// was: <GhostButton label="Members and invites" onClick={() => setView('members')} />
<Link to="/household-members/$kinfolkId" params={{ kinfolkId }} className="ghost-link">
  Members and invites
</Link>
```

- [ ] **Step 6: Write the e2e deep-link test**

```ts
// e2e/tests/directory-deeplink.spec.ts
test('a household profile survives a reload and a back press', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/directory/demo-family-001');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sandy Demo');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sandy Demo');
  await page.getByRole('link', { name: 'Members and invites' }).click();
  await expect(page).toHaveURL(/\/household-members\/demo-family-001/);
  await page.goBack();
  await expect(page).toHaveURL(/\/directory\/demo-family-001/);
});
```

- [ ] **Step 7: Run the full suite and the e2e**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: PASS. `npm run e2e` needs the Firebase emulators; the script starts them.

- [ ] **Step 8: Android parity**

`DirectoryScreen.kt` pushes the profile onto the nav back stack as its own destination with the `kinfolkId` argument, rather than swapping a composable behind local state. Add a Robolectric test asserting the back stack has two entries after selecting a household.

- [ ] **Step 9: Commit**

```bash
git checkout main && git pull && git checkout -b fix/directory-subview-routes
git add src/screens/Directory.tsx src/screens/KinfolkProfile.tsx src/screens/Directory.test.tsx src/screens/KinfolkProfile.test.tsx e2e/tests/directory-deeplink.spec.ts android/
git commit -m "Make Directory sub-views real routes so a household can be linked"
```

---

## PR2 · Item 7b: the DenBreadcrumbs primitive

Ten mocks specify `.crumbs`: `display:flex; gap:9px; font-family:"Spline Sans Mono"; font-size:12px; letter-spacing:.04em; color:var(--cream-dim)`, entering on `rise`. Zero breadcrumbs exist in `src`. The kicker (`THE DEN · DIRECTORY`) is a static section label and reads identically on the list and three levels down.

**Files:**
- Modify: `src/components/DenScreenKit.tsx` (add `DenBreadcrumbs`, extend `DenScreenHeading`)
- Modify: `src/components/DenScreenKit.css`
- Modify: `src/screens/KinfolkProfile.tsx`, `src/screens/HouseholdMembers.tsx`, `src/screens/KinView.tsx`, `src/screens/SessionDetail.tsx`, `src/screens/KinTaleDetail.tsx`
- Test: `src/components/DenScreenKit.test.tsx`
- Android: `.../ui/components/DenScreenKit.kt`

**Interfaces:**
- Produces: `interface Crumb { label: string; to?: string; params?: Record<string, string> }` and `DenScreenHeading`'s new optional `crumbs?: readonly Crumb[]` prop. A crumb without `to` renders as the current page (plain text, `aria-current="page"`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/DenScreenKit.test.tsx
it('renders a breadcrumb trail with the last crumb as the current page', () => {
  render(
    <DenScreenHeading
      kicker="The Den"
      title="Members and"
      accentTail="invites."
      crumbs={[
        { label: 'Directory', to: '/directory' },
        { label: 'Sandy Demo', to: '/directory/$kinfolkId', params: { kinfolkId: 'x' } },
        { label: 'Members and invites' },
      ]}
    />,
    { wrapper: RouterWrapper },
  );
  const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(nav).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/directory');
  expect(screen.getByText('Members and invites')).toHaveAttribute('aria-current', 'page');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/DenScreenKit.test.tsx -t breadcrumb`
Expected: FAIL with "Unable to find an accessible element with the role navigation".

- [ ] **Step 3: Implement DenBreadcrumbs**

```tsx
export interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
}

/**
 * The mocks' `.crumbs`: mono, 12px, .04em tracking, a middot between entries.
 * The final crumb is the page you are on, so it is text and not a link, and it
 * carries aria-current so a screen reader announces it as the destination.
 */
export function DenBreadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav className="den-crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.label}>
            {c.to ? (
              <Link to={c.to} params={c.params}>{c.label}</Link>
            ) : (
              <span aria-current="page">{c.label}</span>
            )}
            {i < crumbs.length - 1 && <span className="den-crumbs-sep" aria-hidden="true">/</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

```css
/* src/components/DenScreenKit.css */
.den-crumbs ol {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
  margin: 0 0 0.4rem;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  color: var(--color-text-dim);
}
.den-crumbs li { display: inline-flex; align-items: center; gap: 0.55rem; }
.den-crumbs a { color: var(--color-text-dim); text-decoration: none; }
.den-crumbs a:hover { color: var(--color-text-primary); text-decoration: underline; }
.den-crumbs a:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.den-crumbs [aria-current='page'] { color: var(--color-text-primary); }
.den-crumbs-sep { color: var(--color-text-faint); }
```

Render it inside `DenScreenHeading` above `.den-heading-kicker`, only when `crumbs` is passed, so all 37 existing call sites are untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/DenScreenKit.test.tsx`
Expected: PASS.

- [ ] **Step 5: Pass crumbs from the five nested screens**

`KinfolkProfile` gets `[Directory, <household name>]`. `HouseholdMembers` gets `[Directory, <household name>, Members and invites]`. `KinView` gets `[Directory, <household name>, <kin name>]`. `SessionDetail` gets `[Auntie Time, <session label>]`. `KinTaleDetail` gets `[KinTales, <report title>]`.

- [ ] **Step 6: Recapture visual goldens**

Run: `npm run visual:react && npm run visual:react:verify`
Expected: the diff shows a breadcrumb line added on nested screens only. Commit the updated goldens under `visual/baselines/react/`.

- [ ] **Step 7: Android parity, then commit**

Add `DenBreadcrumbs` to `DenScreenKit.kt` and wire the same five screens. Then:

```bash
git checkout main && git pull && git checkout -b feat/den-breadcrumbs
git commit -m "Add the mocks' breadcrumb trail to nested Den screens"
```

---

## PR3 · Item 1: the MergePreview primitive

`Templates` → any row opens a narrow modal with a plain Body textarea and a raw `<!DOCTYPE html>` textarea. No preview anywhere in `src`. The live `account.welcome.business` body reads "See their account here: []", an empty link that shipped because nothing rendered it. Six mocks tag a `SUGGESTION: live preview pane`, and three specify it `position:sticky; top:24px` in a right-hand column.

**Files:**
- Create: `src/components/MergePreview.tsx`, `src/components/MergePreview.css`
- Create: `src/lib/mergeFields.ts`
- Modify: `src/screens/TemplateEditor.tsx`, `src/screens/TemplateEditor.css`
- Modify: `src/screens/FormSchemaEditor.tsx`, `src/screens/CommunicateCompose.tsx`
- Test: `src/lib/mergeFields.test.ts`, `src/components/MergePreview.test.tsx`
- Android: `.../ui/components/MergePreview.kt`, `KinTaleTemplateEditorScreen.kt`

**Interfaces:**
- Produces: `findMergeFields(body: string): MergeField[]` where `interface MergeField { token: string; key: string; start: number; end: number }`, and `renderPreview(body: string, sample: Record<string, string>): PreviewSegment[]` where `type PreviewSegment = { kind: 'text'; value: string } | { kind: 'field'; key: string; value: string | null }`. A `value` of `null` means the sample has no binding, which is what the unresolved-field warning counts.

- [ ] **Step 1: Write the failing test for the parser**

```ts
// src/lib/mergeFields.test.ts
describe('findMergeFields', () => {
  it('finds Handlebars tokens and ignores escaped braces', () => {
    expect(findMergeFields('Hi {{kinfolkName}}, see {{ link }}.')).toEqual([
      { token: '{{kinfolkName}}', key: 'kinfolkName', start: 3, end: 18 },
      { token: '{{ link }}', key: 'link', start: 24, end: 34 },
    ]);
  });
  it('returns an empty list for a body with no tokens', () => {
    expect(findMergeFields('No fields here.')).toEqual([]);
  });
});

describe('renderPreview', () => {
  it('marks a token with no sample binding as unresolved', () => {
    const segs = renderPreview('Hi {{kinfolkName}}!', {});
    expect(segs).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'field', key: 'kinfolkName', value: null },
      { kind: 'text', value: '!' },
    ]);
  });
  it('substitutes a bound token', () => {
    const segs = renderPreview('Hi {{kinfolkName}}!', { kinfolkName: 'Sandy' });
    expect(segs[1]).toEqual({ kind: 'field', key: 'kinfolkName', value: 'Sandy' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mergeFields.test.ts`
Expected: FAIL with "Failed to resolve import ./mergeFields".

- [ ] **Step 3: Implement the parser**

```ts
// src/lib/mergeFields.ts
export interface MergeField { token: string; key: string; start: number; end: number }
export type PreviewSegment =
  | { kind: 'text'; value: string }
  | { kind: 'field'; key: string; value: string | null };

// Deliberately NOT a Handlebars runtime. We render a preview, we do not execute
// helpers or partials, and pulling a template engine in to draw a box would ship
// an evaluator into the admin bundle for no gain.
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

export function findMergeFields(body: string): MergeField[] {
  const out: MergeField[] = [];
  for (const m of body.matchAll(TOKEN)) {
    out.push({ token: m[0], key: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function renderPreview(body: string, sample: Record<string, string>): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let cursor = 0;
  for (const f of findMergeFields(body)) {
    if (f.start > cursor) segments.push({ kind: 'text', value: body.slice(cursor, f.start) });
    // `?? null` is the point of this function, not a fallback: an unbound token
    // is the thing the warning counts, so it must survive as null and not as ''.
    segments.push({ kind: 'field', key: f.key, value: sample[f.key] ?? null });
    cursor = f.end;
  }
  if (cursor < body.length) segments.push({ kind: 'text', value: body.slice(cursor) });
  return segments;
}

export function unresolvedCount(segments: readonly PreviewSegment[]): number {
  return segments.filter((s) => s.kind === 'field' && s.value === null).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mergeFields.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

```tsx
// src/components/MergePreview.test.tsx
it('warns once per unresolved field and names the count', () => {
  render(<MergePreview subject="Welcome" body="Hi {{kinfolkName}}, see {{link}}." sample={{ kinfolkName: 'Sandy' }} />);
  expect(screen.getByText('Sandy')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('1 merge field has no sample value: link');
});

it('says nothing when every field resolves', () => {
  render(<MergePreview subject="Welcome" body="Hi {{kinfolkName}}." sample={{ kinfolkName: 'Sandy' }} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Run it, watch it fail, then implement**

Run: `npx vitest run src/components/MergePreview.test.tsx`
Expected: FAIL, no such module. Then build `MergePreview` rendering the subject line, the segments (bound fields as a tinted chip, unbound as a warning chip), and the `role="status"` summary. In `TemplateEditor.css`, widen the modal to a two-column grid and make the preview column `position: sticky; top: 1.5rem;` per the mocks.

- [ ] **Step 7: Wire the three consumers**

`TemplateEditor` previews `subject` + `body` with a sample drawn from the notification catalog key. `FormSchemaEditor` previews the field list as the kinfolk sees it. `CommunicateCompose` previews the broadcast message body.

- [ ] **Step 8: Prove it catches the real bug**

```ts
// e2e/tests/template-preview.spec.ts
test('the welcome template reports its empty link', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/templates');
  await page.getByRole('button', { name: /account\.welcome\.business/ }).click();
  await expect(page.getByRole('status')).toContainText('merge field');
});
```

- [ ] **Step 9: Run everything, Android parity, commit**

Run: `npm test && npm run typecheck && npm run e2e && npm run visual:react`

```bash
git checkout main && git pull && git checkout -b feat/merge-field-preview
git commit -m "Render a live preview beside the template and schema editors"
```

---

## PR4 · Item 2: scheduled marketing blast

`mytribe/functions/src/admin/scheduleMarketingBlast.ts` is deployed, admin-gated, and has zero UI callers. Its `Args` are `{ key: 'newsletter.announcement' | 'survey.event' | 'marketing.optin', fireAtMs: positive int, audienceUids: string[1..5000], data: Record<string, unknown> }`. The admin's Broadcast speaks `BroadcastCriteria`, not uids, and `broadcastMessage` sends immediately. So the scheduled, opt-in-checked path is unreachable.

**Files:**
- Modify: `mytribe/functions/src/admin/scheduleMarketingBlast.ts` (accept `criteria` as an alternative to `audienceUids`)
- Test: `mytribe/functions/src/admin/scheduleMarketingBlast.test.ts`
- Modify: `src/api/communicateWrite.ts` (add `scheduleMarketingBlast` wrapper)
- Modify: `src/screens/CommunicateCompose.tsx`, `src/screens/CommunicateCompose.css`
- Test: `src/api/communicateWrite.test.ts`, `src/screens/CommunicateCompose.test.tsx`
- Android: `.../ui/screens/CommunicateScreen.kt`

**Interfaces:**
- Consumes: `resolveRecipientsFromKinfolk(all, criteria)` and `CriteriaSchema` from `mytribe/functions/src/admin/audienceCriteria.ts`, exactly as `broadcastMessage.ts` does. This is why the extension is the right shape: one audience language, one resolver, two dispatch timings.
- Produces: `scheduleMarketingBlast(args: ScheduleBlastArgs): Promise<ScheduleBlastResult>` in `src/api/communicateWrite.ts`, where `interface ScheduleBlastArgs { key: MarketingKey; fireAtMs: number; criteria: BroadcastCriteria; data: Record<string, string> }` and `interface ScheduleBlastResult { scheduled: number; suppressed: number }`.

- [ ] **Step 1: Write the failing backend test**

```ts
// mytribe/functions/src/admin/scheduleMarketingBlast.test.ts
it('resolves inline criteria to uids and schedules one notification each', async () => {
  seedKinfolk([
    { id: 'a', uid: 'uid-a', status: 'active' },
    { id: 'b', uid: '', status: 'active' },        // not onboarded: no uid, cannot receive
    { id: 'c', uid: 'uid-c', status: 'archived' }, // archived: excluded by criteria
  ]);
  const res = await scheduleMarketingBlastHandler(
    adminReq({ key: 'newsletter.announcement', fireAtMs: Date.now() + 86_400_000, criteria: { kind: 'all' }, data: {} }),
  );
  expect(res).toEqual({ scheduled: 1, suppressed: 2 });
});

it('rejects a past fireAtMs', async () => {
  await expect(
    scheduleMarketingBlastHandler(
      adminReq({ key: 'survey.event', fireAtMs: Date.now() - 120_000, criteria: { kind: 'all' }, data: {} }),
    ),
  ).rejects.toThrow('fireAtMs is in the past');
});

it('still accepts an explicit audienceUids list', async () => {
  const res = await scheduleMarketingBlastHandler(
    adminReq({ key: 'marketing.optin', fireAtMs: Date.now() + 3_600_000, audienceUids: ['uid-a'], data: {} }),
  );
  expect(res.scheduled).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mytribe/functions && npx vitest run src/admin/scheduleMarketingBlast.test.ts`
Expected: FAIL. The Zod schema requires `audienceUids`, so the criteria call is rejected as invalid-argument.

- [ ] **Step 3: Extend the schema, keeping uids working**

```ts
const Args = z
  .object({
    key: z.enum(MARKETING_KEYS),
    fireAtMs: z.number().int().positive(),
    audienceUids: z.array(z.string().min(1)).min(1).max(5000).optional(),
    criteria: CriteriaSchema.optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .superRefine((val, ctx) => {
    if (!val.audienceUids && !val.criteria) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audienceUids'],
        message: 'provide audienceUids or criteria',
      });
    }
  });
```

Resolution reuses the broadcast path verbatim, and reports what it dropped rather than silently shrinking the audience:

```ts
// A kinfolk with no uid has no MyTribe install to notify. That is a real
// exclusion the caller must see, not a row to quietly skip: the operator is
// about to be told "scheduled 1" for a 3-household audience.
const recipients = args.criteria
  ? resolveRecipientsFromKinfolk(await loadAllKinfolk(), args.criteria)
  : null;
const uids = recipients ? recipients.map((k) => k.uid ?? '').filter((u) => u !== '') : args.audienceUids!;
const suppressed = recipients ? recipients.length - uids.length : 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mytribe/functions && npx vitest run src/admin/scheduleMarketingBlast.test.ts`
Expected: PASS, all three cases.

- [ ] **Step 5: Add the admin wrapper**

```ts
// src/api/communicateWrite.ts
export const MARKETING_KEYS = ['newsletter.announcement', 'survey.event', 'marketing.optin'] as const;
export type MarketingKey = (typeof MARKETING_KEYS)[number];

export interface ScheduleBlastArgs {
  key: MarketingKey;
  fireAtMs: number;
  criteria: BroadcastCriteria;
  data: Record<string, string>;
}
export interface ScheduleBlastResult { scheduled: number; suppressed: number }

export function scheduleMarketingBlast(args: ScheduleBlastArgs): Promise<ScheduleBlastResult> {
  return call<ScheduleBlastArgs, ScheduleBlastResult>('scheduleMarketingBlast', args);
}
```

- [ ] **Step 6: Write the failing UI test, then build the control**

```tsx
// src/screens/CommunicateCompose.test.tsx
it('schedules instead of sending when a time is chosen', async () => {
  render(<CommunicateCompose mode="broadcast" />);
  await userEvent.click(screen.getByRole('radio', { name: 'At a time' }));
  await userEvent.type(screen.getByLabelText('Date'), '2026-08-12');
  await userEvent.type(screen.getByLabelText('Time'), '09:00');
  await userEvent.selectOptions(screen.getByLabelText('Marketing category'), 'newsletter.announcement');
  await userEvent.type(screen.getByLabelText(/Message/), 'Autumn newsletter');
  await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
  expect(scheduleMarketingBlast).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'newsletter.announcement', criteria: { kind: 'all' } }),
  );
  expect(sendBroadcast).not.toHaveBeenCalled();
});

it('reports suppressed recipients rather than implying everyone got it', async () => {
  vi.mocked(scheduleMarketingBlast).mockResolvedValue({ scheduled: 1, suppressed: 2 });
  render(<CommunicateCompose mode="broadcast" />);
  await userEvent.click(screen.getByRole('radio', { name: 'At a time' }));
  await userEvent.type(screen.getByLabelText('Date'), '2026-08-12');
  await userEvent.type(screen.getByLabelText('Time'), '09:00');
  await userEvent.selectOptions(screen.getByLabelText('Marketing category'), 'newsletter.announcement');
  await userEvent.type(screen.getByLabelText(/Message/), 'Autumn newsletter');
  await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Scheduled for 1 home. 2 skipped: no MyTribe account yet.',
  );
});

it('surfaces a rejected schedule and does not claim a send', async () => {
  vi.mocked(scheduleMarketingBlast).mockRejectedValue(new Error('fireAtMs is in the past'));
  render(<CommunicateCompose mode="broadcast" />);
  await userEvent.click(screen.getByRole('radio', { name: 'At a time' }));
  await userEvent.type(screen.getByLabelText('Date'), '2026-08-01');
  await userEvent.type(screen.getByLabelText('Time'), '09:00');
  await userEvent.selectOptions(screen.getByLabelText('Marketing category'), 'survey.event');
  await userEvent.type(screen.getByLabelText(/Message/), 'Survey');
  await userEvent.click(screen.getByRole('button', { name: 'Schedule blast' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('fireAtMs is in the past');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
```

Add a Now / At a time segmented control, a date and time pair, and a category select bound to `MARKETING_KEYS`. `fireAtMs` comes from the local date and time via `new Date(`${date}T${time}`).getTime()`, matching the AO-18 local-time convention.

- [ ] **Step 7: Run everything, Android parity, commit**

Run: `npm test && npm run typecheck && npm run e2e`

```bash
git checkout main && git pull && git checkout -b feat/scheduled-marketing-blast
git commit -m "Give scheduleMarketingBlast a door, and teach it the admin's audience language"
```

---

## PR5 · Item 3: global invites screen

Invites live three levels down and are scoped to one household. `listInvites` takes `{ familyId }`, so answering "who never accepted" means opening all 13 households by hand. There is no admin-wide read.

**Files:**
- Create: `mytribe/functions/src/admin/listAllInvites.ts`
- Test: `mytribe/functions/src/admin/listAllInvites.test.ts`
- Modify: `mytribe/functions/src/index.ts` (export the callable)
- Create: `src/screens/Invites.tsx`, `src/screens/Invites.css`, `src/screens/Invites.test.tsx`
- Modify: `src/api/members.ts` (add `listAllInvites`), `src/router.tsx`, `src/components/AppShell.tsx` (rail entry)
- Android: `.../ui/screens/InvitesScreen.kt`

**Interfaces:**
- Consumes: `HouseholdInvite` (`src/api/members.ts:126`), `inviteStatusLabel`, `inviteStatusTone`, `formatInviteDate`, `INVITE_TTL_DAYS`. Reuse them; do not restate expiry logic.
- Produces: `listAllInvites(): Promise<AdminInvite[]>` where `interface AdminInvite extends HouseholdInvite { householdName: string }`. **Only `householdName` is added.** `HouseholdInvite` already carries `tribeId`, and the household key is NOT invented here: this codebase aliases the same id as `tribeId` on the invite doc, `familyId` in `listInvites`'s argument, and `kinfolkId` in the router. **Before wiring the card's link, read `mytribe/functions/src/portal/listInvites.ts` and confirm `tribeId` is the id `/household-members/$kinfolkId` expects.** If it is not, the mapping belongs in the callable, not in the screen.

- [ ] **Step 1: Write the failing backend test**

```ts
// mytribe/functions/src/admin/listAllInvites.test.ts
it('returns every household invite with its household name attached', async () => {
  seedInvites([
    { inviteId: 'i1', tribeId: 'f1', status: 'PENDING', createdAt: iso('2026-08-01') },
    { inviteId: 'i2', tribeId: 'f2', status: 'ACCEPTED', createdAt: iso('2026-07-20') },
  ]);
  seedKinfolk([{ id: 'f1', displayName: 'the Demos' }, { id: 'f2', displayName: 'the Ellerys' }]);
  const res = await listAllInvitesHandler(adminReq({}));
  expect(res.invites).toEqual([
    expect.objectContaining({ inviteId: 'i1', tribeId: 'f1', householdName: 'the Demos', status: 'PENDING' }),
    expect.objectContaining({ inviteId: 'i2', tribeId: 'f2', householdName: 'the Ellerys', status: 'ACCEPTED' }),
  ]);
});

it('refuses a non-admin caller', async () => {
  await expect(listAllInvitesHandler(kinfolkReq({}))).rejects.toThrow('permission-denied');
});

it('names a household whose kinfolk doc is missing rather than dropping the invite', async () => {
  seedInvites([{ inviteId: 'i9', tribeId: 'gone', status: 'PENDING', createdAt: iso('2026-08-01') }]);
  const res = await listAllInvitesHandler(adminReq({}));
  expect(res.invites[0]).toMatchObject({ tribeId: 'gone', householdName: '(household not found: gone)' });
});
```

The third test is the fail-loud rule: an orphaned invite is exactly the row the operator needs to see, so it must not be filtered out for want of a name.

- [ ] **Step 2: Run it, watch it fail, implement behind `wrapAdminCallable`**

Run: `cd mytribe/functions && npx vitest run src/admin/listAllInvites.test.ts`
Expected: FAIL, module not found. Then implement, following `scheduleMarketingBlast.ts`'s `onCall(..., wrapAdminCallable('listAllInvites', handler))` shape and `TRIBETAILS_CORS`.

- [ ] **Step 3: Write the failing screen test**

```tsx
// src/screens/Invites.test.tsx
it('groups by status and defaults to the ones still outstanding', async () => {
  vi.mocked(listAllInvites).mockResolvedValue([
    invite({ inviteId: 'i1', householdName: 'the Demos', status: 'PENDING' }),
    invite({ inviteId: 'i2', householdName: 'the Marlowes', status: 'EXPIRED' }),
    invite({ inviteId: 'i3', householdName: 'the Sparrows', status: 'ACCEPTED' }),
  ]);
  render(<Invites />);
  expect(await screen.findByRole('button', { name: 'Outstanding 2' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('the Demos')).toBeInTheDocument();
  expect(screen.queryByText('the Sparrows')).not.toBeInTheDocument();
});

it('surfaces a failed read instead of an empty list', async () => {
  vi.mocked(listAllInvites).mockRejectedValue(new Error('permission-denied'));
  render(<Invites />);
  expect(await screen.findByRole('alert')).toHaveTextContent('permission-denied');
});
```

- [ ] **Step 4: Build the screen, route, and rail entry**

Card grid per PR9's rule. Each card names the household, links to PR1's `/household-members/$kinfolkId` route, and shows sent and expiry dates through `formatInviteDate`.

```tsx
// src/router.tsx, beside vetClinicsRoute
const invitesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'invites',
  component: lazyRouteComponent(() => import('./screens/Invites'), 'Invites'),
});
```

```tsx
// src/components/AppShell.tsx, in the linkOptions map
invites: linkOptions({ to: '/invites' }),
```

Add `invites` to the same nav group as `directory` in `NavConfig`, so it sits under THE DEN rather than becoming another URL-only screen like Vet Clinics (see the open item at the end of this plan).

- [ ] **Step 5: Run everything, Android parity, commit**

```bash
git checkout main && git pull && git checkout -b feat/global-invites-screen
git commit -m "Add an admin-wide invites screen backed by a new listAllInvites callable"
```

---

## PR6 · Item 5: bookings status sections

`Bookings` shows three stat cards, filter chips, and one flat newest-first list capped at 200. Seven "Unnamed Kinfolk" completed rows sit above the six live ones. The mock's filename directive, `cardsShouldOpenDisplayingFullerDetails`, is already satisfied by `BookingDetailModal` and stays as-is.

**Files:**
- Modify: `src/screens/Bookings.tsx`, `src/screens/Bookings.css`
- Test: `src/screens/Bookings.test.tsx`
- Android: `.../ui/screens/ScheduleViewScreen.kt` (the manifest's android entry for `manage-bookings`)

**Interfaces:**
- Consumes: `BookingEntry` from `src/api/bookings.ts:71` (it extends `SessionEntry`). Do not introduce a parallel row type.
- Produces: `groupBookingsByStatus(rows: readonly BookingEntry[]): BookingSection[]` where `interface BookingSection { key: 'pending' | 'scheduled' | 'history'; label: string; rows: BookingEntry[] }`. Sections come back in that order always, including when empty, so the screen can render an empty hint per section.

- [ ] **Step 1: Write the failing test**

```ts
it('orders sections pending, scheduled, history regardless of input order', () => {
  const sections = groupBookingsByStatus([
    booking({ id: 'c', status: 'completed' }),
    booking({ id: 'p', status: 'pending' }),
    booking({ id: 's', status: 'scheduled' }),
    booking({ id: 'd', status: 'draft' }),
  ]);
  expect(sections.map((s) => s.key)).toEqual(['pending', 'scheduled', 'history']);
  // Draft joins pending, mirroring the "Pending approval" stat this screen already shows.
  expect(sections[0].rows.map((r) => r._id)).toEqual(['p', 'd']);
  expect(sections[2].rows.map((r) => r._id)).toEqual(['c']);
});

it('keeps an empty section so the screen can say nothing is waiting', () => {
  const sections = groupBookingsByStatus([booking({ id: 'c', status: 'completed' })]);
  expect(sections[0]).toEqual({ key: 'pending', label: 'Pending approval', rows: [] });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npx vitest run src/screens/Bookings.test.tsx -t "orders sections"`
Expected: FAIL, `groupBookingsByStatus` is not exported. Implement it beside the existing `STATUS_FILTERS`, reusing the same status predicates so the chips and the sections can never disagree.

- [ ] **Step 3: Render sections, keep the chips**

Chips stay and now filter within sections; picking a single status collapses to that section. History renders collapsed behind a count button, since it holds 94 of the 100 rows.

```tsx
{groupBookingsByStatus(visible).map((section) => (
  <section key={section.key} className="bookings__section">
    <h3 className="bookings__section-head">
      {section.label} <span className="bookings__section-count">{section.rows.length}</span>
    </h3>
    {section.rows.length === 0 ? (
      <EmptyHint>Nothing {section.key === 'pending' ? 'awaiting a reply' : 'here'}.</EmptyHint>
    ) : section.key === 'history' && !historyOpen ? (
      <GhostButton label={`Show ${section.rows.length} finished`} onClick={() => setHistoryOpen(true)} />
    ) : (
      <ul className="bookings__rows">
        {section.rows.map((entry) => (
          <BookingRowItem key={entry._id} entry={entry} onSelect={setSelectedId} />
        ))}
      </ul>
    )}
  </section>
))}
```

`BookingRowItem` is the existing row component; this step only changes what wraps it.

- [ ] **Step 4: Recapture goldens, Android parity, commit**

```bash
git checkout main && git pull && git checkout -b feat/bookings-status-sections
git commit -m "Group bookings by status so the six live ones are not under 94 finished"
```

---

## PR7 · Item 6: inbox status grouping and mark all read

`Inbox` groups by local calendar day via `groupThreadsByDay`. The `1 unread` chip already ships. Missing: grouping by who is waiting, and a bulk mark-read.

**Files:**
- Modify: `src/screens/Inbox.tsx`, `src/screens/Inbox.css`
- Modify: `src/lib/inboxFormat.ts` (add `groupThreadsByWaiting` beside `groupThreadsByDay`)
- Modify: `src/api/inboxThread.ts` (add `markAllThreadsRead`)
- Create: `mytribe/functions/src/admin/markAllThreadsRead.ts` + test
- Test: `src/lib/inboxFormat.test.ts`, `src/screens/Inbox.test.tsx`
- Android: `.../ui/screens/InboxScreen.kt`

**Interfaces:**
- Consumes: `ConversationSummary` from `src/api/inbox.ts:38`. Note `unreadForAdmin` is a STORED **boolean**, not a count (`src/api/inbox.ts:44`, and the comment at :71 explains why). Do not write predicates that treat it as a number.
- Produces: `groupThreadsByWaiting<T extends { unreadForAdmin: boolean }>(threads: readonly T[]): ThreadSection<T>[]` with `interface ThreadSection<T> { key: 'waiting' | 'answered'; label: string; threads: T[] }`. Generic, matching its neighbor `groupThreadsByDay<T extends { lastMessageAtMs: number }>` at `src/lib/inboxFormat.ts:208`, so the same helper serves the screen and its tests without a cast.
- Produces: `markAllThreadsRead(): Promise<{ cleared: number }>`.
- The day grouping is NOT deleted. `groupThreadsByDay` stays and runs inside each status section, so the AO-18 local-day fix keeps applying.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/inboxFormat.test.ts
it('puts threads waiting on a reply above answered ones', () => {
  const sections = groupThreadsByWaiting([
    { _id: 'a', unreadForAdmin: false, lastMessageAtMs: 2 },
    { _id: 'b', unreadForAdmin: true, lastMessageAtMs: 1 },
  ]);
  expect(sections.map((s) => s.key)).toEqual(['waiting', 'answered']);
  expect(sections[0].threads.map((t) => t._id)).toEqual(['b']);
  expect(sections[1].threads.map((t) => t._id)).toEqual(['a']);
});

it('keeps both sections when one is empty so the screen can say so', () => {
  const sections = groupThreadsByWaiting([{ _id: 'a', unreadForAdmin: false, lastMessageAtMs: 1 }]);
  expect(sections[0]).toEqual({ key: 'waiting', label: 'Waiting on a reply', threads: [] });
});

it('clears the badge and reports the count after marking all read', async () => {
  vi.mocked(markAllThreadsRead).mockResolvedValue({ cleared: 4 });
  render(<Inbox />);
  await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
  expect(await screen.findByRole('status')).toHaveTextContent('4 threads marked read');
});

it('leaves the badge alone and shows the error when the write fails', async () => {
  vi.mocked(markAllThreadsRead).mockRejectedValue(new Error('unavailable'));
  render(<Inbox />);
  await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
  expect(screen.getByText(/unread/)).toBeInTheDocument();
});
```

The third test matters: the rail count reads the same `unreadThreadCount` flag, so an optimistic clear on a failed write would leave the chrome lying on every screen.

- [ ] **Step 2: Run, fail, implement backend then UI**

Run: `npx vitest run src/screens/Inbox.test.tsx`
Expected: FAIL. Implement `markAllThreadsRead` as a batched write over threads with `unreadForAdmin > 0`, returning the count it actually cleared. `firestore.rules:798` already grants the admin read; confirm the write rule covers `unreadForAdmin` before assuming it does.

- [ ] **Step 3: Recapture goldens, Android parity, commit**

```bash
git checkout main && git pull && git checkout -b feat/inbox-waiting-first
git commit -m "Sort the Inbox by who is waiting, and add a bulk mark-read"
```

---

## PR8 · Item 8: collapse KinTale template items

`KinTaleTemplates.tsx` is 912 lines and renders every checklist item fully expanded: Item text, a Required toggle with its help line, a Show-even-when-unchecked toggle with its help line, a Conditions label, and an Add condition button. Six items means about thirty always-open controls and roughly fifty scroll ticks. `FormSchemaEditor` already solves this with a collapsed `▸ Advanced` per field.

**Files:**
- Modify: `src/screens/KinTaleTemplates.tsx`, `src/screens/KinTaleTemplates.css`
- Test: `src/screens/KinTaleTemplates.test.tsx`
- Android: `.../ui/screens/KinTaleTemplateEditorScreen.kt`, `ChecklistEditorScreen.kt`

**Interfaces:**
- No new exports. The change is presentational, with one behavioral rule below that the test pins.

- [ ] **Step 1: Write the failing test**

```tsx
it('collapses each item and keeps its text visible', async () => {
  render(<KinTaleTemplates />);
  const item = await screen.findByDisplayValue('Fresh water provided');
  expect(item).toBeVisible();
  expect(screen.queryByLabelText('Required', { selector: `#${item.id}-required` })).not.toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /Advanced for Fresh water provided/ }));
  expect(screen.getByLabelText('Required', { selector: `#${item.id}-required` })).toBeVisible();
});

it('opens an item automatically when it already carries a condition', async () => {
  seedTemplate({ items: [{ text: 'Medications given', conditions: [{ op: 'EQ', source: 'species', value: 'dog' }] }] });
  render(<KinTaleTemplates />);
  expect(await screen.findByText(/species is dog/)).toBeVisible();
});
```

The second test is the rule that makes collapsing safe: a configured item must not hide its configuration, or the operator loses the only signal that an item is conditional.

- [ ] **Step 2: Run, fail, implement with `<details>`**

Run: `npx vitest run src/screens/KinTaleTemplates.test.tsx -t collapses`
Expected: FAIL, no Advanced button exists. Use a native `<details>` per item with `open` defaulting to `conditions.length > 0 || required || showWhenUnchecked`, so anything non-default is visible on load. Native `<details>` gets keyboard and find-in-page behavior for free, which a div-plus-state reimplementation does not.

- [ ] **Step 3: Recapture goldens, Android parity, commit**

```bash
git checkout main && git pull && git checkout -b feat/collapse-kintale-items
git commit -m "Collapse KinTale checklist items behind Advanced, matching Form Schemas"
```

---

## PR9 · Item 4: standardize list screens on cards

Verdict: CARDS. `Directory` and `Vet clinics` already ship card grids. `Templates` (50 rows) and `Form Schemas` (3 rows) ship stacked rows and become cards. This lands last because PR3 and PR8 also edit these files.

**Files:**
- Modify: `src/screens/Templates.tsx`, `src/screens/Templates.css`
- Modify: `src/screens/FormSchemas.tsx`, `src/screens/FormSchemas.css`
- Create: `src/components/EntityCardGrid.tsx`, `src/components/EntityCardGrid.css`
- Test: `src/components/EntityCardGrid.test.tsx`, plus updates to both screen tests
- Modify: `docs/2026-05-31-den-redesign-design.md` (record the rule)
- Android: `.../ui/screens/TemplateBankScreen.kt`, `FormSchemaListScreen.kt`

**Interfaces:**
- Produces: `EntityCardGrid` with `{ children }` and the grid CSS lifted from `Directory.css` and `VetClinics.css` so all four screens share one definition instead of three copies. `Directory` and `VetClinics` migrate onto it in this PR too, which is the point: a rule with three implementations is not a rule.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/EntityCardGrid.test.tsx
it('renders a list semantic so a screen reader announces the count', () => {
  render(<EntityCardGrid label="Templates"><li>one</li><li>two</li></EntityCardGrid>);
  const list = screen.getByRole('list', { name: 'Templates' });
  expect(list).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});
```

- [ ] **Step 2: Run, fail, implement, migrate all four screens**

Run: `npx vitest run src/components/EntityCardGrid.test.tsx`
Expected: FAIL, module not found.

```tsx
// src/components/EntityCardGrid.tsx
export function EntityCardGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="entity-grid" aria-label={label}>
      {children}
    </ul>
  );
}
```

```css
/* src/components/EntityCardGrid.css
   Lifted from Directory.css and VetClinics.css, which had two copies of this. */
.entity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.85rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
```

Then convert `Templates` and `Form Schemas` from `__row` to cards, and repoint `Directory` and `VetClinics` at the shared grid. Keep every existing behavior: search, category chips, counts, per-row delete, row click opening the editor.

- [ ] **Step 3: Record the rule so the next screen inherits it**

Add to `docs/2026-05-31-den-redesign-design.md`:

```markdown
## List shape: cards

Operator ruling, 2026-08-06. Every browse-a-list-of-entities screen uses
`EntityCardGrid`. Rows are for chronological feeds only (Inbox, Activity Log,
Bookings within a status section), where the reading order is the information.
```

- [ ] **Step 4: Recapture goldens, Android parity, commit**

Run: `npm test && npm run typecheck && npm run e2e && npm run visual:react && npm run visual:react:verify`

```bash
git checkout main && git pull && git checkout -b feat/entity-card-grid
git commit -m "Standardize entity list screens on one shared card grid"
```

---

# Wave 2: the sweep

Twelve accepted, one denied, one handed back to the operator. Evidence for each is in the appendix.

---

## PR10 · A11b: the kin profile resolves the household vet

`KinView.tsx:182` renders `<Fact label="Vet info" value={k.vetInfo} />`. `k.vetInfo` is a per-kin free-text string on
the kin doc (`src/api/kinView.ts:34`), and `KinView.tsx` never calls `resolveHouseholdVet`. So the kin profile can show
blank or years-old text while `household_data` holds the real clinic. This is the same "second writable copy" that
`HouseholdVetPanels` was written to kill on the household profile, still alive one screen over.

Operator ruling 2026-08-01, quoted in `src/components/HouseholdVetPanels.tsx:13`: *"vet info lives on household data, it
can be seen on the kin profile."* Reaffirmed 2026-08-06.

**Files:**
- Modify: `src/screens/KinView.tsx`, `src/screens/KinView.css`
- Test: `src/screens/KinView.test.tsx`
- Android: `.../ui/screens/KinCareDetailScreen.kt` and the kin profile composable that renders `vetInfo`

**Interfaces:**
- Consumes: `resolveHouseholdVet`, `hasVet`, `HouseholdVet` from `src/lib/householdVet.ts`, and `VET_CLINICS_QUERY` /
  `VetClinic` from `src/api/vetClinics.ts`. Exactly the imports `HouseholdData.tsx:19-20` already uses. Do not write a
  second resolver.
- Produces: nothing new. This removes a source of truth rather than adding one.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/screens/KinView.test.tsx
it('shows the household clinic, not the per-kin string', async () => {
  seedHouseholdData({ kinfolkId: 'f1', vetClinicId: 'vc1' });
  seedVetClinics([{ _id: 'vc1', name: 'Cedar Street Vet', phone: '(512) 555-0147' }]);
  render(<KinView kinfolkId="f1" kinId="k1" />);
  expect(await screen.findByText('Cedar Street Vet')).toBeInTheDocument();
  expect(screen.getByText('(512) 555-0147')).toBeInTheDocument();
});

it('prefers the household clinic over a stale per-kin vetInfo', async () => {
  seedKin({ _id: 'k1', vetInfo: 'Old Town Vet, 555-0000' });
  seedHouseholdData({ kinfolkId: 'f1', vetClinicId: 'vc1' });
  seedVetClinics([{ _id: 'vc1', name: 'Cedar Street Vet', phone: '(512) 555-0147' }]);
  render(<KinView kinfolkId="f1" kinId="k1" />);
  expect(await screen.findByText('Cedar Street Vet')).toBeInTheDocument();
  expect(screen.queryByText(/Old Town Vet/)).not.toBeInTheDocument();
});

it('keeps a legacy vetInfo visible, labelled, when the household has no clinic on file', async () => {
  seedKin({ _id: 'k1', vetInfo: 'Old Town Vet, 555-0000' });
  seedHouseholdData({ kinfolkId: 'f1' });
  render(<KinView kinfolkId="f1" kinId="k1" />);
  expect(await screen.findByText(/Old Town Vet/)).toBeInTheDocument();
  expect(screen.getByText('From an older record')).toBeInTheDocument();
});

it('offers no edit control on this screen', async () => {
  seedHouseholdData({ kinfolkId: 'f1', vetClinicId: 'vc1' });
  seedVetClinics([{ _id: 'vc1', name: 'Cedar Street Vet' }]);
  render(<KinView kinfolkId="f1" kinId="k1" />);
  await screen.findByText('Cedar Street Vet');
  expect(screen.queryByRole('button', { name: /vet/i })).not.toBeInTheDocument();
});
```

The third test is the one that keeps this from being a data-loss change. Deleting the `vetInfo` render outright would
blank the vet on any kin whose household never got a clinic assigned, which is worse than showing stale text. It stays,
demoted and labelled, the same way `HouseholdData.tsx:14` already handles `legacyVetLeftovers`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/screens/KinView.test.tsx -t "household clinic"`
Expected: FAIL. `KinView` renders only `k.vetInfo`, so the clinic name is never in the document.

- [ ] **Step 3: Resolve the canonical record, read-only**

```tsx
// src/screens/KinView.tsx
const clinics = useCollection<VetClinic>(VET_CLINICS_QUERY);
const householdVet = resolveHouseholdVet(householdData, clinics);

// Read-only by ruling. Picking happens on the household edit form via
// VetClinicPicker; this screen must not offer a second write path, which is the
// whole reason HouseholdVetPanels exists on the household profile.
{hasVet(householdVet) ? (
  <VetFacts vet={householdVet} />
) : k.vetInfo !== '' ? (
  <>
    <Fact label="Vet info" value={k.vetInfo} />
    <p className="kinview__legacy-note">From an older record</p>
  </>
) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/screens/KinView.test.tsx`
Expected: PASS, all four.

- [ ] **Step 5: Android parity, then commit**

The Android kin profile reads the same per-kin field. Point it at the shared resolver and add the equivalent
"prefers household clinic" test.

```bash
git checkout main && git pull && git checkout -b fix/kin-profile-household-vet
git commit -m "Resolve the household clinic on the kin profile instead of a stale per-kin string"
```

---

## PR11 · A11a: the vet bank's two doors

`src/lib/nav.ts:120` files this screen under Settings and marks it `contextual: true` so `railEntries()` filters it out
on purpose. That is correct and stays. The defect is that neither entry point the comment describes exists:
`grep -rn "vet-clinics" src` returns exactly two hits, `router.tsx:281` and `nav.ts:128`. 116 records, reachable only by
typing a URL.

**Files:**
- Modify: `src/screens/Settings.tsx` (add the section), `src/screens/settings/sections.tsx`
- Modify: `src/components/VetClinicPicker.tsx`, `src/components/VetClinicPicker.css`
- Test: `src/screens/Settings.test.tsx`, `src/components/VetClinicPicker.test.tsx`
- Android: `.../ui/screens/AdminSettingsScreen.kt`

**Interfaces:**
- Consumes: the existing `VetClinics` screen component unchanged. This PR adds routes into it, not features to it.
- Produces: a `vetClinics` entry in `SECTIONS` (`src/screens/Settings.tsx:84-103`), placed after `kinCare`, its closest
  analogue: a catalog the operator tidies rather than a preference.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/screens/Settings.test.tsx
it('offers a Vet clinics section after KinCare types', async () => {
  render(<Settings />);
  const nav = screen.getByRole('navigation', { name: /settings sections/i });
  const labels = within(nav).getAllByRole('button').map((b) => b.textContent);
  expect(labels).toContain('Vet clinics');
  expect(labels.indexOf('Vet clinics')).toBe(labels.indexOf('KinCare types') + 1);
});

// src/components/VetClinicPicker.test.tsx
it('links out to the bank so a wrong record can be fixed where it was found', () => {
  render(<VetClinicPicker value={null} onChange={vi.fn()} />, { wrapper: RouterWrapper });
  expect(screen.getByRole('link', { name: 'Manage clinics' })).toHaveAttribute('href', '/vet-clinics');
});
```

- [ ] **Step 2: Run them, watch both fail**

Run: `npx vitest run src/screens/Settings.test.tsx src/components/VetClinicPicker.test.tsx -t "Vet clinics|Manage clinics"`
Expected: FAIL twice. No such section, no such link.

- [ ] **Step 3: Add the section and the link**

```tsx
// src/screens/Settings.tsx, in SECTIONS
{ id: 'kinCare', label: 'KinCare types' },
{ id: 'vetClinics', label: 'Vet clinics' },
```

Render the existing `VetClinics` screen inside that section body. Then in `VetClinicPicker`, beside the search field:

```tsx
{/* The point of a shared bank: the person who spots a wrong phone number while
    picking is the person who should be able to correct it at the source, and
    VetClinics.tsx already promises "correcting a clinic here corrects it on
    every household linked to it". */}
<Link to="/vet-clinics" className="vetpicker__manage">Manage clinics</Link>
```

- [ ] **Step 4: Run to verify they pass, recapture goldens, Android parity, commit**

Run: `npm test && npm run typecheck && npm run visual:react`

```bash
git checkout main && git pull && git checkout -b feat/vet-bank-entry-points
git commit -m "Give the vet clinic bank the two doors nav.ts already documents"
```

---

## PR12 · A4: adopt the mocks' ease curve

All 29 mocks use `--ease: cubic-bezier(.2, .8, .2, 1)`. `src/styles/tokens.css:347` ships
`--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)`, the Material standard curve. One token governs every animation in the
admin, so this changes the feel of the nav drawer, toasts, the `rise` entrance stagger, card hover, and spinners at
once. No information changes.

**Files:**
- Modify: `src/styles/tokens.css`
- Test: `src/styles/tokens.test.ts`
- Android: `android/app/src/main/java/com/tribetails/auntieos/ui/components/AuntieMotion.kt` (the Compose easing that mirrors this token; it is under `ui/components`, not `ui/theme`)

**Interfaces:**
- Produces: no API change. `--ease-standard` keeps its name, so no consumer edits. `--ease-emphasized` is left alone:
  the mocks declare one curve and this replaces the one they correspond to.

- [ ] **Step 1: Write the failing test**

```ts
// src/styles/tokens.test.ts
it('ships the ease curve all 29 ui-ideas mocks specify', () => {
  expect(tokenValue('--ease-standard')).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/styles/tokens.test.ts -t "ease curve"`
Expected: FAIL, received `cubic-bezier(0.4, 0, 0.2, 1)`.

- [ ] **Step 3: Change the token**

```css
/* src/styles/tokens.css
   The curve all 29 ui-ideas mocks declare as --ease. Leaves fast, covers most of
   the distance early, settles into place over the remainder. Replaces the
   Material standard curve, which is near-symmetric and reads as stopping rather
   than settling. Operator verdict 2026-08-06. */
--ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
```

- [ ] **Step 4: Run test, then look at it**

Run: `npx vitest run src/styles/tokens.test.ts`
Expected: PASS.

Then drive the running app and watch the nav drawer open and a toast arrive. A token test proves the value; only
watching proves the value was worth changing.

- [ ] **Step 5: Recapture every golden**

Run: `npm run visual:react && npm run visual:react:verify`
The captures are pinned with reduced motion, so goldens should be byte-identical. **If any golden shifts, stop:** it
means a screen paints a mid-animation frame under `prefers-reduced-motion`, which is its own bug and belongs in its own
PR.

- [ ] **Step 6: Android parity, then commit**

```bash
git checkout main && git pull && git checkout -b feat/mock-ease-curve
git commit -m "Adopt the easing curve every mock specifies"
```

---

## PR13 · A6: the status LED

Mock `.led`: `width: 10px; height: 10px; border-radius: 50%; background: #0A8595; box-shadow: 0 0 10px #0A8595`, flat
and 50% opacity when off. Used in activity-log (the chain), settings (integration connected or not), members, and
kincare-types. Nothing in `src` does this. `PulsingBadge` is a different component: a count badge with a halo, which
answers "how many", never "is this live".

**Files:**
- Create: `src/components/StatusLed.tsx`, `src/components/StatusLed.css`, `src/components/StatusLed.test.tsx`
- Modify: `src/screens/settings/IntegrationsSection.tsx`, `src/screens/ActivityLog.tsx`
- Android: `.../ui/components/StatusLed.kt`

**Interfaces:**
- Produces: `StatusLed` with `{ state: 'live' | 'off' | 'unknown'; label: string }`. `label` is required and rendered as
  text beside the dot, never as the dot's only meaning. Three states, not a boolean, because a read that failed is not
  the same as an integration that is off, and the fail-loud rule makes that distinction the caller's to state.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/StatusLed.test.tsx
it('names the state in text, not only in colour', () => {
  render(<StatusLed state="live" label="Twilio" />);
  expect(screen.getByText('Twilio')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Twilio: connected' })).toBeInTheDocument();
});

it('distinguishes an unknown read from a known off', () => {
  const { rerender } = render(<StatusLed state="off" label="Google Calendar" />);
  expect(screen.getByRole('img', { name: 'Google Calendar: not connected' })).toBeInTheDocument();
  rerender(<StatusLed state="unknown" label="Google Calendar" />);
  expect(screen.getByRole('img', { name: 'Google Calendar: status unavailable' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, fail, implement**

Run: `npx vitest run src/components/StatusLed.test.tsx`
Expected: FAIL, module not found.

```css
/* src/components/StatusLed.css */
.led { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.led[data-state='live'] { background: var(--color-accent); box-shadow: 0 0 10px var(--color-accent); }
.led[data-state='off'] { background: var(--color-text-faint); opacity: 0.5; }
/* Unknown is deliberately NOT a dimmed "off": a failed read must not read as a
   confident answer. Hollow ring, no glow. */
.led[data-state='unknown'] { background: transparent; border: 1.5px solid var(--color-text-faint); }
```

- [ ] **Step 3: Wire Integrations and the Activity Log chain, then commit**

```bash
git checkout main && git pull && git checkout -b feat/status-led
git commit -m "Add the mocks' status LED and use it for integrations and the activity chain"
```

---

## PR14 · A7: cchip, pip, pawtag

Three small mock components with no analogue. `.cchip` is a mono count chip whose number is teal and bold. `.pip` is an
inline icon-plus-label meta pip at 11px. `.pawtag` is a paw glyph pinned to the corner of an event card at 50% opacity.

**Files:**
- Create: `src/components/CountChip.tsx`, `src/components/MetaPip.tsx`, one shared `src/components/Bits.css`
- Test: `src/components/Bits.test.tsx`
- Modify: `src/screens/VetClinics.tsx`, `src/screens/Templates.tsx`, `src/screens/FormSchemas.tsx` (counts),
  `src/screens/FormSchemas.tsx` (the `v2 · 07-18 · by …` meta line becomes pips)
- Modify: `src/screens/Schedule.css` (pawtag on the day-cell event)
- Android: `.../ui/components/Bits.kt`

**Interfaces:**
- Produces: `CountChip` with `{ count: ResolvedScalar<number>; noun: string }` and `MetaPip` with
  `{ glyph: string; label: string }`.
- `CountChip` takes `ResolvedScalar<number>`, not `number`, for the reason `StatCard` documents at
  `DenScreenKit.tsx:78-92`: a count rendered beside a noun is a claim, and a permission-denied read must render as
  unknown rather than as zero.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/Bits.test.tsx
it('renders a resolved count with its noun', () => {
  render(<CountChip count={{ kind: 'value', value: 116 }} noun="clinics" />);
  expect(screen.getByText('116')).toBeInTheDocument();
  expect(screen.getByText('clinics')).toBeInTheDocument();
});

it('does not render a number for a failed read', () => {
  render(<CountChip count={{ kind: 'error', message: 'permission-denied' }} noun="clinics" />);
  expect(screen.queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByTitle('permission-denied')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, fail, implement, adopt on the four screens, commit**

Run: `npx vitest run src/components/Bits.test.tsx`
Expected: FAIL, module not found.

```bash
git checkout main && git pull && git checkout -b feat/count-chip-and-pips
git commit -m "Add the mocks' count chip and meta pip, and use them where counts are prose today"
```

---

## PR15 · A2: indet, wag, expand

Three of the four unshipped keyframes. The fourth, `flow`, needs the route renderer and lands in PR18.

**Files:**
- Create: `src/components/IndeterminateBar.tsx`, `src/components/IndeterminateBar.css`, `src/components/IndeterminateBar.test.tsx`
- Modify: `src/components/MediaUploadDialog.tsx`, `src/components/MediaUploadDialog.css` (`indet`)
- Modify: `src/screens/KinTaleCompose.css`, `src/components/Avatar.css` (`wag`)
- Modify: `src/screens/ConversationThread.css`, `src/screens/Inbox.css` (`expand`)
- Test: `src/components/MediaUploadDialog.test.tsx`
- Android: the matching composables

**Interfaces:**
- Produces: three keyframes in the files that use them, at the mocks' exact values:
  `@keyframes indet { 0% { margin-left: -42% } 100% { margin-left: 100% } }`,
  `@keyframes wag { 0%, 100% { transform: rotate(-8deg) } 50% { transform: rotate(12deg) } }`,
  `@keyframes expand { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: translateY(0) } }`.

- [ ] **Step 1: Read the constraint before writing anything**

`MediaUploadDialog.tsx:20` says the stage text exists instead of *"a fabricated byte-progress percentage the app has no
way to track honestly."* That decision stands. An **indeterminate** bar is compatible with it: it claims "working,
duration unknown", which is true. Converting it to a percentage would violate the fail-loud rule. The bar accompanies
the existing stage line; it does not replace it.

- [ ] **Step 2: Write the failing test**

`MediaUploadDialog` keeps `stage` in internal state (`const [stage, setStage] = useState<UploadStage | null>(null)` at
`MediaUploadDialog.tsx:67`), so it cannot be driven by a prop. Test the bar as its own component, then one integration
test that drives the dialog through a mocked upload.

```tsx
// src/components/IndeterminateBar.test.tsx
it('claims no percentage', () => {
  render(<IndeterminateBar label="Uploading" />);
  const bar = screen.getByRole('progressbar', { name: 'Uploading' });
  expect(bar).not.toHaveAttribute('aria-valuenow');
  expect(bar).not.toHaveAttribute('aria-valuemax');
});
```

```tsx
// src/components/MediaUploadDialog.test.tsx
it('shows the bar beside the stage line while an upload is in flight, and drops it after', async () => {
  let release: (v: unknown) => void = () => {};
  vi.mocked(uploadMedia).mockImplementation(() => new Promise((r) => { release = r; }));
  render(<MediaUploadDialog entityId="kin1" onDone={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /upload/i }));
  expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  // The bar ACCOMPANIES the stage line, it does not replace it.
  expect(screen.getByText('Uploading to Cloudinary…')).toBeInTheDocument();
  release({ ok: true });
  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
});
```

The missing `aria-valuenow` is the assertion that matters: it is how an indeterminate bar tells a screen reader it does
not know the progress, and it is the machine-checkable form of the honesty rule above. Verify the real prop names on
`MediaUploadDialogProps` (`MediaUploadDialog.tsx:12`) before writing the integration test; `entityId` and `onDone` above
are the expected shape, not a confirmed one.

- [ ] **Step 3: Run, fail, implement all three, respect reduced motion**

Run: `npx vitest run src/components/MediaUploadDialog.test.tsx`
Expected: FAIL, no progressbar role in the dialog.

`wag` runs only on hover or while a visit is active, never as an idle loop on a list. `expand` runs once on open. Both
sit under the portal's global guard pattern (`mytribe/web/src/styles/base.css:153`), which the admin should adopt in
this PR if it has not already:

```css
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
```

- [ ] **Step 4: Run everything, Android parity, commit**

```bash
git checkout main && git pull && git checkout -b feat/mock-micro-animations
git commit -m "Add the indet, wag and expand animations the mocks specify"
```

---

## PR16 · A8: sticky preview columns

`position: sticky` appears in 5 mocks and exactly one file in `src`, `Settings.css:27` for the section rail. No preview column uses it. (An earlier draft said zero files; that grep searched `position:sticky` without a space and missed the formatted source. Corrected 2026-08-06.) The kintale-composer and kintale-report mocks both pin
`.side { position: sticky; top: 24px }`; the invites mock pins `.form { position: sticky; top: 22px }`. PR3 already
makes the template editor's preview sticky, so this covers the remaining three.

**Files:**
- Modify: `src/screens/KinTaleCompose.css`, `src/screens/KinTaleDetail.css`, `src/screens/Invites.css` (created in PR5)
- Test: `src/screens/KinTaleCompose.test.tsx`
- Android: not applicable. Sticky is a scroll behavior of the two-column desktop layout; the Android screens are single-column.

**Interfaces:**
- Produces: no JS. Three CSS rules.

- [ ] **Step 1: Write the failing test**

```tsx
// src/screens/KinTaleCompose.test.tsx
it('pins the preview column so it survives a long form', () => {
  render(<KinTaleCompose reportId="r1" />);
  const side = screen.getByTestId('kintale-side');
  expect(getComputedStyle(side).position).toBe('sticky');
});
```

- [ ] **Step 2: Run, fail, add the rule, commit**

Run: `npx vitest run src/screens/KinTaleCompose.test.tsx -t "pins the preview"`
Expected: FAIL, computed position is `static`.

```css
/* Matches .side in the kintale-composer and kintale-report mocks. The form is
   the tallest thing on this screen, and a preview that scrolls away is a
   preview of something you can no longer see. */
.kintale__side { position: sticky; top: 1.5rem; align-self: start; }
```

`align-self: start` is required: in a grid, a stretched item has no room to move, so sticky silently does nothing
without it. This is the single most common way this rule gets shipped broken.

```bash
git checkout main && git pull && git checkout -b feat/sticky-preview-columns
git commit -m "Pin the preview columns the mocks specify as sticky"
```

---

## PR17 · A1: the Schedule hour grid

The Schedule mock declares `--hour` and paints hour rules with
`repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--hour) - 1px), var(--line-2) var(--hour))`,
plus a `.times` mono gutter, event blocks positioned and sized by time, and an `.is-today` coral tint. Shipped
`Schedule.css:145` is `grid-template-columns: repeat(7, minmax(0, 1fr))` of `.schedule__day-cell`. Duration and overlap
are invisible: two visits at 9:00 and 9:15 render identically to two at 9:00 and 17:00.

Largest package in either wave.

**Files:**
- Create: `src/lib/scheduleLayout.ts`, `src/lib/scheduleLayout.test.ts`
- Create: `src/screens/ScheduleWeekGrid.tsx`, `src/screens/ScheduleWeekGrid.css`, `src/screens/ScheduleWeekGrid.test.tsx`
- Modify: `src/screens/Schedule.tsx` (Week tab renders the grid; Day and Month unchanged)
- Android: `.../ui/screens/ScheduleViewScreen.kt`

**Interfaces:**
- Consumes: `ScheduleSessionEntry` from `src/api/schedule.ts`, and the local-day helpers already in
  `src/lib/sessionFormat.ts`. All time reasoning stays local-time per AO-18.
- Produces:
  `layoutDay(entries: readonly ScheduleSessionEntry[], dayStartMs: number): PlacedEvent[]` where
  `interface PlacedEvent { entry: ScheduleSessionEntry; topMinutes: number; heightMinutes: number; column: number; columns: number }`.
  `column` and `columns` are the overlap split: three events that mutually overlap come back as
  `columns: 3` with `column` 0, 1, 2, and the component turns that into `left`/`right` percentages. Placement is pure
  and unit-tested without rendering.

- [ ] **Step 1: Write the failing layout tests**

```ts
// src/lib/scheduleLayout.test.ts
const DAY = new Date('2026-08-06T00:00:00').getTime();

it('places an event by its local start and duration', () => {
  const [p] = layoutDay([session({ start: '2026-08-06T09:00:00', end: '2026-08-06T10:30:00' })], DAY);
  expect(p.topMinutes).toBe(540);
  expect(p.heightMinutes).toBe(90);
  expect(p).toMatchObject({ column: 0, columns: 1 });
});

it('splits two overlapping events into two columns', () => {
  const placed = layoutDay([
    session({ start: '2026-08-06T09:00:00', end: '2026-08-06T10:00:00' }),
    session({ start: '2026-08-06T09:15:00', end: '2026-08-06T09:45:00' }),
  ], DAY);
  expect(placed.map((p) => p.columns)).toEqual([2, 2]);
  expect(placed.map((p) => p.column)).toEqual([0, 1]);
});

it('does not split events that merely touch', () => {
  const placed = layoutDay([
    session({ start: '2026-08-06T09:00:00', end: '2026-08-06T10:00:00' }),
    session({ start: '2026-08-06T10:00:00', end: '2026-08-06T11:00:00' }),
  ], DAY);
  expect(placed.every((p) => p.columns === 1)).toBe(true);
});

it('gives a zero-length or unparseable session a floor height so it stays clickable', () => {
  const [p] = layoutDay([session({ start: '2026-08-06T09:00:00', end: '2026-08-06T09:00:00' })], DAY);
  expect(p.heightMinutes).toBeGreaterThanOrEqual(15);
});

it('keeps an event that starts before the day at the top rather than dropping it', () => {
  const [p] = layoutDay([session({ start: '2026-08-05T23:00:00', end: '2026-08-06T01:00:00' })], DAY);
  expect(p.topMinutes).toBe(0);
  expect(p.heightMinutes).toBe(60);
});
```

The last two are the fail-loud cases. A session with a bad or equal timestamp must still be visible and clickable, not
a zero-height sliver, and an overnight session must clamp rather than vanish.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/scheduleLayout.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement placement, then the grid**

Sweep the day's entries sorted by start, grouping any run that mutually overlaps into a cluster, and assign each member
the lowest free column within its cluster. `columns` is the cluster width. Then:

```css
/* src/screens/ScheduleWeekGrid.css */
.swg { --hour: 3rem; display: grid; grid-template-columns: 2.5rem repeat(7, minmax(0, 1fr)); }
.swg__day {
  position: relative;
  border-right: 1px solid var(--color-border-soft);
  background: repeating-linear-gradient(
    to bottom, transparent 0, transparent calc(var(--hour) - 1px), var(--color-border-soft) var(--hour)
  );
}
.swg__day--today { background:
  repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--hour) - 1px), var(--color-border-soft) var(--hour)),
  linear-gradient(180deg, color-mix(in srgb, var(--color-coral) 7%, transparent), transparent); }
.swg__ev { position: absolute; border-radius: 5px; border-left: 2px solid var(--color-accent); overflow: hidden; }
```

`top` and `height` come from `topMinutes` and `heightMinutes` as `calc(var(--hour) / 60 * Npx)`; `left` and `right` from
`column` and `columns`. Each event is a real `<button>` opening the existing detail modal, so the grid inherits keyboard
access rather than reinventing it.

- [ ] **Step 4: Run tests, add the component test**

```tsx
// src/screens/ScheduleWeekGrid.test.tsx
it('renders an hour gutter and one button per session', async () => {
  render(<ScheduleWeekGrid entries={[session({ start: '2026-08-06T09:00:00', end: '2026-08-06T10:00:00' })]} weekStart={DAY} />);
  expect(screen.getByText('9')).toBeInTheDocument();
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
```

- [ ] **Step 5: Wire the Week tab, recapture goldens, e2e, Android parity, commit**

Day and Month tabs keep their current rendering; only Week changes. Run
`npm test && npm run typecheck && npm run e2e && npm run visual:react`.

```bash
git checkout main && git pull && git checkout -b feat/schedule-hour-grid
git commit -m "Give the Schedule week view hour resolution so duration and overlap are visible"
```

---

## PR18 · A3: the web GPS route view, and the flow keyframe

`stroke-dasharray` appears in 2 mocks and 0 files in `src`. `gpsRoute` and `gpsSummary` sit on the KinTale model with no
consumer (`src/api/kinTales.ts:40`). Android already ships the real thing: `RouteViewerScreen.kt` draws a Mapbox
`PolylineAnnotation` with `MapboxConfig.ROUTE_LINE_COLOR`, so the treasure-map metaphor from the Android mock set was
already rejected in code.

**Files:**
- Create: `src/components/RouteTrace.tsx`, `src/components/RouteTrace.css`, `src/components/RouteTrace.test.tsx`
- Create: `src/lib/routeGeometry.ts`, `src/lib/routeGeometry.test.ts`
- Modify: `src/api/kinTales.ts` (widen the read to carry `gpsRoute` and `gpsSummary`)
- Modify: `src/screens/KinTaleDetail.tsx`
- Android: none. `RouteViewerScreen.kt` already covers this.

**Interfaces:**
- Consumes: the shape the portal already serves, `RoutePointDto { lat: number; lng: number; t?: number }` and
  `GpsSummaryDto { distanceMeters?: number; durationSeconds?: number; route?: RoutePointDto[]; computedAt?: string }`
  (`mytribe/functions/src/portal/getMyKinTales.ts:18-30`). No new callable: the admin reads
  `kin_care_reports` directly, and these fields are already on the document.
- Produces: `projectRoute(points: readonly RoutePoint[], width: number, height: number): { d: string; stops: Pt[] }`,
  an equirectangular projection scaled to the box with a 6px inset. Pure, unit-tested, no map tiles. A tile-backed map
  is a separate decision with a Mapbox bill attached; this renders the trace the mocks draw.

- [ ] **Step 1: Write the failing geometry tests**

```ts
// src/lib/routeGeometry.test.ts
it('projects two points to a straight path inside the box', () => {
  const { d } = projectRoute([{ lat: 30.2, lng: -97.8 }, { lat: 30.3, lng: -97.7 }], 200, 100);
  expect(d).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
});

it('returns an empty path for fewer than two points rather than a degenerate one', () => {
  expect(projectRoute([{ lat: 30.2, lng: -97.8 }], 200, 100).d).toBe('');
  expect(projectRoute([], 200, 100).d).toBe('');
});

it('survives a route with no spread without dividing by zero', () => {
  const { d } = projectRoute([{ lat: 30.2, lng: -97.8 }, { lat: 30.2, lng: -97.8 }], 200, 100);
  expect(d).not.toMatch(/NaN/);
});
```

The third test is the one that would otherwise ship a blank card: a stationary drop-in visit has identical points, and
a naive `(v - min) / (max - min)` gives `NaN` for every coordinate.

- [ ] **Step 2: Run, fail, implement geometry then the component**

Run: `npx vitest run src/lib/routeGeometry.test.ts`
Expected: FAIL, module not found.

```css
/* src/components/RouteTrace.css */
@keyframes flow { to { stroke-dashoffset: -28; } }
.routetrace__line {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 2.5;
  stroke-dasharray: 6 8;
  stroke-linecap: round;
  animation: flow 1.1s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .routetrace__line { animation: none; } }
```

- [ ] **Step 3: Write the component test**

```tsx
// src/components/RouteTrace.test.tsx
it('states the distance and duration it was given, and nothing it was not', () => {
  render(<RouteTrace route={[{ lat: 30.2, lng: -97.8 }, { lat: 30.3, lng: -97.7 }]} summary={{ distanceMeters: 1287 }} />);
  expect(screen.getByText('0.8 mi')).toBeInTheDocument();
  expect(screen.queryByText(/min/)).not.toBeInTheDocument();
});

it('says a visit has no route instead of drawing an empty box', () => {
  render(<RouteTrace route={[]} summary={{}} />);
  expect(screen.getByText('No route recorded for this visit')).toBeInTheDocument();
  expect(document.querySelector('svg')).toBeNull();
});
```

- [ ] **Step 4: Widen the KinTale read, wire the detail screen, commit**

Add `gpsRoute` and `gpsSummary` to the `kin_care_reports` subset type in `src/api/kinTales.ts`, keeping every field
optional per the comment at :45.

```bash
git checkout main && git pull && git checkout -b feat/web-route-trace
git commit -m "Draw the KinTale GPS route on the web admin, with the mocks' flow animation"
```

---

## PR19 · A9 and A10: mock-source hygiene

No application code. Both are bookkeeping about where design authority lives, and they belong together because both
edit the mock inventory.

**Files:**
- Move: `auntieos-admin/ui-ideas/ANDROID-STYLE-MOCKS/` to `mytribe/ui-ideas/ANDROID-STYLE-MOCKS/`
- Modify: `auntieos-admin/web/visual/manifest.json`
- Modify: `mytribe/CLAUDE.md` (note the arriving folder and what it is)
- Modify: `auntieos-admin/docs/2026-07-25-mock-vs-shipped-ui.md` (its counts cite this folder)

- [ ] **Step 1: Move the folder with history**

All 13 images are Kinfolk-facing: every one is headed "The [Family Name] Tribe" with a "Message Auntie" button and a
5-icon bottom tab bar. `CLAUDE.md` says the portal keeps its mockups in `mytribe/ui-ideas/` and "a portal screen is
never answered from here."

```bash
git checkout main && git pull && git checkout -b chore/mock-source-hygiene
git mv auntieos-admin/ui-ideas/ANDROID-STYLE-MOCKS mytribe/ui-ideas/ANDROID-STYLE-MOCKS
```

- [ ] **Step 2: Fix the manifest entry it invalidates**

`web/visual/manifest.json:29` currently says template-assignment has no mock. It does:
`EmailTemplateAssignment.png`, which the move relocates. Replace the `notes` with the new path and what the image
proposes, so the F-series remock starts from a fact instead of a question.

- [ ] **Step 3: Update the two docs that cite the old counts, then verify**

`docs/2026-07-25-mock-vs-shipped-ui.md` states mock inventory counts measured over this folder's old location. Correct
the paths, not the numbers.

Run: `npm run visual:react:verify`
Expected: PASS unchanged. The manifest's `screens` array is untouched, so no golden moves.

- [ ] **Step 4: Commit**

```bash
git commit -m "File the Kinfolk-facing mock set under mytribe, and record the template-assignment mock it contains"
```

---

# Wave 3: the MyTribe portal

The portal sweep (2026-08-06) is not yet ruled on, so only the one approved item is scheduled here. The rest wait on
verdicts.

**Standing context, operator 2026-08-06: the portal is NOT live to kinfolk yet.** That changes severity, not
correctness. Nothing below is a customer-facing incident; it is all pre-launch. Re-read any finding written before this
was known, including in the appendix, with that in mind.

---

## PR20 · Portal pre-launch polish: the SUGGESTION pill and the wordmark collision

Two cosmetic defects found by driving `kinfolk.tribetails.com`. Grouped because both are single-line CSS/JSX fixes on
the customer-facing app, and splitting them would cost more in CI time than the diff is worth.

**Files:**
- Modify: `mytribe/web/src/screens/Schedule.tsx` (line 243)
- Modify: `mytribe/web/src/styles/tribe.css` (the `.sugtag` rule at line 47)
- Modify: the sign-in wordmark rule in `mytribe/web/src/styles/auth.css`
- Test: `mytribe/web/src/screens/Schedule.test.tsx`

**Interfaces:**
- Produces: nothing. Both changes remove or space existing markup.

- [ ] **Step 1: Write the failing test**

```tsx
// mytribe/web/src/screens/Schedule.test.tsx
it('does not render reviewer annotations to kinfolk', async () => {
  render(<Schedule />, { wrapper: RouterWrapper });
  expect(await screen.findByText('Good to know')).toBeInTheDocument();
  expect(screen.queryByText('SUGGESTION')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mytribe/web && npx vitest run src/screens/Schedule.test.tsx -t "reviewer annotations"`
Expected: FAIL. The pill renders, so `queryByText('SUGGESTION')` finds it.

- [ ] **Step 3: Remove the annotation**

```tsx
// mytribe/web/src/screens/Schedule.tsx:243
// was: Good to know <span className="sugtag">SUGGESTION</span>
Good to know
```

`.sugtag` at `tribe.css:47` is commented "SUGGESTION tag for anything outside the contract". It is a reviewer
affordance, not product UI. Delete the rule too, and grep for other users first:

```bash
grep -rn "sugtag\|SUGGESTION" mytribe/web/src
```

At the time of writing the only render site is `Schedule.tsx:243`; `TribePicker.tsx:14` merely mentions the word in a
comment and stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mytribe/web && npx vitest run src/screens/Schedule.test.tsx`
Expected: PASS.

- [ ] **Step 5: Fix the sign-in wordmark collision**

On `/signin` the wordmark and its eyebrow have no gap: "Tribe Tails" runs into "PET CARE PORTAL" with the `s` touching
the `P`. Find the rule that lays out those two elements in `auth.css` and give the row a gap rather than adding a
margin to one child:

```css
/* The wordmark and the eyebrow are siblings on one row. Space them with the
   row's own gap so neither element carries a margin the other has to know about. */
.auth__brand { display: flex; align-items: baseline; gap: 0.6rem; }
```

Confirm by driving the page, not by reading the CSS: the two strings must not touch at any viewport width.

- [ ] **Step 6: Commit**

```bash
git checkout main && git pull && git checkout -b fix/portal-prelaunch-polish
git add mytribe/web/src/screens/Schedule.tsx mytribe/web/src/screens/Schedule.test.tsx mytribe/web/src/styles/tribe.css mytribe/web/src/styles/auth.css
git commit -m "Remove the SUGGESTION reviewer tag from Schedule and space the sign-in wordmark"
```

---

## Wave 3 sequencing

All portal and payment items were ruled on 2026-08-06. `PR21` runs first and is not optional: subagents execute in
worktrees, and until the mock sources are tracked a worktree contains zero admin mocks while this plan cites them as
the spec.

```
PR20  P10 + U4   portal polish + the two stale refund comments   (written above)
PR21  P5         track the mock sources in git                   RUN FIRST
PR22  P1         enRoute as its own timeline step
PR23  P2         share dialog: expiry, passcode, revoke
PR24  P3         photo-first KinTale cards
PR25  P4         KinTale visit facts: times, route, checklist
PR26  P6         guard SHARE_LINK_BASE_URL, cut over to the SSR page
PR27  P7         per-key notification toggles
PR28  P8         gate the tribe picker to operators
PR29  U6         capture the Stripe fee in the webhook
PR30  U8         payment method registry + CTAs on the portal invoice
PR31  U7         tip line on Stripe checkout                     (needs PR30's registry)
PR32  U1         kinfolk can update their payment method
PR33  U2         household contacts on the Tribe tab
PR34  U3         portal visual manifest + re-mock Messages
PR35  U5         split generated contracts per app
```

`PR31` after `PR30`: the tip line changes what the Stripe button charges, and PR30 decides how that button is
configured. `PR29` before `PR31` for the same reason: once a tip can arrive through Stripe, the webhook that records
it must already know how to split amount from tip and capture the fee.

---

## PR21 · P5: track the mock sources in git

> **This is PR0 in execution order.** It is numbered into Wave 3 because that sweep found it, but it blocks every other
> PR in this plan, Wave 1 included. Do not start anything else until it is merged.

`.gitignore:19` is `ui-ideas/`, which matches that directory at any depth. Result: 0 of 29 admin mocks tracked, and 19
of 22 portal mocks, where the 3 missing are exactly the 3 whose filenames carry operator directives.

**Files:**
- Modify: `.gitignore`
- Add: `auntieos-admin/ui-ideas/**`, `mytribe/ui-ideas/**`
- Modify: `auntieos-admin/CLAUDE.md` (the design-authority section claims these are readable)

- [ ] **Step 1: Confirm the damage before changing anything**

```bash
for f in auntieos-admin/ui-ideas/*.html mytribe/ui-ideas/*.html; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || echo "UNTRACKED $f"
done | wc -l
```
Expected: 32 (29 admin + 3 portal).

- [ ] **Step 2: Un-ignore, keeping every other `ui-ideas` rule intact**

```gitignore
# ui-ideas holds design authority source 2 (see auntieos-admin/CLAUDE.md), so it
# must survive a clone and a worktree. It was ignored wholesale, which left every
# admin mock and the three directive-carrying portal mocks on one machine only.
!*/ui-ideas/
!*/ui-ideas/**
```

- [ ] **Step 3: Add them, including the rejected folder**

```bash
git add -f auntieos-admin/ui-ideas mytribe/ui-ideas
git status --short | wc -l
```
`WrongUIDesigns-UpdateKill/` is tracked too. A rejected design is evidence: `CLAUDE.md` forbids building from it, and
an agent cannot honor that rule for a file it cannot see.

- [ ] **Step 4: Prove a worktree now sees them**

```bash
git worktree add ../tribetails-worktrees/mock-check HEAD
ls ../tribetails-worktrees/mock-check/auntieos-admin/ui-ideas/*.html | wc -l   # expect 29
ls ../tribetails-worktrees/mock-check/mytribe/ui-ideas/*.html | wc -l          # expect 22
git worktree remove ../tribetails-worktrees/mock-check
```

This is the acceptance test for the whole PR. Everything else in Wave 3 depends on it.

- [ ] **Step 5: Correct CLAUDE.md and commit**

The design-authority section describes `page-specs/` as gitignored and says nothing about `ui-ideas`. Say plainly that
both are now tracked, and that `page-specs/` remains the exception.

```bash
git checkout main && git pull && git checkout -b chore/track-mock-sources
git commit -m "Track the mock sources so design authority survives a clone"
```

---

## PR30 · U8: the payment method registry

Operator, 2026-08-06: three CTAs now, *"but build out for other more payment options"*. So this is **not** three
hardcoded buttons. It is a configured list, rendered from settings, that grows without a code change to the portal.

`venmoHandle`, `paypalHandle` and `cashappHandle` already exist in `auntieos-admin/src/api/settings.ts:138-140` and
already reach `invoicePdf.ts:357` as a printed "How to pay" line. The portal cannot read them at all.

**Files:**
- Create: `mytribe/functions/src/lib/paymentMethods.ts`, `+ test`
- Modify: `mytribe/functions/src/portal/getMyHome.ts` (carry the enabled methods)
- Create: `mytribe/web/src/components/PayOptions.tsx`, `.css`, `+ test`
- Modify: `mytribe/web/src/screens/InvoiceDetail.tsx` (replace the single Pay button)
- Modify: `auntieos-admin/src/api/settings.ts`, the Payments settings section
- Android: the invoice detail composable

**Interfaces:**
- Produces: `interface PayMethod { id: 'stripe' | 'venmo' | 'paypal' | 'cashapp'; label: string; kind: 'checkout' | 'link'; url: string | null }`
  and `resolvePayMethods(settings: OperatorSettings, invoice: InvoiceDto): PayMethod[]`, which returns only methods
  that are configured and usable. `kind: 'checkout'` means the existing `payInvoice` flow; `kind: 'link'` means
  navigate to `url`.
- Adding a processor later is one entry in `METHOD_SPECS` plus a settings field. No portal change.

- [ ] **Step 1: Write the failing resolver tests**

```ts
// mytribe/functions/src/lib/paymentMethods.test.ts
it('omits a method whose handle is blank rather than rendering a dead button', () => {
  const out = resolvePayMethods({ venmoHandle: '', paypalHandle: 'auntie', cashappHandle: '' }, invoice());
  expect(out.map((m) => m.id)).toEqual(['stripe', 'paypal']);
});

it('normalizes a handle written any of the three ways an operator writes it', () => {
  for (const raw of ['auntie', '@auntie', 'https://venmo.com/u/auntie']) {
    const [venmo] = resolvePayMethods({ venmoHandle: raw }, invoice()).filter((m) => m.id === 'venmo');
    expect(venmo.url).toBe('https://venmo.com/u/auntie');
  }
});

it('supports Cash App, which settings already carries', () => {
  const out = resolvePayMethods({ cashappHandle: '$auntie' }, invoice());
  expect(out.find((m) => m.id === 'cashapp')?.url).toBe('https://cash.app/$auntie');
});

it('always offers Stripe, which needs no handle', () => {
  expect(resolvePayMethods({}, invoice()).map((m) => m.id)).toEqual(['stripe']);
});

it('offers nothing on a settled invoice', () => {
  expect(resolvePayMethods({ venmoHandle: 'auntie' }, invoice({ amountDue: 0 }))).toEqual([]);
});
```

The normalization test is the one that matters. These handles are free text an operator typed months ago, and a
half-parsed handle produces a button that opens a 404 with a bill attached.

- [ ] **Step 2: Run, fail, implement as a spec table**

Run: `cd mytribe/functions && npx vitest run src/lib/paymentMethods.test.ts`
Expected: FAIL, module not found.

```ts
// One entry per processor. Adding Zelle or Apple Pay later is a row here plus a
// settings field, and the portal does not change.
const METHOD_SPECS = [
  { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', field: null, base: null, strip: '' },
  { id: 'venmo', label: 'Pay with Venmo', kind: 'link', field: 'venmoHandle', base: 'https://venmo.com/u/', strip: '@' },
  { id: 'paypal', label: 'Pay with PayPal', kind: 'link', field: 'paypalHandle', base: 'https://paypal.me/', strip: '@' },
  { id: 'cashapp', label: 'Pay with Cash App', kind: 'link', field: 'cashappHandle', base: 'https://cash.app/', strip: '' },
] as const;
```

Normalization: if the value already starts `http`, take it as the URL. Otherwise strip the spec's `strip` prefix and
append to `base`. Cash App keeps its `$`, because `cash.app/$auntie` is the real form.

- [ ] **Step 3: Carry the methods to the portal**

`getMyHome` gains `payMethods: PayMethod[]`. Do NOT send raw handles: the portal needs a URL and a label, not the
operator's account identifiers, and a resolved list keeps the parsing in one tested place.

- [ ] **Step 4: Write the failing component test, then build PayOptions**

```tsx
// mytribe/web/src/components/PayOptions.test.tsx
it('renders one CTA per configured method, Stripe first', () => {
  render(<PayOptions methods={[stripe(), venmo(), cashapp()]} amountDue={12750} onCheckout={vi.fn()} />);
  expect(screen.getAllByRole('button').concat(screen.getAllByRole('link')).map((e) => e.textContent))
    .toEqual(['Pay with Credit Card', 'Pay with Venmo', 'Pay with Cash App']);
});

it('says how a link method settles, because it cannot enforce the amount', () => {
  render(<PayOptions methods={[venmo()]} amountDue={12750} onCheckout={vi.fn()} />);
  expect(screen.getByText(/Send \$127\.50/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Pay with Venmo' })).toHaveAttribute('rel', 'noopener noreferrer');
});
```

The second test earns its place: Venmo cannot be handed an amount, so the screen must state the figure to send or the
household guesses and you reconcile it by hand.

- [ ] **Step 5: Replace the single button, Android parity, commit**

`InvoiceDetail.tsx:277` currently renders one `Pay {amount}`. It becomes `<PayOptions>`. Stripe keeps the existing
`payInvoice` call; link methods are plain anchors.

```bash
git checkout main && git pull && git checkout -b feat/payment-method-registry
git commit -m "Offer every configured payment processor on the portal invoice"
```

---

## PR29 · U6: capture the Stripe fee in the webhook

`billing/stripeWebhook.ts` records `amount_paid` / `amount_received` and stores no fee and no tip. Venmo and PayPal are
manual and therefore complete. So the only auto-recorded processor is the only one losing the fee, and it is also the
only one whose fee is machine-readable.

**Files:**
- Modify: `mytribe/functions/src/billing/stripeWebhook.ts`
- Test: `mytribe/functions/test/stripeWebhook.test.ts`

**Interfaces:**
- Writes the existing `feeCents` field that `recordPayment` already writes and `InvoiceLedger` already renders. No new
  field, no new column.

- [ ] **Step 1: Write the failing test**

```ts
it('stores the processor fee from the balance transaction', async () => {
  stripeMock.balanceTransactions.retrieve.mockResolvedValue({ fee: 271 });
  await handleEvent(checkoutCompleted({ amount_paid: 13750, balance_transaction: 'txn_1' }));
  expect(await paymentDoc()).toMatchObject({ amountCents: 13750, feeCents: 271 });
});

it('records the payment with the fee unset when Stripe does not return one, and says so', async () => {
  stripeMock.balanceTransactions.retrieve.mockRejectedValue(new Error('not available'));
  await handleEvent(checkoutCompleted({ amount_paid: 13750, balance_transaction: 'txn_1' }));
  const doc = await paymentDoc();
  expect(doc.amountCents).toBe(13750);
  expect(doc.feeCents).toBeUndefined();
  expect(doc.feeResolved).toBe(false);
});
```

The second test follows the pattern this file already uses for amounts: it flags `amountResolved: false` and warns
loudly rather than recording a silent zero. A `feeCents: 0` would be a claim that Stripe charged nothing.

- [ ] **Step 2: Run, fail, implement**

Run: `cd mytribe/functions && npx vitest run test/stripeWebhook.test.ts`
Expected: FAIL, `feeCents` undefined on the happy path.

The fee lives on the charge's balance transaction, not the event, so it needs one retrieve. Never let that call fail
the webhook: the payment is real whether or not the fee resolves.

- [ ] **Step 3: Commit**

```bash
git checkout main && git pull && git checkout -b feat/stripe-fee-capture
git commit -m "Record the Stripe processor fee so it survives to tax time"
```

---

## PR22 to PR28, PR31 to PR35

Each carries its evidence in the appendix and its verdict above. They are conventional screen work against a named
mock, so they follow the same shape as Wave 1: write the failing test, run it, implement, run it, recapture goldens,
Android parity, commit.

| PR | Item | Primary files | The one thing not to get wrong |
|---|---|---|---|
| PR22 | P1 enRoute step | `lib/portalFormat.ts:138`, `screens/BookingDetail.tsx` | `enRoute` and `active` are distinct in `BookingStatus`; only the timeline collapsed them. Do not add a status. |
| PR23 | P2 share dialog | `web/src/screens/KinTales.tsx`, `api/kinTalesApi.ts:177` | The backend already takes `expiresInDays` 1 to 90 and a 4 to 8 char `passcode`. Send them; do not widen the contract. `revokeShareLink` needs its first caller. |
| PR24 | P3 photo-first cards | `screens/KinTales.tsx`, `styles/kintales.css` | A tale with no photo must not render an empty hero. Keep the text-only card as its own branch. |
| PR25 | P4 visit facts | `screens/KinTales.tsx`, `api/kinTalesApi.ts` | Shares the route renderer with admin PR18. Build PR18 first or extract `RouteTrace` here and let PR18 consume it. |
| PR26 | P6 share URL | `functions/src/share/createShareLink.ts:77` | Guard before the Firestore write, not after: today the doc and audit entry exist even when the URL is broken. |
| PR27 | P7 per-key toggles | `screens/NotificationSettings.tsx:150,176,187` | `byKey` already round-trips through the component. Write it; do not reshape the prefs document. |
| PR28 | P8 gate the picker | `web/src/screens/TribePicker.tsx:12`, `router.tsx` | One kinfolk, one tribe (operator ruling). Gate on operator and correct the comment. Keep the multi-tribe fan-out: it is correct for operators. |
| PR31 | U7 Stripe tip line | `functions/src/portal/payInvoice.ts:24` | Checkout charges the remaining balance exactly. A tip becomes a second line item, and the webhook must split amount from tip, which is why PR29 lands first. |
| PR32 | U1 update card | `web/src/screens/Account.tsx:281` | Needs a Stripe SetupIntent. Largest of the U series. Status text today is read-only and truthful; keep it truthful while adding the action. |
| PR33 | U2 contacts on Tribe | `web/src/screens/TribeHub.tsx`, `TribeProfile.tsx` | Placement only. `InviteKinfolkCard` and the primary-permissions ruling are unchanged: a primary's entitlements are never rendered as switches. |
| PR34 | U3 portal manifest | create `mytribe/web/visual/manifest.json` | Mirror the admin's shape, including `pendingRemock` for Messages and a `serverRendered` entry for the shared KinTale page. |
| PR35 | U5 split contracts | `contracts/*.generated.ts`, the generator | Types only, no runtime leak. Lowest priority on this page; my recommendation was to leave it and the operator chose to build. |

Before a subagent picks up any row here, expand it into the full task shape used in Waves 1 and 2. The table fixes
scope and the trap; it is not itself the task.

---

## Appendix: the sweep evidence, with verdicts

A fresh pass over all 29 `ui-ideas/*.html` files and the 13 `ANDROID-STYLE-MOCKS/*.png` images, diffed against `src`.

**All thirteen were ruled on by the operator on 2026-08-06.** Verdicts are stamped on each heading below, and the
accepted ones are scheduled as PR10 to PR19 in Wave 2. This section is kept as the evidence behind each call, not as an
open question list.

### A1. Schedule has no hour resolution

> Verdict 2026-08-06: **BUILD** &rarr; PR17

The Schedule mock declares `--hour` and paints hour rules with `repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--hour) - 1px), var(--line-2) var(--hour))`, plus a `.times` mono gutter, absolutely-positioned event blocks proportional to duration, and an `.is-today` coral tint. Shipped `Schedule.css:145` is `grid-template-columns: repeat(7, minmax(0, 1fr))` of `.schedule__day-cell`. So duration and overlap are invisible: two visits at 9:00 and 9:15 look exactly like two at 9:00 and 17:00. For a routed pet-sitting operation that is the most decision-relevant thing on the screen. **Biggest single find in the sweep, and larger than several of the eight.**

### A2. Four unshipped keyframes

> Verdict 2026-08-06: **BUILD** &rarr; PR15 (`indet`, `wag`, `expand`) and PR18 (`flow`)

| Keyframe | Mocks | What it does |
|---|---|---|
| `flow` | kintale-report, kintale-composer | `to { stroke-dashoffset: -28 }`, animates the dashed GPS walk route |
| `wag` | kintale-composer, kintale-report | `rotate(-8deg → 12deg)` tail wag on the Kin avatar |
| `indet` | media-gallery | indeterminate upload bar, `margin-left: -42% → 100%` |
| `expand` | inbox | thread expand, `translateY(-6px)` and fade |

`rise` and `orb-drift` shipped in the July restoration. These four did not.

### A3. The GPS route is unrendered in the admin

> Verdict 2026-08-06: **BUILD** &rarr; PR18

`stroke-dasharray` appears in 2 mocks and 0 files in `src`. `gpsRoute` and `gpsSummary` exist on the KinTale model with no consumer (`src/api/kinTales.ts:40` says they belong to the not-yet-built detail screen). Android already ships the real thing: `RouteViewerScreen.kt` draws a Mapbox `PolylineAnnotation` with `MapboxConfig.ROUTE_LINE_COLOR`. So the treasure-map metaphor from the Android mock set was already rejected in code, and the open question is only whether the web admin gets a route view at all.

### A4. Motion character is globally different

> Verdict 2026-08-06: **BUILD** &rarr; PR12

Every mock uses `--ease: cubic-bezier(.2,.8,.2,1)`, a fast-out, long-settle curve. Shipped `tokens.css:347` is `--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)`, the Material standard curve. One token, every animation in the app, and it is the difference between "settles" and "stops".

### A5. The grain overlay is still absent

> Verdict 2026-08-06: **LEAVE.** Denied 2026-08-06. Not scheduled, and not to be re-proposed without a new ruling.

`.grain` is in all 29 mocks: `position: fixed; inset: 0; opacity: .05` over an inline `feTurbulence type="fractalNoise"` SVG. Zero in `src`. The 2026-07-25 audit called this optional and explicitly did not fight for it. Flagging for completeness, not recommending it. The `.mesh` and blob layers it sits on top of DID ship, as `.orb` in `src/styles/base.css`.

### A6. `.led`, the glowing status dot

> Verdict 2026-08-06: **BUILD** &rarr; PR13

`width: 10px; height: 10px; border-radius: 50%; background: #0A8595; box-shadow: 0 0 10px #0A8595`. Used in activity-log (the chain), settings (integration connected or off), members, and kincare-types. `src` has no glow dot anywhere. `PulsingBadge` is a different component: a count badge with a halo, not a connection state.

### A7. Small mock components with no analogue

> Verdict 2026-08-06: **BUILD** &rarr; PR14, all three including `pawtag`

- `.cchip`, a mono count chip whose number is teal and bold.
- `.pip`, an inline icon-plus-label meta pip at 11px.
- `.pawtag`, a decorative paw glyph pinned to the corner of an event card, `opacity: .5`.

### A8. The preview column is meant to be sticky

> Verdict 2026-08-06: **BUILD** &rarr; PR16 (the template editor's is already in PR3)

Three mocks pin the right-hand column: `.side { position: sticky; top: 24px }` on kintale-composer and kintale-report, `.form { position: sticky; top: 22px }` on invites.

**Figure corrected 2026-08-06.** An earlier draft said `position:sticky` appears in "0 files in `src`". That grep searched `position:sticky` without a space and cannot match the formatted source. Shipped, it appears once, at `Settings.css:27` for the section rail, and on no preview column. The finding stands; the count was wrong.

The MyTribe portal already ships the pattern correctly at `mytribe/web/src/styles/base.css:26`, including the `align-self` trap PR16 warns about. Copy the portal rather than inventing it. Folded into PR3's step 6 for the template editor; the KinTale composer and report still need it.

### A9. ANDROID-STYLE-MOCKS is filed in the wrong tree

> Verdict 2026-08-06: **MOVE** &rarr; PR19

All 13 images are **Kinfolk-facing**, not admin. Every one is headed "The [Family Name] Tribe" with a "Message Auntie" button and a 5-icon bottom tab bar (Home, Calendar, KinTales, Billing, Tribe). `ScheduleTab.png` reads "Today's Schedule" with "Message Auntie". `BillingTab.png` shows a Current Balance hero, Pay Now, and per-invoice PDF download. Three still carry the literal unfilled `[Family Name]` placeholder and the invoices are dated 2023, marking this as the oldest round in the folder.

Per `CLAUDE.md`, the Kinfolk portal keeps its mockups in `mytribe/ui-ideas/` and "a portal screen is never answered from here." These sit in the admin tree instead, which is how the layout review came to read them as a competing design language for the admin. Their ideas are also largely already shipped on the portal: `mytribe/web/src/screens/Invoices.tsx` and `InvoiceDetail.tsx` cover balance, pay, and PDF.

Two calls needed: **move the folder to `mytribe/ui-ideas/`** so the authority rule holds, and decide whether the day-strip selector (Mon-Fri with a selected pill) and the per-row colored status stripe are wanted on the portal Schedule.

### A10. Manifest correction, ready to apply

> Verdict 2026-08-06: **FIX** &rarr; PR19

`web/visual/manifest.json:29` records template-assignment as having no mock: *"ui-ideas holds no template-assignment file; which rejected template mock was meant for this screen is not recorded."* It does have one: `ui-ideas/ANDROID-STYLE-MOCKS/EmailTemplateAssignment.png`, a landscape admin layout with an Active Flows list, an Assignment Details panel, trigger events, audience segments, and Quick Stats for delivery and open rate. It is in the gradient language rather than the Den's, and it proposes a flow-and-trigger model the shipped catalog-key binding does not have. Worth a look before the F-series remock, since it may retire one of the seven pending items.

### A11. Vet Clinics: the two entry points the nav config already claims

> Verdict 2026-08-06: **BUILD both** &rarr; A11a is PR11, A11b is PR10

**Corrected 2026-08-06 after the operator's ruling. An earlier draft of this appendix recommended a rail entry. That was wrong and would have contradicted the spec.**

`src/lib/nav.ts:120` already files this screen exactly where the operator wants it, and marks it `contextual: true` so `railEntries()` filters it out on purpose:

> "The shared vet bank (punchlist B4). Contextual rather than pinned: it is a catalog the operator tidies occasionally, reached from Settings and from a household's vet picker, not a daily destination that earns a rail slot. The spec files it under Settings; this keeps it addressable by URL either way."

So the absence from the rail is correct and stays. The defect is that **neither entry point that comment describes was ever built.** `grep -rn "vet-clinics" src` returns exactly two hits, `router.tsx:281` and `nav.ts:128`. No `Link`, no Settings section, nowhere. 116 records reachable only by typing a URL.

The operator's ruling, 2026-08-06: *"the list of clinics should be in the settings in effort to edit any vet clinics needed, but the clinic can be selected and display on the kinfolk household data and read only on the kin profile."* This restates and extends the recorded ruling of 2026-08-01, quoted in `src/components/HouseholdVetPanels.tsx:13`: *"vet info lives on household data, it can be seen on the kin profile."*

Most of it already holds:

| Ruling | State |
|---|---|
| Selected, not typed | ships. `VetClinicPicker` on `KinfolkEdit.tsx`; ruling 2 in `HouseholdData.tsx:344` is "Vets are not a open string" |
| One canonical record | ships. `resolveHouseholdVet` in `src/lib/householdVet.ts`, fed by `VET_CLINICS_QUERY`, so the profile, Household Data and the bank cannot disagree |
| Displayed on household data | ships. `HouseholdData.tsx:120` resolves through the same listener |
| Read-only on the household profile | ships. `HouseholdVetPanels` is explicitly read-only |
| **Bank lives in Settings** | **not built.** 13 Settings sections, no vet clinics |
| **Reached from the household vet picker** | **not built.** No link anywhere |
| **Read-only on the KIN profile** | **wrong field.** See below |

Two tasks, both small.

**A11a: give the bank its two doors.** Add a `vetClinics` section to `SECTIONS` in `src/screens/Settings.tsx:84-103` (beside `kinCare`, which is the closest analogue: a catalog the operator tidies). Either mount `VetClinics` inside the section or link out to `/vet-clinics`; the section is the operator-facing answer either way. Then add a "Manage clinics" link from `VetClinicPicker`, so the person discovering a wrong phone number while picking can go fix it at the source. That second link is the whole point of a shared bank: `VetClinics.tsx` already tells the operator "Correcting a clinic here corrects it on every household linked to it."

**A11b: the kin profile shows the wrong vet.** `KinView.tsx:182` renders `<Fact label="Vet info" value={k.vetInfo} />`, and `k.vetInfo` is a per-kin free-text string on the kin doc (`src/api/kinView.ts:34`). It is not the resolved household clinic, and `KinView.tsx` never calls `resolveHouseholdVet`. So the kin profile can show stale or blank text while the household record holds the real clinic, which is precisely the "second writable copy" that `HouseholdVetPanels` was written to kill on the household profile. The kin profile should resolve the household vet read-only through the same helper, and `k.vetInfo` should be treated as legacy alongside `legacyVetLeftovers` (already imported by `HouseholdData.tsx:14`).

A11b is the one with teeth: it is a correctness bug about which vet a sitter reads in an emergency, not a navigation nicety.

### A12. Seven shipped screens have no live mock at all

> Verdict 2026-08-06: **REMOCK.** Operator supplies them; nothing to implement. Tracked, not scheduled.

Worth stating plainly, because it bounds how far "the Den set is the layout reference" can go. `web/visual/manifest.json`'s `pendingRemock` lists home, invoice-detail, invoices, notifications, payments, training-documents, and template-assignment. Home's two mocks are both under `WrongUIDesigns-UpdateKill/` (`killhome.html`, `toomanyHomeDesigns-nonefollowed-killthisone.html`) and notifications never had one. Per `CLAUDE.md` a screen with no live mockup does not get one invented, so these wait on the operator, tracked as F1 to F5 in `docs/punchlists/PUNCHLIST_2026-07-31-remaining.md`.
