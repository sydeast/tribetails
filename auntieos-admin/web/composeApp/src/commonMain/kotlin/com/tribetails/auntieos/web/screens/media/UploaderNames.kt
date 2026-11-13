package com.tribetails.auntieos.web.screens.media

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.uploaderNamesFrom

/**
 * #1564: uid -> name for the Gallery's uploader line, read once from listStaff.
 *
 * Uploads store the uploader's uid, so the caption showed a uid. The server's
 * listStaff now fills a missing staff name from the sign-in account, so this map
 * names the person whenever either source has a name or email. A failed read
 * leaves the map empty and the caption as it was: the gallery never waits on it.
 */
/**
 * #1820: the staff roster itself, read once from listStaff, for a screen that
 * needs more than names (the Activity Log also needs who is the owner and who
 * an Auntie). A failed read leaves it empty.
 */
@Composable
internal fun rememberStaffRoster(client: FirestoreClient = remember { FirestoreClient() }): List<com.tribetails.auntieos.web.data.StaffMember> {
    var staff by remember { mutableStateOf<List<com.tribetails.auntieos.web.data.StaffMember>>(emptyList()) }
    LaunchedEffect(client) {
        when (val r = client.listStaff()) {
            is WriteResult.Ok -> staff = r.value
            is WriteResult.Err -> Unit
        }
    }
    return staff
}

@Composable
internal fun rememberUploaderNames(client: FirestoreClient = remember { FirestoreClient() }): Map<String, String> {
    var names by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    LaunchedEffect(client) {
        when (val r = client.listStaff()) {
            is WriteResult.Ok -> names = uploaderNamesFrom(r.value)
            is WriteResult.Err -> Unit
        }
    }
    return names
}
