# Where the flavor went: the 2026-05-27 mocks against the shipped React admin

Written 2026-07-25, on branch `feat/breed-dropdowns-and-flavor-audit`.

> **Status, updated 2026-07-25. ALL SEVEN ITEMS ARE DONE AND ON `main`.**
>
> | Item | Landed as |
> |---|---|
> | 1 ambient wash | #60 |
> | 2 entrance | #59 |
> | 3 brand gradient | #62 |
> | 4 Fraunces | #58 |
> | 5 rail | #61 |
> | 6 gradient surfaces | #62 |
> | 7 card lift | #62 |
>
> The four token bugs in the section below went out as #57. Two of the seven
> turned out to be considerably worse than this document first said, and one of
> those two was not in the list at all. See "What acting on this found" at the
> bottom, which is the honest record and should be read before the numbers above
> are taken at face value.

The operator's report is that pages which used to feel alive now feel flat, and
that the React port is where it happened. This checks that report against the
files rather than against memory, and it holds up. What follows is the measured
gap, which parts of it are worth closing, and which parts of the mocks should
stay unbuilt.

## The one-sentence version

The Den design language is not lost. It is running in production right now in
the MyTribe portal (`mytribe/web`), which is the same React 19 + Vite stack.
The AuntieOS admin (`auntieos-admin/src`) ported the design system's *values*
and dropped its *expression*, and it did so on purpose: `src/styles/tokens.css`
opens with an instruction to "IGNORE ... ui-ideas/*.html". That instruction was
right about where color and type values come from. It was applied far wider than
that, and the atmosphere went out with it.

## How this was measured

Every number below is reproducible. From the repo root:

```bash
grep -rho '@keyframes [a-zA-Z0-9_-]*' auntieos-admin/src --include='*.css' | sort | uniq -c
```

The mock inventory is the same shape of grep over `auntieos-admin/ui-ideas/*.html`
(39 files, all dated 2026-05-27) and `mytribe/ui-ideas/*.html` (19 files, 2026-05-31).

| | admin mocks | shipped admin | portal mocks | shipped portal |
|---|---|---|---|---|
| files | 39 HTML | 79 CSS | 19 HTML | 16 CSS |
| `@keyframes` | 2 to 5 per file | 6 total, all spinners and pulses | 1 to 5 per file | 6 total, incl. `rise` + `drift` |
| staggered entrance (`animation-delay`) | all 39 | 0 | most | 8 |
| ambient drifting blobs | all 39 | 2 static orbs, no animation | yes | yes, animated |
| film grain overlay | all 39 | 0 | 0 | 0 |
| `backdrop-filter` | 10 files | 8 files | all | 15 uses |
| `mix-blend-mode` | all 39 | 0 | n/a | 0 |
| `font-variation-settings` | all 39 | 0 | n/a | 0 |
| `conic-gradient` | 18 files | 0 | n/a | 0 |
| gradients per screen | 3 to 19 | avatars and tag chips only | 7 to 12 | 19 uses |

The portal column is the important one. It is the proof that none of this is a
Compose-only capability that React could not carry.

## The six devices that did not make the crossing

### 1. The ambient background is inert

All 39 mocks paint three blurred color blobs behind the page, each a
`radial-gradient` with `mix-blend-mode: screen`, drifting on a 29 second
`@keyframes drift` with negative `animation-delay` values so they start out of
phase. On top sits a `grain` layer: an inline SVG `feTurbulence` at 5% opacity.

`src/styles/base.css` ships two orbs. They are flat solid fills, not radial
gradients, they do not blend, they do not move, and there is no grain. The
comment there calls them "the two drifting Den orbs" but nothing drifts.

The portal already does this correctly at `mytribe/web/src/styles/base.css:18-23`.

Cost to close: one CSS file, roughly 20 lines. No component changes.

### 2. Nothing enters

`@keyframes rise` (opacity 0 and `translateY(16px)` to rest, 0.6s) appears in all
39 mocks, with per-block `animation-delay` of .06s, .12s, .18s so a screen
assembles top to bottom instead of appearing all at once. The portal shipped this
as four utility classes, `.d1` through `.d4`, at
`mytribe/web/src/styles/base.css:132-134`, and its screens use them: see the
`glass card d1` / `d2` / `d3` sections in `mytribe/web/src/screens/KinEdit.tsx`.

The admin has no entrance animation anywhere. Every screen hard-cuts into place.

Cost to close: the same four utility classes, then a `d1..d4` on the section
wrappers of whichever screens are worth it. This is the single highest ratio of
perceived life to lines changed in this document.

### 3. The brand gradient is defined, tested, and never rendered

`--gradient-tribe` is orange to pink to teal at 135deg, and `tokens.css:118`
calls it "THE Tribe Gradient, the primary brand mark", reserved for "hero and CTA
moments". Outside its own definition and `src/styles/tokens.test.ts`, it appears
in exactly one place in the app: the seed array inside `Avatar.tsx:35`.

