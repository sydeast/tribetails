# AO-5 / AO-8: shared brand voice + contract types across repos

Design pass, 2026-07-18. Status: **decision needed from operator on repo topology.**
No code moved yet, on purpose (see "Why nothing was refactored").

## The two backlog items

- **AO-5**: "duplicate `generate` implementations (AuntieOS `web/functions` vs
  MyTribe `lib/aiCopy.ts`), one brand-voice source."
- **AO-8**: "cross-app contract types live only MyTribe-side; a shared package
  should be the single source."

## Finding 1: AO-5 is mostly a misdiagnosis

The two `generate` functions are **not redundant copies of one thing**. They are
two different assistants for two different speakers. Merging them forces one
prompt to speak as both Auntie and the kinfolk, which degrades both voices; the
risk to the live flow is the smaller problem.

| | AuntieOS `web/functions/generate.js` | MyTribe `portal/generate.ts` + `lib/aiCopy.ts` |
|---|---|---|
| Speaker | **Auntie** (the operator), authoring outbound copy | The **kinfolk** (client), polishing their own message |
| Prompt opener | "You are Auntie. You write communications for Tribe Tails." | "You write for MyTribe... help the kinfolk say what they mean." |
| Modes | sms / email / visit_report / social_post / blog_post | polish / suggest_reply |
| Audience of output | kinfolk + public | the auntie (a reply in a thread) |
| Endpoint | onRequest `/api/generate` (admin-gated) | `generate` callable (kinfolk-gated) |
| Deployed from | AuntieOS `web/functions` (JS) | MyTribe `functions` (TS) |

Both prompts are deliberately **frozen** (MyTribe's `BRAND_VOICE_SYSTEM` carries a
"keep FROZEN, any byte change invalidates the prompt cache for all callers"
warning). They are not the same string and should not become the same string.

What is **genuinely shared** between them is small and specific: the
**terminology + anti-slop lexicon**, the rules both prompts independently encode:

- kin (never "pet"/"animal"), kinfolk (never "client"/"customer"/"owner"),
  auntie, tale
- no em dashes / en dashes, ever
- first person, contractions, no corporate filler, specific over vague

That lexicon is the real "one brand-voice source." It is ~15 lines, not a whole
generator. The redundancy the backlog imagined (two copies of one generator) does
not exist; the redundancy that does exist is those shared vocabulary rules, typed
out twice.

## Finding 2: AO-8 is real, and bigger than "MyTribe-side types"

MyTribe's callables are the contract. **Three** independent clients hand-mirror
that contract today, each in its own language, each kept in sync by hand:

- `auntieos-admin` React: **26** `api/*.ts` files, typed mirrors of callable
  request/response shapes (many carry a "Mirrors the wasm X field-for-field"
  comment, which is the tell).
- AuntieOS `composeApp` Kotlin (`FirestoreClient.kt`): the same callables again,
  as Kotlin data classes + decoders (web + desktop).
- `android` Kotlin (`AuntieRepository.kt` + `ui/*`): the same callables a third
  time.

So a callable whose response shape changes has **four** places to edit (MyTribe +
three mirrors) and nothing but discipline keeping them aligned. That is the actual
cost AO-8 names.

## Why nothing was refactored in this pass

1. **The prompts are cache-frozen.** Editing `BRAND_VOICE_SYSTEM` or the AuntieOS
   `SYSTEM_FRAMING` to point at a shared constant changes the bytes and busts the
   Anthropic prompt cache for every live caller. That is a real production cost on
   the two live AI flows, taken on for a refactor with no user-visible benefit.
2. **The share crosses repos.** AuntieOS (`web/functions`, JS) and MyTribe
   (`functions`, TS) are separately-deployed codebases in different repos, plus
   two Kotlin clients. There is no import path between them today. Making one
   requires a topology decision (below), which is the operator's to make, not a
   default I should pick by restructuring three live repos.

Refactoring across that seam without the decision would be exactly the kind of
"invent a blocker or guess the architecture" the project rules warn against, in
reverse: guessing the architecture and breaking live flows to look done.

## The decision: how do these repos share code?

Three options, each a different bet. This is the operator call.

### Option A — Published private package (`@tribetails/contract`)
One npm package holds the callable contract types (TS) + the shared voice
lexicon; MyTribe and auntieos-admin depend on it; a small codegen step emits the
Kotlin equivalents for composeApp + android.
- Pro: one true source, real compile-time enforcement, versioned.
- Con: needs a private registry (npm/GitHub Packages) + publish credentials +
  a release step in each repo's CI. Kotlin still needs codegen or a second mirror.
- Cost: highest setup, lowest ongoing drift.

### Option B — Vendored single-source-of-truth file, synced by script
A canonical `contract/` dir (types + `voice-lexicon.md`) lives in one repo; a
sync script copies it into the others on change (the pattern AuntieOS
`generate.js` already uses for its vendored `voice/` dir).
- Pro: no registry, no publish; works today across repos as they are.
- Con: sync is still a manual/CI step; Kotlin mirrors stay hand-written; weaker
  than compile-time enforcement.
- Cost: low setup, medium ongoing drift.

### Option C — Accept the mirrors, add a drift guard
Keep the hand-mirrors, but add a contract test: MyTribe emits a JSON schema of
each callable's shape; each client has a test that fails when its mirror drifts.
- Pro: cheapest; no repo restructure; turns silent drift into a red test.
- Con: does not remove the duplication, only alarms on it.
- Cost: lowest setup, duplication remains but is now loud.

## Recommendation

**Do the safe, in-repo slice of AO-5 now (pending your OK on wording), decide
A/B/C for AO-8 separately.**

- **AO-5, low-risk slice:** extract the shared terminology/anti-slop lexicon into
  one canonical doc (`voice/LEXICON.md`, the single source), and have each
  prompt's frozen string be regenerated *from* it in a one-time, reviewed edit
  (so the bytes change **once**, deliberately, with the cache-bust paid once and
  intentionally, not drifting again). The two distinct voices stay distinct;
  only the shared vocabulary is unified. This needs your sign-off on the exact
  wording because it touches live copy (per "Claude authors copy in Auntie
  voice", the operator reviews voice edits).
- **AO-8:** I recommend **Option C first** (drift guard, cheap, no topology
  change) and Option A later if/when a private registry is worth standing up.
  Option C converts AO-8 from "invisible risk" into "a test goes red," which is
  most of its value for near-zero cost and zero risk to live flows.

## Kill criterion

If, after the AO-5 lexicon extraction, the two prompts still need per-speaker
overrides of the "shared" rules (e.g. the kinfolk-assist voice wants a softer
take on a rule the auntie-authoring voice states hard), then the lexicon is not
actually shared and AO-5 should be closed as "by design, two voices." Watch for
that during the wording review.
