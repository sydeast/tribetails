# Communicate — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-communicate-2026-05-27.html`
**Sub-view references:** `ui-ideas/auntieos-email-creation-2026-05-27.html` (template editor: title/subject/body/category) and `ui-ideas/auntieos-marketing-blasts-2026-05-27.html` (broadcast/segment intent).
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicateScreen.kt`
**Current code (android):** parity target — generate/approve paths run through the shared `N8nClient` + `FirestoreClient`; a matching Android comms surface must reach parity.
**Shared components:** `DenScreenHeading`, `DenPanel`, `SegmentedPicker`, `AuntieChipGroup`, `MultilineField`, `AuntieEntityRow`, `AuntieSearchField`, `AuntieEmailPreviewCard`, `AuntieBanner`, `StatusToast`, `AuntieIconTile`, `PrimaryButton`, `GhostButton` (used `CommunicateScreen.kt` ll.51-70).
**Backend surface:** `N8nClient.generate` (`N8nClient.kt`), `GenerateRequest.communication_type` + `CommunicationType` enum (`N8nClient.kt` ll.88-104), `FirestoreClient.approveGeneratedDraft` (l.41), `templatesStream()` (l.162), `kinfolkStream()` (l.25), `N8nClient.sendMessage` (l.69).

> ⚠️ Code correction vs. the assignment complaints. Several complaints are already addressed:
> - "Templates can't be pulled" — **false**: the Template bank drawer reads the real `templatesStream()` and `applyTemplate()` prefills the editable draft from `t.defaultEmailMessage` (`CommunicateScreen.kt` ll.238-247, 757-837). Pulling works.
> - "Broadcast not working" — **correct, and honestly gated**: a `Broadcast` compose mode exists (`ComposeMode`, ll.110-114) but ships **dark** behind `FF_BROADCAST = false` with a fail-loud "Broadcast is not wired yet" banner (ll.116-118, 398-416), because no `broadcastMessage` callable exists. External/raw send is gated behind `FF_EXTERNAL_SEND = false` (ll.120-123, 525-540) even though `N8nClient.sendMessage` exists, because it is not blessed as a screen-level write.
> The genuinely missing pieces are: a **message-type selector** (visit/text/email/blog), the **blog-without-recipient** rule, and an **about/subject selector** — none of which the screen exposes today (it hardwires `CommunicationType.VISIT_REPORT`, ll.172-180, and uses a `subject` placeholder, ll.714-717). Those are the real deltas below.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna Wren`, `Biscuit & Gravy context`, the sample AI draft "Hi Lorna!...", `8 kinfolk`, `Holiday weekend hours`, `open 74%`, `booking.confirmed · email`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). No new user-facing copy is authored here; Auntie writes all real wording. When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web panel looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Message-type selector (visit / text / email / blog) — MISSING
- **Current:** the screen hardwires `communication_type = CommunicationType.VISIT_REPORT` in `generate()` (`CommunicateScreen.kt` ll.172-180). There is no UI to choose the message type. The `CommunicationType` enum already defines the full set: `SMS`, `EMAIL`, `VISIT_REPORT`, `SOCIAL_POST`, `BLOG_POST`, `GENERAL` (`N8nClient.kt` ll.96-104).
- **Desired:** a selector for the **kind of message** being composed (visit report / text / email / blog), so the generator request carries the right `communication_type`. (The mock's two-way Personalize/Broadcast switch, ll.173-176, is the *audience* axis; the message-type axis is the missing one this complaint names.)
- **Fix (full-stack — backend already supports it):** add a message-type picker (reuse `SegmentedPicker` or `AuntieChipGroup`) bound to a new `messageType` state, and pass the chosen `CommunicationType` into the `GenerateRequest` instead of the hardcoded `VISIT_REPORT`. The enum + `generate` request field already exist, so the backend accepts every value — this is wiring + frontend.
  - **Dependency:** confirm the n8n `generate` flow handles each `communication_type` end to end (visit/text/email/blog/social/general). If a given type isn't honored downstream, gate that option dark with a Not-wired note rather than sending a type the backend ignores. Tests: unit on the request building per type, integration on the generate round-trip, parity across web/desktop/Android.

## 2. Blog posts should not require a recipient — MISSING rule
- **Current:** the Personalize flow always shows a Recipient picker and builds the request with `recipient = recipientName` (`CommunicateScreen.kt` ll.162, 172-180, 418-424). There is no concept of a recipient-less message; a blog/social post still funnels through the 1:1 recipient model.
- **Desired:** for **blog** (and social) message types, the recipient is irrelevant — a blog post is authored once, not addressed to a kinfolk. The recipient field should be **hidden or optional** when the message type is blog/social.
- **Fix:** make the recipient picker **conditional on message type** — required for visit/text/email/personalized types, **omitted** for `BLOG_POST` / `SOCIAL_POST`. When recipient is omitted, send `recipient = ""` (or the appropriate empty) in the `GenerateRequest`. This depends on item 1 (the message-type selector) existing first.
  - **Dependency:** confirm the n8n `generate` flow accepts a blank `recipient` for blog/social (the request field is a plain `String`, `N8nClient.kt` l.90, so structurally fine). Also confirm where an approved **blog** draft is meant to land — `approveGeneratedDraft` promotes a `generated_drafts` doc (per recipient flow); a blog may need a different publish target. If no blog publish path exists, gate blog **approve/publish** dark with a Not-wired banner while keeping blog **generate** live. Tests: validation unit (blog needs no recipient), integration on blog generate, parity.

## 3. About / subject selector — MISSING
- **Current:** there is no "what is this about" subject control. The raw-notes field is labeled "What is it about?" (`CommunicateScreen.kt` ll.456-460) but that's the free-text body prompt, not a structured subject/about selector. The preview's subject is a **placeholder** computed from the recipient name ("A note about {name}" / "A note from Auntie", ll.714-717) — explicitly a placeholder per its own comment.
- **Desired:** an **about/subject selector** so the composer picks the message's topic/subject (mirroring the mock's Broadcast `Subject` input, ll.234-235, and the email-creation template's `subject` field, email-creation mock ll.9-14). The complaint pairs this with templates: choosing a subject can pull the matching template.
- **Fix:** add a real subject/about field (and/or a subject-driven template association). Two honest routes: (a) a free-text subject the author writes, bound through to the preview (replacing the placeholder) and to the send path; (b) a subject **picker** sourced from the template catalog's titles/categories (email-creation mock: templates carry `title` + `category` from `FILTER_OPTIONS`). Do not author canned subject strings — either let Auntie type the subject or bind it to real template metadata.
  - **Dependency:** if the subject is a real send field, the chosen send/publish path must carry it (visit/draft approve, or external send). If subject is template-driven, surface the template `title`/`category` from `templatesStream()` (those fields exist per the email-creation mock contract). Tests: subject binds to preview (component), subject carried into the request (integration), parity.

## 4. Template pull — already real (keep), align to message type
- **Current:** Template bank drawer reads `templatesStream()` and `applyTemplate()` prefills the editable draft (`CommunicateScreen.kt` ll.238-247, 757-837). Search by name/description/service, default-first sort, fail-loud empty/error. Fully wired.
- **Desired:** mock's template drawer groups templates by channel/category and prefills subject + body on pull (mock ll.271-293, 319-331). The mock pulls into Broadcast by default; the code pulls into the live Personalize editor.
- **Fix:** keep the real pull. Once items 1+3 land, prefilling should also set the **message type** and **subject** from the template (channel → type, `title` → subject), not just the body. The mock's per-template channel chips (email/push/sms) imply the template carries a channel/type — bind to it, don't fabricate.
  - **Dependency:** template channel/type + title/subject fields surfaced from `templatesStream()` (the email-creation mock confirms `title`, `subject`, `category`, `tags` exist on the template model). Tests: pull sets type+subject+body (component), parity.

## 5. Broadcast (company-wide, multi-channel) — keep dark, honest
- **Current:** `Broadcast` mode exists but is gated dark behind `FF_BROADCAST = false` with a fail-loud "Broadcast is not wired yet" banner explaining the missing `broadcastMessage` callable (`CommunicateScreen.kt` ll.110-118, 385-416). The redesign backlog note is reflected verbatim in code (no audience-segment fan-out callable).
- **Desired:** mock Broadcast mode = audience segment (All / segment / one), channel multi-select (email/push/in-app, SMS "soon"), subject, message, AI draft (mock ll.214-241). The marketing-blasts mock is the fuller broadcast concept.
- **Fix:** keep dark until the backend exists. **Do not** wire the segment picker or channel chips to a non-existent send. Surface the gap honestly (already done).
  - **Dependency (real blocker, per backlog):** a **`broadcastMessage` callable** (audience segment resolution + multi-channel fan-out) — does not exist. Full-stack: Function/callable → data layer → wiring → frontend → parity → tests. Until then `FF_BROADCAST` stays off.

## 6. External / outside-tribe send — keep dark, honest
- **Current:** sending to a raw email/phone outside the tribe is gated behind `FF_EXTERNAL_SEND = false` with a Not-wired banner (`CommunicateScreen.kt` ll.120-123, 525-540), even though `N8nClient.sendMessage` exists (`N8nClient.kt` l.69) — because it is not blessed as a screen-level write path here.
- **Desired:** the mock's "Approve & send →" implies a direct external send.
- **Fix:** keep dark. The live, backed path is **Approve draft** → `approveGeneratedDraft` (Firestore promote + audit log + n8n ping, ll.195-236), which is real and must be preserved. Do not promote `sendMessage` to a blessed send without the blessing decision.
  - **Dependency (backlog):** bless `N8nClient.sendMessage` as a screen-level external-send write (policy + wiring), then flip `FF_EXTERNAL_SEND`. Tests on the send path + parity.

## 7. Recent panel — open/read metrics not wired
- **Current:** `RecentPanel` (`CommunicateScreen.kt` ll.730-750) shows a fail-loud "NOT WIRED" banner instead of fake open/read rates (no engagement-metrics source).
- **Desired:** mock `.panel.r` "Recent" with `open 74%` / `read yes` rates (ll.259-264). Those numbers are placeholder per Rule 1.
- **Fix:** keep the honest banner. **Dependency:** an **engagement-metrics source** (sends + open/read tracking) — none exists. Until then, no fabricated rates.

---

## Out of scope / leave as-is
- Tone + Length chip groups (`CommunicateScreen.kt` ll.426-451) — real, pass through to `tone_hint`/`max_length`.
- Live preview card binding to the editable body (`PreviewPanel`, ll.703-723) — real; only its subject is a placeholder (covered by item 3).
- Approve-draft path (Firestore promote + audit + n8n ping) — real and audited; do not touch.
- Template bank drawer read path — real (covered by item 4).
- Global search / notification bell are shell-level (`web/.../ui/shell/AppShell.kt`), not this screen.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Message-type selector** wired to `GenerateRequest.communication_type` (enum already exists) — confirm each `CommunicationType` is honored downstream; gate any unsupported type dark.
2. **Blog/social recipient-less rule** — make recipient conditional on type; confirm a blank `recipient` is accepted by `generate`, and that a **blog publish target** exists (gate blog approve/publish dark if not).
3. **About/subject control** — real subject field (or template-`title`/`category`-driven picker); carry subject into preview + the send/publish path.
4. **Template channel/type + title/subject binding** — surface those fields from `templatesStream()` so a pull sets type + subject + body, not just body.
5. **`broadcastMessage` callable** (audience segment + multi-channel fan-out) — does not exist; unblocks Broadcast (`FF_BROADCAST`).
6. **Bless `N8nClient.sendMessage` as a screen-level external send** — policy + wiring; unblocks `FF_EXTERNAL_SEND`.
7. **Engagement-metrics source** (open/read tracking) — unblocks the Recent panel.

Every value on this screen must trace to a real source (`templatesStream()`, `kinfolkStream()`, `N8nClient.generate`, `approveGeneratedDraft`) or a new real callable. If it can't, it ships dark with a Not-wired banner — not hardcoded, never faked.
