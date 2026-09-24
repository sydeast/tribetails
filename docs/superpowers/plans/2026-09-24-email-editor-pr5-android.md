# Visual Email Editor, PR 5: Android Simple Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Android admin, a visual-format email template opens in an editor where the operator changes the subject, the headline and the words of the body, sees the real email in a preview, and saves, without being able to add, remove or reorder blocks or formatting, and without any save wiping a field the screen does not show.

**Architecture:** One pure Kotlin unit, `EmailContent.kt`, parses the sanitized `content` fragment into blocks (paragraph, heading, list item, callout, button, image, plus a locked block for shapes the phone does not model) and serializes them back. It keeps every character of the source, so `serializeEmailContent(parseEmailContent(x)) == x` for any string. A second pure unit, `EmailBlockEdit.kt`, applies one text-field change to one block and refuses changes that would add a line break, cut into a merge field, or remove bold, italic or a link. `VisualTemplateSave.kt` (pure) holds the draft, its rotation `Saver`, and the diff-vs-rebuild save. The Compose screen `VisualTemplateEditor.kt` draws each block as a `BasicTextField` whose styling comes from a `VisualTransformation` over the block model, and shows `previewEmailTemplate` output in a WebView with a loading cue and an error state. `TemplateBankBody` routes `format == "visual"` templates to it. `TemplateRepository` gains the visual save shape and the preview call. One server change: `listTemplates` returns `format`, `headline` and `content`, which no PR so far sends to the apps.

**Tech Stack:** Kotlin 2.4.20, Jetpack Compose (BOM 2026.09.00), Coil 3.6.2 (already a dependency), `android.webkit.WebView`, Firebase Functions callables, JUnit 4, MockK, Robolectric 4.17 compose tests. Server: TypeScript, vitest.

**Library decision:** no new dependency. The spec names `com.mohamedrejeb.richeditor:richeditor-compose`. Its latest release on Maven Central is 1.2.0 (`maven-metadata.xml`, `lastUpdated 20260830`). Its HTML round trip is lossy on our allowed subset, read from `richeditor-compose-android-1.2.0-sources.jar`, `parser/html/RichTextStateHtmlParser.kt`:
- export writes `<b>` and `<i>`, never `<strong>` and `<em>` (`htmlElementsSpanStyleDecodeMap`, `BoldSpanStyle to "b"`, `ItalicSpanStyle to "i"`);
- export adds `target="_blank"` to every link (`decodeHtmlElementFromRichSpanStyle`, `"a" to mapOf("href" ..., "target" to "_blank")`);
- export drops `class`, so a button becomes a plain link, and drops an image's `alt` while adding `width` and `height`;
- import turns `<br>` into a new paragraph and appends a space (`// name == "br"`, `stringBuilder.append(' ')`, `RichParagraph(isFromLineBreak = true)`);
- there is no `blockquote` handling, so the Callout block is lost.

It also pulls `androidx.compose.material3:material3-android:1.12.0-alpha03` in transitively (its POM), an alpha into a release build. So the plan uses an in-repo model instead: inline runs kept as a tree (text, `<br />`, inline image, `strong`/`em`/`a` elements whose tags are kept verbatim), edited through `BasicTextField` with an `AnnotatedString` visual transformation. Task 2 and Task 3 prove it lossless.

**Spec:** `docs/superpowers/specs/2026-09-24-visual-email-editor-design.md` (Part 2 "Admin Android", Testing "Android")

**Depends on:** PR 1 and PR 2 merged. PR 1 adds `EmailTemplate.format`, `TemplateEditMode`, `htmlIsHandAuthored`, `templateEditMode` and `templateToSave`. PR 2 adds the visual `saveTemplate` shape and the `previewEmailTemplate` callable. Task 1 below adds the `listTemplates` projection if neither PR has.

## Global Constraints

