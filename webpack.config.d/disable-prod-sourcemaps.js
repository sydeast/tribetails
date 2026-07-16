// Production webpack only: skip source-map generation. The Kotlin/JS bundle
// is large enough that devtool source maps push the production webpack into a
// 50+ minute run (with a "Too many sources" path-rewrite warning). The shipped
// prod bundle does not need inline maps. Dev (jsBrowserDevelopmentRun) keeps maps.
if (config.mode === "production") {
    config.devtool = false;
}
