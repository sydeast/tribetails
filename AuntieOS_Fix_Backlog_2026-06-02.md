> STATUS (2026-06-09): MOSTLY SHIPPED. The `[ ]` checkboxes below are NOT
> maintained and do not reflect current state. Almost all Phase 0 to Phase 16
> items are DONE and DEPLOYED. For what is actually done vs remaining, use
> `AuntieOS_Combined_Execution_Plan_v2.md` and
> `android/_reference/STATE_OF_THE_UNION_2026-06-08.md`. Retained for the
> original June 2 walkthrough record only.

# AuntieOS — Fix Backlog (work top to bottom)

Captured from Auntie's walkthrough on **June 2, 2026, ~9:47 AM**. Ordered so foundational/blocking problems are fixed first, then screen-by-screen. Nothing here is invented — it's a faithful restructuring of the reported issues. Items marked **❓CONFIRM** are places where intent is clear but a detail should be verified before building.

**Standing rules that apply to EVERY item below (from CLAUDE.md + repeated instructions):**
- Every piece of functionality must be wired **front end → back end → tested**, per piece. "Not wired up yet" is not acceptable unless explicitly agreed.
- **Fail loud, never fake.** No silent error swallowing. No fabricated/sample data. Fallbacks only with a visible banner.
- Saves must actually persist to the backend (see Phase 0).
- Follow the existing markups. Stop substituting table/row UIs where a markup defines something else.

---

## PHASE 0 — Foundational (blocks everything; do first)

- [ ] **0.1 — Real data persistence.** Saves are fake. Hitting refresh wipes all changes — business hours, time off, appearance, etc. all disappear. Saving must write to the backend and survive reload. This violates "fail loud, never fake."
- [ ] **0.2 — Wire all features FE↔BE with testing.** Large amounts of the app are not wired up (Communicate, Broadcast, Templates, Schemas, Settings, etc.). Wire each piece front-to-back with tests before considering it done.
- [ ] **0.3 — Global validation framework.** Currently errors only fire **on save (after the fact)**. Required behavior:
  - Validate when the user **finishes typing a field** (on blur), not on save.
  - Phone, email, secondary email, secondary phone, clinic phone all need real format validation.
  - **Phone:** must allow dot `.` and hyphen `-` separators. Must enforce a **full, valid phone number** — a 6-digit number was accepted and saved; that must fail.
  - **Email:** must be a real, valid address format.
  - **Error message rewrite:** "Fix the highlighted fields" + a generic list of rules is wrong. The error must name **which specific field is actually invalid and why**, not list every field's requirement (which makes correct fields look wrong).
- [ ] **0.4 — Brand styling not applied.** Header, logo, and everything at the top of the homepage still use the **old DIN colors/styling**. The new brand styling is not active. Apply the current brand across the top/header/logo.
- [ ] **0.5 — Logo click behavior.** Clicking the logo (top-left) should refresh / go to the homepage, like every other app. Currently does nothing.

---

## PHASE 1 — Login

- [ ] **1.1 — Password manager support.** Login must support password manager autofill. Without it, users won't adopt the app.
- [ ] **1.2 — Tab order broken.** You have to press Tab **twice** to move to the next field. Fix tab order to single-tab field-to-field flow.

---

## PHASE 2 — Homepage

- [ ] **2.1 — Cards not clickable.** On the homepage, the cards (e.g. "Kintails pending") don't open anything. Make cards clickable to open their target.
- [ ] **2.2 — "Review and send drafts" routes wrong.** It goes to Communicate. It should go to **Kintails**.
- [ ] **2.3 — "Kintails to review" routes wrong.** It goes back to Communicate. It should go to **Kintails** (if Kintails need review, route to Kintails).
- [ ] **2.4 — "Today's pack" — works. (no fix)**
- [ ] **2.5 — "Open bookings" — looks fine. (verify only)**
- [ ] **2.6 — "Today's pick" → "View full schedule"** opens the Schedule screen, which has issues — see Phase 6.
- [ ] **2.7 — Notifications as a badge.** Notifications shouldn't be a big screen. Put a small **icon + badge** on the home screen that clicks through to the notifications view. (See Phase 10.)

