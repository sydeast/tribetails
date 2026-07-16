package com.kinfolk.portal.auth

actual fun platformUserAgent(): String = "MyTribe-Desktop/${System.getProperty("os.name", "unknown")}"
