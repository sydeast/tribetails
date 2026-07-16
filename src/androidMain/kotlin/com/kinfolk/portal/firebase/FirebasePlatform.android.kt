package com.kinfolk.portal.firebase

actual fun platformFunctionsClient(): FunctionsClient = NativeAndroidFunctionsClient()