---

## PHASE 3 — Directory (Kinfolk list)

- [ ] **3.1 — Kin / Kinfolk segmented control is broken.** The Kin and Kinfolk buttons sit inside one "pill" container; you can't tell they're separated, the container isn't centered, and the buttons sit at the top of the pill creating a weird gap. Rebuild as a proper, centered segmented control with clearly distinct segments.
- [ ] **3.2 — Sorting wrong.** "A to Z" sorts by **first name**. It must sort by **last name**.

---

## PHASE 4 — Add / Edit Kinfolk (owner profile)

**Structure & layout**
- [ ] **4.1 — Convert long scroll to tabs.** The profile is one long scrolling screen of sections. Make the sections **tabs**. If kept long anywhere, add a **table of contents / quick-jump nav** to reach sections fast.
- [ ] **4.2 — Field visibility / accessibility.** Fields are hard to see — bad for low-vision Kinfolk. Increase contrast/visibility so fields are clearly legible.
- [ ] **4.3 — Pill-in-pill control reappears here too** (off-center, awkward) and is **mislabeled as notifications**. Fix same as 3.1; correct the label.

**Required fields & data model**
- [ ] **4.4 — Service address is REQUIRED.** Stop defaulting it to optional. "Home and access is not optional." Auntie must know where visits go. Mark mandatory.
- [ ] **4.5 — Emergency contact is REQUIRED.** Mark mandatory.
- [ ] **4.6 — Move Service Address + Contact info under "Identity."** All of it is required, necessary profiling info and belongs in the Identity section.
- [ ] **4.7 — Address search: can search but can't select.** Search returns correct results, but selecting a result is buggy (eventually works). Fix the select flow so picking a result reliably populates the field.

**Remove these fields**
- [ ] **4.8 — Remove "Preferred contact method."** It's a single-select one-off; real communication is multi-channel. This will instead be handled by the notification settings system. Remove it.
- [ ] **4.9 — Remove "Best time to contact."** Repeatedly requested removal. Remove it and stop re-adding it.

**Validation (applies on this form specifically — see 0.3)**
- [ ] **4.10 — Phone / email / secondary email / secondary phone / clinic phone** accept invalid formats (hashes of letters/specials/numbers) and only error on save. Validate on finish-typing; reject invalid formats; enforce full phone length (no 6-digit saves).

---

## PHASE 5 — Kin (pet) profile

- [ ] **5.1 — Species must be a dropdown.** Repeatedly requested. Replace open text with a dropdown.
- [ ] **5.2 — Breed should be a dropdown too.** Pull a breed list instead of open text.
- [ ] **5.3 — Profile picture upload not working.** Fix upload.
- [ ] **5.4 — Remove vet info box from the pet (Kin).** Vets attach to the **Kinfolk (owner)**, not the Kin. Stop adding an "add/edit vet info" box to the pet profile. It may be shown **read-only** on the Kin, but never as an entry box there.
- [ ] **5.5 — Precare checklist field is wrong.** It's currently an open text box. A checklist must come from the **dynamic field boxes** (see Phase 14), not a free-text field. Remove the open field.
- [ ] **5.6 — Kin required fields:** required **name**, required **species**, required **gender** (use the label **"gender," not "sex"**).

---

## PHASE 6 — Schedule / Bookings / Antie-Time (resolve the 3-page confusion)

These three are conflated. Define clear, non-overlapping responsibilities and a single source of truth.

- [ ] **6.1 — Schedule becomes a Calendar.** Stop letting users "add a new visit" from Schedule while also "adding a new booking" from Bookings — that's duplicated functionality with no source of truth. **Schedule should simply be a full calendar of events.** Rename/repurpose to a calendar view.
- [ ] **6.2 — Bookings = booking management only.** It currently overlaps Schedule and is just a giant table list (history is unorganized rows). Restrict it to booking management and give it real organization (not raw rows).
- [ ] **6.3 — Antie-Time gets the operational views.** **Today's route, active visits, and upcoming care windows** currently live (mislabeled) under Schedule — they belong under **Antie-Time**. Antie-Time is currently empty/not done. Build it.
- [ ] **6.4 — Calendar UI polish.** Calendar isn't centered, doesn't fill the full space, and the pills aren't level. Fix layout.
- [ ] **6.5 — Fix mislabeled "This week's runs."** Wrong label/grouping — correct it as part of the Schedule→Calendar and Antie-Time split.

