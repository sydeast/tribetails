> STATUS 2026-06-09 (de-stale pass): SHIPPED: `BottomBorderField` a11y overhaul (1.5px resting line + `errorMessage`/`required`/`onFocusLost` params) (items 1/4 primitive), preferred-contact-method editor removed (item 2), service-address + emergency-contact required under Identity (item 3), phone validator 10/11-digit on both platforms (item 5). GENUINE GAPS: blur validation + per-field error text are NOT wired into `KinfolkEditScreen` despite the primitive supporting them (items 1/4); the "6-digit rejected" regression test is missing. CROSS-CUTS VET DECISION (04 item 3): the vet panel still writes `Kinfolk.vetClinic*` and must migrate to `HouseholdData.primaryVet*`/`emergencyVet*`. DECISIONS PENDING: `preferredContactMethod`/`bestTimeToContact` still display on the profile + round-trip in the VM (keep as a system-set value, or fully deprecate?); include an emergency-vet slot in this edit form or handle it elsewhere? Body line refs are stale.

# Edit Kinfolk — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kinfolk-edit-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/KinfolkEditScreen.kt`
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/directory/EditKinfolkScreen.kt` (+ `AddKinfolkScreen.kt`)
**Shared components:** `BottomBorderField`, `MultilineField`, `SegmentedPicker`, `AuntieSaveBar`, `AuntieFieldLabel`, `AuntieStatusPill`, `GlassSurface`, `StatusToast`, `AuntieBanner` (`…/web/ui/components/`); validators `isValidPhone` / `isValidEmail` (`…/web/util/FieldValidators.kt`).

> ⚠️ Mock caveat: this mock's own header comment (ll.11-34) says it **mirrors the current `KinfolkEditScreen.kt`** field-for-field (same sections, same "Preferred contact method" + "Best time" + optional service-address/emergency). So the mock is a snapshot of the **current** screen, NOT the desired end state. **Auntie's complaints below define the true DESIRED state and intentionally diverge from this mock.** Where they conflict, follow the complaints; treat the mock only as the visual/Den-styling reference (panels, legends, sticky save bar, per-field error helper). The mock also writes phone copy as "7 to 15 digits" — the shipped validator enforces stricter US 10/11-digit rules (l.40-46 of FieldValidators); keep the stricter real rule, not the mock's looser copy.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna`, `Wren`, `(555) 014-2231`, `loretta.w@example.com`, `82 Creekside Ln`, the vet-clinic catalog names/numbers, `Riverside Animal`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = the corrected end state (Auntie's complaints + Den styling). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built before the slot can show real data.

---

## 1. Low field visibility / accessibility (Auntie complaint)
- **Current:** all inputs use `BottomBorderField` (`BottomBorderField.kt`). At rest the field is a **0.5px hairline** bottom border only (`lineWidth = 0.5f`, l.65-69), no box, no fill; the label is `labelSmall` in `c.textDim` UPPERCASED (ll.77-86). On a dark navy ground this reads as nearly invisible — there's no enclosing field affordance, the contrast of a 0.5px line is far below WCAG, and the only strong-state is on focus (`c.primary`, 1.5px). Error state only colors the line/label `c.error`. The tap target is the 36dp `Box` (good), but the *visual* field boundary is the problem.
- **Desired:** higher-visibility, accessible inputs. The mock keeps the bottom-border primitive (`.f input{border-bottom:1.5px solid var(--line)}`, l.106-109) but with a thicker resting line and clear label; Auntie wants fields that are obviously editable and meet contrast/a11y.
- **Fix:**
  1. Raise resting line weight (at least the mock's 1.5px, not 0.5px) and/or give the field a subtle filled box so the boundary is visible at rest. Ensure label + value + border all clear WCAG AA contrast against `c.background`.
  2. Add proper a11y semantics: associate the label with the field (Compose `semantics`/`contentDescription`), mark required fields and error states for screen readers (not color-only), and ensure focus order is sane.
  3. Run the design `accessibility-review` pass (contrast, target size, screen-reader labels) on the corrected field.
  4. Apply to the shared `BottomBorderField` so every form benefits; mirror on Android's edit screen. Component/UI + a11y tests.

## 2. Remove "Preferred contact method" and "Best time to contact" (Auntie complaint)
- **Current:** section "03 · Preferred contact method" (`KinfolkEditScreen.kt` ll.401-410) renders a `SegmentedPicker` (Text/Email/Phone/InApp Push) bound to `preferred`, plus a `BottomBorderField` for `bestTime`. Both persist to `Kinfolk.preferredContactMethod` / `bestTimeToContact` (build(), ll.181-182).
- **Desired:** drop this entire section from the edit form.
- **Fix:**
  1. Remove section 03 from the web edit screen and the Android equivalent. Renumber the remaining sections.
  2. **Data decision (full-stack):** `preferredContactMethod` is read elsewhere — the comms reconcile pipeline writes a `contactOverride` against it, and the profile shows "prefers {method}" (`KinfolkProfileScreen.kt` ll.130, 251). Decide whether to (a) keep the field but stop editing it here, or (b) deprecate it. Do NOT just hide the editor while the model/profile still references it inconsistently. `bestTimeToContact` similarly surfaces on the profile (l.131) — remove that read too if the field is dropped. Coordinate model + profile + reconcile pipeline + all platforms.
  3. Tests: ensure removing the editor doesn't break the override pipeline or the profile read; update form tests that asserted these fields.

## 3. Service address + Emergency contact must be REQUIRED and live under Identity (Auntie complaint)
- **Current:**
  - Service address lives in section "04 · Home & access" marked **Optional** (`KinfolkEditScreen.kt` ll.413-431, `Requirement.Optional`), via the Mapbox `AddressAutofillField`. It is **not validated** and **not required** (no `serviceAddrError`, not in `canSave` l.213-214).
  - Emergency contact is section "05" marked **Optional** (ll.434-446); only the emergency *phone format* is validated when non-blank (`emPhoneError`, l.211), nothing is required.
  - Identity (section 01, ll.335-361) currently holds only First/Last name (+ Status picker on create).
- **Desired:** service address and emergency contact are **required**, and both belong **under Identity** (grouped with the household's core identifying info), not buried as optional sections lower down.
- **Fix (full-stack):**
  1. Move the Service address field (with its Mapbox autofill) and the Emergency contact fields (name + phone + relationship) up into the Identity grouping, and mark the section/pills **required**.
  2. Add real required-validation: `serviceAddressError = serviceAddr.isBlank()`, `emergencyNameError`/`emergencyPhoneError` required (in addition to the existing phone-format check), and include them in `canSave`.
  3. Decide the required granularity deliberately (e.g. emergency *name + phone* required, relationship optional) and reflect it in the field labels (add the `*`).
  4. Mirror on Android's edit/add screens; the existing field-required tests (`web/.../util/FieldValidatorsTest.kt`, Android `DirectoryViewModel*Test`) must be extended for the new required fields.
  5. Backfill consideration: existing Kinfolk records may have blank service address / emergency contact. Editing such a record must surface the now-required-but-empty fields as errors on first save attempt (not silently pass). No fabricated values.
  - **Dependency:** none new in the model (`serviceAddress`, `emergencyContact*` already exist on `Kinfolk`, `FirestoreClient.kt` ll.612, 620-622) — this is a requiredness + placement + validation change, plus a decision on how to handle legacy blank records.

## 4. Validation must fire on field-blur with field-specific messages (Auntie complaint)
- **Current:** validation is **on-save-attempt only**, with a **single generic message**. `attemptedSave` gates every `isError` (`KinfolkEditScreen.kt` ll.200, 340, 346, 369…), so fields don't show errors until Save is pressed; and the only message is one banner/toast: *"Fix the highlighted fields. First+Last name required; phone must be digits only; email must be a real address."* (ll.243-247, 326). `BottomBorderField` already tracks per-field `focused` state (l.57, l.136) but **does not** expose an on-blur callback, so no blur-time validation is possible today.
- **Desired:** each field validates **when it loses focus (blur)** and shows its **own** specific helper message under it. The mock already drafts these per-field messages (`.emsg` spans: "First name is required.", "Enter a real email address.", etc., ll.217, 234, 246) and tags them a SUGGESTION not yet in the Kotlin (mock comment l.116).
- **Fix (full-stack-ish — touches the shared field primitive + every form):**
  1. Extend `BottomBorderField` (and `MultilineField`) with an `onFocusLost`/`onBlur` hook and an `errorMessage: String?` param that renders a per-field helper line beneath the field (styled like the mock `.emsg`).
  2. In `KinfolkEditScreen`, track per-field "touched" state; run that field's validator on blur and pass the field-specific message. Keep the save-time gate as a backstop, but errors now appear field-by-field on blur.
  3. Author the per-field copy carefully: reuse the mock's messages where they fit, but the phone message must match the **real** rule (10 or 11 US digits), not the mock's "7 to 15 digits". No em dashes; no invented copy beyond what's needed — leave a TODO where wording needs sign-off.
  4. Mirror on Android edit/add screens; unit-test each validator's message mapping; component-test blur-triggered display.

## 5. Phone: allow dot/hyphen, enforce full length — "a 6-digit save was accepted" (Auntie complaint)
- **Current:** `isValidPhone` (`FieldValidators.kt` ll.40-46) **already** allows `+ - . ( ) space` separators (`PHONE_ALLOWED_CHARS`, l.25) and **already** requires exactly 10 digits (or 11 with leading `1`), explicitly rejecting short numbers (a 9-digit number is rejected; a 6-digit one certainly is). The primary phone is gated in `canSave` via `phoneError = !isValidPhone(phoneNumber)` (l.207, l.213). So in this current web code a 6-digit primary phone **cannot** be saved.
- **Desired:** dot/hyphen allowed; full US length enforced; a 6-digit number rejected on save AND on blur (item 4).
- **Fix:**
  1. **Web:** the validator is correct. Confirm it's wired everywhere a phone is entered — note **secondary/emergency/vet phones are only validated when non-blank** (ll.208, 211, 212), which is intended (they're optional), but verify the *required* phones (primary) are always gated.
  2. **The 6-digit bug is almost certainly the ANDROID screen, not this web file.** Audit `android/.../EditKinfolkScreen.kt` + `AddKinfolkScreen.kt`: confirm they call the same `isValidPhone` (or its Android twin) and gate save on it. If Android has a looser/absent phone check, port the web validator so all platforms enforce 10/11 digits and reject 6.
  3. Add a regression test for the exact failure: "a 6-digit phone is rejected on save" (and on blur), on **every** platform. Extend `FieldValidatorsTest.kt` and the Android validator tests.
  - **Dependency:** none new — this is a cross-platform consistency + test-coverage fix. The web rule is the source of truth; Android must match.

## 6. Vet Clinic section (household-level) — keep as-is, confirm placement
- **Current:** section "06 · Vet Clinic" (ll.448-483) is correctly **household-level** (comment ll.448, 732) with a shared-catalog chip row (`VetClinicChipRow`, autofills name/phone/address), free-typed clinic, and a "new clinic saved to catalog" callout. Vet phone validated when non-blank. This is the correct home for vet info per the cross-cutting decision in 04-kinfolk-profile and 06-kin-detail.
- **Desired:** unchanged in principle — vet stays on the Kinfolk. The Den styling already matches the mock (ll.313-337).
- **Fix:** keep. The only related work is the cross-cutting consolidation (remove the editable vet box on the *Kin* screen, see 06-kin-detail item 4; show read-only inherited vet on Kin). No change needed in this file beyond renumbering if sections move (items 2-3).

---

## Out of scope / leave as-is
- Mapbox `AddressAutofillField` (debounced suggest+retrieve, session-token billing, fail-loud red banner on lookup failure) — real and correct; keep (ll.582-717). It just needs to move under Identity and become required (item 3).
- Vet-clinic shared-catalog upsert on save (ll.254-265) — real, keep.
- Archive block (edit-only, audit-logged) — real, keep (ll.493-522, 764-795).
- `AuntieSaveBar` sticky footer + dirty-pip (a SUGGESTION already implemented) — keep (ll.526-532).
- Audit-log firing on create/update/archive — real, keep.
- `AddressAutofillField` Firebase-Function secret handling — out of scope here.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **`BottomBorderField` a11y/visibility overhaul** (resting line weight + optional fill + WCAG contrast + screen-reader label/required/error semantics). Shared primitive → benefits all forms. Mirror Android. a11y tests.
2. **Per-field blur validation** (add `onBlur` + `errorMessage` to `BottomBorderField`/`MultilineField`; per-field touched state + field-specific messages). Shared primitive → all forms. Mirror Android.
3. **Required + relocate Service address & Emergency contact under Identity** (requiredness, validators, `canSave`, label `*`, legacy-blank handling). Mirror Android. Extend validator tests.
4. **Remove Preferred contact method + Best time** from the editor AND resolve their downstream reads (profile "prefers {method}", `contactOverride` reconcile pipeline) so the model isn't half-referenced. All platforms.
5. **Android phone-validation parity** (port `isValidPhone` 10/11-digit rule; regression test "6-digit phone rejected"). The 6-digit-save bug is cross-platform consistency, sourced to web's correct validator.

Every value rendered/saved on this screen must trace to a real `Kinfolk` field via `build()` or be validated before write. Required fields fail loud on blur and on save — never a silent accept of malformed data.
