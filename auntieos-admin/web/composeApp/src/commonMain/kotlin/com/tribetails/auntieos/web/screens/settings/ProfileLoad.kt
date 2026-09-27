package com.tribetails.auntieos.web.screens.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.ui.components.ReloadableRead
import com.tribetails.auntieos.web.ui.components.settlesRetry

/**
 * #897: where the operator's `users/{uid}` read stands, as the profile editors see it.
 *
 * The screens used to read `(result as? Data)?.value`, which folds "still loading",
 * "the read failed" and "no document yet" into one null. Every form field was
 * keyed on that null, so a failed read (or one failed poll after a good one)
 * reset the fields to blank, and Save wrote the blanks.
 *
 * - [Loading]: no answer yet. Save is off.
 * - [Failed]: the first read failed. Save is off, the error shows with a retry.
 * - [Loaded]: the read answered. [Loaded.profile] null means the document does
 *   not exist, which is the one case where a save creates it.
 */
internal sealed interface ProfileLoad {
    data object Loading : ProfileLoad
    data class Failed(val message: String) : ProfileLoad
    data class Loaded(val profile: UserProfile?) : ProfileLoad
}

/** The profile a save diffs against, or null when there is nothing to diff against yet. */
internal val ProfileLoad.baseline: UserProfile?
    get() = (this as? ProfileLoad.Loaded)?.profile

internal val ProfileLoad.isLoaded: Boolean
    get() = this is ProfileLoad.Loaded

/**
 * Pure step from the previous state and the stream's latest answer.
 *
 * Once a read has answered, a later failed or pending poll keeps that answer.
 * The desktop re-reads every few seconds; one dropped poll must not blank the
 * form under the operator's hands, and the kept profile is still the right thing
 * to diff a save against.
 */
internal fun nextProfileLoad(prev: ProfileLoad, result: FirestoreResult<UserProfile?>): ProfileLoad =
    when (result) {
        is FirestoreResult.Data -> ProfileLoad.Loaded(result.value)
        is FirestoreResult.Error -> if (prev is ProfileLoad.Loaded) prev else ProfileLoad.Failed(result.message)
        FirestoreResult.Loading -> if (prev is ProfileLoad.Loaded) prev else ProfileLoad.Loading
    }

/**
 * A save this screen made, laid over the stream until the stream catches up.
 * [readBefore] is the profile the stream held when the save went out.
 */
internal data class SavedProfile(val readBefore: UserProfile?, val saved: UserProfile)

/**
 * Pure: the load a screen should diff its NEXT save against. Right after a save
 * the stream still holds the old read for up to one poll, and a second save
 * diffed against that old read would miss a field the first save changed
 * (theme DARK then back to LIGHT would write nothing). Until the stream moves
 * off the read the save was built from, the saved profile is the baseline.
 */
internal fun effectiveProfileLoad(stream: ProfileLoad, pending: SavedProfile?): ProfileLoad =
    if (pending != null && stream is ProfileLoad.Loaded && stream.profile == pending.readBefore) {
        ProfileLoad.Loaded(pending.saved)
    } else {
        stream
    }

/**
 * A profile load state, the retry that re-reads it now, and [saved], which a
 * caller invokes after a successful write so its next save diffs against what
 * it just wrote.
 */
internal class ProfileLoadHandle(
    val load: ProfileLoad,
    val retry: () -> Unit,
    /** True from a Retry press until the fresh read answers (the banner's spinner). */
    val retrying: Boolean,
    val saved: (UserProfile) -> Unit,
)

/**
 * Collects [FirestoreClient.userProfileStream] for [uid] through [nextProfileLoad].
 * Retry starts a fresh read at once (the stream also retries on its own poll).
 */
@Composable
internal fun rememberProfileLoad(client: FirestoreClient, uid: String): ProfileLoadHandle {
    val reload = remember(uid) { ReloadableRead() }
    val result by remember(uid, reload.generation) { client.userProfileStream(uid).settlesRetry(reload) }
        .collectAsState(initial = FirestoreResult.Loading)
    // Plain holder, not state: the reducer runs during composition and must not
    // write snapshot state there. It only needs the previous answer.
    val holder = remember(uid) { arrayOf<ProfileLoad>(ProfileLoad.Loading) }
    val streamLoad = remember(result) { nextProfileLoad(holder[0], result).also { holder[0] = it } }
    var pending by remember(uid) { mutableStateOf<SavedProfile?>(null) }
    // Once the stream has moved past the read a save was built from, drop the overlay.
    val streamProfile = streamLoad.baseline
    LaunchedEffect(streamProfile) {
        val p = pending
        if (p != null && streamLoad is ProfileLoad.Loaded && streamProfile != p.readBefore) pending = null
    }
    val load = effectiveProfileLoad(streamLoad, pending)
    return ProfileLoadHandle(
        load = load,
        retry = reload::retry,
        retrying = reload.retrying,
        saved = { profile -> pending = SavedProfile(readBefore = streamProfile, saved = profile) },
    )
}

/** Why a profile write was refused, for a screen that has no Save button to disable. */
internal fun profileNotReadyMessage(load: ProfileLoad, what: String): String = when (load) {
    is ProfileLoad.Failed -> "Couldn't load your profile, $what. ${load.message}"
    else -> "Still loading your profile, $what. Try again in a moment."
}

/**
 * True when the Profile form holds an edit: any of the fields it shows differs
 * from what was loaded ([loaded] null: from a blank profile).
 */
internal fun profileFormChanged(loaded: UserProfile?, edited: UserProfile): Boolean {
    val base = loaded ?: UserProfile()
    return base.displayName != edited.displayName ||
        base.firstName != edited.firstName ||
        base.lastName != edited.lastName ||
        base.phone != edited.phone ||
        base.title != edited.title ||
        base.photoUrl != edited.photoUrl ||
        base.bio != edited.bio
}