- **Operator ruling 2026-09-24: new templates are created on web only.** Android loses its "New template" button (Task 7a). The empty-bank message stops pointing at it.
- **Server interfaces (from PR 2, exactly):**
  - `saveTemplate` visual args: `{ templateId, subject, format: 'visual', headline, content, title?, description?, tags?, category? }`. A visual save never sends `body` or `html` (the server's `superRefine` refuses them).
  - `previewEmailTemplate({ subject, headline, content, catalogKey? }) -> { subject, html, text, issues }`.
  - Allowed content elements: `p`, `br`, `strong`, `em`, `h2`, `h3`, `ul`, `ol`, `li`, `a` (`href`, plus `class="button"`), `img` (`src`, `alt`), `blockquote` (Callout). Merge tokens `{{name}}` appear only in text or as a whole `href`.
- **Canonical form the parser must round-trip.** Probed against sanitize-html 2.17.7 (the version in `mytribe/functions/node_modules`) with PR 2's options:
  - `<br />` and `<img src="…" alt="…" />`, with the space and slash;
  - attributes stay in input order, so `<a class="button" href="{{link}}">` is as legal as `href` first;
  - text escapes only `&`, `<`, `>`; `"` and `'` stay literal;
  - attribute values escape `&`, `"`, `<`, `>` (`&quot;`), and `'` stays literal;
  - non-ASCII (emoji, `é`) stays literal, and `&nbsp;` becomes a literal U+00A0;
  - TipTap (PR 4) list items arrive as `<li><p>…</p></li>`, and a TipTap image can be a bare `<img … />` between blocks.
- **Lossless by construction.** Every tag, attribute and inter-block whitespace is stored as its source text. A text run keeps its source spelling (`raw`) until it is edited, and only then is it re-escaped (`&`, `<`, `>`). A shape the phone does not model (nested list, `<p></p>`, stray top-level text, a list inside a callout) becomes a `LockedBlock` holding its source.
- **What the phone can change:** words. It can't:
  - add or remove a block, or move one;
  - add or remove a line break (`<br />`) or an inline image;
  - empty a `strong`, `em` or `a` (bold, italic and links are never removed);
  - change a link target or a button target (tags are kept verbatim);
  - edit inside an existing merge field. Backspace into one deletes the whole field, and typing over part of one is refused. A field can be typed fresh as text, and Save stays off while one is incomplete.
- **Boundary rule:** text typed where two runs meet joins the run on its left, except that a plain run on the right is preferred over a link on the left. A run emptied by the same change gets the typed text first, so replacing a bold word keeps it bold.
- **Diff-vs-rebuild on save.** Title, description, category and tags are written back as loaded unless the operator changed that control. `content` is written back byte for byte unless a block changed. Fields the screen never shows (`usageInstructions`, `sectionDefinitions`) are never sent, and the server's `set(..., { merge: true })` keeps them.
- **Every wait shows a cue:** the preview shows `LoadingHint("Loading preview…")` whenever a request is in flight, including over a previous render. Save shows `PrimaryButton(loading = true)` and cannot fire twice.
- **No explanatory subtitles under panel titles.** The editor heading passes no `subtitle`. Notes sit under the element they explain (a locked block's note, a refused edit's reason, the button's locked target).
- **Old-format templates stay as PR 1 left them** (FULL or SUBJECT_ONLY in `TemplateEditorScreen`). A `format` other than `"visual"`, or a visual doc missing `headline` or `content`, stays READ_ONLY there.
- **No new Gradle dependency.**
- Gradle: `GRADLE_USER_HOME=$HOME/.gradle-local`, from `auntieos-admin/android`. Test counts come from `app/build/test-results/testDebugUnitTest/TEST-*.xml`, never from the exit code.
- Commits: write the message with the Write tool into a task-scoped scratchpad subdirectory (for example `<scratchpad>/email-editor-pr5/commit-N.txt`), read it back, then `git commit -F <file>`. Every message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A paragraph that is entirely a link.** Changing, replacing or appending words keeps the `<a href>` exactly, and deleting all of it is refused. Pinned in Task 3 (`aParagraphThatIsEntirelyALinkKeepsTheLinkThroughAnyWordEdit`).
2. **Emoji and surrogate pairs.** Replacing an emoji inside bold, typing one after a bold word and deleting a ZWJ family emoji all serialize to valid UTF-16 in the right run, and the cursor never lands mid-pair. Pinned in Task 3 (`emojiAreReplacedWholeAndNeverSplit`, and the no-lone-surrogate assertion in the fuzz test).
3. **A merge token typed over partially.** Typing inside `{{displayName}}` or over part of it is refused with the reason shown, backspace into it removes it whole, and a half-typed `{{na` blocks Save. Pinned in Task 3 (`aMergeFieldIsNeverHalfEdited`), Task 5 (`problems`) and Task 6 (`a refused edit explains itself and keeps the text`).
4. **Rotating the screen mid-edit.** The draft survives through `rememberSaveable` with a `Saver` built from serialize and parse, and the bank reopens the editor after the Activity is recreated. Pinned in Task 5 (`theDraftSurvivesSaveAndRestore`), Task 6 (`rotating mid-edit keeps the edit`) and Task 7 (`rotating mid-edit reopens the editor with the edit`).
5. **Save while the preview is still loading.** Save is enabled, sends the draft on screen (not the one the pending preview was asked about), and the loading cue stays up. A stale preview answer never overwrites a newer one. Pinned in Task 6 (`Save works while the preview is still loading`).

---

## File Structure

Server (Task 1):
- Modify `mytribe/functions/src/admin/listTemplates.ts`: project `format`, `headline`, `content`.
- Modify `mytribe/functions/test/listTemplates.test.ts`: one case.

Android, all under `auntieos-admin/android/app/src/`:
- Create `main/java/com/tribetails/auntieos/ui/admin/EmailContent.kt`: pure. `EmailInline`, `EmailBlock`, `EmailBlockKind`, `parseEmailContent`, `serializeEmailContent`, `plainText`, `buttonTarget`, `htmlAttribute`, `decodeHtmlEntities`, `htmlToReadableText`, `hasBrokenMergeField`, `EMAIL_MERGE_TOKEN`.
- Create `main/java/com/tribetails/auntieos/ui/admin/EmailBlockEdit.kt`: pure. `BlockEdit`, `applyBlockEdit`, the refusal strings.
- Create `main/java/com/tribetails/auntieos/ui/admin/VisualTemplateSave.kt`: pure (compose-runtime `Saver` only). `VisualDraft`, `VisualDraftSaver`, `EmailPreviewRequest`, `previewRequest`, `usesVisualEditor`, `visualTemplateToSave`, `visualDraftProblem`.
- Create `main/java/com/tribetails/auntieos/ui/admin/VisualTemplateEditor.kt`: Compose. `VisualTemplateEditorScreen`, `EmailPreviewPanel`, block views, `styleEmailInlines`.
- Modify `main/java/com/tribetails/auntieos/data/repository/TemplateRepository.kt`: `headline` and `content` on `EmailTemplate`, `EmailPreview`, `saveTemplatePayload`, `previewEmailTemplate`.
- Modify `main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt`: route visual templates, `saving`, saveable `editingId`, the viewer for visual templates.
- Create tests under `test/java/com/tribetails/auntieos/`:
  - `ui/admin/EmailContentRoundTripTest.kt` (6 tests)
  - `ui/admin/EmailBlockEditTest.kt` (14 tests)
  - `data/repository/TemplateRepositoryVisualTest.kt` (7 tests)
  - `ui/admin/VisualTemplateSaveTest.kt` (11 tests)
  - `ui/admin/VisualTemplateEditorUiTest.kt` (9 tests, Robolectric)
  - `ui/admin/TemplateBankVisualTest.kt` (5 tests, Robolectric)

---

### Task 0: Worktree and baseline

**Files:** none.

- [ ] **Step 1: Create the worktree from fresh main.** Run each command in its own Bash call.

```bash
git -C /Users/sydeast/Projects/testai/CascadeProjects/tribetails fetch origin
```
```bash
git -C /Users/sydeast/Projects/testai/CascadeProjects/tribetails worktree add ../tribetails-worktrees/email-editor-android -b feat/email-editor-android origin/main
```

- [ ] **Step 2: Confirm PR 1 and PR 2 are in.**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android && grep -n "fun templateEditMode\|fun htmlIsHandAuthored" auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/MarkdownTemplate.kt && grep -n "previewEmailTemplate" mytribe/functions/src/index.ts && grep -n "val format" auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/TemplateRepository.kt
```
Expected: three hits. If any is missing, stop and report which PR has not merged.

- [ ] **Step 3: Local config and dependencies** (a fresh worktree has neither, and the pre-commit hook needs `node_modules`):

```bash
cp /Users/sydeast/Projects/testai/CascadeProjects/tribetails/auntieos-admin/android/local.properties /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android/auntieos-admin/android/local.properties
```
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android && npm ci && cd mytribe/functions && npm ci
```

- [ ] **Step 4: Baseline.** Run the existing template tests and record the counts:

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android/auntieos-admin/android && GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*TemplateEditModeTest*' --tests '*MarkdownTemplateTest*' --tests '*TemplateBankStatesTest*' --tests '*TemplateRepository*'
```
Then `grep -h "<testsuite" app/build/test-results/testDebugUnitTest/TEST-*Template*.xml | sed 's/ timestamp.*//'` and write the numbers down. Task 8 compares against them.

---

### Task 1: `listTemplates` returns the visual fields

`listTemplates.ts` projects `subject, body, html, title, description, tags, category, usageInstructions, sectionDefinitions` only. Without this, PR 1's `format = m["format"]` is always null on Android and this PR has no `content` to parse.

**Files:**
- Modify: `mytribe/functions/src/admin/listTemplates.ts`
- Test: `mytribe/functions/test/listTemplates.test.ts`

- [ ] **Step 1: Check whether it already landed.**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android && grep -n "headline" mytribe/functions/src/admin/listTemplates.ts
```
If it prints the projection lines from Step 4, skip to Task 2 and say so in the PR body. Otherwise continue.

- [ ] **Step 2: Write the failing test.** Add inside the `describe('listTemplates', …)` block:

```ts
  it('#953: returns format, headline and content for a visual template, and leaves them off an old one', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'auth.password.reset', data: { subject: 'S', format: 'visual', headline: 'Reset', content: '<p>Hi</p>' } },
        { id: 'old.one', data: { subject: 'S', body: 'B' } },
      ]),
    );
    const res = await listTemplatesHandler(req());
    expect(res.templates[0]).toMatchObject({ format: 'visual', headline: 'Reset', content: '<p>Hi</p>', body: '' });
    expect(res.templates[1]).not.toHaveProperty('format');
    expect(res.templates[1]).not.toHaveProperty('headline');
    expect(res.templates[1]).not.toHaveProperty('content');
  });
```

- [ ] **Step 3: Run to verify it fails.**

Run: `cd mytribe/functions && npx vitest run test/listTemplates.test.ts`
Expected: FAIL on `format`.

- [ ] **Step 4: Implement.** In `TemplateDoc` add:

```ts
  format?: string;
  headline?: string;
  content?: string;
```

and in the object returned by `snap.docs.map`, after `category`:

```ts
      // #953: the visual format. Android and desktop choose their editor from
      // `format` and edit `headline` and `content` directly, so the list has to
      // carry them. Absent on an old-format doc, so old clients see no change.
      ...(typeof data.format === 'string' ? { format: data.format } : {}),
      ...(typeof data.headline === 'string' ? { headline: data.headline } : {}),
      ...(typeof data.content === 'string' ? { content: data.content } : {}),
```

- [ ] **Step 5: Run.** `npx vitest run test/listTemplates.test.ts`. Expected: PASS, one more test than before. Then `git grep -n "listTemplates" mytribe/functions/CALLABLE_CONTRACT.md` and, if the response shape is listed there, add the three optional fields in the same style.

- [ ] **Step 6: Commit.** Message file:

```
listTemplates returns format, headline and content (#953)

The Android and desktop admins decide how to edit a template from its
format, and the Android visual editor edits headline and content. The
list never carried them, so PR 1's format check could not fire.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
`git add mytribe/functions/src/admin/listTemplates.ts mytribe/functions/test/listTemplates.test.ts mytribe/functions/CALLABLE_CONTRACT.md && git commit -F <file>`

---

### Task 2: Parse and serialize the content, losslessly

**Files:**
- Create: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/EmailContent.kt`
- Test: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/EmailContentRoundTripTest.kt`

**Interfaces:**
- Produces: `EmailInline` (`Text`, `Break`, `InlineImage`, `Element`), `EmailBlock` (`TextBlock`, `ImageBlock`, `LockedBlock`), `EmailBlockKind`, `parseEmailContent(html): List<EmailBlock>`, `serializeEmailContent(blocks): String`, `EmailBlock.TextBlock.plainText()`, `inlinePlain`, `buttonTarget`, `EmailInline.Element.href`, `EmailInline.Element.isButton`, `EmailBlock.ImageBlock.src/alt`, `htmlAttribute`, `decodeHtmlEntities`, `escapeHtmlText`, `htmlToReadableText`, `hasBrokenMergeField`, `EMAIL_MERGE_TOKEN`, `EMAIL_IMAGE_CHAR`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.random.Random

/**
 * #953 PR 5: the phone reads the body the server's sanitizer stored and must
 * write back exactly what it read wherever the operator changed nothing.
 */
class EmailContentRoundTripTest {

    private val img = "https://res.cloudinary.com/tribetails/image/upload/v1/brand/pup.jpg"

    /**
     * What PR 2's sanitizer writes, probed against sanitize-html 2.17.7:
     * `<br />`, `<img … />`, text escaping only & < >, attributes in input order.
     */
    private val canonical = listOf(
        "<p>Hi {{displayName}},</p>",
        "<h2>Reset</h2><h3>Steps</h3>",
        "<p>A <strong>b</strong> <em>c</em><br />d</p>",
        "<ul><li>x</li><li><strong>y</strong> z</li></ul><ol><li>one</li><li>two <em>2</em></li></ol>",
        "<blockquote><p>careful</p></blockquote>",
        "<blockquote><p>one</p><p>two</p></blockquote>",
        "<p><a href=\"https://tribetails.com/help\">Get help</a></p>",
        "<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>",
        "<p><a class=\"button\" href=\"{{link}}\">Go</a></p>",
        "<p><img src=\"$img\" alt=\"pup\" /></p>",
        "<img src=\"$img\" alt=\"pup\" />",
        "<ul><li><p>item <strong>b</strong></p></li></ul>",
        "<p>See <a href=\"https://x.com/?a=1&amp;b=2\"><strong><em>this</em></strong></a> now</p>",
        "<p><strong><a href=\"mailto:help@tribetails.com\">mail <em>us</em></a></strong></p>",
        "<p>1 &lt; 2 &gt; 0 &amp; \"q\" it's</p>",
        "<p>a b café 😀 👩‍👩‍👧</p>",
        "<p>Line one<br />Line two<br /><strong>Auntie</strong></p>",
        "<p><a href=\"{{link}}\">{{link}}</a></p>",
        "<p><img src=\"$img\" alt=\"say &quot;hi&quot; &amp; it's\" /></p>",
        "<p></p><p>t</p>",
    )

    /** Legal but unusual: whitespace between blocks, `<br>` without the slash, nesting the phone does not edit, broken markup. */
    private val unusual = listOf(
        "<ul>\n<li>x</li>\n</ul>",
        "<p>top</p>\n<p>next</p>",
        "<p>a<br>b</p>",
        "<ul><li>outer<ul><li>nested</li></ul></li></ul>",
        "<blockquote><ul><li>x</li></ul></blockquote>",
        "stray text <strong>top</strong>",
        "<p>Text with <img src=\"$img\" alt=\"i\" /> inline</p>",
        "<p>unclosed <strong>bold",
        "</p>orphan close",
        "<p>1 < 2</p>",
        "",
    )

    @Test fun everyCanonicalInputRoundTripsByteForByte() {
        for (html in canonical) assertEquals(html, serializeEmailContent(parseEmailContent(html)))
    }

    @Test fun everyUnusualInputRoundTripsByteForByte() {
        for (html in unusual) assertEquals(html, serializeEmailContent(parseEmailContent(html)))
    }

    @Test fun anyStringRoundTrips() {
        val parts = listOf(
            "<p>", "</p>", "<strong>", "</strong>", "<em>", "</em>", "<a href=\"{{link}}\" class=\"button\">",
            "<a href=\"https://x.com\">", "</a>", "<br />", "<img src=\"$img\" alt=\"a\" />", "<ul>", "</ul>",
            "<ol>", "</ol>", "<li>", "</li>", "<h2>", "</h2>", "<h3>", "</h3>", "<blockquote>", "</blockquote>",
            "Hi ", "{{name}}", "&amp;", "😀", "\n", " ", "<", ">", "\"",
        )
        val random = Random(953)
        repeat(500) {
            val html = buildString { repeat(random.nextInt(1, 25)) { append(parts[random.nextInt(parts.size)]) } }
            assertEquals(html, serializeEmailContent(parseEmailContent(html)))
        }
    }

    @Test fun blocksAreClassifiedForTheEditor() {
        val kinds = parseEmailContent(
            "<h2>Reset</h2><p>Hi <strong>{{displayName}}</strong>,</p><ul><li>a</li></ul><ol><li>b</li><li>c</li></ol>" +
                "<blockquote><p>careful</p></blockquote><p><a href=\"{{link}}\" class=\"button\">Go</a></p>" +
                "<p><img src=\"$img\" alt=\"pup\" /></p><ul><li>outer<ul><li>nested</li></ul></li></ul>",
        ).map { block ->
            when (block) {
                is EmailBlock.TextBlock -> block.kind.name + (block.number?.let { "#$it" } ?: "")
                is EmailBlock.ImageBlock -> "IMAGE"
                is EmailBlock.LockedBlock -> "LOCKED"
            }
        }
        assertEquals(
            listOf("HEADING2", "PARAGRAPH", "BULLET_ITEM", "NUMBERED_ITEM#1", "NUMBERED_ITEM#2", "CALLOUT", "BUTTON", "IMAGE", "LOCKED"),
            kinds,
        )
    }

    @Test fun plainTextIsWhatTheOperatorReads() {
        val block = parseEmailContent("<p>1 &lt; 2 &amp; <strong>b</strong><br />c</p>").single() as EmailBlock.TextBlock
        assertEquals("1 < 2 & b\nc", block.plainText())
    }

    @Test fun buttonAndImageAttributesAreReadForDisplay() {
        val blocks = parseEmailContent(
            "<p><a href=\"{{link}}\" class=\"button\">Go</a></p><p><img src=\"$img\" alt=\"say &quot;hi&quot;\" /></p>",
        )
        assertEquals("{{link}}", buttonTarget(blocks[0] as EmailBlock.TextBlock))
        val image = blocks[1] as EmailBlock.ImageBlock
        assertEquals(img, image.src)
        assertEquals("say \"hi\"", image.alt)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd auntieos-admin/android && GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*EmailContentRoundTripTest*'`
Expected: compilation FAILS, `parseEmailContent` unresolved.

- [ ] **Step 3: Implement `EmailContent.kt`**

```kotlin
package com.tribetails.auntieos.ui.admin

/**
 * #953 PR 5: a visual email body as blocks the phone can edit, and back to HTML.
 *
 * Pure Kotlin with no Android types, so the JVM suite proves the round trip.
 * The input is what the server's sanitizer (`mytribe/functions/src/lib/emailContent.ts`)
 * stored. Every character of it is kept: markup the phone never edits (tags,
 * attributes, whitespace between blocks) rides along as its source text, and a
 * shape the phone does not model becomes a [EmailBlock.LockedBlock] holding its
 * source. So `serializeEmailContent(parseEmailContent(x)) == x` for any string,
 * and a save with no edits writes back exactly what it read.
 *
 * The Compose rich-text library the spec named was not used: its HTML export
 * writes <b>/<i>, adds target="_blank", drops class and alt, and splits a
 * paragraph at every <br>, so it could not give this guarantee.
 */

/** The server's merge-token shape (`MERGE_TOKEN` in emailContent.ts). */
val EMAIL_MERGE_TOKEN = Regex("""\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}""")

/** Stands in for an inline image in a block's plain text: one UTF-16 unit, so offsets stay simple. */
const val EMAIL_IMAGE_CHAR = '￼'

sealed interface EmailInline {
    /** Text. [raw] is its source spelling, kept until the text is edited, so an untouched run is written back as found. */
    data class Text(val text: String, val raw: String? = null) : EmailInline

    /** A line break, spelled as found (`<br />`). The phone never adds or removes one. */
    data class Break(val raw: String) : EmailInline

    /** An `<img>` inside text. Locked. */
    data class InlineImage(val raw: String) : EmailInline

    /** `strong`, `em` or `a`. Both tags are kept verbatim, so a link target and a button class cannot change. */
    data class Element(
        val name: String,
        val openTag: String,
        val children: List<EmailInline>,
        val closeTag: String,
    ) : EmailInline
}

val EmailInline.Element.href: String? get() = htmlAttribute(openTag, "href")
val EmailInline.Element.isButton: Boolean get() = name == "a" && htmlAttribute(openTag, "class") == "button"

enum class EmailBlockKind { PARAGRAPH, HEADING2, HEADING3, BULLET_ITEM, NUMBERED_ITEM, CALLOUT, BUTTON }

sealed interface EmailBlock {
    /** Source markup written before the block's own content: its tag, a list or callout wrapper, whitespace. */
    val lead: String

    /** Source markup written after it. */
    val trail: String

    data class TextBlock(
        val kind: EmailBlockKind,
        val inlines: List<EmailInline>,
        override val lead: String,
        override val trail: String,
        /** 1-based position in a numbered list, else null. */
        val number: Int? = null,
    ) : EmailBlock

    /** A paragraph holding only an image, or a bare `<img>` between blocks. Shown, never edited. */
    data class ImageBlock(val raw: String, override val lead: String, override val trail: String) : EmailBlock

    /** A shape the phone does not edit: a nested list, an empty paragraph, stray text. Written back as found. */
    data class LockedBlock(val raw: String, override val lead: String = "", override val trail: String = "") : EmailBlock
}

val EmailBlock.ImageBlock.src: String get() = htmlAttribute(raw, "src").orEmpty()
val EmailBlock.ImageBlock.alt: String get() = htmlAttribute(raw, "alt").orEmpty()

// ── plain text ────────────────────────────────────────────────────────────────

fun inlinePlain(n: EmailInline): String = when (n) {
    is EmailInline.Text -> n.text
    is EmailInline.Break -> "\n"
    is EmailInline.InlineImage -> EMAIL_IMAGE_CHAR.toString()
    is EmailInline.Element -> n.children.joinToString("") { inlinePlain(it) }
}

fun EmailBlock.TextBlock.plainText(): String = inlines.joinToString("") { inlinePlain(it) }

/** The locked target of the button in [block], or null when it holds none. */
fun buttonTarget(block: EmailBlock.TextBlock): String? {
    fun find(nodes: List<EmailInline>): EmailInline.Element? {
        for (n in nodes) {
            if (n !is EmailInline.Element) continue
            if (n.isButton) return n
            find(n.children)?.let { return it }
        }
        return null
    }
    return find(block.inlines)?.href
}

/** True when [text] holds `{{` or `}}` that is not part of a whole merge field. */
fun hasBrokenMergeField(text: String): Boolean {
    val rest = EMAIL_MERGE_TOKEN.replace(text, "")
    return "{{" in rest || "}}" in rest
}

/** Readable text for a fragment: tags dropped, entities decoded, one line per block. */
fun htmlToReadableText(html: String): String =
    decodeHtmlEntities(
        html.replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("</(p|h2|h3|li|blockquote)>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("<[^>]*>"), ""),
    ).lines().map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n")

// ── entities and attributes ───────────────────────────────────────────────────

private val ENTITY = Regex("&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);")

fun decodeHtmlEntities(s: String): String {
    if ('&' !in s) return s
    return ENTITY.replace(s) { m ->
        val e = m.groupValues[1]
        val code = when {
            e.startsWith("#x") || e.startsWith("#X") -> e.drop(2).toIntOrNull(16)
            e.startsWith("#") -> e.drop(1).toIntOrNull()
            else -> null
        }
        when {
            code != null -> if (Character.isValidCodePoint(code)) String(Character.toChars(code)) else m.value
            e == "amp" -> "&"
            e == "lt" -> "<"
            e == "gt" -> ">"
            e == "quot" -> "\""
            e == "apos" -> "'"
            e == "nbsp" -> " "
            else -> m.value
        }
    }
}

/** How the sanitizer escapes text: `&`, `<`, `>` only. Used for an edited run. */
fun escapeHtmlText(s: String): String = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/** The decoded value of attribute [name] in one start tag, or null when absent. */
fun htmlAttribute(tag: String, name: String): String? {
    val m = Regex(
        """\s${Regex.escape(name)}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
        RegexOption.IGNORE_CASE,
    ).find(tag) ?: return null
    val value = m.groups[1]?.value ?: m.groups[2]?.value ?: m.groups[3]?.value ?: ""
    return decodeHtmlEntities(value)
}

// ── serialize ─────────────────────────────────────────────────────────────────

fun serializeEmailContent(blocks: List<EmailBlock>): String = buildString {
    for (b in blocks) {
        append(b.lead)
        when (b) {
            is EmailBlock.TextBlock -> b.inlines.forEach { appendInline(it) }
            is EmailBlock.ImageBlock -> append(b.raw)
            is EmailBlock.LockedBlock -> append(b.raw)
        }
        append(b.trail)
    }
}

private fun StringBuilder.appendInline(n: EmailInline) {
    when (n) {
        is EmailInline.Text -> append(n.raw ?: escapeHtmlText(n.text))
        is EmailInline.Break -> append(n.raw)
        is EmailInline.InlineImage -> append(n.raw)
        is EmailInline.Element -> {
            append(n.openTag)
            n.children.forEach { appendInline(it) }
            append(n.closeTag)
        }
    }
}

// ── tokenize into a source-offset tree ────────────────────────────────────────

/**
 * One node of the source, by offsets. [name] is null for text and "" for an end
 * tag that closes nothing. Children cover [openEnd, closeStart) exactly, so
 * every character belongs to one node.
 */
private class Node(val name: String?, val start: Int, val openEnd: Int) {
    var closeStart: Int = openEnd
    var end: Int = openEnd
    val children = mutableListOf<Node>()
    fun close(closeStart: Int, end: Int) {
        this.closeStart = closeStart
        this.end = end
    }
}

private val VOID_TAGS = setOf("br", "img", "hr", "wbr")

private fun String.rawOf(n: Node) = substring(n.start, n.end)
private fun String.openOf(n: Node) = substring(n.start, n.openEnd)
private fun String.closeOf(n: Node) = substring(n.closeStart, n.end)

/** Index just past the `>` of a tag starting at [lt], or -1 when this `<` is text. */
private fun tagEndAt(html: String, lt: Int): Int {
    if (lt + 1 >= html.length) return -1
    val next = html[lt + 1]
    val isTag = next.isLetter() || (next == '/' && lt + 2 < html.length && html[lt + 2].isLetter())
    if (!isTag) return -1
    var j = lt + 1
    var quote: Char? = null
    while (j < html.length) {
        val ch = html[j]
        if (quote != null) {
            if (ch == quote) quote = null
        } else if (ch == '"' || ch == '\'') {
            quote = ch
        } else if (ch == '>') {
            return j + 1
        }
        j++
    }
    return -1
}

private fun tagNameOf(html: String, lt: Int): String {
    var j = lt + 1
    while (j < html.length && html[j].isLetterOrDigit()) j++
    return html.substring(lt + 1, j).lowercase()
}

private fun parseNodes(html: String): List<Node> {
    val root = mutableListOf<Node>()
    val open = ArrayDeque<Node>()
    fun sink(): MutableList<Node> = open.lastOrNull()?.children ?: root
    var textStart = -1
    fun flushText(upTo: Int) {
        if (textStart in 0 until upTo) sink().add(Node(null, textStart, upTo))
        textStart = -1
    }
    var i = 0
    while (i < html.length) {
        val tagEnd = if (html[i] == '<') tagEndAt(html, i) else -1
        if (tagEnd < 0) {
            if (textStart < 0) textStart = i
            i++
            continue
        }
        flushText(i)
        if (html[i + 1] == '/') {
            val name = html.substring(i + 2, tagEnd - 1).trim().lowercase()
            val depth = open.indexOfLast { it.name == name }
            if (depth < 0) {
                sink().add(Node("", i, tagEnd))
            } else {
                // Elements left open inside it end here, with no close tag of their own.
                while (open.size - 1 > depth) open.removeLast().close(i, i)
                open.removeLast().close(i, tagEnd)
            }
        } else {
            val name = tagNameOf(html, i)
            val node = Node(name, i, tagEnd)
            sink().add(node)
            if (name in VOID_TAGS || html[tagEnd - 2] == '/') node.close(tagEnd, tagEnd) else open.addLast(node)
        }
        i = tagEnd
    }
    flushText(html.length)
    while (open.isNotEmpty()) open.removeLast().close(html.length, html.length)
    return root
}

// ── classify into blocks ──────────────────────────────────────────────────────

private val INLINE_ELEMENTS = setOf("strong", "em", "a")

private fun inlineOf(html: String, n: Node): EmailInline? {
    val raw = html.rawOf(n)
    val name = n.name ?: return EmailInline.Text(decodeHtmlEntities(raw), raw)
    return when {
        name == "br" -> EmailInline.Break(raw)
        name == "img" -> EmailInline.InlineImage(raw)
        name in INLINE_ELEMENTS -> {
            val kids = inlinesOf(html, n.children) ?: return null
            EmailInline.Element(name, html.openOf(n), kids, html.closeOf(n))
        }
        else -> null
    }
}

/** The nodes as inline content, or null when any of them is a block or a stray tag. */
private fun inlinesOf(html: String, nodes: List<Node>): List<EmailInline>? {
    val out = ArrayList<EmailInline>(nodes.size)
    for (n in nodes) out += inlineOf(html, n) ?: return null
    return out
}

private fun containsImage(nodes: List<EmailInline>): Boolean =
    nodes.any { it is EmailInline.InlineImage || (it is EmailInline.Element && containsImage(it.children)) }

private fun EmailBlock.withLead(lead: String): EmailBlock = when (this) {
    is EmailBlock.TextBlock -> copy(lead = lead)
    is EmailBlock.ImageBlock -> copy(lead = lead)
    is EmailBlock.LockedBlock -> copy(lead = lead)
}

private fun EmailBlock.withTrail(trail: String): EmailBlock = when (this) {
    is EmailBlock.TextBlock -> copy(trail = trail)
    is EmailBlock.ImageBlock -> copy(trail = trail)
    is EmailBlock.LockedBlock -> copy(trail = trail)
}

private fun MutableList<EmailBlock>.appendToLastTrail(s: String) {
    this[lastIndex] = last().let { it.withTrail(it.trail + s) }
}

private fun paragraphOf(html: String, p: Node, kind: EmailBlockKind, lead: String, trail: String): EmailBlock? {
    val inlines = inlinesOf(html, p.children) ?: return null
    if (inlines.isEmpty()) return null
    val single = inlines.singleOrNull()
    if (single is EmailInline.InlineImage) return EmailBlock.ImageBlock(single.raw, lead, trail)
    val visible = inlines.filterNot { it is EmailInline.Text && it.text.isBlank() }
    val only = visible.singleOrNull() as? EmailInline.Element
    val isButton = only != null && only.isButton && !containsImage(only.children)
    return EmailBlock.TextBlock(if (isButton) EmailBlockKind.BUTTON else kind, inlines, lead, trail)
}

private fun headingOf(html: String, h: Node, kind: EmailBlockKind): List<EmailBlock>? {
    val inlines = inlinesOf(html, h.children)?.takeIf { it.isNotEmpty() } ?: return null
    return listOf(EmailBlock.TextBlock(kind, inlines, html.openOf(h), html.closeOf(h)))
}

private fun listItemsOf(html: String, list: Node, kind: EmailBlockKind): List<EmailBlock>? {
    val items = mutableListOf<EmailBlock>()
    val lead = StringBuilder(html.openOf(list))
    for (child in list.children) {
        val raw = html.rawOf(child)
        if (child.name == null && raw.isBlank()) {
            if (items.isEmpty()) lead.append(raw) else items.appendToLastTrail(raw)
            continue
        }
        if (child.name != "li") return null
        val number = if (kind == EmailBlockKind.NUMBERED_ITEM) items.size + 1 else null
        // TipTap writes <li><p>item</p></li>; the sanitizer keeps it.
        val onlyP = child.children.singleOrNull()?.takeIf { it.name == "p" }
        val item = if (onlyP != null) {
            val inlines = inlinesOf(html, onlyP.children)?.takeIf { it.isNotEmpty() } ?: return null
            EmailBlock.TextBlock(
                kind, inlines,
                lead.toString() + html.openOf(child) + html.openOf(onlyP),
                html.closeOf(onlyP) + html.closeOf(child),
                number,
            )
        } else {
            val inlines = inlinesOf(html, child.children)?.takeIf { it.isNotEmpty() } ?: return null
            EmailBlock.TextBlock(kind, inlines, lead.toString() + html.openOf(child), html.closeOf(child), number)
        }
        items += item
        lead.setLength(0)
    }
    if (items.isEmpty()) return null
    items.appendToLastTrail(html.closeOf(list))
    return items
}

private fun calloutOf(html: String, quote: Node): List<EmailBlock>? {
    val kids = quote.children
    val allParagraphs = kids.any { it.name == "p" } &&
        kids.all { it.name == "p" || (it.name == null && html.rawOf(it).isBlank()) }
    if (!allParagraphs) {
        val inlines = inlinesOf(html, kids)?.takeIf { it.isNotEmpty() } ?: return null
        return listOf(EmailBlock.TextBlock(EmailBlockKind.CALLOUT, inlines, html.openOf(quote), html.closeOf(quote)))
    }
    val blocks = mutableListOf<EmailBlock>()
    val lead = StringBuilder(html.openOf(quote))
    for (child in kids) {
        val raw = html.rawOf(child)
        if (child.name == null) {
            if (blocks.isEmpty()) lead.append(raw) else blocks.appendToLastTrail(raw)
            continue
        }
        blocks += paragraphOf(html, child, EmailBlockKind.CALLOUT, lead.toString() + html.openOf(child), html.closeOf(child))
            ?: return null
        lead.setLength(0)
    }
    blocks.appendToLastTrail(html.closeOf(quote))
    return blocks
}

private fun blocksOf(html: String, n: Node): List<EmailBlock>? = when (n.name) {
    "p" -> paragraphOf(html, n, EmailBlockKind.PARAGRAPH, html.openOf(n), html.closeOf(n))?.let { listOf(it) }
    "h2" -> headingOf(html, n, EmailBlockKind.HEADING2)
    "h3" -> headingOf(html, n, EmailBlockKind.HEADING3)
    "img" -> listOf(EmailBlock.ImageBlock(html.rawOf(n), "", ""))
    "ul" -> listItemsOf(html, n, EmailBlockKind.BULLET_ITEM)
    "ol" -> listItemsOf(html, n, EmailBlockKind.NUMBERED_ITEM)
    "blockquote" -> calloutOf(html, n)
    else -> null
}

fun parseEmailContent(html: String): List<EmailBlock> {
    val out = mutableListOf<EmailBlock>()
    val pending = StringBuilder()
    fun add(block: EmailBlock) {
        out += if (pending.isEmpty()) block else block.withLead(pending.toString() + block.lead)
        pending.setLength(0)
    }
    for (n in parseNodes(html)) {
        val raw = html.rawOf(n)
        if (n.name == null && raw.isBlank()) {
            if (out.isEmpty()) pending.append(raw) else out.appendToLastTrail(raw)
            continue
        }
        val blocks = blocksOf(html, n)
        if (blocks == null) add(EmailBlock.LockedBlock(raw)) else blocks.forEach { add(it) }
    }
    if (pending.isNotEmpty()) out += EmailBlock.LockedBlock(pending.toString())
    return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*EmailContentRoundTripTest*'`
Expected: BUILD SUCCESSFUL. Read `app/build/test-results/testDebugUnitTest/TEST-com.tribetails.auntieos.ui.admin.EmailContentRoundTripTest.xml` and confirm `tests="6" failures="0" errors="0"`. If `anyStringRoundTrips` fails, the tree lost or doubled a character: fix `parseNodes` coverage, never the corpus.

- [ ] **Step 5: Commit.** Message: `Parse the visual email body into blocks, losslessly (#953)`, a body naming the round-trip guarantee and the library decision in one sentence each, then the Co-Authored-By line. `git add` the two files, `git commit -F <file>`.

---

### Task 3: Word edits that cannot touch structure

**Files:**
- Create: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/EmailBlockEdit.kt`
- Test: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/EmailBlockEditTest.kt`

**Interfaces:**
- Consumes: Task 2.
- Produces: `sealed interface BlockEdit { Accepted(block, cursor); Rejected(reason) }`, `applyBlockEdit(block: EmailBlock.TextBlock, newText: String): BlockEdit`, constants `EDIT_NO_NEW_LINES`, `EDIT_LOCKED_STRUCTURE`, `EDIT_WHOLE_MERGE_FIELD`, `EDIT_KEEP_FORMATTING`, `EDIT_NOT_EMPTY`, `EDIT_NO_WORD_HERE`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** #953 PR 5: the phone changes words and nothing else. */
class EmailBlockEditTest {

    private val img = "https://res.cloudinary.com/tribetails/image/upload/v1/brand/pup.jpg"

    private val reset =
        "<p>Hi <strong>{{displayName}}</strong>, we got a request to reset your password.</p>" +
            "<p><a href=\"{{link}}\" class=\"button\">Reset your password</a></p>" +
            "<h3>If you didn't ask</h3>" +
            "<ul><li>You can ignore this <em>email</em>.</li><li>Your password stays the same.</li></ul>" +
            "<blockquote><p>The link works for <strong>one hour</strong>.</p></blockquote>" +
            "<p>Questions? <a href=\"mailto:help@tribetails.com\">Write to us</a>.<br />Take care,<br /><strong>Auntie</strong></p>" +
            "<p><img src=\"$img\" alt=\"Tribe Tails\" /></p>"

    private fun block(html: String) = parseEmailContent(html).single() as EmailBlock.TextBlock

    private fun edit(html: String, newText: String): String {
        val r = applyBlockEdit(block(html), newText)
        assertTrue("expected Accepted, got $r", r is BlockEdit.Accepted)
        return serializeEmailContent(listOf((r as BlockEdit.Accepted).block))
    }

    private fun refusal(html: String, newText: String): String {
        val r = applyBlockEdit(block(html), newText)
        assertTrue("expected Rejected, got $r", r is BlockEdit.Rejected)
        return (r as BlockEdit.Rejected).reason
    }

    private fun tags(s: String) = Regex("<[^>]+>").findAll(s).map { it.value }.toList()

    private fun codePointBoundaries(s: String): List<Int> {
        val out = mutableListOf(0)
        var k = 0
        while (k < s.length) {
            k += Character.charCount(s.codePointAt(k))
            out += k
        }
        return out
    }

    @Test fun changingAWordKeepsTheBoldAroundIt() {
        assertEquals("<p>Hello <strong>dear</strong> friend</p>", edit("<p>Hello <strong>dear</strong> reader</p>", "Hello dear friend"))
        assertEquals("<p>Hello <strong>kind</strong> reader</p>", edit("<p>Hello <strong>dear</strong> reader</p>", "Hello kind reader"))
    }

    @Test fun typingAfterABoldWordContinuesTheBold() {
        assertEquals("<p>Hi <strong>you!</strong></p>", edit("<p>Hi <strong>you</strong></p>", "Hi you!"))
    }

    @Test fun typingAfterALinkPrefersThePlainTextBeside() {
        assertEquals(
            "<p>See <a href=\"https://x.com\">help</a>, now</p>",
            edit("<p>See <a href=\"https://x.com\">help</a> now</p>", "See help, now"),
        )
    }

    @Test fun breaksAndHtmlEscapesSurviveAnEdit() {
        assertEquals("<p>1 &lt; 3 &amp; b<br />c</p>", edit("<p>1 &lt; 2 &amp; b<br />c</p>", "1 < 3 & b\nc"))
    }

    @Test fun anUneditedRunKeepsItsSourceSpelling() {
        // &#39; is not what the sanitizer writes, but a run nobody touched is written back as found.
        assertEquals("<p>it&#39;s <strong>ok</strong> now</p>", edit("<p>it&#39;s <strong>ok</strong> then</p>", "it's ok now"))
    }

    // Review Focus 1
    @Test fun aParagraphThatIsEntirelyALinkKeepsTheLinkThroughAnyWordEdit() {
        val p = "<p><a href=\"https://tribetails.com/help\">Get help</a></p>"
        assertEquals("<p><a href=\"https://tribetails.com/help\">Find help</a></p>", edit(p, "Find help"))
        assertEquals("<p><a href=\"https://tribetails.com/help\">Support</a></p>", edit(p, "Support"))
        assertEquals("<p><a href=\"https://tribetails.com/help\">Get help!</a></p>", edit(p, "Get help!"))
        assertEquals(EDIT_KEEP_FORMATTING, refusal(p, ""))
    }

    // Review Focus 2
    @Test fun emojiAreReplacedWholeAndNeverSplit() {
        assertEquals("<p>Hi <strong>😁</strong> there</p>", edit("<p>Hi <strong>😀</strong> there</p>", "Hi 😁 there"))
        assertEquals("<p>Hi <strong>you👋</strong></p>", edit("<p>Hi <strong>you</strong></p>", "Hi you👋"))
        assertEquals("<p>Family  photo</p>", edit("<p>Family 👩‍👩‍👧 photo</p>", "Family  photo"))
        assertEquals("<p>a<strong>😁😀</strong></p>", edit("<p>a<strong>😀</strong></p>", "a😁😀"))
        val r = applyBlockEdit(block("<p>Hi <strong>😀</strong> there</p>"), "Hi 😁 there") as BlockEdit.Accepted
        assertEquals(5, r.cursor)
        assertFalse(Character.isLowSurrogate("Hi 😁 there"[r.cursor]))
    }

    // Review Focus 3
    @Test fun aMergeFieldIsNeverHalfEdited() {
        val p = "<p>Hi {{displayName}}, welcome</p>"
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Hi {{dispXlayName}}, welcome"))
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Hi Xname}}, welcome"))
        assertEquals("<p>Hi , welcome</p>", edit(p, "Hi {{displayName}, welcome"))
        assertEquals("<p>Hi Pat, welcome</p>", edit(p, "Hi Pat, welcome"))
    }

    @Test fun aFreshlyTypedMergeFieldIsJustText() {
        assertEquals("<p>Hi {{name}}</p>", edit("<p>Hi </p>", "Hi {{name}}"))
        assertTrue(hasBrokenMergeField("Hi {{na"))
        assertTrue(hasBrokenMergeField("Hi name}}"))
        assertFalse(hasBrokenMergeField("Hi {{name}} and {{ link }}"))
    }

    @Test fun aButtonLabelChangesAndItsTargetDoesNot() {
        assertEquals(
            "<p><a href=\"{{link}}\" class=\"button\">Choose a new password</a></p>",
            edit("<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>", "Choose a new password"),
        )
        assertEquals(EDIT_KEEP_FORMATTING, refusal("<p><a href=\"{{link}}\" class=\"button\">Go</a></p>", ""))
    }

    @Test fun lineBreaksAndInlineImagesAreStructure() {
        assertEquals(EDIT_NO_NEW_LINES, refusal("<p>one</p>", "o\nne"))
        assertEquals(EDIT_LOCKED_STRUCTURE, refusal("<p>a<br />b</p>", "ab"))
        assertEquals(EDIT_LOCKED_STRUCTURE, refusal("<p>see <img src=\"$img\" alt=\"i\" /> it</p>", "see  it"))
    }

    @Test fun formattingCannotBeRemovedAndABlockCannotBeEmptied() {
        assertEquals(EDIT_KEEP_FORMATTING, refusal("<p>a <em>b</em> c</p>", "a  c"))
        assertEquals(EDIT_NOT_EMPTY, refusal("<p>plain words</p>", ""))
        assertEquals(EDIT_NOT_EMPTY, refusal("<p>plain words</p>", "   "))
        // Emptying one of two runs inside a link keeps the link, so it is allowed.
        assertEquals(
            "<p><a href=\"mailto:help@tribetails.com\"><em>us</em></a></p>",
            edit("<p><a href=\"mailto:help@tribetails.com\">mail <em>us</em></a></p>", "us"),
        )
    }

    @Test fun wordEditsLeaveEveryTagInPlace() {
        val blocks = parseEmailContent(reset).map { b ->
            if (b !is EmailBlock.TextBlock) return@map b
            val next = b.plainText().replace("password", "passcode").replace("email", "message")
                .replace("hour", "day").replace("us", "the team")
            (applyBlockEdit(b, next) as? BlockEdit.Accepted)?.block ?: b
        }
        val out = serializeEmailContent(blocks)
        assertNotEquals(reset, out)
        assertTrue(out.contains("<a href=\"{{link}}\" class=\"button\">Reset your passcode</a>"))
        assertTrue(out.contains("<em>message</em>"))
        assertTrue(out.contains("<strong>one day</strong>"))
        assertEquals(tags(reset), tags(out))
    }

    @Test fun noSequenceOfEditsAddsRemovesOrReshapesABlock() {
        val random = Random(5)
        val alphabet = listOf("a", " ", "é", "😀", "{", "}", "{{name}}", "<", "&", "")
        val original = parseEmailContent(reset)
        var blocks = original
        repeat(2000) {
            val i = random.nextInt(blocks.size)
            val b = blocks[i] as? EmailBlock.TextBlock ?: return@repeat
            val text = b.plainText()
            val cuts = codePointBoundaries(text)
            val from = cuts[random.nextInt(cuts.size)]
            val later = cuts.filter { it >= from }
            val to = later[random.nextInt(later.size)]
            val next = text.substring(0, from) + alphabet[random.nextInt(alphabet.size)] + text.substring(to)
            val r = applyBlockEdit(b, next)
            if (r is BlockEdit.Accepted) blocks = blocks.toMutableList().also { it[i] = r.block }
        }
        val out = serializeEmailContent(blocks)
        val reparsed = parseEmailContent(out)
        assertEquals(original.size, reparsed.size)
        original.zip(reparsed).forEach { (a, b) ->
            assertEquals(a::class, b::class)
            assertEquals(a.lead, b.lead)
            assertEquals(a.trail, b.trail)
            if (a is EmailBlock.TextBlock) assertEquals(a.kind, (b as EmailBlock.TextBlock).kind)
        }
        assertEquals(tags(reset), tags(out))
        out.forEachIndexed { k, ch ->
            if (ch.isHighSurrogate()) assertTrue("lone high surrogate at $k", k + 1 < out.length && out[k + 1].isLowSurrogate())
            if (ch.isLowSurrogate()) assertTrue("lone low surrogate at $k", k > 0 && out[k - 1].isHighSurrogate())
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails.** `GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*EmailBlockEditTest*'`. Expected: compilation FAILS, `applyBlockEdit` unresolved.

- [ ] **Step 3: Implement `EmailBlockEdit.kt`**

```kotlin
package com.tribetails.auntieos.ui.admin

/**
 * #953 PR 5: one text-field change applied to one block, or refused.
 *
 * The field shows the block's plain text. A change arrives as the whole new
 * text; the diff (common prefix and suffix, widened so it never cuts a
 * surrogate pair) says what was deleted and what was typed. The rules are the
 * spec's "change words, not formatting": no new line breaks, no removed
 * breaks or images, no emptied bold, italic or link, no half-edited merge
 * field, and no emptied block. Tags are never touched, so link and button
 * targets cannot change.
 */
sealed interface BlockEdit {
    /** [cursor] is where the caret belongs in the new plain text. */
    data class Accepted(val block: EmailBlock.TextBlock, val cursor: Int) : BlockEdit
    data class Rejected(val reason: String) : BlockEdit
}

internal const val EDIT_NO_NEW_LINES = "Line breaks can't be added on the phone."
internal const val EDIT_LOCKED_STRUCTURE = "Line breaks and images stay as they are on the phone."
internal const val EDIT_WHOLE_MERGE_FIELD = "A merge field changes as a whole. Delete all of it or leave it."
internal const val EDIT_KEEP_FORMATTING = "Bold, italic and links can't be removed on the phone. Keep at least one letter."
internal const val EDIT_NOT_EMPTY = "A block can't be emptied on the phone."
internal const val EDIT_NO_WORD_HERE = "Put the cursor next to a word to type."

private class Leaf(
    val index: Int,
    val start: Int,
    val end: Int,
    val node: EmailInline,
    val formatted: Boolean,
    val inLink: Boolean,
) {
    val text: String get() = (node as? EmailInline.Text)?.text.orEmpty()
}

/** Every non-element node in document order, with its span in the plain text. */
private fun collectLeaves(inlines: List<EmailInline>): List<Leaf> {
    val out = mutableListOf<Leaf>()
    var offset = 0
    fun walk(nodes: List<EmailInline>, formatted: Boolean, inLink: Boolean) {
        for (n in nodes) {
            if (n is EmailInline.Element) {
                walk(n.children, true, inLink || n.name == "a")
                continue
            }
            val length = inlinePlain(n).length
            out += Leaf(out.size, offset, offset + length, n, formatted, inLink)
            offset += length
        }
    }
    walk(inlines, formatted = false, inLink = false)
    return out
}

/** The same tree with text leaves replaced by index (the [collectLeaves] numbering). */
private fun rewriteTexts(inlines: List<EmailInline>, replaced: Map<Int, String>): List<EmailInline> {
    var index = 0
    fun walk(nodes: List<EmailInline>): List<EmailInline> = nodes.map { n ->
        when (n) {
            is EmailInline.Element -> n.copy(children = walk(n.children))
            is EmailInline.Text -> {
                val next = replaced[index++]
                if (next == null || next == n.text) n else EmailInline.Text(next)
            }
            else -> {
                index++
                n
            }
        }
    }
    return walk(inlines)
}

private fun countEmptyElements(nodes: List<EmailInline>): Int {
    var count = 0
    for (n in nodes) {
        if (n !is EmailInline.Element) continue
        if (inlinePlain(n).isEmpty()) count++
        count += countEmptyElements(n.children)
    }
    return count
}

fun applyBlockEdit(block: EmailBlock.TextBlock, newText: String): BlockEdit {
    val old = block.plainText()
    if (old == newText) return BlockEdit.Accepted(block, newText.length)

    val shortest = minOf(old.length, newText.length)
    var prefix = 0
    while (prefix < shortest && old[prefix] == newText[prefix]) prefix++
    var suffix = 0
    while (suffix < shortest - prefix && old[old.length - 1 - suffix] == newText[newText.length - 1 - suffix]) suffix++
    // Never cut a surrogate pair: an emoji is replaced or kept whole.
    if (prefix > 0 && old[prefix - 1].isHighSurrogate()) prefix--
    if (suffix > 0 && old[old.length - suffix].isLowSurrogate()) suffix--

    var delStart = prefix
    var delEnd = old.length - suffix
    val insert = newText.substring(prefix, newText.length - suffix)
    if (insert.any { it == '\n' || it == '\r' || it == EMAIL_IMAGE_CHAR }) return BlockEdit.Rejected(EDIT_NO_NEW_LINES)

    // Merge fields: nothing typed inside one, nothing typed over part of one,
    // and a deletion that reaches into one takes all of it.
    val tokens = EMAIL_MERGE_TOKEN.findAll(old).map { it.range.first to it.range.last + 1 }.toList()
    var grew = true
    while (grew) {
        grew = false
        for ((ts, te) in tokens) {
            if (delStart == delEnd) {
                if (delStart in ts + 1 until te) return BlockEdit.Rejected(EDIT_WHOLE_MERGE_FIELD)
                continue
            }
            val overlaps = delStart < te && delEnd > ts
            val covers = delStart <= ts && delEnd >= te
            if (overlaps && !covers) {
                if (insert.isNotEmpty()) return BlockEdit.Rejected(EDIT_WHOLE_MERGE_FIELD)
                delStart = minOf(delStart, ts)
                delEnd = maxOf(delEnd, te)
                grew = true
            }
        }
    }

    val leaves = collectLeaves(block.inlines)
    if (leaves.any { it.node !is EmailInline.Text && it.start < delEnd && it.end > delStart }) {
        return BlockEdit.Rejected(EDIT_LOCKED_STRUCTURE)
    }
    val texts = leaves.filter { it.node is EmailInline.Text }
    val replaced = HashMap<Int, String>()
    for (leaf in texts) {
        val from = maxOf(leaf.start, delStart)
        val to = minOf(leaf.end, delEnd)
        if (from < to) replaced[leaf.index] = leaf.text.removeRange(from - leaf.start, to - leaf.start)
    }

    if (insert.isNotEmpty()) {
        // A run this change emptied gets the new words first (a formatted one
        // before a plain one), so replacing a bold word keeps it bold.
        val emptied = texts.filter { it.end > it.start && it.start >= delStart && it.end <= delEnd }
        val target = emptied.firstOrNull { it.formatted }
            ?: emptied.firstOrNull()
            ?: texts.firstOrNull { it.start < delStart && delStart < it.end }
            ?: texts.firstOrNull { it.end == delStart && !it.inLink }
            ?: texts.firstOrNull { it.start == delStart }
            ?: texts.firstOrNull { it.end == delStart }
            ?: return BlockEdit.Rejected(EDIT_NO_WORD_HERE)
        val current = replaced[target.index] ?: target.text
        val at = (delStart - target.start).coerceIn(0, current.length)
        replaced[target.index] = current.substring(0, at) + insert + current.substring(at)
    }

    val inlines = rewriteTexts(block.inlines, replaced)
    if (countEmptyElements(inlines) > countEmptyElements(block.inlines)) return BlockEdit.Rejected(EDIT_KEEP_FORMATTING)
    val updated = block.copy(inlines = inlines)
    if (updated.plainText().isBlank()) return BlockEdit.Rejected(EDIT_NOT_EMPTY)
    return BlockEdit.Accepted(updated, delStart + insert.length)
}
```

- [ ] **Step 4: Run to verify it passes.** Same command. Read `TEST-com.tribetails.auntieos.ui.admin.EmailBlockEditTest.xml`: `tests="14" failures="0" errors="0"`. If an expected string differs, work the case through the diff by hand before touching either side; the expectations above were derived that way.

- [ ] **Step 5: Commit.** Message: `Apply word edits to email blocks without touching structure (#953)`, body listing the six refusal rules, Co-Authored-By line.

---

### Task 4: Repository: the visual save shape and the preview call

**Files:**
- Modify: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/TemplateRepository.kt`
- Test: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/data/repository/TemplateRepositoryVisualTest.kt`

**Interfaces:**
- Consumes: `EmailTemplate.format` (PR 1).
- Produces: `EmailTemplate.headline: String? = null`, `EmailTemplate.content: String? = null`, `TemplateRepository.EmailPreview(subject, html, text, issues)`, `internal fun saveTemplatePayload(template, expectNew): Map<String, Any>`, `suspend fun previewEmailTemplate(subject, headline, content, catalogKey: String?): Result<EmailPreview>`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #953 PR 5: the visual format through the callables. FirebaseFunctions is mocked. */
class TemplateRepositoryVisualTest {

    private val visual = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset", body = "", html = null,
        title = "Password reset", description = "", tags = listOf("auth"), category = "Account",
        format = "visual", headline = "Reset your password", content = "<p>Hi</p>",
    )

    private fun functionsFor(name: String, data: Any?, payload: io.mockk.CapturingSlot<Map<String, Any>> = slot()): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns data
        every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable(name) } returns ref
        return functions
    }

    @Test
    fun `listTemplates decodes format, headline and content`() = runBlocking {
        val functions = functionsFor(
            "listTemplates",
            mapOf("templates" to listOf(mapOf(
                "templateId" to "auth.password.reset", "subject" to "Reset", "body" to "", "html" to null,
                "format" to "visual", "headline" to "Reset your password", "content" to "<p>Hi</p>",
            ))),
        )
        val t = TemplateRepository(functions).listTemplates().getOrThrow().single()
        assertEquals("visual", t.format)
        assertEquals("Reset your password", t.headline)
        assertEquals("<p>Hi</p>", t.content)
    }

    @Test
    fun `a visual save sends format, headline and content and never body or html`() {
        val p = saveTemplatePayload(visual, expectNew = false)
        assertEquals(
            setOf("templateId", "subject", "format", "headline", "content", "title", "description", "tags", "category"),
            p.keys,
        )
        assertEquals("visual", p["format"])
        assertEquals("<p>Hi</p>", p["content"])
        assertEquals("", p["description"])
        assertFalse(p.containsKey("body"))
        assertFalse(p.containsKey("html"))
    }

    @Test
    fun `an old-format save is unchanged`() {
        val old = visual.copy(format = null, headline = null, content = null, body = "Body", html = "<p>h</p>", description = null, category = null)
        val p = saveTemplatePayload(old, expectNew = true)
        assertEquals(listOf("templateId", "subject", "body", "html", "title", "tags", "expectNew"), p.keys.toList())
        assertEquals("Body", p["body"])
        assertEquals("<p>h</p>", p["html"])
    }

    @Test
    fun `saveTemplate sends the payload built for it`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val functions = functionsFor("saveTemplate", mapOf("templateId" to "auth.password.reset"), payload)
        assertTrue(TemplateRepository(functions).saveTemplate(visual).isSuccess)
        assertEquals(saveTemplatePayload(visual, expectNew = false), payload.captured)
    }

    @Test
    fun `previewEmailTemplate sends the draft and decodes the render`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val functions = functionsFor(
            "previewEmailTemplate",
            mapOf("subject" to "Reset", "html" to "<html>framed</html>", "text" to "framed", "issues" to listOf("Removed an image that is not from your Cloudinary library.")),
            payload,
        )
        val preview = TemplateRepository(functions).previewEmailTemplate("Reset", "Headline", "<p>Hi</p>", "auth.password.reset").getOrThrow()
        assertEquals(mapOf("subject" to "Reset", "headline" to "Headline", "content" to "<p>Hi</p>", "catalogKey" to "auth.password.reset"), payload.captured)
        assertEquals("<html>framed</html>", preview.html)
        assertEquals("framed", preview.text)
        assertEquals(listOf("Removed an image that is not from your Cloudinary library."), preview.issues)
    }

    @Test
    fun `previewEmailTemplate leaves out a blank catalogKey`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val functions = functionsFor("previewEmailTemplate", mapOf("subject" to "s", "html" to "<p/>", "text" to "t", "issues" to emptyList<String>()), payload)
        TemplateRepository(functions).previewEmailTemplate("s", "h", "<p>c</p>", " ").getOrThrow()
        assertFalse(payload.captured.containsKey("catalogKey"))
    }

    @Test
    fun `previewEmailTemplate fails loud on a payload with no html`() = runBlocking {
        val functions = functionsFor("previewEmailTemplate", mapOf("subject" to "s", "text" to "t"))
        val r = TemplateRepository(functions).previewEmailTemplate("s", "h", "<p>c</p>", null)
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("missing html"))
    }
}
```

- [ ] **Step 2: Run to verify it fails.** `--tests '*TemplateRepositoryVisualTest*'`. Expected: compilation FAILS (`headline`, `saveTemplatePayload`, `previewEmailTemplate` unresolved).

- [ ] **Step 3: Implement.**

In `EmailTemplate`, after PR 1's `val format: String? = null,`:

```kotlin
        /** #953: the visual format's header-bar text. Null on an old-format template. */
        val headline: String? = null,
        /** #953: the visual format's sanitized body fragment. Null on an old-format template. */
        val content: String? = null,
