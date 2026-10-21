package uk.zhixia.ff14hub.widgets.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import uk.zhixia.ff14hub.widgets.R
import uk.zhixia.ff14hub.widgets.SnapshotValidator
import uk.zhixia.ff14hub.widgets.WidgetData
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object PvpWidgetRenderer {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val hour = DateTimeFormatter.ofPattern("HH:mm").withZone(zone)
    private val date = DateTimeFormatter.ofPattern("MM/dd HH:mm").withZone(zone)
    private fun at(ms: Long, full: Boolean = false) = (if (full) date else hour).format(Instant.ofEpochMilli(ms))

    fun responsive(context: Context, manager: AppWidgetManager, id: Int,
        snapshot: JSONObject, now: Long, preset: PvpDensity): RemoteViews {
        val fontScale = context.resources.configuration.fontScale
        val options = manager.getAppWidgetOptions(id)
        @Suppress("DEPRECATION")
        val sizedHost = Build.VERSION.SDK_INT >= 31 &&
            !options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES).isNullOrEmpty()
        if (Build.VERSION.SDK_INT >= 31 && sizedHost) {
            // Android 12+ lets the host select a matching layout immediately during resize.
            val sizes = listOf(SizeF(140f, 140f), SizeF(140f, 320f), SizeF(240f, 180f), SizeF(280f, 320f))
            return RemoteViews(sizes.associateWith { size ->
                build(context, PvpPresentation.density(size.width, size.height, fontScale), snapshot, now, id, size.width < 240)
            })
        }
        val defaults = when (preset) {
            PvpDensity.SMALL -> 155 to 155
            PvpDensity.MEDIUM -> 320 to 180
            PvpDensity.LARGE -> 320 to 340
        }
        // Older MIUI/HyperOS launchers may still report only the classic size bundle.
        val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val width = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
            else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, defaults.first))
        val height = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
            else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, defaults.second))
        return build(context, PvpPresentation.density(width.toFloat(), height.toFloat(), fontScale), snapshot, now, id, width < 240)
    }

    fun build(context: Context, density: PvpDensity, snapshot: JSONObject, now: Long, id: Int = 0, stacked: Boolean = false): RemoteViews {
        val layout = when (density) {
            PvpDensity.SMALL -> R.layout.pvp_widget_small
            PvpDensity.MEDIUM -> if (stacked) R.layout.pvp_widget_tall else R.layout.pvp_widget_medium
            PvpDensity.LARGE -> R.layout.pvp_widget_large
        }
        val views = RemoteViews(context.packageName, layout)
        // Hosts reuse views: reset properties changed by an earlier font/theme/density.
        val basePadding = ((if (density == PvpDensity.LARGE) 14 else 12) * context.resources.displayMetrics.density).toInt()
        views.setViewPadding(R.id.widget_root, basePadding, basePadding, basePadding, basePadding)
        views.setInt(R.id.widget_root, "setBackgroundResource", 0)
        views.setInt(R.id.widget_root, "setBackgroundResource", R.drawable.pvp_widget_background)
        views.setViewVisibility(R.id.pvp_heading, if (density == PvpDensity.LARGE) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.pvp_status, View.VISIBLE)
        views.setViewVisibility(R.id.pvp_front_label, View.VISIBLE)
        views.setViewVisibility(R.id.pvp_crystal_label, View.VISIBLE)
        val baseText = if (density == PvpDensity.SMALL) 16f else 19f
        views.setTextViewTextSize(R.id.pvp_front_current, TypedValue.COMPLEX_UNIT_SP, baseText)
        views.setTextViewTextSize(R.id.pvp_crystal_current, TypedValue.COMPLEX_UNIT_SP, baseText)
        views.setTextColor(R.id.pvp_heading, context.getColor(R.color.pvp_text))
        views.setTextColor(R.id.pvp_front_current, context.getColor(R.color.pvp_text))
        views.setTextColor(R.id.pvp_crystal_current, context.getColor(R.color.pvp_text))
        views.setTextColor(R.id.pvp_status, context.getColor(R.color.pvp_muted))
        views.setTextColor(R.id.pvp_front_label, context.getColor(R.color.pvp_frontline))
        views.setTextColor(R.id.pvp_crystal_label, context.getColor(R.color.pvp_crystal))
        val rules = snapshot.getJSONObject("pvp")
        val front = SnapshotValidator.rotation(rules.getJSONObject("frontline"), now)
        val crystal = SnapshotValidator.rotation(rules.getJSONObject("crystalline"), now)
        val largeText = context.resources.configuration.fontScale > PvpPresentation.LARGE_FONT_SCALE
        val currentFront = PvpPresentation.shortMap(front.current)
        val currentCrystal = PvpPresentation.shortMap(crystal.current)
        views.setTextViewText(R.id.pvp_front_current, currentFront)
        views.setTextViewText(R.id.pvp_crystal_current, currentCrystal)
        views.setContentDescription(R.id.widget_root,
            "国服 PVP。纷争前线 ${front.current}，下轮 ${front.next}，北京时间 ${at(front.changesAtMs, true)} 换图。" +
            "水晶冲突 ${crystal.current}，下张 ${crystal.next}，北京时间 ${at(crystal.changesAtMs)} 换图。")
        val source = when {
            snapshot.optBoolean("bundledRules") -> "内置规则"
            now >= snapshot.getLong("staleAfterMs") -> "离线推算，规则待校验"
            else -> "已同步 ${at(snapshot.getLong("generatedAtMs"))}"
        }
        views.setTextViewText(R.id.pvp_status,
            if (density == PvpDensity.SMALL) "国服 · $source" else "北京时间 · $source")
        if (density == PvpDensity.SMALL && largeText) {
            views.setViewVisibility(R.id.pvp_heading, View.GONE)
            views.setViewVisibility(R.id.pvp_status, View.GONE)
            views.setViewVisibility(R.id.pvp_front_label, View.GONE)
            views.setViewVisibility(R.id.pvp_crystal_label, View.GONE)
            fun readable(label: String, name: String, color: Int): SpannableString =
                SpannableString("$label\n$name").apply {
                    setSpan(RelativeSizeSpan(0.65f), 0, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    setSpan(ForegroundColorSpan(context.getColor(color)), 0, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            views.setTextViewText(R.id.pvp_front_current, readable("纷争前线", currentFront, R.color.pvp_frontline))
            views.setTextViewText(R.id.pvp_crystal_current, readable("水晶冲突", currentCrystal, R.color.pvp_crystal))
            // Compact physical space is finite: retain both full names, at up to 20dp text.
            val readableSize = minOf(14f, 20f / context.resources.configuration.fontScale)
            val padding = (8 * context.resources.displayMetrics.density).toInt()
            views.setViewPadding(R.id.widget_root, padding, padding, padding, padding)
            views.setTextViewTextSize(R.id.pvp_front_current, TypedValue.COMPLEX_UNIT_SP, readableSize)
            views.setTextViewTextSize(R.id.pvp_crystal_current, TypedValue.COMPLEX_UNIT_SP, readableSize)
        }
        if (density != PvpDensity.SMALL) {
            for (field in intArrayOf(R.id.pvp_front_next, R.id.pvp_crystal_next,
                R.id.pvp_front_boundary, R.id.pvp_crystal_boundary))
                views.setTextColor(field, context.getColor(R.color.pvp_muted))
            views.setTextColor(R.id.pvp_front_countdown, context.getColor(R.color.pvp_frontline))
            views.setTextColor(R.id.pvp_crystal_countdown, context.getColor(R.color.pvp_crystal))
            views.setTextViewText(R.id.pvp_front_next, "下轮 ${PvpPresentation.shortMap(front.next)}")
            views.setTextViewText(R.id.pvp_crystal_next, "下张 ${PvpPresentation.shortMap(crystal.next)}")
            views.setTextViewText(R.id.pvp_front_boundary, "${at(front.changesAtMs)} 换图")
            views.setTextViewText(R.id.pvp_crystal_boundary, "${at(crystal.changesAtMs)} 换图")
            countdown(views, R.id.pvp_front_countdown, front.changesAtMs, now)
            countdown(views, R.id.pvp_crystal_countdown, crystal.changesAtMs, now)
            if (largeText) views.setViewVisibility(R.id.pvp_heading, View.GONE)
        }
        if (density == PvpDensity.LARGE) {
            val frontTimes = intArrayOf(R.id.pvp_front_slot_1_time, R.id.pvp_front_slot_2_time, R.id.pvp_front_slot_3_time)
            val frontMaps = intArrayOf(R.id.pvp_front_slot_1_map, R.id.pvp_front_slot_2_map, R.id.pvp_front_slot_3_map)
            val crystalTimes = intArrayOf(R.id.pvp_crystal_slot_1_time, R.id.pvp_crystal_slot_2_time, R.id.pvp_crystal_slot_3_time)
            val crystalMaps = intArrayOf(R.id.pvp_crystal_slot_1_map, R.id.pvp_crystal_slot_2_map, R.id.pvp_crystal_slot_3_map)
            for (i in 0..2) {
                val frontAt = front.changesAtMs + i * rules.getJSONObject("frontline").getLong("periodMs")
                val crystalAt = crystal.changesAtMs + i * rules.getJSONObject("crystalline").getLong("periodMs")
                views.setTextViewText(frontTimes[i], at(frontAt, true))
                views.setTextViewText(frontMaps[i], PvpPresentation.shortMap(SnapshotValidator.rotation(rules.getJSONObject("frontline"), frontAt).current))
                views.setTextViewText(crystalTimes[i], at(crystalAt, true))
                views.setTextViewText(crystalMaps[i], PvpPresentation.shortMap(SnapshotValidator.rotation(rules.getJSONObject("crystalline"), crystalAt).current))
                views.setTextColor(frontTimes[i], context.getColor(R.color.pvp_muted))
                views.setTextColor(crystalTimes[i], context.getColor(R.color.pvp_muted))
                views.setTextColor(frontMaps[i], context.getColor(R.color.pvp_text))
                views.setTextColor(crystalMaps[i], context.getColor(R.color.pvp_text))
            }
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(WidgetData.SITE)).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        return views
    }

    private fun countdown(views: RemoteViews, view: Int, until: Long, now: Long) {
        views.setChronometer(view, SystemClock.elapsedRealtime() + until - now, null, true)
        views.setChronometerCountDown(view, true)
    }
}
