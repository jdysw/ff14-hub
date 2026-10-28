package uk.zhixia.ff14hub.widgets.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.content.res.Configuration
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import uk.zhixia.ff14hub.widgets.R
import uk.zhixia.ff14hub.widgets.WidgetData
import uk.zhixia.ff14hub.widgets.SnapshotValidator
import uk.zhixia.ff14hub.widgets.MainActivity
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

enum class WidgetKind { FRONTLINE, CRYSTALLINE, PVP_LARGE, FISH, EVENTS, OVERVIEW }

private data class WidgetText(
    val title: String, val primary: String, val secondary: String,
    val tertiary: String = "", val changesAtMs: Long = 0,
    val compactSecondary: String = secondary
)

object WidgetRenderer {
    private val dateFormat = DateTimeFormatter.ofPattern("MM-dd HH:mm")
        .withZone(ZoneId.of("Asia/Shanghai"))

    private fun formatAt(ms: Long) = dateFormat.format(Instant.ofEpochMilli(ms))
    /** 离线时仍可根据 API 下发的规则精确计算当前 PVP 时段。 */
    private fun pvp(snapshot: JSONObject, name: String, now: Long): WidgetText {
        val rule = snapshot.getJSONObject("pvp").getJSONObject(name)
        val rotation = SnapshotValidator.rotation(rule, now)
        val title = if (name == "frontline") "国服前线 · 今日战场" else "国服水晶冲突 · 当前地图"
        val later = if (name == "frontline") "明日" else "下张"
        return WidgetText(title, rotation.current,
            "$later：${rotation.next}",
            "北京时间 ${formatAt(rotation.changesAtMs)} 切换", rotation.changesAtMs)
    }

    private fun fish(snapshot: JSONObject, now: Long): WidgetText {
        val fish = snapshot.getJSONObject("fish")
        when (fish.getString("status")) {
            "selection_required" -> return WidgetText("关注鱼窗", "选择关注的鱼",
                "点击卡片，在应用中按名称添加")
            "unavailable" -> return WidgetText("关注鱼窗", "鱼窗数据暂不可用", "请稍后刷新")
        }
        val list = fish.getJSONArray("items")
        var best: JSONObject? = null
        for (i in 0 until list.length()) {
            val entry = list.getJSONObject(i)
            if (entry.getLong("endsAtMs") <= now) continue
            if (best == null || entry.getLong("startsAtMs") < best.getLong("startsAtMs"))
                best = entry
        }
        if (best == null) return WidgetText("关注鱼窗", "暂无近期鱼窗", "可在应用中调整关注鱼")
        val title = best.getString("name")
        val starts = best.getLong("startsAtMs")
        val ends = best.getLong("endsAtMs")
        val uncertain = best.optBoolean("candidateOnly",false) ||
            best.optString("validationStatus") != "verified"
        val status = if (starts <= now) "开放中，${formatAt(ends)} 结束"
                     else "下次开放 ${formatAt(starts)}"
        val shortTime = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Shanghai"))
            .format(Instant.ofEpochMilli(if (starts <= now) ends else starts))
        return WidgetText("关注鱼窗", title, status,
            if (uncertain) "预测待核实 · 请以游戏实际条件为准" else "鱼窗预测 · 北京时间",
            compactSecondary = (if (uncertain) "候选 · " else "") + shortTime + if (starts <= now) " 结束" else " 开放")
    }

    private fun events(snapshot: JSONObject, now: Long): WidgetText {
        val events = snapshot.getJSONObject("events")
        val status = events.getString("status")
        if (status == "unavailable")
            return WidgetText("国服活动", "活动暂不可用", "打开网站查看公告")
        val list = events.getJSONArray("items")
        for (i in 0 until list.length()) {
            val item = list.getJSONObject(i)
            val begins = item.getLong("startsAtMs")
            val ends = item.getLong("endsAtMs")
            if (ends <= now) continue
            return WidgetText("国服活动", item.getString("title"),
                if (begins <= now) "进行中 · ${formatAt(ends)} 结束"
                else "${formatAt(begins)} 开始",
                if (status == "stale") "官方快照已过期，待刷新" else "北京时间",
                compactSecondary = if (status == "stale") "官方快照待刷新" else
                    formatAt(if (begins <= now) ends else begins) + if (begins <= now) " 截止" else " 开始")
        }
        return WidgetText("国服活动", "暂无已确认时间的近期活动",
            if (status == "stale") "官方快照已过期，待刷新" else "可进入网页查看待确认公告")
    }

