package com.tribetails.auntieos.ui.kintales

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the I7 call-site contract: every UI call into the KinTale condition
 * engine must hand over the household it already loaded.
 *
 * Why a source scan and not just a behavior test. The engine fails OPEN, and both
 * `isChecklistItemVisible` and `applicableKinForChecklistItem` take `kinfolk` as
 * an OPTIONAL trailing parameter so pre-I7 call sites keep compiling. That is
 * exactly what makes a forgotten argument invisible: the screen still builds, the
 * tests still pass, and every KINFOLK_ATTRIBUTE / KINFOLK_TAG rule silently
 * evaluates true in production. Nothing but reading the call sites catches it.
 *
 * The scan runs from the android unit-test JVM, so it covers BOTH trees: the
 * android screens and the Compose commonMain screens that serve web and desktop.
 */
class KinTaleEngineCallSiteTest {

    /** The two engine entry points whose trailing `kinfolk` argument is easy to drop. */
    private val engineCalls = listOf("isChecklistItemVisible", "applicableKinForChecklistItem")

    /**
     * Every non-engine source that calls into the engine. Paths are repo-relative.
     *
     * NOT in this list, and deliberately so: the commonMain
     * `web/.../web/data/SentChecklistResolver.kt` also calls
     * `isChecklistItemVisible` with three arguments. It belongs to another owner
     * and could not be edited from here, so its household rules still fail open
     * on a SENT report. Add it to this list with the rest once it is threaded.
     */
    private val scannedFiles = listOf(
        "android/app/src/main/java/com/tribetails/auntieos/ui/kintales/KinTaleReportScreen.kt",
        "android/app/src/main/java/com/tribetails/auntieos/ui/kintales/ChecklistEditorScreen.kt",
        "web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleComposeScreen.kt",
        "web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleConditionEditorHelpers.kt",
    )

    @Test
    fun everyEngineCallSitePassesAHousehold() {
        val root = repoRoot()
        var checked = 0
        scannedFiles.forEach { relative ->
            val file = File(root, relative)
            assertTrue(
                "Scanned source is missing: $relative. If it moved, update scannedFiles - do not delete the case.",
                file.isFile,
            )
            val source = file.readText()
            engineCalls.forEach { call ->
                argumentListsOf(source, call).forEach { args ->
                    assertEquals(
                        "$relative calls $call with ${args.size} arguments (${args.joinToString(", ")}). " +
                            "It must pass the household as a 4th argument: omitting it makes every " +
                            "KINFOLK_ATTRIBUTE and KINFOLK_TAG condition fail open to true.",
                        4,
                        args.size,
                    )
                    checked++
                }
            }
        }
        // A scan that finds nothing proves nothing: fail rather than pass silently
        // if the call sites were renamed out from under this test.
        assertTrue("Found no engine call sites at all. The scan is looking in the wrong place.", checked > 0)
    }

    /**
     * The top-level argument lists of every `name(...)` call in [source]. Tracks
     * paren depth and string literals so a nested call or a comma inside a string
     * is not mistaken for an argument separator.
     */
    private fun argumentListsOf(source: String, name: String): List<List<String>> {
        val out = mutableListOf<List<String>>()
        var from = 0
        while (true) {
            val at = source.indexOf("$name(", from)
            if (at < 0) return out
            from = at + name.length + 1
            // Skip the declaration itself ("fun isChecklistItemVisible(") if the
            // scanned file ever hosts one.
            val before = source.substring(maxOf(0, at - 4), at)
            if (before.endsWith("fun ")) continue
            out.add(splitTopLevelArgs(source, from))
        }
    }

    private fun splitTopLevelArgs(source: String, openIndex: Int): List<String> {
        val args = mutableListOf<String>()
        val current = StringBuilder()
        var depth = 0
        var inString = false
        var i = openIndex
        while (i < source.length) {
            val ch = source[i]
            when {
                inString && ch == '\\' -> { current.append(ch); i++; if (i < source.length) current.append(source[i]) }
                ch == '"' -> { inString = !inString; current.append(ch) }
                inString -> current.append(ch)
                ch == '(' || ch == '[' || ch == '{' -> { depth++; current.append(ch) }
                ch == ')' && depth == 0 -> {
                    if (current.isNotBlank()) args.add(current.toString().trim())
                    return args
                }
                ch == ')' || ch == ']' || ch == '}' -> { depth--; current.append(ch) }
                ch == ',' && depth == 0 -> {
                    if (current.isNotBlank()) args.add(current.toString().trim())
                    current.clear()
                }
                else -> current.append(ch)
            }
            i++
        }
        return args
    }

    /** The repo root: the nearest ancestor holding both platform trees. */
    private fun repoRoot(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            if (File(dir, "android").isDirectory && File(dir, "web").isDirectory) return dir
            dir = dir.parentFile
        }
        throw AssertionError(
            "Could not find the repo root (an ancestor of ${File("").absolutePath} holding both " +
                "'android/' and 'web/'). This test reads real sources and cannot run without it.",
        )
    }
}
