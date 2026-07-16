package com.tribetails.auntieos.ui.calls

import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import com.tribetails.auntieos.R

class CallScreenActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        turnScreenOnAndKeyguardOff()
        
        setContentView(R.layout.activity_call_screen)

        val webView = findViewById<WebView>(R.id.screeningWebView)
        
        // Essential WebView settings for your Twilio screen-ui
        @SuppressLint("SetJavaScriptEnabled")
        webView.settings.javaScriptEnabled = true
        webView.webViewClient = WebViewClient()

        // Extract the data from the push notification
        val callSid = intent.getStringExtra("CALL_SID") ?: ""
        val from = intent.getStringExtra("CALLER_NUMBER") ?: ""
        val transcript = intent.getStringExtra("TRANSCRIPT") ?: ""

        // Load your Twilio Screen UI with the parameters
        val url = "https://tribetailsattendant-8587.twil.io/screen-ui?callSid=$callSid&from=$from&transcript=$transcript"
        webView.loadUrl(url)
    }

    private fun turnScreenOnAndKeyguardOff() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
    }
}