```

Next to `EmailTemplate`:

```kotlin
    /** #953: what previewEmailTemplate rendered, exactly as a real send would render it. */
    data class EmailPreview(
        val subject: String,
        val html: String,
        val text: String,
        val issues: List<String>,
    )
```

In `listTemplates`, after the `format = …` line PR 1 added:

```kotlin
                headline = m["headline"] as? String,
                content = m["content"] as? String,
```

Replace the `val payload = buildMap<String, Any> { … }` in `saveTemplate` with `val payload = saveTemplatePayload(template, expectNew)`, and add at file level, after `decodeImportReport`:

```kotlin
/**
 * Pure: the saveTemplate arguments for [template].
 *
 * #953: a visual template sends `format`, `headline` and `content` and never
 * `body` or `html` (the server refuses a visual save that carries either). An
 * old-format template sends exactly what it always did, in the same order.
 * The drag-to-categorize path goes through here too, so moving a visual
 * template to a category no longer sends an empty body.
 */
internal fun saveTemplatePayload(
    template: TemplateRepository.EmailTemplate,
    expectNew: Boolean,
): Map<String, Any> = buildMap<String, Any> {
    put("templateId", template.templateId)
    put("subject", template.subject)
    if (template.format == "visual") {
        put("format", "visual")
        put("headline", template.headline.orEmpty())
        put("content", template.content.orEmpty())
    } else {
        put("body", template.body)
        template.html?.let { put("html", it) }
    }
    put("title", template.title)
    template.description?.let { put("description", it) }
    put("tags", template.tags)
    template.category?.let { put("category", it) }
    if (expectNew) put("expectNew", true)
}
```

Add the preview call inside the class, after `saveTemplate`:

```kotlin
    /**
     * #953: the email as it would be sent: the shared frame, the generated text
     * part, sample values for [catalogKey]'s merge fields. `issues` are the
     * sanitizer's notes on [content], returned rather than thrown so the editor
     * can show them. Cancellation is rethrown so a superseded preview stops.
     */
    suspend fun previewEmailTemplate(
        subject: String,
        headline: String,
        content: String,
        catalogKey: String?,
    ): Result<EmailPreview> = runCatching {
        val payload = buildMap<String, Any> {
            put("subject", subject)
            put("headline", headline)
            put("content", content)
            catalogKey?.takeIf { it.isNotBlank() }?.let { put("catalogKey", it) }
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("previewEmailTemplate").call(payload).awaitCallable().data as? Map<String, Any?>
            ?: error("previewEmailTemplate: non-map payload")
        EmailPreview(
            subject = raw["subject"] as? String ?: "",
            html = raw["html"] as? String ?: error("previewEmailTemplate: missing html"),
            text = raw["text"] as? String ?: "",
            issues = (raw["issues"] as? List<*>).orEmpty().mapNotNull { it as? String },
        )
    }.onFailure {
        if (it is kotlinx.coroutines.CancellationException) throw it
        AuntieLog.e("TemplateRepository.previewEmailTemplate failed", it)
    }
```

- [ ] **Step 4: Run** `--tests '*TemplateRepositoryVisualTest*' --tests '*TemplateRepository*' --tests '*SessionEndedSeam*'`. Expected: PASS; `TemplateRepositoryVisualTest` shows `tests="7"`, and the existing repository tests keep their Task 0 counts. `SessionEndedSeamTest` passes because the new call uses `awaitCallable()`.

- [ ] **Step 5: Commit.** Message: `Android template repo saves the visual shape and asks for previews (#953)`.

---

### Task 5: The draft, rotation, and a save that rebuilds nothing it did not change

**Files:**
- Create: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/VisualTemplateSave.kt`
- Test: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/VisualTemplateSaveTest.kt`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces: `VISUAL_FORMAT`, `data class VisualDraft(subject, headline, blocks, title, description, category, tags)` with `VisualDraft.from(template)`, `VisualDraftSaver: Saver<VisualDraft, Any>`, `data class EmailPreviewRequest(subject, headline, content, catalogKey)`, `VisualDraft.previewRequest(templateId)`, `usesVisualEditor(template, creating)`, `visualTemplateToSave(original, draft)`, `visualDraftProblem(draft): String?`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.saveable.SaverScope
import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #953 PR 5: the Android rule that edit screens never rebuild a model from
 * form state. Every field comes back as loaded unless its control changed.
 */
class VisualTemplateSaveTest {

    private val original = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset", body = "", html = null,
        title = "", description = "", tags = listOf("auth", "account"), category = "",
        format = "visual", headline = "Reset your password",
        content = "<p>Hi <strong>{{displayName}}</strong>,<br>tap below.</p>",
    )

    private fun editedFirstBlock(draft: VisualDraft, newText: String): VisualDraft {
        val first = draft.blocks[0] as EmailBlock.TextBlock
        val r = applyBlockEdit(first, newText) as BlockEdit.Accepted
        return draft.copy(blocks = draft.blocks.toMutableList().also { it[0] = r.block })
    }

    @Test fun anUntouchedDraftSavesTheTemplateAsLoaded() {
        assertEquals(original, visualTemplateToSave(original, VisualDraft.from(original)))
    }

    @Test fun changingTheSubjectChangesOnlyTheSubject() {
        val saved = visualTemplateToSave(original, VisualDraft.from(original).copy(subject = "New"))
        assertEquals(original.copy(subject = "New"), saved)
    }

    @Test fun anEmptyDescriptionNobodyTouchedStaysEmptyNotNull() {
        assertEquals("", visualTemplateToSave(original, VisualDraft.from(original)).description)
        assertEquals("", visualTemplateToSave(original, VisualDraft.from(original)).category)
    }

    @Test fun aDescriptionTheOperatorClearedBecomesNull() {
        val withNote = original.copy(description = "Sent on request")
        assertNull(visualTemplateToSave(withNote, VisualDraft.from(withNote).copy(description = "")).description)
    }

    @Test fun aTitleClearedByTheOperatorFallsBackToTheKey() {
        val named = original.copy(title = "Password reset")
        assertEquals("auth.password.reset", visualTemplateToSave(named, VisualDraft.from(named).copy(title = " ")).title)
    }

    @Test fun untouchedContentIsWrittenBackByteForByte() {
        // `<br>` without the slash is not the sanitizer's spelling; it still comes back as stored.
        assertEquals(original.content, visualTemplateToSave(original, VisualDraft.from(original).copy(headline = "H")).content)
    }

    @Test fun editedContentIsSerializedFromTheBlocks() {
        val draft = editedFirstBlock(VisualDraft.from(original), "Hi {{displayName}},\ntap the button.")
        assertEquals(
            "<p>Hi <strong>{{displayName}}</strong>,<br>tap the button.</p>",
            visualTemplateToSave(original, draft).content,
        )
    }

    @Test fun onlyACompleteVisualDocUsesTheVisualEditor() {
        assertTrue(usesVisualEditor(original, creating = false))
        assertFalse(usesVisualEditor(original, creating = true))
        assertFalse(usesVisualEditor(original.copy(content = null), creating = false))
        assertFalse(usesVisualEditor(original.copy(headline = null), creating = false))
        assertFalse(usesVisualEditor(original.copy(format = "mjml"), creating = false))
        assertFalse(usesVisualEditor(original.copy(format = null), creating = false))
    }

    @Test fun problems() {
        val draft = VisualDraft.from(original)
        assertNull(visualDraftProblem(draft))
        assertEquals(DRAFT_NEEDS_SUBJECT, visualDraftProblem(draft.copy(subject = " ")))
        assertEquals(DRAFT_NEEDS_HEADLINE, visualDraftProblem(draft.copy(headline = "")))
        assertEquals(DRAFT_BROKEN_MERGE_FIELD, visualDraftProblem(draft.copy(subject = "Hi {{na")))
        assertEquals(DRAFT_BROKEN_MERGE_FIELD, visualDraftProblem(editedFirstBlock(draft, "Hi {{displayName}},\ntap {{li")))
    }

    // Review Focus 4
    @Test fun theDraftSurvivesSaveAndRestore() {
        val edited = editedFirstBlock(VisualDraft.from(original), "Hi {{displayName}},\ntap here 😀.")
            .copy(subject = "S2", tags = listOf("x"))
        val scope = SaverScope { true }
        val saved = with(VisualDraftSaver) { scope.save(edited) }!!
        val restored = VisualDraftSaver.restore(saved)!!
        assertEquals(serializeEmailContent(edited.blocks), serializeEmailContent(restored.blocks))
        assertEquals(edited.copy(blocks = restored.blocks), restored)
    }

    @Test fun thePreviewIsAskedForTheDraftUnderTheTemplateKey() {
        val request = VisualDraft.from(original).copy(subject = "S2").previewRequest(original.templateId)
        assertEquals(EmailPreviewRequest("S2", "Reset your password", original.content!!, "auth.password.reset"), request)
    }
}
```

- [ ] **Step 2: Run to verify it fails.** `--tests '*VisualTemplateSaveTest*'`. Expected: compilation FAILS.

- [ ] **Step 3: Implement `VisualTemplateSave.kt`**

```kotlin
package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import com.tribetails.auntieos.data.repository.TemplateRepository

/** #953: `emailTemplates/{id}.format` for the headline + content shape. */
internal const val VISUAL_FORMAT = "visual"

internal const val DRAFT_NEEDS_SUBJECT = "Add a subject."
internal const val DRAFT_NEEDS_HEADLINE = "Add a headline."
internal const val DRAFT_BROKEN_MERGE_FIELD = "A merge field is incomplete. Finish it as {{name}} or delete it."

/** Everything the visual editor lets the operator change, as the controls hold it. */
data class VisualDraft(
    val subject: String,
    val headline: String,
    val blocks: List<EmailBlock>,
    val title: String,
    val description: String,
    val category: String,
    val tags: List<String>,
) {
    companion object {
        fun from(t: TemplateRepository.EmailTemplate) = VisualDraft(
            subject = t.subject,
            headline = t.headline.orEmpty(),
            blocks = parseEmailContent(t.content.orEmpty()),
            title = t.title,
            description = t.description.orEmpty(),
            category = t.category.orEmpty(),
            tags = t.tags,
        )
    }
}

/** One previewEmailTemplate request. Equal requests are not sent twice. */
data class EmailPreviewRequest(
    val subject: String,
    val headline: String,
    val content: String,
    val catalogKey: String?,
)

/** The template key doubles as its catalog key (the default binding), so the preview gets that key's sample values. */
fun VisualDraft.previewRequest(templateId: String) =
    EmailPreviewRequest(subject, headline, serializeEmailContent(blocks), templateId.ifBlank { null })

/**
 * The visual editor opens only for a doc that is really in the visual shape.
 * Anything else (an unknown format, a visual flag without its fields, a new
 * template) stays with PR 1's modes in the old editor.
 */
fun usesVisualEditor(template: TemplateRepository.EmailTemplate, creating: Boolean): Boolean =
    !creating && template.format == VISUAL_FORMAT && template.headline != null && template.content != null

/**
 * The template a visual Save sends. Diff against what was loaded, never a
 * rebuild from form state: a field whose control is untouched goes back
 * exactly as it came, including "" versus null, and untouched content goes
 * back byte for byte.
 */
fun visualTemplateToSave(
    original: TemplateRepository.EmailTemplate,
    draft: VisualDraft,
): TemplateRepository.EmailTemplate {
    val start = VisualDraft.from(original)
    return original.copy(
        subject = draft.subject,
        format = VISUAL_FORMAT,
        headline = draft.headline,
        content = if (draft.blocks == start.blocks) original.content else serializeEmailContent(draft.blocks),
        title = if (draft.title == start.title) original.title else draft.title.ifBlank { original.templateId },
        description = if (draft.description == start.description) original.description else draft.description.ifBlank { null },
        category = if (draft.category == start.category) original.category else draft.category.ifBlank { null },
        tags = if (draft.tags == start.tags) original.tags else draft.tags,
    )
}

/** Why Save is off, or null when it can go. */
fun visualDraftProblem(draft: VisualDraft): String? = when {
    draft.subject.isBlank() -> DRAFT_NEEDS_SUBJECT
    draft.headline.isBlank() -> DRAFT_NEEDS_HEADLINE
    hasBrokenMergeField(draft.subject) || hasBrokenMergeField(draft.headline) ||
        draft.blocks.any { it is EmailBlock.TextBlock && hasBrokenMergeField(it.plainText()) } -> DRAFT_BROKEN_MERGE_FIELD
    else -> null
}

/**
 * Rotation recreates the Activity (the manifest declares no configChanges).
 * The body is saved as its HTML, which the round trip guarantees, so the
 * restored blocks serialize to exactly what was on screen.
 */
val VisualDraftSaver: Saver<VisualDraft, Any> = listSaver(
    save = {
        listOf(
            it.subject, it.headline, serializeEmailContent(it.blocks),
            it.title, it.description, it.category, ArrayList(it.tags),
        )
    },
    restore = {
        @Suppress("UNCHECKED_CAST")
        VisualDraft(
            subject = it[0] as String,
            headline = it[1] as String,
            blocks = parseEmailContent(it[2] as String),
            title = it[3] as String,
            description = it[4] as String,
            category = it[5] as String,
            tags = it[6] as List<String>,
        )
    },
)
```

- [ ] **Step 4: Run** `--tests '*VisualTemplateSaveTest*'`. Expected: PASS, `tests="11" failures="0"`.

- [ ] **Step 5: Commit.** Message: `Visual template draft: diff-vs-rebuild save and a rotation saver (#953)`.

---

### Task 6: The editor screen and the preview

**Files:**
- Create: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/VisualTemplateEditor.kt`
- Test: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/VisualTemplateEditorUiTest.kt`

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces: `VisualTemplateEditorScreen(template, categories, saving, saveError, onDismissError, onDismiss, onSave, loadPreview, previewDebounceMs = PREVIEW_DEBOUNCE_MS)`, `EmailPreviewPanel(request, loadPreview, debounceMs)`, tags `VISUAL_SAVE_TAG`, `PREVIEW_WEB_TAG`, `blockTag(i)`, `imageTag(i)`, `PREVIEW_LOADING_TEXT`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.ui.admin

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/** #953 PR 5: the Android visual editor, driven like an operator would. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class VisualTemplateEditorUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val img = "https://res.cloudinary.com/tribetails/image/upload/v1/brand/pup.jpg"
    private val template = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset your password", body = "", html = null,
        title = "Password reset", description = "Sent on request", tags = listOf("auth"), category = "Account",
        format = "visual", headline = "Choose a new password",
        content = "<p>Hi <strong>{{displayName}}</strong>, tap below.</p>" +
            "<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>" +
            "<p><img src=\"$img\" alt=\"pup\" /></p>",
    )
    private val preview = TemplateRepository.EmailPreview("Reset your password", "<html><body>framed</body></html>", "framed", emptyList())
    private val blockFields = SemanticsMatcher("an email block field") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("email-block-") == true
    }

    private fun editor(
        loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview> = { Result.success(preview) },
        saving: Boolean = false,
        onSave: (TemplateRepository.EmailTemplate) -> Unit = {},
    ): @androidx.compose.runtime.Composable () -> Unit = {
        AuntieOSTheme {
            VisualTemplateEditorScreen(
                template = template, categories = emptyList(), saving = saving, saveError = null,
                onDismissError = {}, onDismiss = {}, onSave = onSave, loadPreview = loadPreview, previewDebounceMs = 0,
            )
        }
    }

    private fun webView(): WebView {
        fun find(v: View): WebView? = when (v) {
            is WebView -> v
            is ViewGroup -> (0 until v.childCount).firstNotNullOfOrNull { find(v.getChildAt(it)) }
            else -> null
        }
        return find(composeRule.activity.window.decorView) ?: error("no WebView on screen")
    }

    @Test
    fun `a word edit keeps the bold, the button and the image`() {
        var saved: TemplateRepository.EmailTemplate? = null
        composeRule.setContent(editor(onSave = { saved = it }))
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals(
            "<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>" +
                "<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>" +
                "<p><img src=\"$img\" alt=\"pup\" /></p>",
            saved!!.content,
        )
        assertEquals("visual", saved!!.format)
        assertEquals(template.tags, saved!!.tags)
        assertEquals(template.description, saved!!.description)
    }

    @Test
    fun `the button label is editable and its target is shown, locked`() {
        var saved: TemplateRepository.EmailTemplate? = null
        composeRule.setContent(editor(onSave = { saved = it }))
        composeRule.onNodeWithText("{{link}}").assertExists().assert(!hasSetTextAction())
        composeRule.onNodeWithTag(blockTag(1)).performTextReplacement("Choose a new password")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertTrue(saved!!.content!!.contains("<a href=\"{{link}}\" class=\"button\">Choose a new password</a>"))
    }

    @Test
    fun `a refused edit explains itself and keeps the text`() {
        composeRule.setContent(editor())
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{dispXlayName}}, tap below.")
        composeRule.onNodeWithText(EDIT_WHOLE_MERGE_FIELD).assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap below.")
    }

    @Test
    fun `the image is shown and locked, and the block count never changes`() {
        composeRule.setContent(editor())
        composeRule.onNodeWithContentDescription("pup").assertExists()
        composeRule.onNodeWithTag(imageTag(2)).assert(!hasSetTextAction())
        composeRule.onAllNodes(blockFields).assertCountEquals(2)
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(blockTag(1)).performTextReplacement("Go")
        composeRule.onAllNodes(blockFields).assertCountEquals(2)
    }

    @Test
    fun `the preview shows a loading cue until the server answers, then the email`() {
        val answer = CompletableDeferred<Result<TemplateRepository.EmailPreview>>()
        composeRule.setContent(editor(loadPreview = { answer.await() }))
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertExists()
        composeRule.onNodeWithTag(PREVIEW_WEB_TAG).assertDoesNotExist()
        answer.complete(Result.success(preview))
        composeRule.waitForIdle()
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertDoesNotExist()
        composeRule.onNodeWithTag(PREVIEW_WEB_TAG).assertExists()
        assertEquals(preview.html, Shadows.shadowOf(webView()).lastLoadDataWithBaseURL.data)
    }

    @Test
    fun `a failed preview says so, and Retry asks again`() {
        var calls = 0
        composeRule.setContent(editor(loadPreview = {
            calls++
            if (calls == 1) Result.failure(RuntimeException("deadline-exceeded")) else Result.success(preview)
        }))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("deadline-exceeded").assertExists()
        composeRule.onNodeWithText("Retry").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("deadline-exceeded").assertDoesNotExist()
        composeRule.onNodeWithTag(PREVIEW_WEB_TAG).assertExists()
        assertEquals(2, calls)
    }

    // Review Focus 5
    @Test
    fun `Save works while the preview is still loading, and sends the draft on screen`() {
        var saved: TemplateRepository.EmailTemplate? = null
        composeRule.setContent(editor(loadPreview = { awaitCancellation() }, onSave = { saved = it }))
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertExists()
        assertTrue(saved!!.content!!.startsWith("<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>"))
    }

    @Test
    fun `while a save is in flight, Save cannot fire again`() {
        var count = 0
        composeRule.setContent(editor(saving = true, onSave = { count++ }))
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals(0, count)
    }

    // Review Focus 4
    @Test
    fun `rotating mid-edit keeps the edit`() {
        var saved: TemplateRepository.EmailTemplate? = null
        val tester = StateRestorationTester(composeRule)
        tester.setContent(editor(onSave = { saved = it }))
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithText("Reset your password").performTextReplacement("Reset it")
        tester.emulateSavedInstanceStateRestore()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals("Reset it", saved!!.subject)
        assertTrue(saved!!.content!!.startsWith("<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>"))
    }
}
```

`StateRestorationTester` takes any `ComposeContentTestRule`, which the v2 `createAndroidComposeRule` returns. If the BOM ships a `v2` variant of `StateRestorationTester`, import that one instead; the calls are the same.

- [ ] **Step 2: Run to verify it fails.** `--tests '*VisualTemplateEditorUiTest*'`. Expected: compilation FAILS, `VisualTemplateEditorScreen` unresolved.

- [ ] **Step 3: Implement `VisualTemplateEditor.kt`**

```kotlin
package com.tribetails.auntieos.ui.admin

import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import coil3.compose.AsyncImage
import com.composables.icons.lucide.Lock
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.TagAssignField
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

internal const val PREVIEW_DEBOUNCE_MS = 700L
internal const val PREVIEW_LOADING_TEXT = "Loading preview…"
internal const val VISUAL_SAVE_TAG = "visual-save"
internal const val PREVIEW_WEB_TAG = "email-preview-web"
internal fun blockTag(index: Int) = "email-block-$index"
internal fun imageTag(index: Int) = "email-image-$index"

/** An inline image shows as this glyph in a text field: same length as [EMAIL_IMAGE_CHAR], so offsets map 1:1. */
private const val IMAGE_GLYPH = '▣'

/**
 * #953 PR 5: the Android editor for a visual template (spec, "Admin Android").
 *
 * Subject and headline are plain fields. The body is its blocks, in order, and
 * nothing adds, removes or moves one. Text blocks change words only (see
 * [applyBlockEdit]); a button's label changes and its target is shown locked;
 * images and shapes the phone does not model are shown locked. The preview is
 * the server's own render, in a WebView. Save sends [visualTemplateToSave],
 * which writes back every field the operator did not change exactly as loaded.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun VisualTemplateEditorScreen(
    template: TemplateRepository.EmailTemplate,
    categories: List<String>,
    saving: Boolean,
    saveError: String?,
    onDismissError: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (TemplateRepository.EmailTemplate) -> Unit,
    loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview>,
    previewDebounceMs: Long = PREVIEW_DEBOUNCE_MS,
) {
    val c = AuntieTheme.colors
    var draft by rememberSaveable(template.templateId, stateSaver = VisualDraftSaver) {
        mutableStateOf(VisualDraft.from(template))
    }
    val problem = visualDraftProblem(draft)

    BackHandler { onDismiss() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        DenScreenHeading(
            kicker = "The Den · Template bank",
            crumbs = listOf(DenCrumb("Template bank", onDismiss), DenCrumb("Edit template")),
            title = "Email",
            accentTail = "template",
            modifier = Modifier.fillMaxWidth(),
            trailing = {
                PrimaryButton(
                    label = "Save",
                    enabled = problem == null,
                    loading = saving,
                    onClick = { onSave(visualTemplateToSave(template, draft)) },
                    modifier = Modifier.testTag(VISUAL_SAVE_TAG),
                )
            },
        )

        saveError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Couldn't save",
                icon = Lucide.X,
                onDismiss = onDismissError,
                body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
            )
        }

        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Column {
                    AuntieFieldLabel(text = "Template key")
                    Spacer(Modifier.height(6.dp))
                    Text(template.templateId, style = AuntieTheme.typography.mono, color = c.textPrimary)
                }
                LabeledField("Display name", draft.title, placeholder = "Defaults to the template key") {
                    draft = draft.copy(title = it)
                }
                LabeledField("Subject", draft.subject, required = true) { draft = draft.copy(subject = it) }
                LabeledField("Headline", draft.headline, required = true) { draft = draft.copy(headline = it) }

                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AuntieFieldLabel(text = "Body")
                    draft.blocks.forEachIndexed { index, block ->
                        key(index) {
                            when (block) {
                                is EmailBlock.TextBlock -> EmailTextBlockField(block, index) { updated ->
                                    draft = draft.copy(blocks = draft.blocks.toMutableList().also { it[index] = updated })
                                }
                                is EmailBlock.ImageBlock -> EmailImageBlockView(block, index)
                                is EmailBlock.LockedBlock -> EmailLockedBlockView(block)
                            }
                        }
                    }
                }

                LabeledField("Internal description", draft.description, singleLine = false) {
                    draft = draft.copy(description = it)
                }
                Column {
                    LabeledField("Category", draft.category, placeholder = "Booking") { draft = draft.copy(category = it) }
                    if (categories.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            categories.forEach { cat ->
                                AuntieChip(
                                    label = cat,
                                    selected = draft.category.equals(cat, ignoreCase = true),
                                    onClick = { draft = draft.copy(category = cat) },
                                )
                            }
                        }
                    }
                }
                Column {
                    AuntieFieldLabel(text = "Tags")
                    Spacer(Modifier.height(6.dp))
                    TagAssignField(
                        value = draft.tags,
                        vocab = emptyList(),
                        onChange = { draft = draft.copy(tags = it) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                problem?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
            }
        }

        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieFieldLabel(text = "Preview")
                EmailPreviewPanel(draft.previewRequest(template.templateId), loadPreview, previewDebounceMs)
            }
        }
    }
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    placeholder: String = "",
    required: Boolean = false,
    singleLine: Boolean = true,
    onChange: (String) -> Unit,
) {
    Column {
        AuntieFieldLabel(text = label, required = required)
        Spacer(Modifier.height(6.dp))
        AuntieField(
            value = value,
            onValueChange = onChange,
            placeholder = placeholder,
            singleLine = singleLine,
            minLines = if (singleLine) 1 else 2,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * One text block. The field holds the block's plain text; bold, italic, links
 * and merge fields are drawn by a [VisualTransformation] over the block model,
 * so the styling can never drift from what Save serializes.
 */
@Composable
private fun EmailTextBlockField(
    block: EmailBlock.TextBlock,
    index: Int,
    onChange: (EmailBlock.TextBlock) -> Unit,
) {
    val c = AuntieTheme.colors
    val plain = block.plainText()
    var field by remember { mutableStateOf(TextFieldValue(plain, TextRange(plain.length))) }
    var refusal by remember { mutableStateOf<String?>(null) }
    // After a restore or an outside change, the model wins over the field.
    val shown = if (field.text == plain) field else TextFieldValue(plain, TextRange(plain.length))
    val styled = remember(block, c.accent) { styleEmailInlines(block.inlines, c.accent) }
    val isButton = block.kind == EmailBlockKind.BUTTON
    val textStyle = when (block.kind) {
        EmailBlockKind.HEADING2 -> AuntieTheme.typography.titleLarge
        EmailBlockKind.HEADING3 -> AuntieTheme.typography.titleMedium
        EmailBlockKind.BUTTON -> AuntieTheme.typography.labelLarge
        else -> AuntieTheme.typography.bodyMedium
    }.copy(color = if (isButton) c.background else c.textPrimary)

    val input: @Composable () -> Unit = {
        BasicTextField(
            value = shown,
            onValueChange = { next ->
                if (next.text == plain) {
                    field = next
                    return@BasicTextField
                }
                when (val r = applyBlockEdit(block, next.text)) {
                    is BlockEdit.Accepted -> {
                        refusal = null
                        val text = r.block.plainText()
                        field = if (text == next.text) next else TextFieldValue(text, TextRange(r.cursor))
                        onChange(r.block)
                    }
                    is BlockEdit.Rejected -> {
                        refusal = r.reason
                        field = shown
                    }
                }
            },
            textStyle = textStyle,
            cursorBrush = SolidColor(c.accent),
            visualTransformation = VisualTransformation { TransformedText(styled, OffsetMapping.Identity) },
            modifier = Modifier.fillMaxWidth().testTag(blockTag(index)),
        )
    }
    val boxed = Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp))
        .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(10.dp))
        .padding(horizontal = 12.dp, vertical = 10.dp)

    Column(Modifier.fillMaxWidth()) {
        when (block.kind) {
            EmailBlockKind.BULLET_ITEM, EmailBlockKind.NUMBERED_ITEM -> Row(boxed) {
                Text(
                    if (block.kind == EmailBlockKind.BULLET_ITEM) "•" else "${block.number}.",
                    style = textStyle.copy(color = c.textDim),
                    modifier = Modifier.width(24.dp),
                )
                Box(Modifier.weight(1f)) { input() }
            }
            EmailBlockKind.CALLOUT -> Row(boxed.height(IntrinsicSize.Min)) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent))
                Box(Modifier.padding(start = 12.dp).weight(1f)) { input() }
            }
            EmailBlockKind.BUTTON -> Column {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(c.kinfolkOrange)
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                ) { input() }
                buttonTarget(block)?.let { target ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                        Icon(Lucide.Lock, contentDescription = "Locked", tint = c.textFaint, modifier = Modifier.size(12.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(target, style = AuntieTheme.typography.mono, color = c.textDim)
                    }
                }
            }
            else -> Box(boxed) { input() }
        }
        refusal?.let {
            Text(it, style = AuntieTheme.typography.bodySmall, color = c.error, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun EmailImageBlockView(block: EmailBlock.ImageBlock, index: Int) {
    val c = AuntieTheme.colors
    Column(Modifier.fillMaxWidth().testTag(imageTag(index))) {
        AsyncImage(
            model = block.src,
            contentDescription = block.alt.ifBlank { "Email image" },
            contentScale = ContentScale.FillWidth,
            modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp).clip(RoundedCornerShape(8.dp)),
        )
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            Icon(Lucide.Lock, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(6.dp))
            Text("Image, changed on the web admin", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        }
    }
}

@Composable
private fun EmailLockedBlockView(block: EmailBlock.LockedBlock) {
    val c = AuntieTheme.colors
    val text = htmlToReadableText(block.raw)
    if (text.isBlank()) return
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
        Icon(Lucide.Lock, contentDescription = null, tint = c.textFaint, modifier = Modifier.padding(top = 3.dp).size(12.dp))
        Spacer(Modifier.width(8.dp))
        Column {
            Text(text, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            Text("Edit this part on the web admin.", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        }
    }
}

/** Bold, italic, links and merge fields, over exactly the block's plain text. */
internal fun styleEmailInlines(inlines: List<EmailInline>, accent: Color): AnnotatedString {
    val plain = inlines.joinToString("") { inlinePlain(it) }
    return buildAnnotatedString {
        fun walk(nodes: List<EmailInline>, bold: Boolean, italic: Boolean, link: Boolean) {
            for (n in nodes) {
                if (n is EmailInline.Element) {
                    walk(n.children, bold || n.name == "strong", italic || n.name == "em", link || n.name == "a")
                    continue
                }
                val style = SpanStyle(
                    fontWeight = if (bold) FontWeight.Bold else null,
                    fontStyle = if (italic) FontStyle.Italic else null,
                    color = if (link) accent else Color.Unspecified,
                    textDecoration = if (link) TextDecoration.Underline else null,
                )
                withStyle(style) { append(inlinePlain(n).replace(EMAIL_IMAGE_CHAR, IMAGE_GLYPH)) }
            }
        }
        walk(inlines, bold = false, italic = false, link = false)
        EMAIL_MERGE_TOKEN.findAll(plain).forEach {
            addStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, background = accent.copy(alpha = 0.12f)),
                it.range.first,
                it.range.last + 1,
            )
        }
    }
}

