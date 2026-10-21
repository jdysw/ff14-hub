package uk.zhixia.ff14hub.widgets

import android.content.Context
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** 用户数据仅存本机。服务端只接收明确选择的鱼 ID，不接收钓获记录或凭据。 */
object WidgetData {
    const val SITE = "https://ff14.zhixia.uk"
    // 调试 APK 只读取预览服务；release 才访问正式 API。网站跳转保持正式域名。
    val apiOrigin: String get() = if (BuildConfig.DEBUG) "https://ff14-preview.zhixia.uk" else SITE
    private const val PREFS = "widget_preferences"
    private const val CACHE = "public_snapshot"
    private const val PVP_CACHE = "pvp_snapshot"
    private const val CACHE_IDS = "snapshot_fish_ids"
    private const val GENERATION = "settings_generation"
    private const val LIMIT_BYTES = 128 * 1024
    private val lock = Any()

    internal data class Selection(val region: String, val ids: String, val generation: Long)
    internal fun selection(context: Context): Selection = synchronized(lock) {
        Selection(region(context), fishIds(context), prefs(context).getLong(GENERATION, 0))
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun region(context: Context): String =
        if (prefs(context).getString("region", "cn") == "global") "global" else "cn"

    fun fishIds(context: Context): String = prefs(context).getString("fishIds", "") ?: ""

    fun normalizeFishIds(raw: String): String = FishIds.normalize(raw)

    fun saveSettings(context: Context, selectedRegion: String, rawIds: String) {
        require(selectedRegion == "cn" || selectedRegion == "global")
        val ids = normalizeFishIds(rawIds)
        synchronized(lock) {
            val current = selection(context)
            if (current.region == selectedRegion && current.ids == ids) return
            // Keep the last validated rules independently of fish selection/region.
            val old = cached(context)
            val editor = prefs(context).edit().putString("region", selectedRegion)
                .putString("fishIds", ids).putLong(GENERATION, current.generation + 1)
                .remove(CACHE).remove(CACHE_IDS).remove("lastError")
            if (old != null) editor.putString(PVP_CACHE, old.toString())
            editor.apply()
        }
    }

    fun cached(context: Context): JSONObject? = synchronized(lock) {
        val storage = prefs(context)
        val region = region(context)
        fun parsed(key: String): JSONObject? = try {
            storage.getString(key, null)?.let { JSONObject(it) }?.also {
                // Cached timestamps can predate a user correcting the system clock.
                SnapshotValidator.validate(it, it.getString("region"), 4_102_444_800_000L)
            }
        } catch (_: Exception) { null }
        val complete = parsed(CACHE)
        val cachedIds = storage.getString(CACHE_IDS, "")
        if (complete != null && complete.getString("region") == region && cachedIds == fishIds(context))
            return@synchronized complete
        val downloaded = parsed(PVP_CACHE) ?: complete
        val rules = downloaded ?: try {
            context.assets.open("pvp-rules-v1.json").bufferedReader(Charsets.UTF_8).use {
                JSONObject(it.readText()).also { body ->
                    SnapshotValidator.validate(body, "cn", 4_102_444_800_000L)
                    body.put("bundledRules", true)
                }
            }
        } catch (_: Exception) { return@synchronized null }
        // PVP uses CN rules in both selections; unrelated data must not cross selections.
        rules.put("region", region)
            .put("fish", JSONObject().put("status", if (fishIds(context).isBlank()) "selection_required" else "unavailable")
                .put("items", org.json.JSONArray()))
            .put("events", JSONObject().put("status", "unavailable")
                .put("sourceCheckedAtMs", JSONObject.NULL).put("items", org.json.JSONArray()))
    }

    internal fun accept(context: Context, raw: String, requested: Selection): Boolean {
        val body = JSONObject(raw)
        SnapshotValidator.validate(body, requested.region, System.currentTimeMillis())
        return synchronized(lock) {
            if (selection(context) != requested) return@synchronized false
            val previous = cached(context)
            if (previous != null && !previous.optBoolean("bundledRules") &&
                previous.getLong("generatedAtMs") > body.getLong("generatedAtMs")) return@synchronized false
            prefs(context).edit().putString(CACHE, raw).putString(CACHE_IDS, requested.ids)
                .putString(PVP_CACHE, raw).putLong("syncedAtMs", System.currentTimeMillis())
                .remove("lastError").apply()
            true
        }
    }

    fun lastError(context: Context): String? = prefs(context).getString("lastError", null)

    /** 只在 WorkManager 的后台线程调用；绝不在 BroadcastReceiver 主线程里联网。 */
    fun refresh(context: Context): Boolean {
        var connection: HttpsURLConnection? = null
        val requested = selection(context)
        return try {
            val params = buildString {
                append("?region=").append(requested.region)
                val ids = requested.ids
                if (ids.isNotBlank()) append("&fishIds=").append(ids)
            }
            val url = URL("$apiOrigin/api/v1/widgets/v1/summary$params")
            connection = url.openConnection() as HttpsURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 8_000
            connection.readTimeout = 12_000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "FF14Hub-AndroidWidgets/0.1")
            require(connection.responseCode == 200) { "HTTP ${connection.responseCode}" }
            require(connection.contentType?.contains("application/json", true) == true) {
                "服务器返回的不是 JSON"
            }
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val length = input.read(buffer)
                    if (length < 0) break
                    require(output.size() + length <= LIMIT_BYTES) { "响应超出大小上限" }
                    output.write(buffer, 0, length)
                }
            }
            val raw = output.toString(Charsets.UTF_8.name())
            accept(context, raw, requested)
        } catch (error: Exception) {
            synchronized(lock) {
                if (selection(context) == requested) prefs(context).edit()
                    .putString("lastError", error.message?.take(100) ?: "数据更新失败").apply()
            }
            false
        } finally {
            connection?.disconnect()
        }
    }
}