---

## PHASE 7 — Invoices & Payments

- [ ] **7.1 — Invoice rows missing data.** Kinfolk first/last name and key info aren't shown on invoice rows. The actual information is not being migrated onto invoices. Migrate and display the real data.
- [ ] **7.2 — Add filtering, not just search.** A bare search box isn't usable (search by what — invoice number?). Add **filtering**, including by **Kinfolk name (first + last)**.
- [ ] **7.3 — Payments is a sub of Invoices, not its own page.** Clicking an invoice should show its **linked payment**. Right now payments aren't linked to invoices and there's a standalone Payments page, which is wrong. Link payments to invoices.
- [ ] **7.4 — "Record payment" button.** Add a Record Payment action, likely **on the invoice itself**. ❓CONFIRM placement (on invoice vs. elsewhere).

---

## PHASE 8 — Kintails

- [ ] **8.1 — Stop the long table/row list.** Kintails is one long list / rows of tables — unorganized and unhelpful. Too many table UIs (explicitly told not to use them).
- [ ] **8.2 — Follow the markups.** The Kintails layout does not match the markups. The markup layout (lines/box/booking style) is better — build to the markup.

---

## PHASE 9 — Communicate (core feature — pieces were lost)

- [ ] **9.1 — Add message-type selection.** Can't choose what you're creating. Add a type selector: **visit / text message / email / blog post**. Right now it's one giant "personalized, choose a recipient" flow.
- [ ] **9.2 — Blog posts shouldn't force a recipient.** A blog post doesn't need a specific Kinfolk attached. Don't require a recipient for it.
- [ ] **9.3 — Add "about / subject" selection.** Can't select what the message is about. Add it.
- [ ] **9.4 — Clarify "Generate and approve draft."** Its purpose/behavior is unclear. Define and label it clearly.
- [ ] **9.5 — Templates not working.** Can't pull templates into Communicate. Wire template selection. (Depends on Phase 13.)
- [ ] **9.6 — Broadcast not working.** Broadcast = **company-wide messaging** (email/text/push/marketing to **all** Kinfolk). Build and wire it.
- [ ] **9.7 — Wire Communicate end-to-end.** Currently not wired up.

---

## PHASE 10 — Notifications & Inbox (de-duplicate the terminology)

- [ ] **10.1 — Notifications shouldn't be a big admin screen.** Shrink to a **badge + icon** (on the home screen) that clicks into the detail view.
- [ ] **10.2 — Sidebar "Notifications" is meaningless as-is.** There are multiple notification types — general **business notifications**: received an email, received a text, booking requested, etc. Organize by type so the label/section is meaningful.
- [ ] **10.3 — Resolve duplicate "Inbox" vs "Notifications."** There's also an Inbox; lots of duplicate, wordy, convoluted terminology. Consolidate naming so there aren't overlapping inbox/notification concepts. ❓CONFIRM the final naming/structure with Auntie.

---

## PHASE 11 — Activity Log

- [ ] **11.1 — Rows aren't usable.** It's random table rows you can't click into for detail. Make entries clickable with detail, and surface usable information (not junk).
- [ ] **11.2 — Sentry linkage?** Confirm whether activity log entries are/should be attached to **Sentry**. ❓CONFIRM intended data source and what detail each entry should show.

---

## PHASE 12 — Training Dogs (currently mis-built — repurpose)

- [ ] **12.1 — "Training Dogs" is not a business-operations feature.** Rebuild it as the **AI-generator upload tool**:
  - Lets Auntie **type up notes, take/upload screenshots, attach files**, and attach them to a **Kinfolk or Kin**.
  - That information then **propagates/updates the client's folk note** — i.e. the **411 and dossiers**, and AI-generated profile blurbs.
  - Context: some info (texts, emails, notes, kin care) is auto-grabbed by the system; **in-person conversations are not** — this tool is where Auntie manually feeds that in so dossiers/411 stay updated.
  - ❓CONFIRM final name (keep "Training Dogs" or rename).