/**
 * The server's render of [request], in a WebView. A loading cue shows for
 * every request in flight, over the last render if there is one. A newer
 * request cancels the older one, and an answer that arrives for a cancelled
 * request is dropped, so the page never shows an older draft than the last
 * one asked for.
 */
@Composable
internal fun EmailPreviewPanel(
    request: EmailPreviewRequest,
    loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview>,
    debounceMs: Long = PREVIEW_DEBOUNCE_MS,
) {
    val c = AuntieTheme.colors
    var html by remember { mutableStateOf<String?>(null) }
    var issues by remember { mutableStateOf<List<String>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(request, attempt) {
        loading = true
        if (debounceMs > 0) delay(debounceMs)
        val result = loadPreview(request)
        if (!isActive) return@LaunchedEffect
        result
            .onSuccess {
                html = it.html
                issues = it.issues
                error = null
            }
            .onFailure { error = it.message ?: "The preview could not be loaded." }
        loading = false
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (loading) LoadingHint(PREVIEW_LOADING_TEXT)
        error?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Preview unavailable",
                icon = Lucide.X,
                trailing = { GhostButton(label = "Retry", onClick = { attempt++ }) },
                body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
            )
        }
        if (issues.isNotEmpty()) {
            AuntieBanner(
                tone = AuntieBannerTone.Warning,
                title = "Check before saving",
                body = {
                    Column { issues.forEach { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) } }
                },
            )
        }
        html?.let { EmailHtmlView(it, Modifier.fillMaxWidth().height(520.dp)) }
    }
}

