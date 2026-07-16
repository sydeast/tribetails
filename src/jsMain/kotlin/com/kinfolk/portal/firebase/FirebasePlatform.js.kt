package com.kinfolk.portal.firebase

// JS path still goes through gitlive — the kinfolk web bundle uses the same
// FunctionsClient interface but exercises it through the gitlive JS SDK, which
// has its own serialization quirks tracked separately from the Android SEND
// bug (see NativeAndroidFunctionsClient.kt for the Android fix).
actual fun platformFunctionsClient(): FunctionsClient = GitliveFunctionsClient()
