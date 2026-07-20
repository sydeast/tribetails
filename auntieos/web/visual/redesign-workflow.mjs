export const meta = {
  name: 'auntieos-den-redesign-screens',
  description: 'Redesign + bug-fix + flag-gate the remaining AuntieOS web screens to the Den aesthetic, one agent per screen (disjoint files), each reviewed/self-repaired',
  phases: [
    { title: 'Redesign', detail: 'one writer agent per screen rewrites its file to the Den kit + fixes audited bugs + gates suggested items' },
    { title: 'Review', detail: 'reviewer reads each edited file, repairs compile/em-dash/fail-loud issues in place' },
  ],
}

const ROOT = '/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS'
const SCR = `${ROOT}/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens`
const AUDIT = `${ROOT}/docs/2026-06-01-web-audit.md`
const UI = `${ROOT}/ui-ideas`

// Shared reference embedded in every agent prompt: the real, verified API surface.
const REF = `
=== AuntieOS web — VERIFIED API surface (use ONLY what is listed; read a file if unsure) ===

THEME (com.tribetails.auntieos.web.theme.AuntieTheme):
  AuntieTheme.colors -> AuntieColors fields: background, surface, surface2, surfaceGlass, border, borderSoft,
    primary (orange), primaryDim, secondary (pink), accent (teal), tertiary (purple), coral,
    textPrimary, textDim, textFaint, success, warning, error, errorContainer, isDark.
    gradient helpers: tribeGradientColors, orangeToPinkColors, tealToPurpleColors, sunsetGlowColors.
  AuntieTheme.typography fields (TextStyle): displayLarge, displayMedium, headlineLarge, headlineMedium,
    headlineSmall, titleLarge, titleMedium, titleSmall, bodyLarge, bodyMedium, bodySmall,
    labelLarge, labelMedium, labelSmall, mono.  (NOTE: there is NO displaySmall / label / caption.)
  AuntieTheme.dims: borderHairline, maxContentWidth, sideRailWidth, bottomDockHeight,
    space1..space10 (spacing dp tokens). Read theme/AuntieDimensions.kt if you need exact values.

DEN KIT (com.tribetails.auntieos.web.ui.components.*) — PREFER THESE, the shared redesign vocabulary:
  DenScreenHeading(kicker: String, title: String, modifier=Modifier, accentTail: String?=null,
    subtitle: String?=null, trailing: (@Composable ()->Unit)?=null)
      -> mono uppercase kicker (orange) + big serif title + optional italic accent word + subtitle. PUT AT TOP OF EVERY SCREEN.
  StatCard(label, value, trend, tone: AuntieStatusTone, modifier=Modifier, feature=false, onClick:(()->Unit)?=null)
  DenPanel(title, modifier=Modifier, subtitle: String?=null, cornerRadius=18.dp, contentPadding=20.dp,
    trailing:(@Composable ()->Unit)?=null, content:@Composable ()->Unit)  -> glass section panel w/ serif title.
  ServicePill(serviceType: String, tone: AuntieStatusTone = serviceTone(serviceType))
  EmptyHint(text: String, error: Boolean=false)
  helpers (top-level fun): denCurrentHour(): Int, greetingForHour(hour): String, serviceTone(s): AuntieStatusTone,
    statusLabel(status): String, formatTime(iso): String.

EXISTING COMPONENTS (com.tribetails.auntieos.web.ui.components.*) — reuse, do not reinvent:
  ScreenScaffold(content)  -> capped-width vertical-scroll container. WRAP top-level screens in this.
  GlassSurface(modifier=Modifier, cornerRadius=12.dp, backdropBlur=0.dp, content)
  PrimaryButton(label, onClick, modifier=Modifier, enabled=true, leading:(@Composable()->Unit)?=null)
  GhostButton(label, onClick, modifier=Modifier, enabled=true, leading=null)
  AuntieBanner(modifier=Modifier, tone: AuntieBannerTone=Info, title:String?=null, icon:ImageVector?=null,
    dashed=false, pillLabel:String?=null, onDismiss=null, trailing=null, body:@Composable()->Unit)
    AuntieBannerTone: Info, Success, Warning, Error, Suggestion.
  AuntieEmptyState(title, modifier=Modifier, message:String?=null, icon:ImageVector?=null, compact=false, action=null)
  AuntieStatusPill(label, modifier=Modifier, tone=Neutral, showDot=false, dotOnly=false, mono=false, glow=false, leadingIcon=null)
  AuntieStatTile(label, value, modifier=Modifier, caption:String?=null, tone=Neutral, emphasized=false, alignEnd=false, onClick=null)
  AuntieEntityRow(title, modifier=Modifier, subtitle:String?=null, leading=null, trailing=null,
    leadingDotTone:AuntieStatusTone?=null, selected=false, showDivider=false, onClick=null)
  AuntieIconTile(icon: ImageVector, modifier=Modifier, size=42.dp, tone=Neutral, background:Brush?=null, contentDescription=null)
  SectionHeader(title, modifier=Modifier, icon:ImageVector?=null, subtitle:String?=null, onBack:(()->Unit)?=null, breadcrumbs:List<String>=emptyList(), trailing=null)
  AuntieSearchField(value, onValueChange, modifier=Modifier, placeholder="Search...", leadingIcon=null, shortcutHint=null, onClear=null, onSubmit=null, enabled=true)
  AuntieChip(label, modifier=Modifier, selected=false, onClick=null, enabled=true, leading=null, trailingTag=null, secondaryLabel=null, onRemove=null, tone:AuntieChipTone=Neutral, mono=false)
    AuntieChipTone: Neutral, Accent, Teal, Purple, Orange.
  SegmentedPicker<T>(options:List<T>, selected:T, onSelect:(T)->Unit, label:(T)->String, modifier=Modifier)
  AuntieStatusTone enum: Neutral, Success, Warning, Error, Teal, Purple, Orange, Muted. extension: tone.color(c).
  Also available (read the file before using): AuntieSelectField, AuntieToggle, AuntieCheckbox, AuntieSlider,
    AuntieSaveBar, AuntieDialog, AuntieTable, SortMenu, AuntieDashedAddButton, MultilineField, BottomBorderField,
    AuntieKeyValueRow, AuntieSettingRow, AuntieFieldLabel, AuntieAvatar, AuntieMediaGrid, ShimmerSkeleton, AuntieSpinner.
  Icons: com.composables.icons.lucide.Lucide.<Name> (e.g. Lucide.PawPrint). M3 is BANNED except Text, Icon, DropdownMenu, DatePicker.

DATA (val client = remember { FirestoreClient() }; com.tribetails.auntieos.web.data.*):
  FirestoreResult<T> = Loading | Data(value) | Error(message). WriteResult<T> = Ok(value) | Err(message).
  Collect streams with the P0-FLICKER pattern:  val s by remember { client.fooStream() }.collectAsState(initial = FirestoreResult.Loading)
  Streams: kinfolkStream(), kinStream(kinfolkId), allKinStream(), sessionsStream(), sessionsForKinfolkStream(id),
    sessionsBySourceBookingIdStream(id), generatedDraftsStream(), reportsStream(), voicemailsStream(), callsStream(),
    smsStream(), emailsStream(), invoicesStream(), activityStream(), notificationsStream(), templatesStream(),
    activeTemplateForService(serviceType), reportForSessionStream(sessionId), mediaForSessionStream(sessionId),
    mediaStream(entityId, entityType), paymentsStream(), businessSettingsStream(), bookingRequestsStream(),
    incomingKinCaresStream(), trainingDocsStream(), userProfileStream(uid), vetClinicsStream(), dynamicFieldsStream(),
    dossierStream(id), kin411Stream(id), reportForSessionStream(id), breadcrumbsStream(sessionId).
  suspend writes: approveGeneratedDraft(draftId, editedCopy), updateInvoiceSessionIds(invoiceId, ids),
    updateSessionInvoiceId(sessionId, invoiceId), getFeatureFlags(), createKinfolk/updateKinfolk/archiveKinfolk,
    createKin/updateKin/archiveKin, patchKinCare(id, patch), markVoicemailReplied(...), markVoicemailRead(id),
    createKinTaleReport(r), updateKinTaleReport(r), markKinTaleReportSent(...), assignKinfolkToOrphanReport(...),
    markOrphanReportAsDuplicate(...), archiveOrphanReportAsBadData(...), saveReport(r), sendReport(reportId),
    uploadMedia(entityId, entityType, bytes, mimeType), deleteMedia(id), recordPayment(payment),
    saveBusinessSettings(s), approveBooking(id), rejectBooking(id), createBookingRequest(b), patchKinCareDoc(...),
    saveUserProfile(p), createVetClinic/updateVetClinic, logActivity(entry), getHouseholdData(id), saveHouseholdData(d),
    createDynamicField/updateDynamicField/archiveDynamicField, createKinTaleTemplate(t), updateKinTaleTemplate(t),
    deleteKinTaleTemplate(id), bookingNotesStream(kinfolkId, bookingId, internal, visitId=""), addBookingNote(...).
  There is NO method beyond this list. If a fix needs a method that does not exist, DO NOT invent it: keep the
  control disabled with a visible "Not wired yet" banner/pill and report it in clientMethodsNeeded.

NAV (com.tribetails.auntieos.web.ui.shell.Destination): Home, Directory, KinTales, Schedule, Bookings, Sessions,
  Invoices, Communicate, Inbox, Notifications, Activity, Payments, Settings, TrainingDocs, TemplateBank,
  TemplateAssignment, FormSchemas, MediaGallery.

FEATURE FLAGS (com.tribetails.auntieos.web.config.LocalFeatureFlags.current -> FeatureFlags):
  val flags = LocalFeatureFlags.current ; then gate: if (flags.<prop>) { ... }
  EXISTING props (all default false): homeWeeklyRevenueStat, homeGlobalSearch, notificationBell,
    directoryLastVisit, directoryNewBadge, inboxBulkMarkRead, activityChainVerify, scheduleNewVisit,
    scheduleDragReschedule, scheduleGoogleCalBusy, notificationsQuickActions.
  If your screen needs a flag NOT in that list: DO NOT edit FeatureFlags.kt (a central file). Instead gate the
  element behind a local  \`val FF_<NAME> = false // TODO(flag): auntieos.<area>.<flag>\`  so it ships dark and
  compiles, and report it in flagsNeeded so the main thread wires it centrally.

=== HARD CONSTRAINTS (violating any is a failure) ===
1. Edit ONLY your assigned file(s). NEVER edit any shared file (FeatureFlags.kt, LocalFeatureFlags.kt,
   DenScreenKit.kt, FirestoreClient.kt, FirestoreInterop.*.kt, NavDestinations.kt, AppShell.kt, App.kt, theme/*,
   any other screen). If you need a change there, report it; do not make it.
2. FAIL LOUD, NEVER FAKE. Never fabricate data or fake a success. Unbacked actions stay disabled + carry a
   visible AuntieBanner(tone=Suggestion/Warning) or AuntieStatusPill "Not wired yet". Surface errors
   (FirestoreResult.Error / WriteResult.Err) visibly, never swallow.
3. NO EM DASH (U+2014) and no en-dash-used-as-a-pause anywhere (comments, strings, copy). Use period, comma,
   colon, or parentheses.
4. Do NOT fabricate kinfolk/customer-facing copy (email/notification body text, marketing words). Preserve any
   existing such copy verbatim; if a new such string is needed, leave a TODO placeholder. You MAY write
   operator-facing UI chrome labels (section titles, button labels, hints) since the operator is the app's user.
5. Keep it COMPILABLE. Only call APIs verified above or by reading a file. Keep imports correct and complete.
   Match existing idioms (P0-FLICKER remember{} on streams; FirestoreResult Loading/Data/Error handling).
6. Apply the Den aesthetic: start with DenScreenHeading; use DenPanel for sections, StatCard for stat rows, and
   the existing Auntie* components + brand tones. The shell already paints the mesh-gradient background and glass
   rail, so do NOT paint your own page background. Match Home (screens/home/HomeScreen.kt) as the exemplar.
`