@Composable
private fun EmailHtmlView(html: String, modifier: Modifier) {
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                webViewClient = object : WebViewClient() {
                    // The preview is a picture of the email: a tapped link must not navigate it.
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                }
            }
        },
        update = { view ->
            if (view.tag != html) {
                view.tag = html
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }
        },
        modifier = modifier.testTag(PREVIEW_WEB_TAG).semantics { contentDescription = "Email preview" },
    )
}
```

Colour tokens used here (`textDim`, `textFaint`, `textPrimary`, `accent`, `border`, `error`, `background`, `kinfolkOrange`) and `AuntieTheme.dims.borderHairline` all exist today; check `ui/theme/AuntieColors.kt` if the compiler disagrees rather than inventing a token.

- [ ] **Step 4: Run** `--tests '*VisualTemplateEditorUiTest*'`. Expected: PASS, `tests="9" failures="0"`. If `lastLoadDataWithBaseURL` has a different name in Robolectric 4.17's `ShadowWebView`, use the shadow's getter for the last `loadDataWithBaseURL` call and keep the assertion on the HTML string.

- [ ] **Step 5: Commit.** Message: `Android visual template editor: word edits, locked targets, server preview (#953)`.

---

### Task 7: Route visual templates in the Template Bank

**Files:**
- Modify: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt`
- Test: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/TemplateBankVisualTest.kt`

**Interfaces:**
- Consumes: `usesVisualEditor`, `VisualTemplateEditorScreen`, `EmailPreviewPanel`, `VisualDraft.previewRequest`, `htmlToReadableText`, `TemplateRepository.previewEmailTemplate`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.awaitCancellation
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #953 PR 5: the bank sends visual templates to the visual editor and keeps it open across rotation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class TemplateBankVisualTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val visual = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset your password", body = "", html = null,
        title = "Password reset", description = null, tags = emptyList(), category = null,
        format = "visual", headline = "Choose a new password",
        content = "<p>Hi <strong>{{displayName}}</strong>, tap below.</p>",
    )

    private fun repo(templates: List<TemplateRepository.EmailTemplate>): TemplateRepository {
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returns Result.success(templates)
        coEvery { r.listCategories() } returns Result.success(emptyList())
        coEvery { r.previewEmailTemplate(any(), any(), any(), any()) } returns
            Result.success(TemplateRepository.EmailPreview("s", "<p>x</p>", "x", emptyList()))
        coEvery { r.saveTemplate(any(), any()) } returns Result.success(visual.templateId)
        return r
    }

    @Test
    fun `a visual template opens the visual editor and saves the visual shape`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 1) {
            r.saveTemplate(
                match {
                    it.format == "visual" && it.headline == "Choose a new password" &&
                        it.content == "<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>" &&
                        it.description == null && it.category == null
                },
                false,
            )
        }
    }

    // Review Focus 4
    @Test
    fun `rotating mid-edit reopens the editor with the edit`() {
        val r = repo(listOf(visual))
        val tester = StateRestorationTester(composeRule)
        tester.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
    }

    @Test
    fun `an old template with a custom design still opens subject-only`() {
        val old = visual.copy(format = null, headline = null, content = null, body = "Body", html = "<div>custom</div>")
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = repo(listOf(old))) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithText("This email has a custom design. Edit its body on the web admin.").assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
    }

    @Test
    fun `a second tap while saving does not save twice`() {
        val r = repo(listOf(visual))
        coEvery { r.saveTemplate(any(), any()) } coAnswers { awaitCancellation() }
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 1) { r.saveTemplate(any(), any()) }
    }

    @Test
    fun `the viewer shows a visual template's headline and body`() {
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = repo(listOf(visual))) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Password reset").performClick()
        composeRule.onNodeWithText("Choose a new password").assertExists()
        composeRule.onNodeWithText("Hi {{displayName}}, tap below.").assertExists()
    }
}
```

- [ ] **Step 2: Run to verify it fails.** `--tests '*TemplateBankVisualTest*'`. Expected: the visual cases FAIL (the bank still opens `TemplateEditorScreen`, which is READ_ONLY for visual after PR 1, so there is no `email-block-0`), and the rotation case fails because `editing` is plain `remember`.

- [ ] **Step 3: Implement.** In `TemplateBankBody`:

  1. Add `import androidx.compose.runtime.saveable.rememberSaveable`. Next to `saveError`:

```kotlin
    // #953: a save in flight. The Save button shows a spinner and cannot fire twice.
    var saving by remember { mutableStateOf(false) }
    // #953: the template open in an editor, by key, so rotation (which recreates
    // the Activity) reopens it once the list has loaded again.
    var editingId by rememberSaveable { mutableStateOf<String?>(null) }
