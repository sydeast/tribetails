pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("https://api.mapbox.com/downloads/v2/releases/maven")
            credentials.username = "mapbox"
            val mapboxDownloadsToken =
                providers.gradleProperty("MAPBOX_DOWNLOADS_TOKEN").orNull
                    ?: System.getenv("MAPBOX_DOWNLOADS_TOKEN")
                    ?: throw GradleException(
                        "Missing MAPBOX_DOWNLOADS_TOKEN. Add it to gradle.properties or export it in your environment."
                    )
            credentials.password = mapboxDownloadsToken
        }
    }
}

rootProject.name = "AuntieOS"
include(":app")
