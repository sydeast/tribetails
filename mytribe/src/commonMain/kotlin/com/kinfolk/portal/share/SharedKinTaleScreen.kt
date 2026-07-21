package com.kinfolk.portal.share

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Unauth viewer for a shared KinTale. Reads `getShareLink/{shareId}` and
 * renders the scrubbed payload visually matching the KinTale composer
 * mockup (gradient hero, narrative card, captured moments grid).
 *
 * Stages:
 *  1. Loading — fetch in flight
 *  2. PasscodeGate — 401 returned, prompts for passcode
 *  3. Ready — render payload
 *  4. NotFound / Expired — terminal error banner
 *
 * Guest comment thread is OUT OF SCOPE for the first cut — backend exists
 * (`addGuestKinTaleComment`) but reCAPTCHA v3 widget integration belongs
 * with the JS bridge (not yet wired). Comments shown only if payload
 * carries them; submission blocked w/ visible banner.
 *
 * Per `feedback_fail_loud_policy.md`: all failure paths show banners.
 */
@Composable
fun SharedKinTaleScreen(
    shareId: String,
    fetcher: ShareLinkFetcher = remember { makeShareLinkFetcher() },
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val scope = rememberCoroutineScope()

    var stage: ViewerStage by remember(shareId) { mutableStateOf(ViewerStage.Loading) }
    var passcode by remember { mutableStateOf("") }
    var errorBanner by remember { mutableStateOf<String?>(null) }

    fun load(pin: String?) {
        scope.launch {
            stage = ViewerStage.Loading
            errorBanner = null
            try {
                when (val r = fetcher.getShareLink(shareId, pin)) {
                    is GetShareLinkResult.Ok           -> stage = ViewerStage.Ready(r.payload)
                    GetShareLinkResult.PasscodeRequired -> stage = ViewerStage.PasscodeGate
                    GetShareLinkResult.NotFound        -> stage = ViewerStage.Terminal("This share link doesn't exist.")
                    GetShareLinkResult.Expired         -> stage = ViewerStage.Terminal("This share link has expired.")
                }
            } catch (t: Throwable) {
                stage = ViewerStage.Terminal(t.message ?: "Could not load this share.")
            }
        }
    }

    LaunchedEffect(shareId) { load(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(KinfolkGradients.tribe),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
        ) {
            when (val s = stage) {
                ViewerStage.Loading -> LoadingState()
                ViewerStage.PasscodeGate -> PasscodeGateCard(
                    passcode = passcode,
                    onChange = { passcode = it.take(8) },
                    onSubmit = { load(passcode) },
                    error = errorBanner,
                )
                is ViewerStage.Ready -> SharedPayloadView(
                    payload = s.payload,
                    shareId = shareId,
                    fetcher = fetcher,
                )
                is ViewerStage.Terminal -> TerminalBanner(s.message)
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Stages
// -----------------------------------------------------------------------------

private sealed class ViewerStage {
    object Loading : ViewerStage()
    object PasscodeGate : ViewerStage()
    data class Ready(val payload: JsonObject) : ViewerStage()
    data class Terminal(val message: String) : ViewerStage()
}

@Composable
private fun LoadingState() {
    val type = KinfolkTheme.typography
    Box(
        modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth().padding(top = 80.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Loading the tale…",
            style = type.sansBody.copy(color = Color.White.copy(alpha = 0.85f)),
        )
    }
}

@Composable
private fun PasscodeGateCard(
    passcode: String,
    onChange: (String) -> Unit,
    onSubmit: () -> Unit,
    error: String?,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
            Text(
                text = "This tale is passcode-protected.",
                style = type.heritageTitle,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
            Text(
                text = "Enter the passcode the family shared with you to read on.",
                style = type.sansBody.copy(color = c.navyMuted),
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
            KinField(
                value = passcode,
                onValueChange = onChange,
                label = "Passcode",
            )
            if (error != null) {
                Text(error, style = type.sansMeta.copy(color = c.coral))
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(KinfolkShapes.pill)
                    .background(KinfolkGradients.orangeToPink)
                    .clickable(enabled = passcode.isNotBlank(), onClick = onSubmit)
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Unlock", style = type.sansButton.copy(color = Color.White))
            }
        }
    }
}

@Composable
private fun TerminalBanner(message: String) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Couldn't load this share", style = type.heritageTitle)
            Text(message, style = type.sansBody.copy(color = c.navyMuted))
        }
    }
}

@Composable
private fun SharedPayloadView(
    payload: JsonObject,
    shareId: String,
    fetcher: ShareLinkFetcher,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val authorDisplayName = payload["authorDisplayName"]?.jsonPrimitive?.contentOrNull?.ifBlank { null } ?: "Auntie"
    val body = payload["body"]?.jsonPrimitive?.contentOrNull.orEmpty()
    val photos = runCatching {
        payload["photos"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }
    }.getOrNull().orEmpty()
    val fileCountLabel = when (photos.size) {
        0    -> null
        1    -> "1 file"
        else -> "${photos.size} files"
    }

    Column(
        modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
    ) {
        // Hero — gradient orange→pink w/ "FAMILY SHARE" eyebrow + "From {author}" title
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(KinfolkShapes.card)
                .background(KinfolkGradients.orangeToPink)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                "FAMILY SHARE",
                style = type.sansMeta.copy(color = Color.White.copy(alpha = 0.85f), fontWeight = FontWeight.SemiBold),
            )
            Text(
                "From $authorDisplayName",
                style = type.heritageTitle.copy(color = Color.White, fontWeight = FontWeight.SemiBold),
            )
        }

        // Narrative
        if (body.isNotBlank()) {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text("KinTale Narrative", style = type.heritageTitle)
                    Text(body, style = type.sansBody.copy(color = c.navy))
                }
            }
        }

        // Captured Moments
        if (photos.isNotEmpty()) {
            GlassCard(modifier = Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Captured Moments", style = type.heritageTitle, modifier = Modifier.weight(1f))
                        if (fileCountLabel != null) {
                            Text(fileCountLabel, style = type.sansMeta.copy(color = c.navyMuted))
                        }
                    }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(photos, key = { it }) { url -> PhotoTile(url) }
                    }
                }
            }
        }

        // Guest comment form — taleId surfaced in the wrapped getShareLink response.
        val taleId = payload["sourceKinTaleId"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (taleId.isNotBlank()) {
            GuestCommentForm(shareToken = shareId, taleId = taleId, fetcher = fetcher)
        }

        Spacer(Modifier.height(KinfolkSpacing.m))
        Text(
            "Shared with love. protected by reCAPTCHA",
            style = type.sansMeta.copy(color = Color.White.copy(alpha = 0.75f)),
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun GuestCommentForm(shareToken: String, taleId: String, fetcher: ShareLinkFetcher) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val scope = rememberCoroutineScope()

    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    GlassCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Leave a Note for the Family", style = type.heritageTitle)
            if (sent) {
                Text(
                    "Thanks! Your note was sent.",
                    style = type.sansBody.copy(color = c.teal, fontWeight = FontWeight.SemiBold),
                )
                return@Column
            }
            KinField(value = name,  onValueChange = { name = it.take(60) },  label = "Your name")
            KinField(value = email, onValueChange = { email = it.take(120) }, label = "Your email (kept private)")
            KinField(value = body,  onValueChange = { body = it.take(500) },  label = "Your note",
                singleLine = false)
            if (error != null) {
                Text(error!!, style = type.sansMeta.copy(color = c.coral))
            }
            KinButton(
                label = if (submitting) "Sending…" else "Send Note",
                enabled = !submitting && name.isNotBlank() && email.isNotBlank() && body.isNotBlank(),
                onClick = {
                    submitting = true
                    error = null
                    scope.launch {
                        try {
                            val token = try { executeRecaptcha("guest_comment") }
                                catch (e: RecaptchaUnavailableException) {
                                    throw ShareFetchException(
                                        "Couldn't reach reCAPTCHA. Refresh and try again.",
                                    )
                                }
                            fetcher.postGuestComment(
                                shareToken = shareToken,
                                taleId = taleId,
                                body = body.trim(),
                                guestName = name.trim(),
                                guestEmail = email.trim(),
                                recaptchaToken = token.orEmpty(),
                                parentCommentId = null,
                            )
                            sent = true
                        } catch (t: Throwable) {
                            error = t.message ?: "Couldn't send. Try again in a moment."
                        } finally {
                            submitting = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Protected by reCAPTCHA. Your email is hashed server-side, never stored in plain text.",
                style = type.sansMeta.copy(color = c.navyMuted),
            )
        }
    }
}

@Composable
private fun PhotoTile(url: String) {
    val c = KinfolkTheme.colors
    Box(
        modifier = Modifier
            .size(140.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(c.glassSurface)
            .border(1.dp, c.glassBorder, RoundedCornerShape(10.dp)),
    ) {
        AsyncImage(
            model = url,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(10.dp)),
        )
    }
}