```

  2. In `reload()`, replace `.onSuccess { templates = it; error = null }` with:

```kotlin
            .onSuccess { list ->
                templates = list
                error = null
                if (editing == null) editingId?.let { id -> editing = list.firstOrNull { it.templateId == id } }
            }
```

  3. Replace the whole `editing?.let { current -> … return }` block with:

```kotlin
    editing?.let { current ->
        if (usesVisualEditor(current, creating)) {
            VisualTemplateEditorScreen(
                template = current,
                categories = categories,
                saving = saving,
                saveError = saveError,
                onDismissError = { saveError = null },
                onDismiss = { editing = null; editingId = null; saveError = null },
                onSave = { updated ->
                    saving = true
                    scope.launch {
                        templateRepo.saveTemplate(updated)
                            .onSuccess { saving = false; editing = null; editingId = null; saveError = null; reload() }
                            .onFailure { saving = false; saveError = it.message ?: "Save failed." }
                    }
                },
                loadPreview = { req ->
                    templateRepo.previewEmailTemplate(req.subject, req.headline, req.content, req.catalogKey)
                },
            )
            return
        }
        TemplateEditorScreen(
            template = current,
            creating = creating,
            categories = categories,
            existingKeys = templates.map { it.templateId },
            saveError = saveError,
            onDismissError = { saveError = null },
            onDismiss = { editing = null; editingId = null; creating = false; saveError = null },
            onSave = { updated ->
                scope.launch {
                    // expectNew on create: the collision check above only sees
                    // the templates this screen loaded, and the server sees them
                    // all. Issue #468.
                    templateRepo.saveTemplate(updated, expectNew = creating)
                        .onSuccess { editing = null; editingId = null; creating = false; saveError = null; reload() }
                        .onFailure { saveError = it.message ?: "Save failed." }
                }
            },
        )
        return
    }
