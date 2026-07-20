package com.kinfolk.portal.firebase

/** Static config for Firebase REST clients on the JVM target. */
internal object FirebaseRestConfig {
    const val PROJECT_ID = "auntieos-ttpc"
    const val API_KEY = "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo"
    const val DATABASE_ID = "(default)"

    const val IDENTITY_TOOLKIT_BASE = "https://identitytoolkit.googleapis.com/v1"
    const val SECURE_TOKEN_BASE = "https://securetoken.googleapis.com/v1"
    const val FIRESTORE_BASE = "https://firestore.googleapis.com/v1"

    fun firestoreDocumentsRoot() =
        "$FIRESTORE_BASE/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
}