const SCREENS = [
  { key: 'directory', hard: true, files: [`${SCR}/directory/DirectoryScreen.kt`, `${SCR}/directory/DirectoryViewModel.kt`], mockup: `${UI}/auntieos-directory-2026-05-27.html`, audit: '43,77',
    direction: 'Replace FlowRow(widthIn.weight) with a fixed equal-height responsive grid of kinfolk cards. WIRE the currently-unused DirectoryViewModel (search/sort). REMOVE the per-card N+1 kinStream call. Gate per-card last-visit (directoryLastVisit) and NEW badge (directoryNewBadge).' },
  { key: 'communicate', hard: true, files: [`${SCR}/communicate/CommunicateScreen.kt`], mockup: `${UI}/auntieos-communicate-2026-05-27.html`, audit: '105,140',
    direction: 'Build the real comms surface: template picker (templatesStream), kinfolk recipient picker (kinfolkStream), and live preview of the selected template/draft. approveGeneratedDraft is the backed send-path for drafts. Delete any stale "no backend" comment. If external/outside-tribe send has NO callable, gate it behind a flag + Not-wired banner (report flag). Do not fake sends.' },
  { key: 'manage-bookings', hard: true, files: [`${SCR}/booking/BookingScreen.kt`, `${SCR}/booking/BookingViewModel.kt`], mockup: `${UI}/auntieos-manage-bookings-2026-05-27.html`, audit: '162,197',
    direction: 'Fix z-overlap: wrap GlassSurface children in a Column with spacing (nothing stacked on the header). Render the Pending-approval + Scheduled sections, not only History; point them at bookingRequestsStream()/the real requested source. Resolve kinfolkName + a date fallback (startTime then completedAt) so rows are not "Unnamed Kinfolk / No date". approveBooking/rejectBooking are backed. Gate bulk-select if unbacked.' },
  { key: 'settings', hard: true, files: [`${SCR}/settings/SettingsScreen.kt`, `${SCR}/settings/SettingsViewModel.kt`, `${SCR}/settings/DynamicFieldsCard.kt`], mockup: `${UI}/auntieos-settings-2026-05-27.html`, audit: '379,415',
    direction: 'FIX the "stuck on Integrations" bug: SectionNav is decorative (active hardcoded to Integrations, empty onClick lambdas). Add real selectedSection state; clicking a nav item switches which panel(s) show (single-panel switch is cleanest). Keep the app full settings set (Profile, Business Profile, Business Hours, Notifications, Integrations, Scheduling, Appearance, Security, Time off, Dynamic Fields). Guard the Save buttons (disable while settings doc not loaded). Gate profile-pic upload (it uploads an empty ByteArray today; report flag + keep disabled). Integration "Connected" pills are hardcoded literals: relabel to reflect they are static config, do not present fake live health. Apply Den heading + DenPanel per section.' },
  { key: 'schedule', hard: true, files: [`${SCR}/schedule/ScheduleScreen.kt`, `${SCR}/schedule/BookingDetailModal.kt`], mockup: `${UI}/auntieos-schedule-2026-05-27.html`, audit: '223,258',
    direction: 'Apply Den heading + glass week grid. Fix serviceTint color matching (use serviceTone), UTC->local time display, and off-window clamp. New-visit / drag-reschedule / gcal-busy stay gated (scheduleNewVisit, scheduleDragReschedule, scheduleGoogleCalBusy) with the existing Not-wired banner. Data emptiness is a separate migration task, not yours: render a clean empty state.' },
  { key: 'invoice-detail', files: [`${SCR}/invoices/InvoiceDetailScreen.kt`, `${SCR}/invoices/InvoiceDetailState.kt`], mockup: `${UI}/auntieos-invoice-detail-2026-05-27.html`, audit: '78,104',
    direction: 'Apply Den heading + DenPanel. This screen will host PAYMENTS for the invoice: render the invoice payment(s) section (paymentsStream filtered to this invoice) so opening a paid invoice shows its payment. Unify paid/outstanding/overdue (compare dueDate to today). If Payment has no invoiceId join yet, show a clear "no linked payment recorded" empty state and report it in clientMethodsNeeded/openQuestions (do not fake).' },
  { key: 'auntie-time', files: [`${SCR}/sessions/KinCareSessionsScreen.kt`], mockup: `${UI}/auntieos-auntie-time-2026-05-27.html`, audit: '198,222',
    direction: 'Apply Den heading + DenPanel + StatCards + the shared VisitRow look (paw AuntieIconTile + ServicePill + statusLabel/formatTime). Active/Upcoming/Recent grouping. Empty data is migration, not yours: clean empty state.' },
  { key: 'invoices', files: [`${SCR}/invoices/InvoicesScreen.kt`, `${SCR}/invoices/InvoiceFilters.kt`], mockup: `${UI}/auntieos-invoices-2026-05-27.html`, audit: '259,292',
    direction: 'Apply Den heading + StatCards (totals) + DenPanel list. Unify paid/outstanding/overdue logic (dueDate vs today). onInvoiceClick(invoiceId) already routes to invoice-detail. Consume real invoicesStream(); surface errors loudly.' },
  { key: 'payments', files: [`${SCR}/payments/PaymentsScreen.kt`, `${SCR}/payments/PaymentsViewModel.kt`], mockup: `${UI}/auntieos-payments-2026-05-27.html`, audit: '293,323',
    direction: 'Apply Den heading + DenPanel. Consume real paymentsStream(). Per user intent, Payments is being folded under Invoices (open a paid invoice -> see its payment); keep this screen as the full payments ledger but make it Den-consistent. Surface errors loudly.' },
  { key: 'inbox', files: [`${SCR}/inbox/InboxScreen.kt`], mockup: `${UI}/auntieos-inbox-2026-05-27.html`, audit: '324,346',
    direction: 'Apply Den heading + DenPanel + AuntieEntityRow rows. Gate bulk "Mark all read" (inboxBulkMarkRead) since no bulk callable. Surface errors loudly.' },
  { key: 'activity-log', files: [`${SCR}/activity/ActivityLogScreen.kt`], mockup: `${UI}/auntieos-activity-log-2026-05-27.html`, audit: '347,378',
    direction: 'Apply Den heading + DenPanel + rows. Gate "Chain verified" badge + Re-verify + per-entry hash columns behind activityChainVerify. Consume activityStream(); surface errors loudly.' },
  { key: 'training-documents', files: [`${SCR}/trainingdocs/TrainingDocumentsScreen.kt`], mockup: `${UI}/auntieos-training-documents-2026-05-27.html`, audit: '416,438',
    direction: 'Apply Den heading + DenPanel. Add-document form + Comm-Type filter chips stay gated/disabled (no create callable) with the existing fail-loud banner. The comm-type chips currently do not narrow the list and mislead: either wire them to a local filter over displayedDocs or label them clearly as non-functional grouping. Consume trainingDocsStream(); surface deserialization/errors loudly.' },
  { key: 'notifications', files: [`${SCR}/notifications/NotificationsScreen.kt`], mockup: `${UI}/auntieos-notifications-2026-05-27.html`, audit: '439,467',
    direction: 'Apply Den heading + DenPanel + rows. The read-permission rule is already fixed server-side. Gate per-notification quick actions + read/unread model behind notificationsQuickActions. Consume notificationsStream(); surface errors loudly.' },
  { key: 'template-bank', files: [`${SCR}/admin/TemplateBankScreen.kt`], mockup: `${UI}/auntieos-template-bank-2026-05-27.html`, audit: '468,495',
    direction: 'Apply Den heading + DenPanel + cards. FIX: card tap should open a read view of the template (today only Edit reveals data). FIX: "New Template" must work: open the editor with a fresh template and persist via createKinTaleTemplate. Consume templatesStream(); surface errors loudly.' },
  { key: 'template-assignment', files: [`${SCR}/admin/TemplateAssignmentScreen.kt`], mockup: `${UI}/auntieos-template-assignment-2026-05-27.html`, audit: '496,523',
    direction: 'Apply Den heading + DenPanel. Verify the assign flow uses a real backed path; if assignTemplate triggerKey/catalogKey handling is risky, surface it in openQuestions (the callable lives in MyTribe, not this repo, so do not edit it). Surface errors loudly.' },
  { key: 'formschema-list', files: [`${SCR}/admin/formschemas/FormSchemaListScreen.kt`], mockup: `${UI}/auntieos-formschema-list-2026-05-27.html`, audit: '524,549',
    direction: 'Apply Den heading + DenPanel + cards. FIX "New schema" nav round-trip: onOpenEditor("") -> "#/form-schemas/" parses to null and bounces. Use a "new" sentinel id so the editor opens in create mode. Surface errors loudly.' },
  { key: 'kintale-report', files: [`${SCR}/kintales/KinTaleReportScreen.kt`, `${SCR}/kintales/KinTaleReportViewModel.kt`], mockup: `${UI}/auntieos-kintale-report-2026-05-27.html`, audit: '550,589',
    direction: 'Apply Den heading + DenPanel. Render the dead-code row meta (visit date + media/channel pips). Fix report send pop-back. Use a live stream not .first(). saveReport/sendReport are backed. Surface errors loudly.' },
  { key: 'kintale-logs', files: [`${SCR}/kintales/KinTaleLogsScreen.kt`], mockup: `${UI}/auntieos-kintale-logs-2026-05-27.html`, audit: '141,161',
    direction: 'Apply Den heading + DenPanel + AuntieEntityRow rows with the subtitle/meta slot (visit date + media/channel pips). onOpenReport(sessionId) routes to the report. Consume reportsStream(); surface errors loudly.' },
  { key: 'formschema-editor', files: [`${SCR}/admin/formschemas/FormSchemaEditorScreen.kt`, `${SCR}/admin/formschemas/FormSchemaEditorViewModel.kt`, `${SCR}/admin/formschemas/FormSchemaHelpers.kt`], mockup: `${UI}/auntieos-formschema-editor-2026-05-27.html`, audit: '590,614',
    direction: 'Apply Den heading + DenPanel. Add client-side validation parity (min 1 section / min 1 field) and surface the server Zod error detail on save failure. Handle the "new" sentinel id (create mode) from formschema-list. Surface errors loudly.' },
]