    private fun overview(snapshot: JSONObject, now: Long): WidgetText {
        val front = pvp(snapshot, "frontline", now)
        val crystal = pvp(snapshot, "crystalline", now)
        val first = fish(snapshot, now)
        return WidgetText("今日概览",
            "战场：${front.primary}",
            "水晶冲突：${crystal.primary}",
            "鱼窗：${first.primary}", compactSecondary = "55 ${PvpPresentation.shortMap(crystal.primary)}")
    }

    private fun offline(kind: WidgetKind, snapshot: JSONObject?, now: Long): WidgetText {
        if (snapshot == null) return WidgetText("FF14 Hub",
            "尚无离线数据", "打开应用连接网络同步")
        val stale = now > snapshot.getLong("staleAfterMs")
        val result = when (kind) {
            WidgetKind.FRONTLINE -> pvp(snapshot, "frontline", now)
            WidgetKind.CRYSTALLINE -> pvp(snapshot, "crystalline", now)
            WidgetKind.PVP_LARGE -> overview(snapshot, now)
            WidgetKind.FISH -> fish(snapshot, now)
            WidgetKind.EVENTS -> events(snapshot, now)
            WidgetKind.OVERVIEW -> overview(snapshot, now)
        }
        if (snapshot.optBoolean("bundledRules") &&
            kind in listOf(WidgetKind.FRONTLINE, WidgetKind.CRYSTALLINE, WidgetKind.OVERVIEW))
            return result.copy(tertiary = listOf(result.tertiary,
                "内置国服规则 · 联网后校验").filter { it.isNotBlank() }.joinToString("\n"))
        // PVP 仍可离线依规则计算；需要联网确认官方是否调整了轮换。
        if (!stale) return result
        val note = if (kind == WidgetKind.FISH || kind == WidgetKind.EVENTS)
            "数据已过期 · 需要联网刷新" else "规则缓存较旧 · 请联网校验"
        return result.copy(tertiary = listOf(result.tertiary, note).filter { it.isNotBlank() }.joinToString("\n"), compactSecondary = note)
    }

    fun providerClass(kind: WidgetKind): Class<out HubWidgetProvider> = when (kind) {
        WidgetKind.FRONTLINE -> FrontlineWidgetProvider::class.java
        WidgetKind.CRYSTALLINE -> CrystallineWidgetProvider::class.java
        WidgetKind.PVP_LARGE -> PvpLargeWidgetProvider::class.java
        WidgetKind.FISH -> FishWidgetProvider::class.java
        WidgetKind.EVENTS -> EventsWidgetProvider::class.java
        WidgetKind.OVERVIEW -> OverviewWidgetProvider::class.java
    }

