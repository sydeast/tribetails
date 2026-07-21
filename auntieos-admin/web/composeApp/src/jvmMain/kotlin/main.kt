import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import com.tribetails.auntieos.web.App
import com.tribetails.auntieos.web.observability.initCrashReporting

fun main() {
    // Crash/error reporting (0H). Installs Sentry + the uncaught-exception backstop before the
    // UI starts, so a crash during composition is captured. No-op if no DSN is configured.
    initCrashReporting()
    application {
        val state = rememberWindowState(width = 1280.dp, height = 800.dp)
    Window(
        onCloseRequest = ::exitApplication,
        title          = "AuntieOS Desktop",
        state          = state,
        ) {
            App()
        }
    }
}