So the brand mark exists only at 42 pixels wide, behind someone's initials. No
header, no primary button, no hero stat, no sign-in panel uses it. Same story for
`--gradient-rainbow-accent` and `--gradient-sunset-glow`, both of which have
tests asserting their exact angle and no consumer to assert it for.

The mocks put gradients on card fills (`linear-gradient(160deg, ...)` on every
`.qcard` and `.scard`), on the rail's brand mark (`conic-gradient(from 200deg, ...)`),
and on per-household avatars with six different conic starting angles so two
adjacent rows never look the same.

Cost to close: pick two surfaces. The sign-in panel and the Home hero stat are
the obvious pair.

### 4. Fraunces is loaded as a variable font and used as a static one

`src/main.tsx:8` imports `@fontsource-variable/fraunces`, which ships the SOFT
and WONK axes. Zero `font-variation-settings` in the codebase. Every mock sets
`font-variation-settings: "SOFT" 50, "WONK" 1` on its display headings, and the
mocks also use fractional weights (380, 440) that only a variable font can hit.
`tokens.css` pins weight 400 and 500 flat.

We are paying the download cost of the variable file for none of its range. WONK
in particular is what makes Fraunces read as the friendly editorial face the
brand picked it for rather than as a generic serif.

Cost to close: three lines in `tokens.css`.

**Correction, found while fixing this:** the axes were the smaller half of the
problem. Fraunces was not rendering AT ALL. See below.

### 5. The side rail is not interactive

`src/styles/shell.css:52` sets `cursor: default` on `.shell__link`, and the file
has no `:hover` rule for rail links at all. The rail has no icons and no count
badges. The mock rail (see the `.rail` block in
`ui-ideas/auntieos-home-2026-05-27.html`) has a 17px icon per entry, a hover
background, a mono-face count pill in tinted orange on entries that carry a
number, and a conic-gradient brand mark above it.

The rail is on every screen, so this is the flatness the operator sees most
often.

### 6. Cards do not respond

`DenScreenKit.css` is the exception that proves the rule: `.den-stat--button`
does a `translateY(-3px)` on hover with a tone-colored border, and
`.den-stat--feature` lays a radial tone wash over the glass. That is exactly the
mock idiom, and it is good. It is also confined to two components. The mocks
apply lift plus a colored border plus `box-shadow: 0 16px 36px -22px rgba(0,0,0,.8)`
to every clickable card on every screen. Shipped, `box-shadow` appears in 8 of
79 CSS files.

## Four token bugs found on the way

These are not taste. They are wiring faults, and they are cheap.

1. **Body text defaults to orange.** `src/styles/base.css:22` is
   `color: var(--color-primary, #1a1c28)`. The fallback shows navy was intended,
   but `--color-primary` resolves to Kinfolk Orange `#df8431`. `.screen` sets no
   color, so any element whose own CSS omits `color` inherits orange. Well styled
   components mask this; plain `<p>` and `<li>` do not. Should be
   `var(--color-text-primary)`.

2. **24 places use Pack Pink as muted label gray.** `var(--color-secondary, #5a5c6a)`
   appears 24 times across `shell.css`, `signin.css` and `screens.css`, always
   with a gray fallback that says what the author meant. `--color-secondary` is
   `#d55c87`. Rail group labels, the account role line, sign-in helper text and
   activity-log day headers are all rendering pink. Should be
   `var(--color-text-dim)`.

3. **Three referenced tokens do not exist.** `--color-surface2` (4 uses, the real
   name is `--color-surface-2`), `--motion-fast` (1 use, the real name is
   `--dur-fast`), and `--color-teal` (1 use, the real name is `--color-accent`).
   Each silently takes its fallback, so the second background orb in `base.css`
   is not themed at all and does not follow dark mode.

4. **Rail links are keyboard-invisible.** No `:hover`, no `:focus-visible` on
   `.shell__link`. Combined with `cursor: default` the rail reads as static text.

Fixing all four is under 30 lines and needs no design decision.

## What to take from each mock, and what to leave

Not everything in the mocks should be built. The 2026-05-27 set was drawn before
half the current screens existed and it invents affordances we deliberately do
not have.

**Worth taking:**

- `auntieos-home`: the 5-across quick-action grid with tinted icon tiles, the
  gradient-filled stat cards. Feeds Phase 3 (Task 3.2) of the restoration plan,
  which already owns the Home layout rewrite.
- `auntieos-directory`: per-household conic avatars and the per-kin
  `radial-gradient` species dot. `Directory.css` has 275 lines and zero
  gradients. `Avatar.tsx` already has the seeded gradient machinery, so the
  household half is close to free.
