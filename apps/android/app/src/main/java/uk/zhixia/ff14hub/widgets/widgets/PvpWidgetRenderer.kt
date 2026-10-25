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
        val xiaomiHost = Build.MANUFACTURER.lowercase() in setOf("xiaomi", "redmi", "poco")
        @Suppress("DEPRECATION")
        val sizedHost = !xiaomiHost && Build.VERSION.SDK_INT >= 31 &&
            !options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES).isNullOrEmpty()
        if (Build.VERSION.SDK_INT >= 31 && sizedHost) {
            // Android 12+ lets the host select a matching layout immediately during resize.
            val sizes = listOf(SizeF(1f, 1f), SizeF(120f, 88f), SizeF(120f, 220f), SizeF(220f, 120f), SizeF(260f, 240f))
            return RemoteViews(sizes.associateWith { size ->
                build(context, PvpPresentation.density(size.width, size.height, fontScale), snapshot, now, id, size.width < 220)
            })
        }
        val defaults = when (preset) {
            PvpDensity.MINI -> 110 to 72
            PvpDensity.SMALL -> 140 to 100
            PvpDensity.MEDIUM -> 280 to 140
            PvpDensity.LARGE -> 280 to 260
        }
        // Older MIUI/HyperOS launchers may still report only the classic size bundle.
        val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val width = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
            else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, defaults.first))
        val height = options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
            else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, defaults.second))
        return build(context, PvpPresentation.density(width.toFloat(), height.toFloat(), fontScale), snapshot, now, id, width < 220)
    }

    fun build(context: Context, density: PvpDensity, snapshot: JSONObject, now: Long, id: Int = 0, stacked: Boolean = false): RemoteViews {
        val layout = when (density) {
            PvpDensity.MINI -> R.layout.pvp_widget_mini
            PvpDensity.SMALL -> R.layout.pvp_widget_compact
            PvpDensity.MEDIUM -> if (stacked) R.layout.pvp_widget_vertical else R.layout.pvp_widget_wide
            PvpDensity.LARGE -> R.layout.pvp_widget_schedule
        }
        val views = RemoteViews(context.packageName, layout)
        // Hosts reuse views: reset properties changed by an earlier font/theme/density.
        // Keep surface and palette in XML. Xiaomi can rebuild cached RemoteViews on theme changes.
        val compact = density == PvpDensity.SMALL || density == PvpDensity.MINI
        val basePadding = (contentPadding(density) * context.resources.displayMetrics.density).toInt()
        views.setViewPadding(R.id.pvp_content, basePadding, basePadding, basePadding, basePadding)
        views.setViewVisibility(R.id.pvp_heading, View.GONE)
        views.setViewVisibility(R.id.pvp_status, View.GONE)
        views.setTextViewText(R.id.pvp_status, "")
        views.setViewVisibility(R.id.pvp_front_label, View.VISIBLE)
        views.setViewVisibility(R.id.pvp_crystal_label, View.VISIBLE)
        val baseText = baseTextSize(density)
        views.setTextViewTextSize(R.id.pvp_front_current, TypedValue.COMPLEX_UNIT_SP, baseText)
        views.setTextViewTextSize(R.id.pvp_crystal_current, TypedValue.COMPLEX_UNIT_SP, baseText)
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
        if (compact && (largeText || density == PvpDensity.MINI)) {
            views.setViewVisibility(R.id.pvp_heading, View.GONE)
            views.setViewVisibility(R.id.pvp_status, View.GONE)
            views.setViewVisibility(R.id.pvp_front_label, View.GONE)
            views.setViewVisibility(R.id.pvp_crystal_label, View.GONE)
            fun readable(label: String, name: String): SpannableString =
                SpannableString("$label $name").apply {
                    setSpan(RelativeSizeSpan(0.65f), 0, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            views.setTextViewText(R.id.pvp_front_current, readable("前线", currentFront))
            views.setTextViewText(R.id.pvp_crystal_current, readable("水晶", currentCrystal))
            val readableSize = if (density == PvpDensity.MINI) minOf(12f, 12.5f / context.resources.configuration.fontScale)
                else minOf(13f, 15.5f / context.resources.configuration.fontScale)
            views.setTextViewTextSize(R.id.pvp_front_current, TypedValue.COMPLEX_UNIT_SP, readableSize)
            views.setTextViewTextSize(R.id.pvp_crystal_current, TypedValue.COMPLEX_UNIT_SP, readableSize)
        }
        if (!compact) {
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
            }
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(WidgetData.SITE)).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        return views
    }

    private fun contentPadding(density: PvpDensity) = when (density) {
        PvpDensity.MINI -> 6
        PvpDensity.SMALL -> 8
        else -> 10
    }

    private fun baseTextSize(density: PvpDensity) = when (density) {
        PvpDensity.MINI -> 12f
        PvpDensity.SMALL -> 14f
        else -> 16f
    }

    private fun countdown(views: RemoteViews, view: Int, until: Long, now: Long) {
        views.setChronometer(view, SystemClock.elapsedRealtime() + until - now, null, true)
        views.setChronometerCountDown(view, true)
    }
}
