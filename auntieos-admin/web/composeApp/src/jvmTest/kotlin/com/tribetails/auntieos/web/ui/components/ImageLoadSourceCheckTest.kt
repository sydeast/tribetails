package com.tribetails.auntieos.web.ui.components

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #867 re-review: every remote image in main code goes through
 * `AuntieAsyncImage` or `AuntieSubcomposeAsyncImage`, which pass the console's
 * guarded loader explicitly. A direct Coil call would load with whatever loader
 * Coil finds, which inside a test outside the theme is Coil's default.
 */
class ImageLoadSourceCheckTest {

    private val wrapperFile = "AuntieAsyncImage.kt"

    private val bannedImport = Regex("""^\s*import\s+coil3\.compose\.(AsyncImage|SubcomposeAsyncImage|rememberAsyncImagePainter)\s*$""")
    private val bannedCall = Regex("""(?<![A-Za-z0-9_])(AsyncImage|SubcomposeAsyncImage|rememberAsyncImagePainter)\s*\(""")

    /** Pure: every banned reference in [text], as "line: source". */
    internal fun violations(text: String): List<String> =
        text.lines().mapIndexedNotNull { i, line ->
            val code = line.substringBefore("//")
            if (bannedImport.containsMatchIn(line) || bannedCall.containsMatchIn(code)) "${i + 1}: ${line.trim()}" else null
        }

    @Test
    fun noMainSourceCallsCoilImageComposablesDirectly() {
        val roots = listOf(File("src/commonMain/kotlin"), File("src/jvmMain/kotlin"))
        assertTrue(roots.all { it.isDirectory }, "run from the composeApp project directory: ${roots.map { it.absolutePath }}")
        val found = roots.flatMap { root ->
            root.walkTopDown()
                .filter { it.isFile && it.extension == "kt" && it.name != wrapperFile }
                .flatMap { f -> violations(f.readText()).map { "${f.path}:$it" } }
        }
        assertTrue(found.isEmpty(), "use AuntieAsyncImage / AuntieSubcomposeAsyncImage instead:\n" + found.joinToString("\n"))
    }

    @Test
    fun theCheckRecognisesEachBannedFormAndIgnoresTheWrappers() {
        assertTrue(violations("import coil3.compose.AsyncImage").isNotEmpty())
        assertTrue(violations("import coil3.compose.SubcomposeAsyncImage").isNotEmpty())
        assertTrue(violations("import coil3.compose.rememberAsyncImagePainter").isNotEmpty())
        assertTrue(violations("        AsyncImage(model = url)").isNotEmpty())
        assertTrue(violations("    SubcomposeAsyncImage (").isNotEmpty())
        assertTrue(violations("val p = rememberAsyncImagePainter(url)").isNotEmpty())
        assertTrue(violations("coil3.compose.AsyncImage(model = url)").isNotEmpty())
        assertTrue(violations("AuntieAsyncImage(model = url)").isEmpty())
        assertTrue(violations("AuntieSubcomposeAsyncImage(model = url) {").isEmpty())
        assertTrue(violations("    else -> SubcomposeAsyncImageContent()").isEmpty())
        assertTrue(violations("import coil3.compose.AsyncImagePainter").isEmpty())
        assertTrue(violations(" * loaded via coil3 AsyncImage. On a load error").isEmpty())
    }
}
