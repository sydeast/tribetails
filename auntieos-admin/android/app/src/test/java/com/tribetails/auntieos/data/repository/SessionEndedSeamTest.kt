package com.tribetails.auntieos.data.repository

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The seam that #573 installs is only worth anything if it is unforgettable.
 *
 * `FirebaseFunctions` and `HttpsCallableReference` are final, so this app cannot
 * decorate the client the way the kinfolk portal decorates its own. What it can
 * own is the last link of every callable chain — the `await()` on the resulting
 * `Task<HttpsCallableResult>` — and that is what `awaitCallable()` is. But an
 * "always use this helper" rule enforced by nothing is not a rule: one call site
 * added next month with a plain `.await()` is a hole, and the symptom of that
 * hole is a revoked admin who stays signed in, which nobody discovers by using
 * the app normally.
 *
 * So this reads the source. It is a lint rule that happens to live in the test
 * suite, and it fails with the file and the line rather than with a count.
 *
 * It deliberately does NOT try to parse Kotlin. Every callable chain in this
 * codebase starts at `getHttpsCallable(` and reaches its `await` within a few
 * lines, so the check is: from each `getHttpsCallable(`, the first `.await(`
 * that follows must be `.awaitCallable(`. A future chain shaped so differently
 * that this cannot see it would also be a chain worth looking at by hand.
 *
 * `getHttpsCallable` is the only door in, checked 2026-08-24: `src/main` has
 * zero uses of the ktx `functions.httpsCallable("name")` extension and zero of
 * `getHttpsCallableFromUrl`. If either ever appears, it bypasses the seam AND
 * is invisible to this test, so add it to the scan in the same commit.
 */
class SessionEndedSeamTest {

    /** Walk up from the test's working directory to `app/src/main`. */
    private fun mainSourceRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "app/src/main/java/com/tribetails/auntieos")
            if (candidate.isDirectory) return candidate
            val here = File(dir, "src/main/java/com/tribetails/auntieos")
            if (here.isDirectory) return here
            dir = dir.parentFile
        }
        error("Could not locate app/src/main from ${System.getProperty("user.dir")}")
    }

    @Test
    fun `every callable chain in src-main ends in awaitCallable`() {
        val root = mainSourceRoot()
        val offenders = mutableListOf<String>()
        var chains = 0

        root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" && it.name != "SessionEnded.kt" }
            .forEach { file ->
                val text = file.readText()
                var from = 0
                while (true) {
                    val start = text.indexOf("getHttpsCallable(", from)
                    if (start < 0) break
                    chains++
                    // `.await`, not `.await(`. Searching for the open paren skips
                    // straight past `.awaitCallable(` and lands on the NEXT plain
                    // await in the file, which reports every correctly migrated
                    // chain as an offender — a false red that would have been
                    // "fixed" by loosening the check.
                    val await = text.indexOf(".await", start)
                    val line = text.take(start).count { it == '\n' } + 1
                    if (await < 0) {
                        offenders += "${file.name}:$line — callable chain with no await at all"
                    } else if (!text.startsWith(".awaitCallable(", await)) {
                        val ends = text.substring(await, minOf(await + 20, text.length)).substringBefore('\n')
                        offenders += "${file.name}:$line — callable chain ends in `$ends`, not .awaitCallable()"
                    }
                    from = start + 1
                }
            }

        // The count guard is the other half. An accidental rename of
        // `getHttpsCallable` would make the loop above find nothing and pass
        // silently, which is the classic way a source-scanning test rots into a
        // no-op.
        assertTrue(
            "expected to find the app's callable chains under $root, found $chains",
            chains >= 100,
        )
        assertTrue(
            "callables that bypass the revoked-session seam:\n" + offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }
}
