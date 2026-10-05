import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Release signing credentials live in local.properties (gitignored, per-machine),
// not in this file, since it's committed. See android-native/README.md for how to
// generate a keystore and populate these keys.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val releaseStoreFile = localProperties.getProperty("voynix.release.storeFile")

android {
    namespace = "com.voynix"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.tekapo.voynix"
        minSdk = 26
        targetSdk = 36
        versionCode = 119
        versionName = "0.22.0"
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = localProperties.getProperty("voynix.release.storePassword")
                keyAlias = localProperties.getProperty("voynix.release.keyAlias")
                keyPassword = localProperties.getProperty("voynix.release.keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseStoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Lets Android 13+ (API 33) offer a per-app language picker in system
    // Settings, generated from the values-*/  locales actually shipped
    // (currently en default + ja) — no separate manual locale_config.xml to
    // keep in sync. Paired with the in-app picker in SettingsScreen.kt for
    // API 26-32, where there's no per-app system Settings entry.
    androidResources {
        generateLocaleConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    sourceSets {
        // Room schema JSONs exported by ksp (see the `room.schemaLocation` arg
        // below) — MigrationTestHelper reads them as assets. Robolectric unit
        // tests resolve assets through the merged *main* assets output (see
        // generateDebugUnitTestConfig's android_merged_assets), not a
        // separate test source set, so this has to live on "main".
        getByName("main").assets.srcDirs("$projectDir/schemas")
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    debugImplementation(libs.androidx.ui.tooling)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.session)

    // Home-screen "now playing" widget (Glance renders it; the transport
    // buttons still ride the same MediaButtonReceiver as Bluetooth/notification).
    implementation(libs.androidx.glance.appwidget)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.work.runtime.ktx)

    // Pairing by scanning the Mac's QR code. Google Code Scanner needs no CAMERA
    // permission (the scan UI is hosted by Google Play services).
    implementation(libs.androidx.fragment)
    implementation(libs.play.services.code.scanner)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.room.testing)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
    testImplementation(libs.mockito.kotlin)
    testImplementation(libs.androidx.media3.exoplayer)
    testImplementation(libs.androidx.work.testing)
}
