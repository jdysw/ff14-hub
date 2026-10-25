plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "uk.zhixia.ff14hub.widgets"
    compileSdk = 35
    buildFeatures { buildConfig = true }
    // 预览调试版与正式版可在同一台手机共存，不共享个人配置和缓存。
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-preview"
        }
    }
    defaultConfig {
        applicationId = "uk.zhixia.ff14hub.widgets"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
dependencyLocking { lockAllConfigurations() }

dependencies {
    implementation(libs.androidx.work.runtime.ktx)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
}