---

## PHASE 13 — Templates (Template Bank + Template Assignment)

- [ ] **13.1 — Merge/relate the two nav items.** Template Bank and Template Assignment are separate nav entries but are related. Unify or clearly link them. ❓CONFIRM whether to merge into one or keep linked.
- [ ] **13.2 — Category must pull from real categories, not be optional free text.** Optional/open category on a company template creates duplicate, mistyped, misformatted categories. Replace with a selector from the **existing category list**.
- [ ] **13.3 — Replace the plain text-box editor with a real editor widget.** "New template" is just filled-in text boxes (body / HTML / description) — unhelpful. Provide a proper editor.
- [ ] **13.4 — Add formatting tools.** Client-facing templates need **HTML formatting, images, and links**.
- [ ] **13.5 — Live preview in edit mode.** Editing should show a **live preview** of what the template will look like while editing the body/HTML.
- [ ] **13.6 — Viewing a template is unreadable.** Opening one just shows rows of text that are hard to differentiate. Render it clearly.
- [ ] **13.7 — Add instructions/directions.** The Template Bank has no guidance on what to do. Add directions.
- [ ] **13.8 — Let templates be assigned to categories.** Can't attach categories (onboarding / booking / invoicing / re-engagement) to templates. Add assignment, including **drag-and-drop** (currently no drag-and-drop is allowed anywhere — enable it here). Allow editing the category on **seeded** templates too.
- [ ] **13.9 — Template Assignment page does nothing.** "New binding" does nothing; rows do nothing; the page is dead. Build/wire it. ❓CONFIRM what a "binding" is meant to do (template ↔ category ↔ trigger?).

---

## PHASE 14 — Format Schemas / Dynamic Fields (duplicate + broken)

- [ ] **14.1 — Consolidate the duplicates.** "Format Schemas" and "Dynamic Fields Manager" appear to be the same feature built twice, and neither works. Merge into one working dynamic-fields system.
- [ ] **14.2 — Purpose:** dynamic fields the admin can add to **Kinfolk, Kin, Kintails, and pet profile pages** (this powers the precare checklist in 5.5). This previously **worked in an earlier iteration under Settings → Business Settings**. Restore that working behavior.
- [ ] **14.3 — Backend should generate snake_case.** Don't make the user type a `snake_case` key for every field. Auto-generate it on the backend.
- [ ] **14.4 — "Applies to" needs a real placement target.** It says it applies to "kin folk / kin session / booking" but not **where** under those. Let the admin choose the exact section/location the field appears, and show where it will go.
- [ ] **14.5 — Add formatting/config tools.** Currently can't set or add anything. Provide field configuration (type, label, options, placement) and have it actually save and render.

---

## PHASE 15 — Settings (split personal vs business; fix everything)

- [ ] **15.1 — Separate "My Profile" (personal) from "Business" settings.** Personal profile, personal password reset, and time off are mixed into the business settings page. Split them into distinct areas.
- [ ] **15.2 — Notifications settings are wrong (high priority).** Today it's only three on/off toggles (email on/off, SMS on/off, push on/off). Required design:
  - List **every notification TYPE** as a row — e.g. Kintails, visit confirmations, marketing, Antie checked-in, Antie arrived/departed, new note, new comments, etc.
  - Put **Email / SMS / Push as checkboxes next to each type**.
  - Admin toggles whether each type is available per channel; on the **Kinfolk (client) side**, clients then choose which of the enabled notifications they want to receive and on which channel.
- [ ] **15.3 — Appearance needs real customization.** Only light / dark / system is offered. Add meaningful appearance customization beyond a theme toggle. ❓CONFIRM the customization options Auntie wants (colors, density, etc.).
- [ ] **15.4 — Security / login credentials are broken.**
  - Security currently shows the **business password reset** and lists the **business email as the user's email** (incorrect).
  - There is **no way to edit the personal email / login email**, and no way to change the password (only reset to the original email).
  - Add the ability to **edit login email and change password**, with an account-recovery path for lost access.
