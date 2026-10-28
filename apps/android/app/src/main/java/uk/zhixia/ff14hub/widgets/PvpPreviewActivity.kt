package uk.zhixia.ff14hub.widgets

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.RemoteViews
import android.widget.ScrollView
import android.widget.TextView
import uk.zhixia.ff14hub.widgets.widgets.PvpPresentation
import uk.zhixia.ff14hub.widgets.widgets.PvpWidgetRenderer
import uk.zhixia.ff14hub.widgets.widgets.WidgetKind
import uk.zhixia.ff14hub.widgets.widgets.WidgetRenderer

/** Inflates the same RemoteViews used by the desktop; all content comes from the current cache. */
class PvpPreviewActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dp = resources.displayMetrics.density
        val available = resources.configuration.screenWidthDp - 32
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (32 * dp).toInt(), (16 * dp).toInt(), (32 * dp).toInt())
        }
        setContentView(ScrollView(this).apply { setBackgroundColor(getColor(R.color.widget_preview_surface)); addView(content) })
        fun label(text: String, size: Float = 14f): TextView = TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(getColor(R.color.pvp_text))
            setPadding(0, (12 * dp).toInt(), 0, (8 * dp).toInt())
        }
        content.addView(label("桌面小组件", 22f))
        content.addView(label("PVP 支持 2×1 · 其他组件保持标准尺寸", 12f))
        val snapshot = WidgetData.cached(this) ?: return
        val now = System.currentTimeMillis()
        fun card(name: String, key: String, width: Int, height: Int, remote: RemoteViews): LinearLayout {
            val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            column.addView(label(name, 12f))
            val view = remote.apply(this, column)
            column.addView(view, LinearLayout.LayoutParams((width * dp).toInt(), (height * dp).toInt()))
            if (BuildConfig.DEBUG) view.post {
                runCatching {
                    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                    try {
                        view.draw(Canvas(bitmap))
                        java.io.File(cacheDir, "widget-preview-$key.png").outputStream().use {
                            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                        }
                    } finally { bitmap.recycle() }
                }
            }
            return column
        }
        val compactWidth = minOf(140, available)
        content.addView(card("PVP · 2×1", "pvp-2x1", compactWidth, 72,
            PvpWidgetRenderer.build(this, PvpPresentation.density(compactWidth.toFloat(), 72f, resources.configuration.fontScale), snapshot, now)))
        for ((name, width, cardHeight) in listOf(Triple("PVP · 4×2", 280, 140), Triple("PVP · 4×4", 280, 260))) {
            val w = minOf(available, width)
            val tier = PvpPresentation.density(w.toFloat(), cardHeight.toFloat(), resources.configuration.fontScale)
            content.addView(card(name, "pvp-${width}x$cardHeight", w, cardHeight,
                PvpWidgetRenderer.build(this, tier, snapshot, now, stacked = w < 220)))
        }
        for ((kind, name) in listOf(WidgetKind.FISH to "关注鱼窗", WidgetKind.EVENTS to "国服活动", WidgetKind.OVERVIEW to "今日概览")) {
            val width = minOf(available, 280)
            content.addView(card(name, kind.name.lowercase(), width, 200,
                WidgetRenderer.buildTile(this, kind, snapshot, now, width = width, height = 200)))
        }
        content.addView(label("格子尺寸由桌面决定。支持明暗主题；大字体与窄矮尺寸会减少附加信息。", 12f))
    }
}
