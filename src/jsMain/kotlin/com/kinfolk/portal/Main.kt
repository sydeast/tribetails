package com.kinfolk.portal

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.ComposeViewport
import com.kinfolk.portal.auth.initRecaptchaForMyTribe
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import dev.gitlive.firebase.Firebase
import dev.gitlive.firebase.FirebaseOptions
import dev.gitlive.firebase.initialize
import kotlinx.browser.document
import kotlinx.browser.window

@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    console.log("[MyTribe] main() entered")
    try {
        Firebase.initialize(
            context = null,
            options = FirebaseOptions(
                applicationId = "1:153396971788:web:23eab70f9dfe37447f2129",
                apiKey = "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo",
                authDomain = "auntieos-ttpc.firebaseapp.com",
                projectId = "auntieos-ttpc",
                storageBucket = "auntieos-ttpc.firebasestorage.app",
                gcmSenderId = "153396971788",
            ),
        )
        console.log("[MyTribe] Firebase initialized")
        initRecaptchaForMyTribe()
    } catch (t: Throwable) {
        console.error("[MyTribe] Firebase init failed:", t.message ?: t.toString())
        window.alert("Firebase init failed: ${t.message ?: t}")
        throw t
    }
    try {
        ComposeViewport(document.body!!) {
            KinfolkPortalAppGuarded()
        }
        // The app has mounted — drop the static boot splash from index.html.
        // (boot.js repeats this as a fallback; remove() is idempotent.)
        document.getElementById("boot-splash")?.remove()
        console.log("[MyTribe] ComposeViewport mounted")
    } catch (t: Throwable) {
        console.error("[MyTribe] ComposeViewport failed:", t.message ?: t.toString())
        window.alert("Compose mount failed: ${t.message ?: t}")
        throw t
    }
}