- `auntieos-kintale-report` and `auntieos-kintale-composer`: the two richest
  mocks (19 and 17 gradients, 5 and 4 keyframes). KinTales is the operator's
  signature output and the surface most worth spending motion on.
- `auntieos-media-gallery`: the glass overlay treatment on tiles.
- `auntieos-sign-in`: the one screen where a full-bleed brand gradient is
  unambiguously correct, and the cheapest place to prove the direction.

**Leave alone:**

- The mocks' side rail is labeled `SUGGESTION` in its own source comment and its
  entries mirror a `NavDestinations.kt` order that has since changed. Take the
  icons, hover and count pills. Do not take its link list.
- `auntieos-redesign.html` is a concept index, not a screen.
- Anything in a mock that implies a callable we do not have. The mocks predate
  the current backend and several show data nothing serves.
- The grain overlay is optional. It is 5% opacity noise, it costs a fixed
  full-viewport layer, and it is the one device here I would not fight for.

## Suggested order

1. The four token bugs. No design decision, immediate legibility win.
2. `rise` + `d1..d4` utilities, applied to Home, Directory and KinTales section
   wrappers. Copy `mytribe/web/src/styles/base.css:132-134` verbatim.
3. Animate and blend the existing orbs. Copy the portal again.
4. Fraunces variation settings on the display and headline tokens.
5. Rail: icons, hover, focus ring, count pills.
6. Brand gradient on sign-in and the Home hero stat.
7. Card hover lift and shadow, generalized out of `DenScreenKit.css` into a
   shared `.lift` utility.

Items 1 through 4 are independent of the React Port Restoration plan and can
land as their own branch. Items 5 through 7 overlap Phase 3, so they should ride
with it rather than conflict.

## What acting on this found

All seven items shipped, one concern per PR. Three findings were worse than this
document estimated, and every one of them was found only by trying to fix the
smaller thing next to it. That is the pattern worth remembering: none of these
were visible from the audit, only from the repair.

**The rail count pill was nearly shipped dark.** Item 5's first pass built a
working count pill with a permanently empty source, on the reasoning that no
count was reachable without a new read. That is precisely the "gate dark"
`CLAUDE.md` forbids for our own code. The reasoning was also wrong: the obvious
fix (the `listConversations` callable) is a one-shot, and reading a thread clears
`unreadForAdmin` server-side, so a page-load snapshot pinned to the chrome would
have sat in the corner of every screen claiming four unread after the operator
had read all four. It ships instead as one bounded live listener projected
through the EXISTING `unreadThreadCount`, so the rail counts the same flag the
Inbox screen does. `firestore.rules:798` already granted the read, so no backend
change was needed. A number that is wrong everywhere is worse than no number.

**Fraunces has never rendered in this admin.** `@fontsource-variable/fraunces`
registers its `@font-face` under the family name `Fraunces Variable`.
`tokens.css` asked for `Fraunces`, which nothing declares. So every serif
heading in the app, the page titles, the panel titles, the stat values, the
wordmark, fell straight through to `ui-serif` / Georgia, while the real face
downloaded on every page load and went unused. This is almost certainly the
single largest contributor to the "feels flat" report: the brand's editorial
display face was simply absent, and no amount of correct color or spacing
substitutes for that. Verified fixed by driving the running app: the sign-in
wordmark now computes to `"Fraunces Variable"` with
`"SOFT" 50, "WONK" 1` applied, in both schemes.

The package default also ships the `wght` axis alone. Getting SOFT and WONK
meant importing `@fontsource-variable/fraunces/full.css`, which is 121 KB for
the latin subset against 36 KB. That trade is stated at the import so it can be
reversed in one line.

**The undefined-token count was eleven, not three.** The audit found `--color-surface2`,
`--motion-fast` and `--color-teal` by grepping for names it already suspected. A
full walk of all 79 stylesheets found ELEVEN tokens referenced but never
declared, including `--type-label-family` / `-size` / `-tracking` (the real names
carry an `-md` or `-sm` step), which meant the vet clinic picker and the address
autofill field had been rendering their labels with no face, no size and no
tracking at all. `--color-surface-raised` was used with no fallback in
`TribalIntelForm.css`, so that chip had no hover colour.

The same walk found 146 stale literal fallbacks, `var(--color-x, #hex)` where the
hex was a copy of one theme's value taken at some point in the past. None of them
rendered, because the tokens are always defined, but they are how all of this
hid: a wrong token name reads as correct when a plausible colour sits next to it.
They are gone, and `src/styles/tokenUsage.test.ts` now fails the build on a new
one, on a reference to an undeclared token, and on the specific mis-wirings
above.

`prefers-reduced-motion` is honored per-file in 8 admin CSS files, which means
every new animation has to remember to opt in. The portal took the safer route:
`mytribe/web/src/styles/base.css:153` is a single global
`@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`.
Copy that first, then the animations, so nothing added here can arrive
unguarded.
