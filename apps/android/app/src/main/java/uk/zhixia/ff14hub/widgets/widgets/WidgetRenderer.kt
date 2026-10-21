package uk.zhixia.ff14hub.widgets.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import uk.zhixia.ff14hub.widgets.R
import uk.zhixia.ff14hub.widgets.WidgetData
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

enum class WidgetKind { FRONTLINE, CRYSTALLINE, FISH, EVENTS, OVERVIEW }

private data class WidgetText(
    val title: String, val primary: String, val secondary: String,
    val tertiary: String = "", val changesAtMs: Long = 0
)

object WidgetRenderer {
    private val dateFormat = DateTimeFormatter.ofPattern("MM-dd HH:mm")
        .withZone(ZoneId.of("Asia/Shanghai"))

    private fun formatAt(ms: Long) = dateFormat.format(Instant.ofEpochMilli(ms))
    /** 离线时仍可根据 API 下发的规则精确计算当前 PVP 时段。 */
    private fun pvp(snapshot: JSONObject, name: String, now: Long): WidgetText {
        val rule = snapshot.getJSONObject("pvp").getJSONObject(name)
        val maps = rule.getJSONArray("cycle")
        val period = rule.getLong("periodMs")
        val anchor = rule.getLong("anchorUtcMs")
        val initialIndex = rule.getInt("anchorIndex")
        require(period > 0 && maps.length() in 1..12)
        val rotation = RotationMath.at(now,anchor,initialIndex,period,
            (0 until maps.length()).map { maps.getString(it) })
        val title = if (name == "frontline") "纷争前线 · 今日战场" else "水晶冲突 · 当前地图"
        val later = if (name == "frontline") "明日" else "下张"
        return WidgetText(title, rotation.current,
            "$later：${rotation.next}",
            "北京时间 ${formatAt(rotation.changesAtMs)} 切换", rotation.changesAtMs)
    }

    private fun fish(snapshot: JSONObject, now: Long): WidgetText {
        val fish = snapshot.getJSONObject("fish")
        when (fish.getString("status")) {
            "selection_required" -> return WidgetText("鱼窗提醒", "尚未选择关注的鱼",
                "打开 FF14 Hub 小部件应用设置鱼 ID")
            "unavailable" -> return WidgetText("鱼窗提醒", "鱼窗数据暂不可用", "请稍后刷新")
        }
        val list = fish.getJSONArray("items")
        var best: JSONObject? = null
        for (i in 0 until list.length()) {
            val entry = list.getJSONObject(i)
            if (entry.getLong("endsAtMs") <= now) continue
            if (best == null || entry.getLong("startsAtMs") < best.getLong("startsAtMs"))
                best = entry
        }
        if (best == null) return WidgetText("鱼窗提醒", "暂无可用的关注鱼窗", "可在应用中调整关注鱼")
        val title = best.getString("name")
        val starts = best.getLong("startsAtMs")
        val ends = best.getLong("endsAtMs")
        val uncertain = best.optBoolean("candidateOnly",false) ||
            best.optString("validationStatus") != "verified"
        val status = if (starts <= now) "开放中，${formatAt(ends)} 结束"
                     else "下次开放 ${formatAt(starts)}"
        return WidgetText("鱼窗提醒", title, status,
            if (uncertain) "预测待核实 · 请以游戏实际条件为准" else "鱼窗预测 · 北京时间")
    }

    private fun events(snapshot: JSONObject, now: Long): WidgetText {
        val events = snapshot.getJSONObject("events")
        val status = events.getString("status")
        if (status == "unavailable")
            return WidgetText("国服活动", "官方活动数据暂不可用", "保留后续刷新机会")
        val list = events.getJSONArray("items")
        for (i in 0 until list.length()) {
            val item = list.getJSONObject(i)
            val begins = item.getLong("startsAtMs")
            val ends = item.getLong("endsAtMs")
            if (ends <= now) continue
            return WidgetText("国服活动", item.getString("title"),
                if (begins <= now) "进行中 · ${formatAt(ends)} 结束"
                else "${formatAt(begins)} 开始",
                if (status == "stale") "官方快照已过期，待刷新" else "北京时间")
        }
        return WidgetText("国服活动", "暂无已确认时间的近期活动",
            if (status == "stale") "官方快照已过期，待刷新" else "可进入网页查看待确认公告")
    }

