package com.kinfolk.portal.firebase

// JS path still goes through gitlive — the kinfolk web bundle uses the same
// FunctionsClient interface but exercises it through the gitlive JS SDK, which
// has its own serialization quirks tracked separately from the Android SEND
// bug (see NativeAndroidFunctionsClient.kt for the Android fix).
// #557: wrapped so a revoked session's refusal ends the local session here
// too. Installed at the actual rather than the composition root, for the
// reasoning in RevocationAwareFunctionsClient.
actual fun platformFunctionsClient(): FunctionsClient =
    RevocationAwareFunctionsClient(GitliveFunctionsClient())
