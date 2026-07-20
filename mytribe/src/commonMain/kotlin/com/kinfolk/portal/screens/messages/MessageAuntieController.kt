package com.kinfolk.portal.screens.messages

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.kinfolk.portal.portal.ConversationMessage
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Server cap (functions/src/lib/conversations.ts MAX_MESSAGE_BODY). */
const val MAX_MESSAGE_BODY = 5000

/**
 * State holder for the Message Auntie conversation screen. Loads the household
 * thread via getMyConversation and sends via sendKinfolkMessage, then refetches
 * (no optimistic fakery: the displayed thread is always the server's truth, per
 * the fail-loud policy). Mirrors the InvoicesController pattern.
 */
class MessageAuntieController internal constructor(
    private val kinfolkId: String,
    private val portalApi: PortalApi,
    private val scope: CoroutineScope,
) {
    /** null = not loaded yet; empty list = loaded, no messages. */
    var messages by mutableStateOf<List<ConversationMessage>?>(null)
        private set

    /** Load failure only. The screen swaps the thread for a retryable empty
     *  state ONLY off this — a failed send must never blank the thread. */
    var loadError by mutableStateOf<String?>(null)
        private set

    /** Send failure only. Rendered as a dismissible inline banner above the
     *  composer while the thread stays visible; the draft is preserved because
     *  [send]'s onSent (which clears the input) never fired. */
    var sendError by mutableStateOf<String?>(null)
        private set
    var sending by mutableStateOf(false)
        private set

    /** True while an AI assist (polish/suggest) call is in flight. */
    var assisting by mutableStateOf(false)
        private set

    /** Assist failure only. Rendered as a dismissible inline banner (same
     *  pattern as [sendError]); the draft is never touched on failure. */
    var assistError by mutableStateOf<String?>(null)
        private set

    suspend fun reload() {
        try {
            messages = portalApi.getMyConversation(kinfolkId).messages
            loadError = null
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load your messages"
        }
    }

    /**
     * Sends [body] to the auntie. No-op if blank, over the cap, or a send is
     * already in flight. On success refetches the thread; [onSent] lets the
     * screen clear its input. Surfaces the server/validation error fail-loud
     * via [sendError] — never [loadError], so the thread stays on screen.
     */
    fun send(body: String, onSent: () -> Unit) {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || trimmed.length > MAX_MESSAGE_BODY || sending) return
        sending = true
        sendError = null
        scope.launch {
            try {
                portalApi.sendKinfolkMessage(body = trimmed, kinfolkId = kinfolkId)
                onSent()
                reload()
            } catch (t: Throwable) {
                sendError = t.message ?: "Your message didn't send."
            } finally {
                sending = false
            }
        }
    }

    /** Dismisses the send-failure banner (the X action). The draft stays put. */
    fun dismissSendError() {
        sendError = null
    }

    /**
     * Rewrites [draft] via the generate callable ("polish" mode) and hands the
     * polished text to [onResult] (the screen swaps it into the composer).
     * No-op if the draft isn't sendable or an assist is already in flight.
     * Surfaces failure fail-loud via [assistError]; the draft stays put
     * because [onResult] never fired.
     */
    fun polish(draft: String, onResult: (String) -> Unit) {
        if (assisting || !isSendableMessage(draft)) return
        runAssist(onResult) { portalApi.generateAssist("polish", body = draft, kinfolkId = kinfolkId) }
    }

    /**
     * Drafts a reply from the household thread via the generate callable
     * ("suggest_reply" mode — the server reads the thread itself, no body)
     * and hands the suggestion to [onResult]. No-op if an assist is already
     * in flight. Surfaces failure fail-loud via [assistError].
     */
    fun suggestReply(onResult: (String) -> Unit) {
        if (assisting) return
        runAssist(onResult) { portalApi.generateAssist("suggest_reply", kinfolkId = kinfolkId) }
    }

    /** Shared assist plumbing: re-entrancy flag + warm fail-loud error copy. */
    private fun runAssist(onResult: (String) -> Unit, call: suspend () -> String) {
        assisting = true
        assistError = null
        scope.launch {
            try {
                onResult(call())
            } catch (t: Throwable) {
                assistError = "The writing helper isn't available right now. Please try again in a moment."
            } finally {
                assisting = false
            }
        }
    }

    /** Dismisses the assist-failure banner (the X action). */
    fun dismissAssistError() {
        assistError = null
    }
}

@Composable
fun rememberMessageAuntieController(kinfolkId: String, portalApi: PortalApi): MessageAuntieController {
    val scope = rememberCoroutineScope()
    return remember(kinfolkId, portalApi) { MessageAuntieController(kinfolkId, portalApi, scope) }
}

/** True when [body] is a sendable message (non-blank, within the server cap). Pure. */
fun isSendableMessage(body: String): Boolean {
    val t = body.trim()
    return t.isNotEmpty() && t.length <= MAX_MESSAGE_BODY
}