    private fun overview(snapshot: JSONObject, now: Long): WidgetText {
        val front = pvp(snapshot, "frontline", now)
        val crystal = pvp(snapshot, "crystalline", now)
        val first = fish(snapshot, now)
        return WidgetText("FF14 今日概览",
            "前线：${front.primary}",
            "水晶冲突：${crystal.primary}",
            "鱼窗：${first.primary}")
    }

    private fun offline(kind: WidgetKind, snapshot: JSONObject?, now: Long): WidgetText {
        if (snapshot == null) return WidgetText("FF14 Hub",
            "尚无离线数据", "打开应用连接网络同步")
        val stale = now > snapshot.getLong("staleAfterMs")
        val result = when (kind) {
            WidgetKind.FRONTLINE -> pvp(snapshot, "frontline", now)
            WidgetKind.CRYSTALLINE -> pvp(snapshot, "crystalline", now)
            WidgetKind.FISH -> fish(snapshot, now)
            WidgetKind.EVENTS -> events(snapshot, now)
            WidgetKind.OVERVIEW -> overview(snapshot, now)
        }
        // PVP 仍可离线依规则计算；需要联网确认官方是否调整了轮换。
        if (!stale) return result
        val note = if (kind == WidgetKind.FISH || kind == WidgetKind.EVENTS)
            "数据已过期 · 需要联网刷新" else "规则缓存较旧 · 请联网校验"
        return result.copy(tertiary = note)
    }

    fun providerClass(kind: WidgetKind): Class<out HubWidgetProvider> = when (kind) {
        WidgetKind.FRONTLINE -> FrontlineWidgetProvider::class.java
        WidgetKind.CRYSTALLINE -> CrystallineWidgetProvider::class.java
        WidgetKind.FISH -> FishWidgetProvider::class.java
        WidgetKind.EVENTS -> EventsWidgetProvider::class.java
        WidgetKind.OVERVIEW -> OverviewWidgetProvider::class.java
    }

    fun activePvpWidgetCount(context: Context): Int {
        val manager=AppWidgetManager.getInstance(context)
        return listOf(WidgetKind.FRONTLINE,WidgetKind.CRYSTALLINE,WidgetKind.OVERVIEW).sumOf { kind ->
            manager.getAppWidgetIds(ComponentName(context,providerClass(kind))).size
        }
    }

    fun activeWidgetCount(context: Context): Int {
        val manager = AppWidgetManager.getInstance(context)
        return WidgetKind.entries.sumOf { kind ->
            manager.getAppWidgetIds(ComponentName(context, providerClass(kind))).size
        }
    }

    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        WidgetKind.entries.forEach { kind ->
            updateIds(context, manager,
                manager.getAppWidgetIds(ComponentName(context, providerClass(kind))), kind)
        }
    }

    fun updateIds(context: Context, manager: AppWidgetManager, ids: IntArray, kind: WidgetKind) {
        if (ids.isEmpty()) return
        val now = System.currentTimeMillis()
        val content = try { offline(kind, WidgetData.cached(context), now) }
            catch (_: Exception) { WidgetText("FF14 Hub", "数据格式需要更新", "请打开应用重新同步") }
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_tile)
            views.setTextViewText(R.id.widget_title, content.title)
            views.setTextViewText(R.id.widget_primary, content.primary)
            views.setTextViewText(R.id.widget_secondary, content.secondary)
            views.setTextViewText(R.id.widget_tertiary, content.tertiary)
            if (content.changesAtMs > now) {
                val base = SystemClock.elapsedRealtime() + content.changesAtMs - now
                views.setViewVisibility(R.id.widget_countdown, View.VISIBLE)
                views.setChronometer(R.id.widget_countdown, base, null, true)
                views.setChronometerCountDown(R.id.widget_countdown, true)
            } else {
                views.setViewVisibility(R.id.widget_countdown, View.GONE)
            }
            // 小部件点击直接进入 FF14 Hub；不绑定任何私有会话。
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(WidgetData.SITE)).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            val pending = PendingIntent.getActivity(context,id,intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_root, pending)
            manager.updateAppWidget(id, views)
        }
    }
}
