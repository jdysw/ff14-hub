package uk.zhixia.ff14hub.widgets.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowBuild
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uk.zhixia.ff14hub.widgets.R
import uk.zhixia.ff14hub.widgets.WidgetData

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PvpWidgetLayoutTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private fun render(density: PvpDensity, using: Context = context, at: Long = 1792548600000L, stacked: Boolean = false): View = PvpWidgetRenderer.build(using, density,
        WidgetData.cached(using)!!, at, stacked = stacked).apply(using, FrameLayout(using))

    @Test fun compactShowsBothCurrentMapsWithoutNextOrSchedule() {
        val view = render(PvpDensity.SMALL)
        assertEquals("战场", view.findViewById<TextView>(R.id.pvp_front_label).text.toString())
        assertEquals("55", view.findViewById<TextView>(R.id.pvp_crystal_label).text.toString())
        assertEquals("尘封秘岩", view.findViewById<TextView>(R.id.pvp_front_current).text.toString())
        assertEquals("赤土红沙", view.findViewById<TextView>(R.id.pvp_crystal_current).text.toString())
        assertNull(view.findViewById<View>(R.id.pvp_front_next))
        assertNull(view.findViewById<View>(R.id.pvp_schedule_section))
    }
    @Test fun miniUsesApprovedShortLabelsAndKeepsFullAccessibleModeNames() {
        val view = render(PvpDensity.MINI)
        assertEquals("战场", view.findViewById<TextView>(R.id.pvp_front_label).text.toString())
        assertEquals("55", view.findViewById<TextView>(R.id.pvp_crystal_label).text.toString())
        assertEquals("尘封秘岩", view.findViewById<TextView>(R.id.pvp_front_current).text.toString())
        assertTrue(view.contentDescription.contains("纷争前线"))
        assertTrue(view.contentDescription.contains("水晶冲突"))
    }
    @Test fun compactRowsKeepEqualLabelColumnsAndMapInsets() {
        val directory = java.io.File("build/outputs/widget-gallery").apply { mkdirs() }
        for (night in listOf(false, true)) for (font in listOf(1f, 2f)) {
            for ((width, height) in listOf(109 to 56, 140 to 72, 140 to 100)) {
                verifyAlignedCompact(night, font, width, height, directory)
            }
        }
    }

    private fun verifyAlignedCompact(night: Boolean, font: Float, width: Int, height: Int, directory: java.io.File) {
            val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
                fontScale = font
                uiMode = (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO) or Configuration.UI_MODE_TYPE_NORMAL
            })
                val tier = PvpPresentation.density(width.toFloat(), height.toFloat())
                val payload = PvpWidgetRenderer.build(context, tier, WidgetData.cached(context)!!, 1792548600000L)
                val root = payload.apply(using, FrameLayout(using))
                val w = (width * using.resources.displayMetrics.density).toInt()
                val h = (height * using.resources.displayMetrics.density).toInt()
                root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                root.layout(0, 0, w, h)
                val frontLabel = root.findViewById<TextView>(R.id.pvp_front_label)
                val crystalLabel = root.findViewById<TextView>(R.id.pvp_crystal_label)
                val frontMap = root.findViewById<TextView>(R.id.pvp_front_current)
                val crystalMap = root.findViewById<TextView>(R.id.pvp_crystal_current)
                assertEquals(frontLabel.width, crystalLabel.width)
                assertEquals(frontMap.left, crystalMap.left)
                assertEquals(frontMap.baseline, crystalMap.baseline)
                assertTrue(kotlin.math.abs(frontMap.height - crystalMap.height) <= 1)
                for (text in listOf(frontLabel, crystalLabel, frontMap, crystalMap)) {
                    assertEquals(View.VISIBLE, text.visibility)
                    assertTrue("compact clips ${text.text} at $width x $height font=$font", text.layout.height <= text.height)
                }
                inspectVisibleBounds(root, 0, h, "aligned compact $width x $height font=$font")
                if (font == 1f) {
                    val image = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    try { root.draw(Canvas(image)); java.io.File(directory, "${if (night) "dark" else "light"}-pvp-aligned-${width}x$height.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
                    finally { image.recycle() }
                }
    }

    @Test fun cachedMiniFitsAfterHostFontScaleChangesWithoutProviderRefresh() {
        val payload = PvpWidgetRenderer.build(context, PvpDensity.MINI, WidgetData.cached(context)!!, 1792548600000L)
        val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply { fontScale = 2f })
        val root = payload.apply(using, FrameLayout(using))
        val w = (109 * using.resources.displayMetrics.density).toInt()
        val h = (56 * using.resources.displayMetrics.density).toInt()
        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, w, h)
        inspectVisibleBounds(root, 0, h, "cached MINI 109x56 at font=2")
    }

    @Test fun cachedCountdownsFitOneLineAfterHostFontScaleChanges() {
        val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply { fontScale = 2f })
        for (density in listOf(PvpDensity.MEDIUM, PvpDensity.LARGE)) {
            val payload = PvpWidgetRenderer.build(context, density, WidgetData.cached(context)!!, 1792548600000L)
            val root = payload.apply(using, FrameLayout(using))
            val timers = listOf(R.id.pvp_front_countdown, R.id.pvp_crystal_countdown).map { root.findViewById<TextView>(it) }
            timers.forEach { it.text = "23:59:59" }
            val w = (260 * using.resources.displayMetrics.density).toInt()
            val h = (340 * using.resources.displayMetrics.density).toInt()
            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, w, h)
            for (timer in timers) {
                assertEquals("$density countdown wraps", 1, timer.layout.lineCount)
                assertTrue("$density countdown clips horizontally", timer.layout.getLineWidth(0) <= timer.width - timer.paddingLeft - timer.paddingRight)
                assertTrue("$density countdown clips vertically", timer.layout.height <= timer.height - timer.paddingTop - timer.paddingBottom)
                assertEquals("$density countdown truncates", 0, timer.layout.getEllipsisCount(0))
            }
        }
    }

    @Test fun cachedScheduleKeepsAllThreeRoundsAfterHostFontScaleChanges() {
        val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply { fontScale = 2f })
        val payload = PvpWidgetRenderer.build(context, PvpDensity.LARGE, WidgetData.cached(context)!!, 1792548600000L)
        val root = payload.apply(using, FrameLayout(using))
        val w = (280 * using.resources.displayMetrics.density).toInt()
        val h = (260 * using.resources.displayMetrics.density).toInt()
        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, w, h)
        inspectVisibleBounds(root, 0, h, "cached schedule at font=2")
        for (id in listOf(R.id.pvp_front_slot_1_time, R.id.pvp_front_slot_1_map,
            R.id.pvp_front_slot_2_time, R.id.pvp_front_slot_2_map, R.id.pvp_front_slot_3_time, R.id.pvp_front_slot_3_map,
            R.id.pvp_crystal_slot_1_time, R.id.pvp_crystal_slot_1_map, R.id.pvp_crystal_slot_2_time,
            R.id.pvp_crystal_slot_2_map, R.id.pvp_crystal_slot_3_time, R.id.pvp_crystal_slot_3_map)) {
            val text = root.findViewById<TextView>(id)
            assertTrue("cached schedule clips ${text.text}: layout=${text.layout.height}, height=${text.height}, size=${text.textSize}", text.layout.height <= text.height - text.paddingTop - text.paddingBottom)
        }
    }

    @Test fun mediumAddsBothNextMapsAndCountdowns() {
        val view = render(PvpDensity.MEDIUM)
        assertEquals("下轮 周边遗迹群", view.findViewById<TextView>(R.id.pvp_front_next).text.toString())
        assertEquals("23:00 换图", view.findViewById<TextView>(R.id.pvp_front_boundary).text.toString())
        assertEquals("下张 角力学校", view.findViewById<TextView>(R.id.pvp_crystal_next).text.toString())
        assertNotNull(view.findViewById<View>(R.id.pvp_front_countdown))
        assertNotNull(view.findViewById<View>(R.id.pvp_crystal_countdown))
        assertNull(view.findViewById<View>(R.id.pvp_schedule_section))
    }

    @Test fun largeShowsThreeFutureRotationsForBothModes() {
        val view = render(PvpDensity.LARGE)
        assertEquals("10/21 23:00", view.findViewById<TextView>(R.id.pvp_front_slot_1_time).text.toString())
        assertEquals("周边遗迹群", view.findViewById<TextView>(R.id.pvp_front_slot_1_map).text.toString())
        assertEquals("10/23 23:00", view.findViewById<TextView>(R.id.pvp_front_slot_3_time).text.toString())
        assertEquals("11:00", view.findViewById<TextView>(R.id.pvp_crystal_slot_1_time).text.toString().substringAfter(' '))
        assertEquals("13:00", view.findViewById<TextView>(R.id.pvp_crystal_slot_3_time).text.toString().substringAfter(' '))
    }

    @Test fun everyVisibleFieldFitsItsDesignedSize() {
        for (fontScale in listOf(1f, 1.15f, 1.3f, 2f)) {
            for ((width, height) in listOf(109 to 56, 140 to 72, 120 to 88, 140 to 100, 220 to 120, 280 to 140, 120 to 220, 260 to 240, 280 to 260)) {
                for (now in listOf(1792548600000L, java.time.Instant.parse("2026-10-23T02:10:00Z").toEpochMilli())) {
                    assertDesignedSize(fontScale, width, height, now)
                }
            }
        }
    }

    private fun assertDesignedSize(fontScale: Float, width: Int, height: Int, now: Long) {
        val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            this.fontScale = fontScale
        })
        val density = PvpPresentation.density(width.toFloat(), height.toFloat(), fontScale)
        val root = render(density, using, now, width < 220)
        val scale = using.resources.displayMetrics.density
        val w = (width * scale).toInt()
        val h = (height * scale).toInt()
        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, w, h)
        inspectVisibleBounds(root, 0, h, density.toString() + " " + width + "x" + height + " font=" + fontScale)
    }

    private fun inspectVisibleBounds(view: View, parentTop: Int, height: Int, label: String) {
        if (view.visibility != View.VISIBLE) return
        val top = parentTop + view.top
        if (view is TextView) inspectTextBounds(view, top, height, label)
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) inspectVisibleBounds(view.getChildAt(i), top, height, label)
        }
    }

    private fun inspectTextBounds(view: TextView, top: Int, height: Int, label: String) {
        if (view.text.isNotEmpty()) assertTrue(label + " has zero height for " + view.text, view.height > 0)
        assertTrue(label + " clips " + view.text + ": top=" + top + " height=" + view.height + " limit=" + height,
            top + view.height <= height)
        val textLayout = view.layout ?: return
        for (line in 0 until textLayout.lineCount) {
            assertEquals(label + " ellipsizes " + view.text, 0, textLayout.getEllipsisCount(line))
        }
    }

    @Test @Config(qualifiers = "night") fun darkThemeUsesReadableDedicatedColors() {
        val view = render(PvpDensity.MEDIUM)
        assertEquals(context.getColor(R.color.pvp_text), view.findViewById<TextView>(R.id.pvp_front_current).currentTextColor)
        assertEquals(0xFFF0F4F8.toInt(), view.findViewById<TextView>(R.id.pvp_front_current).currentTextColor)
    }

    @Test @Config(sdk = [30, 35]) fun sameLegacyWidgetChangesDensityAfterResizeCallback() {
        val manager = AppWidgetManager.getInstance(context)
        val info = AppWidgetProviderInfo().apply { provider = ComponentName(context, FrontlineWidgetProvider::class.java) }
        val shadow = shadowOf(manager)
        shadow.addBoundWidget(501, info)
        fun resize(width: Int, height: Int): View {
            val options = Bundle().apply {
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height)
            }
            manager.updateAppWidgetOptions(501, options)
            FrontlineWidgetProvider().onAppWidgetOptionsChanged(context, manager, 501, options)
            return shadow.getViewFor(501)
        }
        assertNull(resize(155, 155).findViewById<View>(R.id.pvp_front_next))
        assertNotNull(resize(320, 180).findViewById<View>(R.id.pvp_front_next))
        assertNotNull(resize(320, 340).findViewById<View>(R.id.pvp_schedule_section))
        assertNull(resize(155, 155).findViewById<View>(R.id.pvp_front_next))
    }

    @Test fun resizeBreakpointsDependOnBothDimensionsAndFontScale() {
        assertEquals(PvpDensity.MINI, PvpPresentation.density(119f, 500f))
        assertEquals(PvpDensity.MINI, PvpPresentation.density(280f, 70f))
        assertEquals(PvpDensity.MEDIUM, PvpPresentation.density(155f, 340f))
        assertEquals(PvpDensity.SMALL, PvpPresentation.density(320f, 119f))
        assertEquals(PvpDensity.MEDIUM, PvpPresentation.density(280f, 180f))
        assertEquals(PvpDensity.LARGE, PvpPresentation.density(280f, 320f))
        assertEquals(PvpDensity.SMALL, PvpPresentation.density(320f, 180f, 2f))
        assertEquals(PvpDensity.MEDIUM, PvpPresentation.density(320f, 340f, 2f))
    }

    @Test fun reusedCompactViewKeepsAlignedLabelsAcrossFontModes() {
        val largeFont = context.createConfigurationContext(Configuration(context.resources.configuration).apply { fontScale = 2f })
        val snapshot = WidgetData.cached(context)!!
        val view = PvpWidgetRenderer.build(largeFont, PvpDensity.SMALL, snapshot, 1792548600000L)
            .apply(largeFont, FrameLayout(largeFont))
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.pvp_front_label).visibility)
        assertEquals(View.GONE, view.findViewById<View>(R.id.pvp_status).visibility)
        PvpWidgetRenderer.build(context, PvpDensity.SMALL, snapshot, 1792548600000L).reapply(context, view)
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.pvp_front_label).visibility)
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.pvp_crystal_label).visibility)
        assertEquals(View.GONE, view.findViewById<View>(R.id.pvp_status).visibility)
        assertEquals("尘封秘岩", view.findViewById<TextView>(R.id.pvp_front_current).text.toString())
        assertEquals((6 * context.resources.displayMetrics.density).toInt(), view.findViewById<View>(R.id.pvp_content).paddingLeft)
    }

    @Test fun unsupportedSizesStillHaveOpaqueSurfaceEvenIfHostClearsRootBackground() {
        for ((width, height) in listOf(96 to 64, 110 to 72, 140 to 100, 210 to 115, 280 to 140, 280 to 260)) {
            val tier = PvpPresentation.density(width.toFloat(), height.toFloat())
            val root = render(tier, stacked = width < 220)
            root.background = null // Reproduce the reported disappearing root surface.
            val scale = context.resources.displayMetrics.density
            val w = (width * scale).toInt()
            val h = (height * scale).toInt()
            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, w, h)
            val image = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            try {
                root.draw(Canvas(image))
                assertEquals("$width x $height lost surface", 255, Color.alpha(image.getPixel(w / 2, h / 2)))
                assertNotNull(root.findViewById<View>(R.id.pvp_background))
                assertEquals(View.GONE, root.findViewById<View>(R.id.pvp_status).visibility)
            } finally { image.recycle() }
        }
    }

    @Test fun cachedRemoteViewsRebuiltInNightModeResolveXmlPalette() {
        val snapshot = WidgetData.cached(context)!!
        val payload = PvpWidgetRenderer.build(context, PvpDensity.SMALL, snapshot, 1792548600000L)
        val night = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            uiMode = Configuration.UI_MODE_NIGHT_YES or Configuration.UI_MODE_TYPE_NORMAL
        })
        val rebuilt = payload.apply(night, FrameLayout(night))
        assertEquals(0xFFF0F4F8.toInt(), rebuilt.findViewById<TextView>(R.id.pvp_front_current).currentTextColor)
    }

    @Test fun xiaomiUsesClassicDimensionsWhenHostAlsoReportsSizeArray() {
        ShadowBuild.setManufacturer("Xiaomi")
        val manager = AppWidgetManager.getInstance(context)
        val info = AppWidgetProviderInfo().apply { provider = ComponentName(context, FrontlineWidgetProvider::class.java) }
        shadowOf(manager).addBoundWidget(502, info)
        manager.updateAppWidgetOptions(502, Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 280)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 140)
            putParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, arrayListOf(android.util.SizeF(280f, 140f)))
        })
        WidgetRenderer.updateIds(context, manager, intArrayOf(502), WidgetKind.FRONTLINE)
        assertNotNull(shadowOf(manager).getViewFor(502).findViewById<View>(R.id.pvp_front_next))
    }
}