- [ ] **15.5 — "Time off" is confusingly named and conflated.** It mixes a person's **personal time-off request** with **business closures / holiday hours** — these are different. Separate them and name them clearly (personal time off vs. business hours/closures).
- [ ] **15.6 — Settings don't persist.** Business hours, time off, and appearance are lost on refresh — covered by Phase 0.1, but verify each Settings screen specifically persists.

---

## Cross-cutting themes (keep in mind throughout)
- **No table/row dumps** where a markup or organized view is expected (Kintails, Bookings history, Invoices, Activity Log, Payments).
- **Follow the markups** — several screens diverge from them.
- **Enable drag-and-drop** where it makes sense (template→category assignment at minimum).
- **De-duplicate terminology** — Inbox vs Notifications, Schedule vs Bookings vs Antie-Time, Format Schemas vs Dynamic Fields, Template Bank vs Template Assignment.
- **Persistence + wiring + tests** on every single item before it's called done.

---

## PHASE 16 — MyTribe flagged features to build full-stack (added 2026-06-02 PM)

MyTribe "suggested UI" features that were started + gated behind a flag but never finished full-stack. Each: complete the full stack, then leave it behind its flag (toggle via the Feature Flags admin screen). Operator design decisions are recorded inline.

- [ ] **16.1 — Feature Flags admin screen: Android.** Build the Android equivalent of the web Feature Flags admin screen (nav + screen + `setFeatureFlags` client call); same 11 `auntieos.*` flags + toggles.

- [ ] **16.2 — Invoice PDF download (MyTribe kinfolk).** Flag `mytribe.invoice.downloadPdf` (disabled "Download PDF" stub on InvoiceDetailScreen). **Decision: client-side print-to-PDF** (no backend). Gotcha: MyTribe web is a Skiko canvas, so `window.print()` prints the canvas ugly — build an HTML invoice in a popup window + print (jsMain interop); Android = PrintManager. Then flip the flag on. *(Relates to Phase 7 — Invoices.)*

- [ ] **16.3 — Recurring visit request (MyTribe kinfolk + backend).** Flag `mytribe.schedule.recurringVisit` ("Coming soon" stub on ScheduleScreen). **Decision: simple weekly/biweekly request** — kinfolk picks weekday + cadence (weekly/biweekly) + time block → creates a recurring booking REQUEST the admin approves; a new `createRecurringBooking` callable expands it into individual bookings on approval. Rules + tests + flag on. *(Relates to Phase 6 — Schedule/Bookings.)*

- [ ] **16.4 — Message Auntie (MyTribe → AuntieOS Inbox; both apps).** Flag `mytribe.schedule.messageAuntie` ("Coming soon" stub). **Decision: real conversations** — new `conversations`/`messages` model + `sendKinfolkMessage` callable + rules; MyTribe compose UI; **AuntieOS Inbox** reads threads + reply callable + UI. Largest item; spans both apps + platforms. *(Relates to Phase 9 — Communicate + Phase 10 — Inbox/Notifications.)*

- [ ] **16.5 — `mytribe.booking.envelope` decision (D1).** Booking-envelope grouping (group visits by `batchId`) is partially wired in MyTribe but blocked on an AuntieOS parent-doc schema decision. Resolve D1 (whether AuntieOS needs a parent booking doc), then finish.

- **Note:** `mytribe.tribe.legacyCustomFields` stays OFF intentionally (escape hatch enforcing "kinfolk cannot add custom fields"); do not enable without a reason.

**AuntieOS `FF_` local-const backlog (~30 items):** compile-time gated suggested UI in AuntieOS web screens, each needing a backing callable before promotion to a central flag. Full list in `docs/2026-06-01-redesign-backlog.md` (invoice create/receipt/reminder, communicate broadcast/external-send, bookings bulk-select, profile-pic upload, scheduling sync, template/schema search, comment thread, view-as-kinfolk, etc.). Many overlap existing phases here (e.g. invoice actions → Phase 7, broadcast → 9.6, dynamic fields → Phase 14).
