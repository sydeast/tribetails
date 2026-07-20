package com.kinfolk.portal.firebase

import dev.gitlive.firebase.functions.HttpsCallableResult

expect fun decodeHttpsResult(result: HttpsCallableResult): Map<String, Any?>
