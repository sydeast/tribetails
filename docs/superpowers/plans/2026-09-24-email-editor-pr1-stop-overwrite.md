# Visual Email Editor, PR 1: Stop the Overwrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saving an email template from the Android admin or the desktop admin never replaces HTML those apps did not write, and never touches a visual-format template.

**Architecture:** Each Kotlin app gets one pure function, `templateEditMode(template)`, that decides between three modes: FULL (today's markdown editing), SUBJECT_ONLY (hand-authored HTML: the body and html are shown, not editable, and saved back unchanged), and READ_ONLY (a visual template: nothing is saved from this device). The editor screen reads that mode. The model gains a `format` field, decoded from the document.

**Tech Stack:** Kotlin, Jetpack Compose (Android, `auntieos-admin/android`), Compose Multiplatform (desktop, `auntieos-admin/web/composeApp`), JUnit.

**Spec:** `docs/superpowers/specs/2026-09-24-visual-email-editor-design.md` (Build order, item 1)

**Depends on:** nothing. It must merge before PR 2 is released. The `format` field reaches these apps through `listTemplates` once PR 2 Task 4a lands. Until then it decodes as null, and only the hand-authored rule applies.

## Global Constraints

- "Hand-authored" means `html` is not blank and `html != markdownToHtml(body)`. Markdown-derived HTML is what these apps wrote themselves, so editing it stays allowed.
- A visual template is `format == "visual"`. These apps must not save it at all until PR 5 (Android). Desktop stays read-only until desktop work resumes.
- Save in SUBJECT_ONLY mode sends `body` and `html` exactly as loaded. Title, description, tags and category keep their existing behavior.
- Copy: note text sits under the body area, never as a subtitle under a panel title. Wording:
  - Hand-authored: "This email has a custom design. Edit its body on the web admin."
  - Visual: "Edit this template on the web admin."
- Gradle: `GRADLE_USER_HOME=$HOME/.gradle-local`. Android needs `auntieos-admin/android/local.properties`, copied from the main checkout.
- Commits: write the message file with the Write tool and run `git commit -F`. It ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A template whose `html` is markdown-derived but whose body has trailing whitespace must still count as FULL. The comparison uses the same `markdownToHtml(body)` the save uses. Pinned in Task 1.
2. A template with `html = ""` (empty string, not null) counts as not hand-authored. Pinned in Task 1.
3. A SUBJECT_ONLY save must send the original html byte for byte, including `{{link}}` with single quotes. Pinned in Task 1.
4. A new template (create mode) is always FULL. Pinned in Task 1.
5. A document with an unknown `format` value (such as `"mjml"`) is treated as READ_ONLY, never FULL. Pinned in Task 1.

---

## File Structure

- Modify `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/TemplateRepository.kt`: add `format` to `EmailTemplate` and decode it.
- Modify `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/MarkdownTemplate.kt`: add `TemplateEditMode`, `htmlIsHandAuthored` and `templateEditMode`.
- Modify `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt` (`TemplateEditorScreen`, around lines 865-935): read the mode.
- Test `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/TemplateEditModeTest.kt`.
- The same four changes in `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/`, under `data/TemplateService.kt`, `screens/admin/MarkdownTemplate.kt` and `screens/admin/TemplateBankScreen.kt` (around lines 685-735). Test in `auntieos-admin/web/composeApp/src/commonTest/.../screens/admin/TemplateEditModeTest.kt` (create the directory if commonTest has none for admin; check `git ls-files auntieos-admin/web/composeApp/src | grep -i test | head` for the right source set).

---

### Task 1: Android edit mode

**Files:** the Android files listed in File Structure.

**Interfaces:**
- Produces:
  - `enum class TemplateEditMode { FULL, SUBJECT_ONLY, READ_ONLY }`
  - `fun htmlIsHandAuthored(body: String, html: String?): Boolean`
  - `fun templateEditMode(template: TemplateRepository.EmailTemplate, creating: Boolean): TemplateEditMode`
  - `EmailTemplate.format: String?`, defaulting to null

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TemplateEditModeTest {
    private fun tpl(body: String, html: String?, format: String? = null) = TemplateRepository.EmailTemplate(
        templateId = "k", subject = "S", body = body, html = html, title = "k",
        description = null, tags = emptyList(), category = null, format = format,
    )

    @Test fun markdownDerivedHtmlIsNotHandAuthored() {
        val body = "Hi **there**\n\n- one\n"
        assertFalse(htmlIsHandAuthored(body, markdownToHtml(body)))
    }

    @Test fun nullOrEmptyHtmlIsNotHandAuthored() {
        assertFalse(htmlIsHandAuthored("x", null))
        assertFalse(htmlIsHandAuthored("x", ""))
    }

    @Test fun seedStyleHtmlIsHandAuthored() {
        assertTrue(htmlIsHandAuthored("Hi", "<!DOCTYPE html><html><body><a href='{{link}}' class='button'>Go</a></body></html>"))
    }

    @Test fun modes() {
        assertEquals(TemplateEditMode.FULL, templateEditMode(tpl("b", null), creating = false))
        assertEquals(TemplateEditMode.SUBJECT_ONLY, templateEditMode(tpl("b", "<div>custom</div>"), creating = false))
        assertEquals(TemplateEditMode.READ_ONLY, templateEditMode(tpl("", null, format = "visual"), creating = false))
        assertEquals(TemplateEditMode.READ_ONLY, templateEditMode(tpl("b", null, format = "mjml"), creating = false))
        assertEquals(TemplateEditMode.FULL, templateEditMode(tpl("b", "<div>custom</div>"), creating = true))
    }

    @Test fun subjectOnlySaveKeepsBodyAndHtmlByteForByte() {
        val original = tpl("Body {{link}}", "<p><a href='{{link}}' class='button'>Go</a></p>")
        val saved = templateToSave(original, TemplateEditMode.SUBJECT_ONLY, editedSubject = "New", editedBody = "ignored")
        assertEquals("New", saved.subject)
        assertEquals(original.body, saved.body)
        assertEquals(original.html, saved.html)
    }

    @Test fun fullSaveDerivesHtmlFromTheEditedBody() {
        val saved = templateToSave(tpl("old", null), TemplateEditMode.FULL, editedSubject = "S", editedBody = "**new**")
        assertEquals("**new**", saved.body)
        assertEquals(markdownToHtml("**new**"), saved.html)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd auntieos-admin/android && GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*TemplateEditModeTest*'`
Expected: compilation FAILS, because `format`, `htmlIsHandAuthored`, `templateEditMode` and `templateToSave` are unresolved.

- [ ] **Step 3: Implement**

In `TemplateRepository.kt`, add a last constructor parameter to `EmailTemplate`: `val format: String? = null`. In the decoder around line 101, add `format = m["format"] as? String,`. The save map around line 157 is unchanged: this app never writes `format`.

Append to `MarkdownTemplate.kt`:

```kotlin
/** #953 PR 1: what this device may change on a template. */
enum class TemplateEditMode { FULL, SUBJECT_ONLY, READ_ONLY }

/**
 * True when [html] was not produced by this app's own [markdownToHtml] from
 * [body]: a seed's branded design, or HTML written on the web admin. Saving it
 * from here used to replace it with markdown output and destroy the design.
 */
fun htmlIsHandAuthored(body: String, html: String?): Boolean =
    !html.isNullOrBlank() && html != markdownToHtml(body)

fun templateEditMode(template: TemplateRepository.EmailTemplate, creating: Boolean): TemplateEditMode = when {
    creating -> TemplateEditMode.FULL
    template.format != null -> TemplateEditMode.READ_ONLY
    htmlIsHandAuthored(template.body, template.html) -> TemplateEditMode.SUBJECT_ONLY
    else -> TemplateEditMode.FULL
}

/** The template a Save sends, given the mode. READ_ONLY never reaches here: the screen hides Save. */
fun templateToSave(
    original: TemplateRepository.EmailTemplate,
    mode: TemplateEditMode,
    editedSubject: String,
    editedBody: String,
): TemplateRepository.EmailTemplate = when (mode) {
    TemplateEditMode.SUBJECT_ONLY -> original.copy(subject = editedSubject)
    else -> original.copy(subject = editedSubject, body = editedBody, html = markdownToHtml(editedBody).ifBlank { null })
}
```

Add `import com.tribetails.auntieos.data.repository.TemplateRepository` to the top of `MarkdownTemplate.kt`.

- [ ] **Step 4: Wire the screen.** In `TemplateEditorScreen`:

```kotlin
    val mode = remember(template.templateId, creating) { templateEditMode(template, creating) }
    val canSave = when (mode) {
        TemplateEditMode.READ_ONLY -> false
        TemplateEditMode.SUBJECT_ONLY -> subject.isNotBlank()
        TemplateEditMode.FULL -> subject.isNotBlank() && bodyValue.text.isNotBlank() && keyError == null
    }
```

In the Save `onClick`, replace the inline `template.copy(...)` with:

```kotlin
                        val base = templateToSave(template, mode, editedSubject = subject, editedBody = bodyValue.text)
                        onSave(
                            base.copy(
                                templateId = templateId.trim(),
                                title = title.ifBlank { templateId.trim() },
                                category = category.ifBlank { null },
                                description = description.ifBlank { null },
                                tags = tags,
                            ),
                        )
```

Hide the Save button when `mode == TemplateEditMode.READ_ONLY`: wrap the `trailing` PrimaryButton in `if (mode != TemplateEditMode.READ_ONLY)`. Where the markdown body field and its toolbar render, branch on the mode:

```kotlin
        when (mode) {
            TemplateEditMode.FULL -> { /* existing markdown toolbar + body field, unchanged */ }
            TemplateEditMode.SUBJECT_ONLY -> {
                Text(template.body, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
                Text("This email has a custom design. Edit its body on the web admin.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            }
            TemplateEditMode.READ_ONLY -> {
                Text("Edit this template on the web admin.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            }
        }
```

In READ_ONLY mode the subject field is `enabled = false`. Use the colour token names this file already uses (check `AuntieTheme.colors` members nearby; don't invent new ones).

- [ ] **Step 5: Run the tests and the existing template tests**

Run: `GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :app:testDebugUnitTest --tests '*TemplateEditModeTest*' --tests '*MarkdownTemplateTest*' --tests '*TemplateBankStatesTest*' --tests '*TemplateRepository*'`
Expected: BUILD SUCCESSFUL. Read `app/build/test-results/testDebugUnitTest/TEST-*TemplateEditModeTest.xml` and confirm `tests="6" failures="0"`.

- [ ] **Step 6: Commit**: "Android admin never overwrites template HTML it did not write (#953)".

---

### Task 2: Desktop edit mode

**Files:** the desktop files listed in File Structure.

**Interfaces:** the same four names as Task 1, with `TemplateService.EmailTemplate` in place of `TemplateRepository.EmailTemplate`.

- [ ] **Step 1: Write the failing test**: the same six tests as Task 1, with the package `com.tribetails.auntieos.web.screens.admin`, `TemplateService.EmailTemplate` as the model, and `kotlin.test` assertions (`assertEquals`, `assertTrue`, `assertFalse` from `kotlin.test`) if commonTest uses kotlin.test. Check an existing commonTest file for the convention.

- [ ] **Step 2: Run to verify it fails**: `cd auntieos-admin/web && GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :composeApp:jvmTest --tests '*TemplateEditModeTest*'`. Expected: compilation fails.

- [ ] **Step 3: Implement.** Add `val format: String? = null` to `TemplateService.EmailTemplate`, and `format = o["format"]?.jsonPrimitive?.contentOrNull,` in the decoder (around line 191). Put the same `TemplateEditMode`, `htmlIsHandAuthored`, `templateEditMode` and `templateToSave` code in the desktop `MarkdownTemplate.kt`, typed on `TemplateService.EmailTemplate`. Wire `TemplateEditorScreen` (around lines 685-735) the same way: `canSave` by mode, the footer Save hidden in READ_ONLY, the body branch with the same two notes, and the subject disabled in READ_ONLY.

- [ ] **Step 4: Run**: `GRADLE_USER_HOME=$HOME/.gradle-local ./gradlew :composeApp:jvmTest --tests '*TemplateEditModeTest*' --tests '*MarkdownTemplate*'`. Expected: PASS. Read the test-results XML for counts.

- [ ] **Step 5: Commit**: "Desktop admin never overwrites template HTML it did not write (#953)".

---

### Task 3: PR

- [ ] Push in its own Bash call, then `gh pr create` in another. Title: "Android and desktop admin stop overwriting template designs (#953)". Body:
  - the defect;
  - the three modes;
  - that it protects the reset template the moment the operator imports it;
  - test counts per app.

  End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The PR can merge on its own.