const WRITER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screen', 'filesEdited', 'summary', 'bugsFixed', 'interactionsWired', 'suggestedGated', 'flagsNeeded', 'clientMethodsNeeded', 'compileRisks', 'emDashRemoved', 'openQuestions'],
  properties: {
    screen: { type: 'string' },
    filesEdited: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    bugsFixed: { type: 'array', items: { type: 'string' } },
    interactionsWired: { type: 'array', items: { type: 'string' } },
    suggestedGated: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { item: { type: 'string' }, gate: { type: 'string' } }, required: ['item', 'gate'] } },
    flagsNeeded: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, propName: { type: 'string' }, default: { type: 'boolean' }, desc: { type: 'string' } }, required: ['key', 'propName', 'default', 'desc'] } },
    clientMethodsNeeded: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { method: { type: 'string' }, why: { type: 'string' } }, required: ['method', 'why'] } },
    compileRisks: { type: 'array', items: { type: 'string' } },
    emDashRemoved: { type: 'boolean' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screen', 'verdict', 'issuesFixedInFile', 'remainingCompileRisks', 'emDashPresent', 'failLoudViolations', 'editedOnlyAssignedFiles', 'notes'],
  properties: {
    screen: { type: 'string' },
    verdict: { type: 'string', enum: ['clean', 'fixed', 'needs-main-thread'] },
    issuesFixedInFile: { type: 'array', items: { type: 'string' } },
    remainingCompileRisks: { type: 'array', items: { type: 'string' } },
    emDashPresent: { type: 'boolean' },
    failLoudViolations: { type: 'array', items: { type: 'string' } },
    editedOnlyAssignedFiles: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const results = await pipeline(
  SCREENS,
  // Stage 1: redesign writer
  (s) => agent(
    `You are redesigning ONE AuntieOS web screen to the Den aesthetic and fixing its bugs. Screen: "${s.key}"${s.hard ? ' (HARD: a real rework, not a polish pass)' : ''}.

ASSIGNED FILE(S) you may edit (and NOTHING else):
${s.files.map(f => '  ' + f).join('\n')}

STEPS:
1. Read your assigned file(s) in full.
2. Read your audit findings: Read ${AUDIT} with offset/limit covering lines ${s.audit}. Fix EVERY bug + data issue listed there for this screen that is fixable in your file(s) with the verified API.
3. Read your mockup for layout intent (reference, not pixel-law): ${s.mockup}
4. Read the Home exemplar for the target look: ${SCR}/home/HomeScreen.kt , and the kit: ${ROOT}/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/ui/components/DenScreenKit.kt
5. Rewrite your file(s) so the screen: (a) opens with DenScreenHeading and uses DenPanel/StatCard/Auntie* components + brand tones; (b) fixes the audited bugs; (c) wires backable interactions with REAL client methods; (d) gates every suggested/unbacked item behind a feature flag (existing prop, or a local FF_ constant + flagsNeeded report) with a fail-loud Not-wired banner where an action is dead.

SCREEN-SPECIFIC DIRECTION: ${s.direction}

${REF}

When done, return the structured result. Be precise in flagsNeeded (exact propName you referenced or the FF_ constant you left) and clientMethodsNeeded (exact method signature you wished existed). Your final structured output IS the deliverable.`,
    { label: `redesign:${s.key}`, phase: 'Redesign', schema: WRITER_SCHEMA },
  ).then(r => ({ ...(r || {}), key: s.key, files: s.files })),

  // Stage 2: reviewer / self-repair
  (w, s) => agent(
    `You are reviewing and REPAIRING the redesign of AuntieOS web screen "${s.key}". The writer just edited:
${s.files.map(f => '  ' + f).join('\n')}

Read each edited file in full, then VERIFY and FIX IN PLACE (use Edit on the assigned files only):
1. COMPILES: every referenced symbol exists (theme typography has NO displaySmall/label/caption; only the listed FirestoreClient methods exist; only the listed FeatureFlags props exist; a referenced flag that is not a real prop MUST be a local FF_ constant, not flags.<unknown>). Imports complete and correct. Balanced braces. Fix what you can.
2. EM DASH: search for U+2014 (the long dash) and any en-dash-used-as-pause in strings/comments. If present, REPLACE with period/comma/colon/parens. This is mandatory.
3. FAIL LOUD: no faked data, no fake success, no swallowed errors. Unbacked actions disabled + visible banner/pill. Fix violations.
4. DEN AESTHETIC actually applied: DenScreenHeading at top; DenPanel/StatCard/Auntie* used; no raw M3 visual components (Text/Icon/DropdownMenu/DatePicker are allowed).
5. SCOPE: confirm only the assigned files were changed; if the writer edited a forbidden shared file, note it (you cannot revert other files, just report).

Apply safe in-file fixes directly. Set verdict: "clean" (no issues), "fixed" (you repaired everything), or "needs-main-thread" (a risk you could not safely fix). Be specific in remainingCompileRisks. Your final structured output IS the deliverable.

${REF}`,
    { label: `review:${s.key}`, phase: 'Review', schema: REVIEW_SCHEMA },
  ).then(r => ({ writer: w, review: r, key: s.key })),
)

const clean = results.filter(Boolean)
log(`Redesign pass complete: ${clean.length}/${SCREENS.length} screens processed`)

// Aggregate everything the main thread must act on centrally.
const allFlags = []
const allMethods = []
const risks = []
const emDash = []
const scopeLeaks = []
const questions = []
for (const r of clean) {
  const w = r.writer || {}
  const v = r.review || {}
  for (const f of (w.flagsNeeded || [])) allFlags.push({ screen: r.key, ...f })
  for (const m of (w.clientMethodsNeeded || [])) allMethods.push({ screen: r.key, ...m })
  for (const x of (v.remainingCompileRisks || [])) risks.push({ screen: r.key, risk: x })
  if (v.emDashPresent) emDash.push(r.key)
  if (v.editedOnlyAssignedFiles === false) scopeLeaks.push(r.key)
  for (const q of (w.openQuestions || [])) questions.push({ screen: r.key, q })
}

return {
  processed: clean.map(r => ({ screen: r.key, verdict: r.review?.verdict, summary: r.writer?.summary, bugsFixed: r.writer?.bugsFixed, filesEdited: r.writer?.filesEdited })),
  flagsNeeded: allFlags,
  clientMethodsNeeded: allMethods,
  remainingCompileRisks: risks,
  emDashStillPresent: emDash,
  scopeLeaks,
  openQuestions: questions,
}
