package com.tribetails.auntieos.web.visual

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.foundation.layout.Box
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.FirestoreAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaRepository
import com.tribetails.auntieos.web.data.FormSchemaSummary
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.activity.ActivityLogScreen
import com.tribetails.auntieos.web.screens.admin.TemplateAssignmentScreen
import com.tribetails.auntieos.web.screens.admin.TemplateBankScreen
import com.tribetails.auntieos.web.screens.admin.formschemas.FormSchemaEditorScreen
import com.tribetails.auntieos.web.screens.admin.formschemas.FormSchemaListScreen
import com.tribetails.auntieos.web.screens.booking.BookingScreen
import com.tribetails.auntieos.web.screens.communicate.CommunicateScreen
import com.tribetails.auntieos.web.screens.directory.DirectoryScreen
import com.tribetails.auntieos.web.screens.home.HomeScreen
import com.tribetails.auntieos.web.screens.inbox.InboxScreen
import com.tribetails.auntieos.web.screens.invoices.InvoiceDetailScreen
import com.tribetails.auntieos.web.screens.invoices.InvoicesScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleLogsScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportScreen
import com.tribetails.auntieos.web.screens.notifications.NotificationsScreen
import com.tribetails.auntieos.web.screens.schedule.ScheduleScreen
import com.tribetails.auntieos.web.screens.sessions.KinCareSessionsScreen
import com.tribetails.auntieos.web.screens.settings.SettingsScreen
import com.tribetails.auntieos.web.screens.trainingdocs.TrainingDocumentsScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * Desktop (Compose JVM / Skia) screenshot captures for the visual-comparison harness.
 * Renders each pilot screen against demo fixtures and writes a PNG to visual/desktop/,
 * which build-report.mjs pairs against the ui-ideas mockup. Deterministic: fixed fixtures,
 * dark theme, fixed 1440x900 viewport.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopScreenshotTest {

    private val outDir = File("../../visual/desktop").apply { mkdirs() }

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun capture(name: String, content: @Composable () -> Unit) =
        runDesktopComposeUiTest(width = 1440, height = 900) {
            setContent {
                AuntieAppTheme(themeMode = ThemeMode.DARK) {
                    // Screens don't paint their own backdrop (AppShell does in the real app).
                    // Provide the theme navy so contrast matches the mockup.
                    Box(Modifier.fillMaxSize().background(AuntieTheme.colors.background)) { content() }
                }
            }
            // composeResources Font(...) loads on a background dispatcher that waitForIdle()
            // does not await; pump frames over a real time window so Fraunces/Hanken resolve
            // before capture, otherwise the heading falls back to a thin default face.
            val deadline = System.currentTimeMillis() + FONT_LOAD_WINDOW_MS
            do { waitForIdle() } while (System.currentTimeMillis() < deadline)
            val awt = onRoot().captureToImage().toAwtImage()
            ImageIO.write(awt, "png", File(outDir, "$name.png"))
        }

    private companion object { const val FONT_LOAD_WINDOW_MS = 4000L }

    @Test
    fun directory() {
        JvmFirestoreFixtures.kinfolk = DemoFixtures.kinfolk
        JvmFirestoreFixtures.allKin = DemoFixtures.allKin
        JvmFirestoreFixtures.kinByKinfolk = DemoFixtures.kinByKinfolk
        capture("directory") { DirectoryScreen() }
    }

    @Test
    fun home() {
        JvmFirestoreFixtures.kinfolk = DemoFixtures.kinfolk
        JvmFirestoreFixtures.sessions = DemoFixtures.sessions
        JvmFirestoreFixtures.bookingRequests = emptyList()
        JvmFirestoreFixtures.generatedDrafts = emptyList()
        JvmFirestoreFixtures.provideUserProfile = true
        JvmFirestoreFixtures.userProfile = DemoFixtures.userProfile
        capture("home") { HomeScreen(onNavigate = {}) }
    }

    @Test
    fun invoiceDetail() {
        JvmFirestoreFixtures.invoices = DemoFixtures.invoices
        JvmFirestoreFixtures.sessionsForKinfolk = emptyList()
        capture("invoice-detail") { InvoiceDetailScreen(invoiceId = "demo-inv-1", onBack = {}) }
    }

    // ---- Stage 2 (2026-05-31): 15 expanded full-content captures ----

    @Test
    fun communicate() {
        // No fixtures: renders the default Personalize form. Draft/preview-filled state
        // is HTTP-callable gated and not reachable from the harness (see recipe).
        capture("communicate") { CommunicateScreen() }
    }

    @Test
    fun kinTaleLogs() {
        JvmFirestoreFixtures.reports = DemoFixtures.kinTaleLogReports
        JvmFirestoreFixtures.kinfolk = DemoFixtures.kinfolk
        capture("kintale-logs") { KinTaleLogsScreen(onOpenReport = {}) }
    }

    @Test
    fun manageBookings() {
        JvmFirestoreFixtures.sessions = DemoFixtures.bookingSessions
        capture("manage-bookings") { BookingScreen() }
    }

    @Test
    fun auntieTime() {
        JvmFirestoreFixtures.sessions = DemoFixtures.auntieTimeSessions
        JvmFirestoreFixtures.kinfolk = DemoFixtures.kinfolk
        capture("auntie-time") { KinCareSessionsScreen() }
    }

    @Test
    fun schedule() {
        JvmFirestoreFixtures.sessions = DemoFixtures.sessions
        capture("schedule") { ScheduleScreen() }
    }

    @Test
    fun invoices() {
        JvmFirestoreFixtures.invoices = DemoFixtures.variedInvoices
        capture("invoices") { InvoicesScreen(onInvoiceClick = {}) }
    }


    @Test
    fun inbox() {
        JvmFirestoreFixtures.voicemails = DemoFixtures.voicemails
        JvmFirestoreFixtures.calls = DemoFixtures.calls
        JvmFirestoreFixtures.sms = DemoFixtures.sms
        JvmFirestoreFixtures.emails = DemoFixtures.emails
        capture("inbox") { InboxScreen() }
    }

    @Test
    fun activityLog() {
        JvmFirestoreFixtures.activity = DemoFixtures.activityLog
        capture("activity-log") { ActivityLogScreen() }
    }

    @Test
    fun settings() {
        JvmFirestoreFixtures.provideUserProfile = true
        JvmFirestoreFixtures.userProfile = DemoFixtures.userProfile
        JvmFirestoreFixtures.businessSettings = DemoFixtures.businessSettings
        capture("settings") {
            SettingsScreen(
                authUser = AuthUser(uid = "demo-admin", email = "admin@tribetails.com"),
                auth = AuthClient(),
                themeMode = ThemeMode.DARK,
                onThemeModeChange = {},
                personalization = com.tribetails.auntieos.web.theme.ThemePersonalization(),
                onPersonalizationChange = {},
            )
        }
    }

    @Test
    fun trainingDocuments() {
        JvmFirestoreFixtures.trainingDocs = DemoFixtures.trainingDocs
        capture("training-documents") { TrainingDocumentsScreen() }
    }

    @Test
    fun notifications() {
        JvmFirestoreFixtures.notifications = DemoFixtures.notifications
        capture("notifications") { NotificationsScreen() }
    }

    @Test
    fun formSchemaList() {
        val fakeRepo = object : FormSchemaRepository {
            override suspend fun listSchemas(): WriteResult<List<FormSchemaSummary>> =
                WriteResult.Ok(DemoFixtures.formSchemas)
            override suspend fun getSchema(id: String): WriteResult<FormSchema> =
                WriteResult.Err("unused")
            override suspend fun saveSchema(schema: FormSchema): WriteResult<FormSchema> =
                WriteResult.Err("unused")
            override suspend fun deleteSchema(id: String): WriteResult<Unit> =
                WriteResult.Err("unused")
        }
        capture("formschema-list") { FormSchemaListScreen(repository = fakeRepo, onOpenEditor = {}) }
    }

    @Test
    fun kinTaleReport() {
        JvmFirestoreFixtures.reports = DemoFixtures.kinTaleReports
        capture("kintale-report") {
            KinTaleReportScreen(
                sessionId = "demo-sess-1",
                dataSource = FirestoreAuntieDataSource(FirestoreClient()),
                onBack = {},
            )
        }
    }

    @Test
    fun formSchemaEditor() {
        val fakeRepo = object : FormSchemaRepository {
            override suspend fun listSchemas(): WriteResult<List<FormSchemaSummary>> =
                WriteResult.Ok(emptyList())
            override suspend fun getSchema(id: String): WriteResult<FormSchema> =
                WriteResult.Ok(DemoFixtures.formSchema)
            override suspend fun saveSchema(schema: FormSchema): WriteResult<FormSchema> =
                WriteResult.Ok(schema)
            override suspend fun deleteSchema(id: String): WriteResult<Unit> =
                WriteResult.Ok(Unit)
        }
        capture("formschema-editor") {
            FormSchemaEditorScreen(schemaId = "tribeProfile", repository = fakeRepo, onBack = {})
        }
    }

    // ---- Stage 2 follow-up (2026-06-01): callable-only template screens, un-blocked on
    // desktop via the JvmFirestoreFixtures.callableResponses seam (raw JSON the wasm bridge
    // would return). TemplateService() default reads platformInvokeCallable -> our fixture. ----

    @Test
    fun templateBank() {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listTemplates" to DemoFixtures.templatesJson,
            "listCategories" to DemoFixtures.categoriesJson,
        )
        capture("template-bank") { TemplateBankScreen() }
    }

    @Test
    fun templateAssignment() {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listTemplateBindings" to DemoFixtures.templateBindingsJson,
            "listTemplates" to DemoFixtures.templatesJson,
        )
        capture("template-assignment") { TemplateAssignmentScreen() }
    }
}