```

  4. Where a card's Edit sets `editing`, record the key: `onEdit = { creating = false; editing = tpl; editingId = tpl.templateId },`. In the viewer's `onEdit`: `viewing = null; creating = false; editing = current; editingId = current.templateId`. Leave "New template" alone (`editingId` stays null, so a half-typed new template is not reopened after rotation, the same as today).

  5. Pass the preview to the viewer: the `TemplateViewOverlay(...)` call gains `loadPreview = { req -> templateRepo.previewEmailTemplate(req.subject, req.headline, req.content, req.catalogKey) },`. In `TemplateViewOverlay`, add the parameter `loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview>`, then replace the `Body` and `HTML` read fields with:

```kotlin
        val visual = usesVisualEditor(template, creating = false)
        if (visual) {
            ReadField("Headline", template.headline.orEmpty())
            ReadField("Body", htmlToReadableText(template.content.orEmpty()).ifBlank { "(empty)" })
        } else {
            ReadField("Body", template.body.ifBlank { "(empty)" })
            template.html?.takeIf { it.isNotBlank() }?.let { ReadField("HTML", it, mono = true) }
        }
```

  and, inside the "Inbox preview" column, draw `EmailPreviewPanel(VisualDraft.from(template).previewRequest(template.templateId), loadPreview)` when `visual`, and the existing `MergePreview(...)` otherwise.

- [ ] **Step 4: Run** `--tests '*TemplateBankVisualTest*' --tests '*TemplateEditModeTest*' --tests '*TemplateBankStatesTest*'`. Expected: PASS; `TemplateBankVisualTest` `tests="5"`, and PR 1's `TemplateEditModeTest` keeps its count (its `visual → READ_ONLY` assertion still holds: `templateEditMode` is unchanged, the bank simply routes visual docs before reaching it). If the rotation case reopens the editor but loses the edit, the editor's `rememberSaveable` key moved between the two compositions: hoist `draft` into `TemplateBankBody` as `rememberSaveable(editingId, stateSaver = VisualDraftSaver)` and pass it down with an `onDraftChange`, then re-run.

- [ ] **Step 5: Commit.** Message: `Template Bank opens visual templates in the visual editor (#953)`, body noting that rotation now reopens whichever template was being edited.

---

### Task 7a: Remove "New template" from the Android admin

**Files:**
- Modify: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt` (the button around lines 358-366, the empty-state text at line 191, the doc comment at line 209)
- Modify: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/TemplateBankStatesTest.kt:52`

- [ ] **Step 1: Update the test first.** In `TemplateBankStatesTest.kt`, change the expected empty-state text to `"No templates yet. Create one on the web admin."`. If a test drives the New template button, replace it with an assertion that no node has the text `"New template"`, using that file's existing test style.
- [ ] **Step 2: Run it and see it fail**: `GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*TemplateBankStatesTest*'`.
- [ ] **Step 3: Implement.**
  - Delete the "New template" `PrimaryButton` block, including the comment above it.
  - Change the empty-state string to `"No templates yet. Create one on the web admin."`.
  - Change the doc comment at line 209 to say templates are created on the web admin.
  - Keep the editor's `creating` parameter: rotation restore and existing callers still pass `false`. Deleting it is out of scope.
- [ ] **Step 4: Run** the same command. Expected: PASS. Read the XML for counts.
- [ ] **Step 5: Commit**: "Android admin creates no templates; new ones start on the web editor (#953)".

---

### Task 8: Full verification and the PR

- [ ] **Step 1: Whole Android suite.**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android/auntieos-admin/android && GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest
```
Then open the results, not the exit code:
```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android/auntieos-admin/android && grep -h "<testsuite" app/build/test-results/testDebugUnitTest/TEST-*.xml | grep -o 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' | awk -F'"' '{t+=$2;s+=$4;f+=$6;e+=$8} END {print "tests",t,"skipped",s,"failures",f,"errors",e}'
```
Expected: failures 0, errors 0, and the six new classes present with 6, 14, 7, 11, 9 and 5 tests (52). The Task 0 classes keep their counts.

- [ ] **Step 2: Debug build compiles.** `GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:assembleDebug`. Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Functions suite** (Task 1 touched it): `cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android/mytribe/functions && npm test`. Read the summary line and confirm the number of files run is at least the count before the change.

- [ ] **Step 4: Push** (its own Bash call):

```bash
git -C /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android push -u origin feat/email-editor-android
```

- [ ] **Step 5: Write the PR body** with the Write tool at `<scratchpad>/email-editor-pr5/pr-body.md`, then read it back. Content:

```markdown
## What changed

The Android admin now edits visual-format email templates (#953, PR 5 of 5).

- Subject and headline are plain fields.
- The body is shown as its blocks: paragraphs, headings, list items, callouts, buttons and images. The operator changes words. Bold, italic and links stay, a button's label changes and its target is locked, and images are shown and locked. Blocks can't be added, removed or moved.
- The preview is the server's own render (`previewEmailTemplate`) in a WebView, with a loading cue, an error state and Retry.
- Save sends the visual shape (`format`, `headline`, `content`, no `body` or `html`). Title, description, category and tags go back exactly as loaded unless their control changed, and an untouched body goes back byte for byte.
- `listTemplates` now returns `format`, `headline` and `content`. Without it, the apps never learned a template was visual.
- Rotating the phone mid-edit keeps the editor open and the edit.

## Not using the rich-text library the spec named

`com.mohamedrejeb.richeditor` 1.2.0 writes `<b>`/`<i>`, adds `target="_blank"`, drops `class` and `alt`, and splits paragraphs at `<br>`, so a save from the phone would have changed the email. The body is parsed by a small in-repo model instead; tests prove `serialize(parse(x)) == x` for every sanitizer output and for 500 random strings.

## Old-format templates

Unchanged from PR 1: full markdown editing, or subject-only when the HTML is a custom design.

## Operator steps

`listTemplates` is a callable, so the change reaches the apps with the next release.

## Tests

<paste the per-class counts from Step 1 and the functions summary from Step 3>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 6: Open the PR** (its own Bash call):

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/email-editor-android && gh pr create --base main --head feat/email-editor-android --title "Android admin edits visual email templates (#953)" --body-file <scratchpad>/email-editor-pr5/pr-body.md
```

- [ ] **Step 7: Re-check before reporting.** `gh pr view --json number,url,state,statusCheckRollup` and report the URL and the CI state as it is now.

---

## Self-review against the spec and PR 2

| Spec / PR 2 item | Where |
|---|---|
| Subject and Headline native fields | Task 6 `LabeledField` |
| Body parsed into paragraph, heading, list item, button, image blocks (plus Callout from PR 2) | Task 2 |
| Text blocks keep bold, italic, links; no formatting added or removed | Tasks 3 and 6 |
| Button label editable, target locked | Task 3 `aButtonLabelChangesAndItsTargetDoesNot`, Task 6 |
| Image blocks shown and locked (Coil) | Task 6 |
| No add, remove or reorder | Task 3 fuzz, Task 6 block count |
| Preview in a WebView with a loading cue | Task 6 |
| Save rebuilds `content` and goes through `saveTemplate` visual shape | Tasks 4 and 5 |
| Old-format stays as PR 1 left it | Task 7 `an old template with a custom design still opens subject-only` |
| Android testing: lossless parse, word edit keeps formatting, blocks fixed, old path subject-only | Tasks 2, 3, 6, 7 |
| PR 2 `saveTemplate` visual args, no body/html | Task 4 payload tests |
| PR 2 `previewEmailTemplate` request and response | Task 4 |
| Allowed elements incl. `blockquote`, tokens only in text or whole href | Task 2 corpus, Task 3 token rules |
