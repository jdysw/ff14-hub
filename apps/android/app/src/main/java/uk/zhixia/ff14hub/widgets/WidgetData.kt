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
    private const val LIMIT_BYTES = 128 * 1024

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun region(context: Context): String =
        if (prefs(context).getString("region", "cn") == "global") "global" else "cn"

    fun fishIds(context: Context): String = prefs(context).getString("fishIds", "") ?: ""

    fun normalizeFishIds(raw: String): String = FishIds.normalize(raw)

    fun saveSettings(context: Context, selectedRegion: String, rawIds: String) {
        require(selectedRegion == "cn" || selectedRegion == "global")
        val ids = normalizeFishIds(rawIds)
        prefs(context).edit().putString("region", selectedRegion)
            .putString("fishIds", ids).remove(CACHE).apply()
    }

    fun cached(context: Context): JSONObject? {
        return try {
            val text = prefs(context).getString(CACHE, null) ?: return null
            val body = JSONObject(text)
            if (body.getInt("schemaVersion") != 1 ||
                body.getString("timezone") != "Asia/Shanghai" ||
                body.getString("region") != region(context)) null else body
        } catch (_: Exception) { null }
    }

    fun lastError(context: Context): String? = prefs(context).getString("lastError", null)

    /** 只在 WorkManager 的后台线程调用；绝不在 BroadcastReceiver 主线程里联网。 */
    fun refresh(context: Context): Boolean {
        var connection: HttpsURLConnection? = null
        return try {
            val params = buildString {
                append("?region=").append(region(context))
                val ids = fishIds(context)
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
            val body = JSONObject(raw)
            require(body.getInt("schemaVersion") == 1) { "小部件数据协议版本不兼容" }
            require(body.getString("timezone") == "Asia/Shanghai") { "时区不一致" }
            require(body.getString("region") == region(context)) { "区服不一致" }
            val generated = body.getLong("generatedAtMs")
            val refreshAfter = body.getLong("refreshAfterMs")
            val staleAfter = body.getLong("staleAfterMs")
            require(generated > 0 && refreshAfter > generated && staleAfter > refreshAfter) {
                "时间戳无效"
            }
            require(generated <= System.currentTimeMillis() + 300_000) { "服务器时间异常" }
            // 防止任意字段缺失造成错误的「没有活动 / 没有鱼」展示。
            require(body.getJSONObject("pvp").has("frontline") &&
                    body.getJSONObject("pvp").has("crystalline"))
            require(body.getJSONObject("fish").has("items") &&
                    body.getJSONObject("events").has("items"))
            prefs(context).edit().putString(CACHE, raw)
                .putLong("syncedAtMs", System.currentTimeMillis())
                .remove("lastError").apply()
            true
        } catch (error: Exception) {
            prefs(context).edit()
                .putString("lastError", error.message?.take(100) ?: "数据更新失败").apply()
            false
        } finally {
            connection?.disconnect()
        }
    }
}
