package uk.zhixia.ff14hub.widgets

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import uk.zhixia.ff14hub.widgets.widgets.PvpPresentation
import uk.zhixia.ff14hub.widgets.widgets.PvpWidgetRenderer

/** Uses the actual RemoteViews and current public rules; no separate mockup implementation. */
class PvpPreviewActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dp = resources.displayMetrics.density
        val available = resources.configuration.screenWidthDp - 32
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (32 * dp).toInt(), (16 * dp).toInt(), (32 * dp).toInt())
        }
        setContentView(ScrollView(this).apply { setBackgroundColor(getColor(R.color.pvp_surface)); addView(content) })
        fun label(text: String) {
            content.addView(TextView(this).apply {
                this.text = text
                textSize = 16f
                setTextColor(getColor(R.color.pvp_text))
                setPadding(0, (16 * dp).toInt(), 0, (12 * dp).toInt())
            })
        }
        label("PVP 战场 · 尺寸预览")
        val snapshot = WidgetData.cached(this) ?: return
        val now = System.currentTimeMillis()
        val variants = listOf(Triple("小 · 当前战场", 155, 155),
            Triple("中 · 当前、下轮与倒计时", 320, 180),
            Triple("大 · 接下来三轮", 320, 340))
        for ((name, desiredWidth, height) in variants) {
            label(name)
            val width = minOf(available, desiredWidth)
            val tier = PvpPresentation.density(width.toFloat(), height.toFloat(), resources.configuration.fontScale)
            val view = PvpWidgetRenderer.build(this, tier, snapshot, now).apply(this, content)
            content.addView(view, LinearLayout.LayoutParams((width * dp).toInt(), (height * dp).toInt()))
            if (BuildConfig.DEBUG) view.post {
                // Debug-only visual QA renders exactly the same native view as the launcher.
                runCatching {
                    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                    try {
                        view.draw(Canvas(bitmap))
                        java.io.File(cacheDir, "pvp-preview-${desiredWidth}x$height.png").outputStream().use {
                            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                        }
                    } finally { bitmap.recycle() }
                }
            }
        }
        label("桌面缩放时会自动切换。大字体优先保留当前战场，减少附加信息。")
    }
}