    fun activePvpModes(context: Context): Set<String> {
        val manager = AppWidgetManager.getInstance(context)
        fun active(kind: WidgetKind) = manager.getAppWidgetIds(ComponentName(context, providerClass(kind))).isNotEmpty()
        val combined = active(WidgetKind.OVERVIEW) || active(WidgetKind.FRONTLINE) ||
            active(WidgetKind.CRYSTALLINE) || active(WidgetKind.PVP_LARGE)
        return buildSet {
            if (combined) { add("frontline"); add("crystalline") }
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
        ids.forEach { id ->
            if (kind in listOf(WidgetKind.FRONTLINE, WidgetKind.CRYSTALLINE, WidgetKind.PVP_LARGE)) {
                val snapshot = WidgetData.cached(context)
                if (snapshot != null) {
                    val preset = when (kind) {
                        WidgetKind.FRONTLINE -> PvpDensity.SMALL
                        WidgetKind.CRYSTALLINE -> PvpDensity.MEDIUM
                        else -> PvpDensity.LARGE
                    }
                    manager.updateAppWidget(id, PvpWidgetRenderer.responsive(context, manager, id, snapshot, now, preset))
                    return@forEach
                }
            }
            val options = manager.getAppWidgetOptions(id)
            val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            val width = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, if (kind == WidgetKind.OVERVIEW) 250 else 180)
            val height = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
                options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, if (kind == WidgetKind.OVERVIEW) 170 else 110))
            val views = buildTile(context, kind, WidgetData.cached(context), now, id, width, height)
            manager.updateAppWidget(id, views)
        }
    }

    /** The launcher and the in-app preview inflate the same adaptive native layout. */
    fun buildTile(context: Context, kind: WidgetKind, snapshot: JSONObject?, now: Long,
        id: Int = 0, width: Int = 220, height: Int = 170): RemoteViews {
        val content = try { offline(kind, snapshot, now) }
            catch (_: Exception) { WidgetText("FF14 Hub", "数据格式需要更新", "请打开应用重新同步") }
        val largeFont = context.resources.configuration.fontScale > 1.3f
        val views = RemoteViews(context.packageName, R.layout.widget_tile)
        val padding = ((if (height < 160) 8 else 12) * context.resources.displayMetrics.density).toInt()
        views.setViewPadding(R.id.widget_content, padding, padding, padding, padding)
        val icon = when (kind) {
            WidgetKind.FISH -> R.drawable.widget_symbol_fish
            WidgetKind.EVENTS -> R.drawable.widget_symbol_events
            else -> R.drawable.widget_symbol_overview
        }
        views.setImageViewResource(R.id.widget_icon, icon)
        views.setTextViewText(R.id.widget_title, content.title)
        val brief = height < 170 || largeFont
        val primary = if (brief && kind == WidgetKind.OVERVIEW) content.primary.substringBefore('（') else content.primary
        views.setTextViewText(R.id.widget_primary, primary)
        views.setTextViewTextSize(R.id.widget_primary, TypedValue.COMPLEX_UNIT_SP, if (height < 140) 16f else 18f)
        views.setInt(R.id.widget_primary, "setMaxLines", if ((width < 200 && height < 160) || (largeFont && height < 200)) 1 else 2)
        val showDetails = height >= (if (largeFont) 300 else 200)
        views.setTextViewText(R.id.widget_secondary, if (showDetails) content.secondary else content.compactSecondary)
        views.setInt(R.id.widget_secondary, "setMaxLines", if (showDetails) 2 else 1)
        views.setTextViewText(R.id.widget_tertiary, content.tertiary)
        views.setViewVisibility(R.id.widget_tertiary, if (showDetails) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.widget_header, if (largeFont && height < 180) View.GONE else View.VISIBLE)
        views.setViewVisibility(R.id.widget_secondary, View.VISIBLE)
        views.setViewVisibility(R.id.widget_countdown, View.GONE)
        if (content.changesAtMs > now) {
            views.setViewVisibility(R.id.widget_countdown, View.VISIBLE)
            views.setChronometer(R.id.widget_countdown, SystemClock.elapsedRealtime() + content.changesAtMs - now, null, true)
            views.setChronometerCountDown(R.id.widget_countdown, true)
        }
        views.setContentDescription(R.id.widget_root, listOf(content.title, content.primary, content.secondary, content.tertiary).filter { it.isNotBlank() }.joinToString("。"))
        val needsSelection = kind == WidgetKind.FISH && snapshot?.optJSONObject("fish")?.optString("status") == "selection_required"
        val intent = if (needsSelection) Intent(context, MainActivity::class.java) else Intent(Intent.ACTION_VIEW, Uri.parse(WidgetData.SITE))
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        return views
    }

}
