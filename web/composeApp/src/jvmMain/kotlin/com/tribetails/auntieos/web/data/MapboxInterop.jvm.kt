package com.tribetails.auntieos.web.data

internal actual suspend fun platformMapboxSuggest(
    query: String,
    sessionToken: String,
    limit: Int,
): MapboxSuggestResult = MapboxSuggestResult.Err("Desktop Mapbox not yet implemented")

internal actual suspend fun platformMapboxRetrieve(
    mapboxId: String,
    sessionToken: String,
): MapboxRetrieveResult = MapboxRetrieveResult.Err("Desktop Mapbox not yet implemented")
