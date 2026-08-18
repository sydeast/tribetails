package com.tribetails.auntieos.visual

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.ui.admin.ActivityLogScreen
import com.tribetails.auntieos.ui.admin.AdminDataViewModel
import com.tribetails.auntieos.ui.admin.AdminSettingsScreen
import com.tribetails.auntieos.ui.admin.AdminSettingsViewModel
import com.tribetails.auntieos.ui.admin.InvoicesScreen
import com.tribetails.auntieos.ui.admin.KinCareSessionsScreen
import com.tribetails.auntieos.ui.admin.KinTaleLogsScreen
import com.tribetails.auntieos.ui.admin.NotificationsScreen
import com.tribetails.auntieos.ui.admin.ScheduleViewScreen
import com.tribetails.auntieos.ui.admin.SchedulingOptionsScreen
import com.tribetails.auntieos.ui.admin.TemplateAssignmentScreen
import com.tribetails.auntieos.ui.admin.TemplateBankScreen
import com.tribetails.auntieos.ui.admin.TrainingDocumentsScreen
import com.tribetails.auntieos.ui.admin.formschemas.FormSchemaEditorScreen
import com.tribetails.auntieos.ui.admin.formschemas.FormSchemaEditorViewModel
import com.tribetails.auntieos.ui.admin.formschemas.FormSchemaListScreen
import com.tribetails.auntieos.ui.admin.scheduling.EnhancedSchedulingViewModel
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarConnection
import com.tribetails.auntieos.ui.admin.services.ServiceManagementViewModel
import com.tribetails.auntieos.ui.communicate.CommunicateScreen
import com.tribetails.auntieos.ui.communicate.CommunicateViewModel
import com.tribetails.auntieos.ui.directory.DirectoryScreen
import com.tribetails.auntieos.ui.directory.DirectoryViewModel
import com.tribetails.auntieos.ui.home.HomeScreen
import com.tribetails.auntieos.ui.home.HomeViewModel
import com.tribetails.auntieos.ui.inbox.InboxScreen
import com.tribetails.auntieos.ui.inbox.InboxViewModel
import com.tribetails.auntieos.ui.invoices.InvoiceDetailScreen
import com.tribetails.auntieos.ui.invoices.InvoiceDetailViewModel
import com.tribetails.auntieos.ui.kintales.KinTaleReportScreen
import com.tribetails.auntieos.ui.kintales.KinTaleReportViewModel
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Android (native Compose) screenshot captures for the visual-comparison harness.
 * Roborazzi captures real pixels under Robolectric NATIVE graphics (no forceRedraw
 * dance, tolerant of the Den scaffold's infinite background animation) and writes a
 * PNG into visual/android/, paired against the ui-ideas mockups by build-report.mjs.
 * Deterministic: mockk repo with fixed demo fixtures, Unconfined main so the VM loads inline.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h900dp-xhdpi")
class AndroidScreenshotTest {

    @get:Rule
    val compose = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun directory() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        coEvery { repo.getAllKin() } returns Result.success(AndroidDemoFixtures.allKin)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(AndroidDemoFixtures.sessions)
        val vm = DirectoryViewModel(repo, mockk<InvoiceRepository>(relaxed = true), kinCareRepo)
        vm.loadDirectory() // inline on Unconfined main -> state populated before render
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                DirectoryScreen(vm, onKinfolkClick = {}, onKinClick = {}, onAddKinfolk = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/directory.png")
    }

    @Test
    fun home() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { repo.getKinfolkCount() } returns Result.success(6)
        coEvery { repo.getKinCount() } returns Result.success(9)
        coEvery { repo.getPendingDraftCount() } returns Result.success(0)
        coEvery { repo.getRecentDrafts() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(AndroidDemoFixtures.sessions)
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { repo.getKinfolkById(any()) } returns Result.success(AndroidDemoFixtures.kinfolk.first())
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoices() } returns Result.success(emptyList())
        // The same trap the invoices test below already documents, unswept here.
        // HomeViewModel.load() also reads getKinCareSessions() (the gatekeeper's
        // last-completed-visit lookup, HomeViewModel.kt:202) and getAllKin()
        // (AO-24's pets-by-type widget, :204). Unstubbed, the relaxed mock returns
        // a bare Object that dies at the List cast, so this test was capturing a
        // CRASHED dashboard: two fail-loud banners, "0 VISITS", every widget gone.
        // Nothing noticed because the golden was recorded, never asserted.
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(AndroidDemoFixtures.sessions)
        coEvery { repo.getAllKin() } returns Result.success(AndroidDemoFixtures.allKin)
        // init{} calls load() inline on the Unconfined main dispatcher.
        val vm = HomeViewModel(repo, invoiceRepo, kinCareRepo, mockk<VisitNotifier>(relaxed = true))
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                HomeScreen(vm, onNavigateToCommunicate = {}, onNavigateToCalls = {}, onWriteKinTale = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/home.png")
    }

    @Test
    fun invoiceDetail() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("demo-inv-1") } returns Result.success(AndroidDemoFixtures.invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        // The payments panel is served by getInvoiceLedger now, not by a raw read
        // of the root `payments` collection. AndroidDemoFixtures.invoiceLedger is
        // the demo answer, and it carries a Stripe-sourced row so this golden
        // actually shows the figure this task fixed.
        coEvery { invoiceRepo.getInvoiceLedger("demo-inv-1") } returns
            Result.success(AndroidDemoFixtures.invoiceLedger)
        // A8: loadInvoice fetches business settings (How-to-pay). Blank settings keep the
        // panel hidden so this golden is unchanged.
        coEvery { repo.getBusinessSettings() } returns Result.success(com.tribetails.auntieos.data.model.BusinessSettings())
        val vm = InvoiceDetailViewModel(repository = repo, invoiceRepository = invoiceRepo, kinCareRepository = kinCareRepo)
        vm.loadInvoice("demo-inv-1")
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                InvoiceDetailScreen(invoiceId = "demo-inv-1", onBack = {}, viewModel = vm)
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/invoice-detail.png")
    }

    @Test
    fun communicate() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        coEvery { repo.getDossier(any()) } returns Result.success(AndroidDemoFixtures.dossier)
        coEvery { repo.getKin(any()) } returns Result.success(AndroidDemoFixtures.kinForKinfolk)
        coEvery { repo.get411ForKin(any()) } returns Result.success(AndroidDemoFixtures.kin411)
        coEvery { repo.generate(any()) } returns Result.success(AndroidDemoFixtures.generateResponse)
        coEvery { repo.listRecentSends() } returns Result.success(emptyList())
        val vm = CommunicateViewModel(repo) // init{} loads kinfolk inline on Unconfined main
        vm.selectKinfolk(AndroidDemoFixtures.kinfolk.first())
        vm.setRawNotes("Biscuit had a great walk today, lots of tail wags and met two new dog friends at the park.")
        vm.generate()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                CommunicateScreen(vm)
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/communicate.png")
    }

    @Test
    fun kintaleLogs() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(AndroidDemoFixtures.kinTaleReports)
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true), kinCareRepository = kinCareRepo)
        // Screen's LaunchedEffect(Unit) auto-loads reports + kinfolk directory.
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                KinTaleLogsScreen(viewModel = vm, onBack = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/kintale-logs.png")
    }

    @Test
    fun manageBookings() {
        val bookingRepo = mockk<BookingRepository>(relaxed = true)
        val serviceRepo = mockk<ServiceRepository>(relaxed = true)
        val auntieRepo = mockk<AuntieRepository>(relaxed = true)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(AndroidDemoFixtures.bookings)
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getBaseServices(any()) } returns Result.success(AndroidDemoFixtures.baseServices)
        coEvery { serviceRepo.getSupplementalServices(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        // Task 7.2: init { loadGoogleCalendarState() } reads this too. Relaxed mocks
        // still need this stubbed explicitly: Result<T> is a Kotlin inline class, and
        // an unstubbed relaxed answer for it throws a ClassCastException rather than
        // quietly returning a default.
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        // init{} -> loadInitialData() + loadBookingsForDateRange() run inline on Unconfined main.
        val vm = EnhancedSchedulingViewModel(
            bookingRepository = bookingRepo,
            serviceRepository = serviceRepo,
            auntieRepository = auntieRepo,
        )
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                ScheduleViewScreen(
                    onBack = {},
                    onNavigateToCommunicate = {},
                    onOpenSchedulingOptions = {},
                    viewModel = vm,
                )
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/manage-bookings.png")
    }

    @Test
    fun auntieTime() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(AndroidDemoFixtures.auntieTimeSessions)
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        coEvery { repo.getAllKin() } returns Result.success(AndroidDemoFixtures.allKin)
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true), kinCareRepository = kinCareRepo)
        vm.loadKinCareSessions()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                KinCareSessionsScreen(
                    viewModel = vm,
                    onBack = {},
                    onOpenDetail = {},
                    onWriteKinTale = {},
                    onLiveTrack = { _, _, _ -> },
                    // Hermetic: no live Firestore breadcrumb read in the screenshot test.
                    breadcrumbsFor = { kotlinx.coroutines.flow.flowOf(Result.success(emptyList())) },
                )
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/auntie-time.png")
    }

    @Test
    fun schedule() {
        val bookingRepo = mockk<BookingRepository>(relaxed = true)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(AndroidDemoFixtures.bookings)
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(AndroidDemoFixtures.blockedTimeSlots)
        // Busy blocks now stream live into the schedule; feed the same fixture so the
        // "Busy" bands render in the hermetic screenshot (relaxed mock would emit none).
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(AndroidDemoFixtures.blockedTimeSlots))
        // One ServiceRepository mock shared by both ViewModels.
        val serviceRepo = mockk<ServiceRepository>(relaxed = true)
        coEvery { serviceRepo.getBaseServices(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSurcharges(any()) } returns Result.success(AndroidDemoFixtures.surcharges)
        coEvery { serviceRepo.getDiscounts(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getPromoCodes(any()) } returns Result.success(emptyList())
        val auntieRepo = mockk<AuntieRepository>(relaxed = true)
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        // Unified settings: booking config (observeUsHolidays etc) now read from BusinessSettings.
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(AndroidDemoFixtures.businessSettings)
        // Task 7.2: init { loadGoogleCalendarState() } reads this too; see the note
        // in manageBookings() above on why a relaxed mock still needs this stubbed.
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        val vm = EnhancedSchedulingViewModel(
            bookingRepository = bookingRepo,
            serviceRepository = serviceRepo,
            auntieRepository = auntieRepo,
        )
        val svcVm = ServiceManagementViewModel(serviceRepository = serviceRepo, auntieRepository = auntieRepo)
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                SchedulingOptionsScreen(
                    onBack = {},
                    schedulingViewModel = vm,
                    serviceManagementViewModel = svcVm,
                    onNavigateToServiceManagement = {},
                )
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/schedule.png")
    }

    @Test
    fun invoices() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoices() } returns Result.success(AndroidDemoFixtures.invoices)
        // Slice 2: the screen now loads the kinfolk directory for the composer
        // picker on mount; seed it so the relaxed mock's default Result (a bare
        // Object) never reaches the List cast in loadKinfolkDirectory.
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = invoiceRepo)
        vm.loadInvoices()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                InvoicesScreen(viewModel = vm, onBack = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/invoices.png")
    }


    @Test
    fun inbox() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.observeVoicemails() } returns flowOf(AndroidDemoFixtures.voicemails)
        coEvery { repo.observeCalls() } returns flowOf(AndroidDemoFixtures.calls)
        coEvery { repo.observeSmsMessages() } returns flowOf(AndroidDemoFixtures.sms)
        every { repo.observeEmails() } returns flowOf(AndroidDemoFixtures.emails)
        coEvery { repo.listConversations() } returns Result.success(emptyList())
        val vm = InboxViewModel(repo) // init auto-collects all four channels inline.
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                InboxScreen(viewModel = vm, onBack = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/inbox.png")
    }

    @Test
    fun activityLog() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getActivityLog() } returns Result.success(AndroidDemoFixtures.activityLog)
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true))
        vm.loadActivityLog()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                ActivityLogScreen(viewModel = vm, onBack = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/activity-log.png")
    }

    @Test
    fun settings() {
        // AdminSettingsViewModel.loadUserProfile()/loadIntegrations() call
        // FirebaseAuth.getInstance() + FirebaseMessaging.getInstance() directly (not via repo).
        // Under Robolectric with no FirebaseApp these throw, so init a default app first.
        if (com.google.firebase.FirebaseApp.getApps(RuntimeEnvironment.getApplication()).isEmpty()) {
            com.google.firebase.FirebaseApp.initializeApp(
                RuntimeEnvironment.getApplication(),
                com.google.firebase.FirebaseOptions.Builder()
                    .setApplicationId("1:153396971788:android:demo")
                    .setApiKey("demo")
                    .setProjectId("auntieos-ttpc")
                    .build(),
            )
        }
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getBusinessSettings() } returns Result.success(AndroidDemoFixtures.businessSettings)
        coEvery { repo.getBusinessHours() } returns Result.success(AndroidDemoFixtures.businessHours)
        val vm = AdminSettingsViewModel(repository = repo)
        // Screen's LaunchedEffect drives loadBusinessSettings/Hours/UserProfile/loadIntegrations.
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                AdminSettingsScreen(onBack = {}, viewModel = vm)
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/settings.png")
    }

    @Test
    fun trainingDocuments() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getTrainingDocuments() } returns Result.success(AndroidDemoFixtures.trainingDocs)
        // The screen loads BOTH rosters: the kinfolk one for the target picker and
        // the household/kinfolk names, the kin one so a pet-targeted row can name
        // the pet instead of printing its id.
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        coEvery { repo.getAllKin() } returns Result.success(AndroidDemoFixtures.allKin)
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true))
        vm.loadTrainingDocuments()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                TrainingDocumentsScreen(viewModel = vm, onBack = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/training-documents.png")
    }

    @Test
    fun notifications() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getNotifications() } returns Result.success(AndroidDemoFixtures.notifications)
        // The feed resolves household names against the directory (issue #20),
        // so the screen loads it too and the double has to answer.
        coEvery { repo.getKinfolk() } returns Result.success(AndroidDemoFixtures.kinfolk)
        val vm = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true))
        vm.loadNotifications()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                NotificationsScreen(viewModel = vm, onBack = {})
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/notifications.png")
    }

    @Test
    fun templateBank() {
        val repo = mockk<TemplateRepository>(relaxed = true)
        coEvery { repo.listTemplates() } returns Result.success(AndroidDemoFixtures.emailTemplates)
        // Category list is now data-driven (server-deduped). Feed the deduped set the
        // server would return for these fixtures so the chips render deterministically.
        coEvery { repo.listCategories() } returns Result.success(
            AndroidDemoFixtures.emailTemplates.mapNotNull { it.category?.takeIf(String::isNotBlank) }
                .distinctBy { it.lowercase() }.sortedBy { it.lowercase() }
        )
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                TemplateBankScreen(onBack = {}, templateRepo = repo)
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/template-bank.png")
    }

    @Test
    fun templateAssignment() {
        val repo = mockk<TemplateRepository>(relaxed = true)
        coEvery { repo.listBindings() } returns Result.success(AndroidDemoFixtures.templateBindings)
        coEvery { repo.listTemplates() } returns Result.success(AndroidDemoFixtures.emailTemplates)
        // Stage 2 tail: the screen now reads the dispatcher catalog via listCatalogKeys
        // and renders the unbound-catalog hint from the diff. Feed a deterministic catalog
        // (two bound + one unbound key) so the hint panel renders the same every run.
        coEvery { repo.listCatalogKeys(any()) } returns Result.success(
            listOf("kincare.booking.confirm", "billing.invoice.sent", "kincare.tale.published"),
        )
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                TemplateAssignmentScreen(onBack = {}, templateRepo = repo)
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/template-assignment.png")
    }

    @Test
    fun formschemaList() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.listFormSchemas() } returns Result.success(AndroidDemoFixtures.formSchemas)
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                FormSchemaListScreen(onBack = {}, onOpenEditor = {}, repository = repo)
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/formschema-list.png")
    }

    @Test
    fun kintaleReport() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("demo-s1") } returns Result.success(AndroidDemoFixtures.kinTaleSession)
        coEvery { repo.getKinfolkById("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinfolk.first())
        coEvery { repo.getKin("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinTaleKin)
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { kinCareRepo.getKinCareReport("demo-report-1") } returns Result.success(AndroidDemoFixtures.kinTaleReport)
        coEvery { repo.getMediaFiles("demo-s1", MediaEntityType.VISIT_LOG) } returns Result.success(AndroidDemoFixtures.kinTaleMedia)
        val vm = KinTaleReportViewModel(
            repository = repo,
            kinCareRepository = kinCareRepo,
            mediaUploader = mockk<MediaUploadManager>(relaxed = true),
            notifier = mockk<VisitNotifier>(relaxed = true),
        )
        vm.load("demo-s1", "demo-report-1")
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                KinTaleReportScreen(
                    sessionId = "demo-s1",
                    existingReportId = "demo-report-1",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/kintale-report.png")
    }

    @Test
    fun formschemaEditor() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(AndroidDemoFixtures.formSchema)
        val vm = FormSchemaEditorViewModel(repository = repo)
        // Screen's LaunchedEffect(schemaId) calls vm.load("tribeProfile") inline.
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    onDeleted = {},
                    viewModel = vm,
                )
            }
        }
        compose.onRoot().captureRoboImage("../../visual/android/formschema-editor.png")
    }
}
