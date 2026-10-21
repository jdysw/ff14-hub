package uk.zhixia.ff14hub.widgets.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.res.Configuration
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
        assertEquals("尘封秘岩", view.findViewById<TextView>(R.id.pvp_front_current).text.toString())
        assertEquals("赤土红沙", view.findViewById<TextView>(R.id.pvp_crystal_current).text.toString())
        assertNull(view.findViewById<View>(R.id.pvp_front_next))
        assertNull(view.findViewById<View>(R.id.pvp_schedule_section))
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
        for (fontScale in listOf(1f, 1.15f, 1.3f, 2f)) for ((width, height) in listOf(155 to 155, 240 to 180, 320 to 180, 140 to 320, 320 to 340))
            for (now in listOf(1792548600000L, java.time.Instant.parse("2026-10-23T02:10:00Z").toEpochMilli())) {
            val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
                this.fontScale = fontScale
            })
            val density = PvpPresentation.density(width.toFloat(), height.toFloat(), fontScale)
            val root = render(density, using, now, width < 240)
            val scale = using.resources.displayMetrics.density
            val w = (width * scale).toInt()
            val h = (height * scale).toInt()
            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, w, h)
            fun inspect(view: View, parentTop: Int) {
                if (view.visibility != View.VISIBLE) return
                val top = parentTop + view.top
                if (view is TextView) {
                    if (view.text.isNotEmpty()) assertTrue("$density ${width}x$height font=$fontScale has zero height for ${view.text}", view.height > 0)
                    assertTrue("$density clips ${view.text}: top=$top height=${view.height} limit=$h font=$fontScale", top + view.height <= h)
                    val textLayout = view.layout
                    if (textLayout != null) for (line in 0 until textLayout.lineCount)
                        assertEquals("$density ellipsizes ${view.text}", 0, textLayout.getEllipsisCount(line))
                }
                if (view is ViewGroup) for (i in 0 until view.childCount) inspect(view.getChildAt(i), top)
            }
            inspect(root, 0)
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
        assertEquals(PvpDensity.SMALL, PvpPresentation.density(139f, 500f))
        assertEquals(PvpDensity.MEDIUM, PvpPresentation.density(155f, 340f))
        assertEquals(PvpDensity.SMALL, PvpPresentation.density(320f, 179f))
        assertEquals(PvpDensity.MEDIUM, PvpPresentation.density(280f, 180f))
        assertEquals(PvpDensity.LARGE, PvpPresentation.density(280f, 320f))
        assertEquals(PvpDensity.SMALL, PvpPresentation.density(320f, 180f, 2f))
        assertEquals(PvpDensity.MEDIUM, PvpPresentation.density(320f, 340f, 2f))
    }

    @Test fun reusedCompactViewRestoresLabelsAfterLargeFontMode() {
        val largeFont = context.createConfigurationContext(Configuration(context.resources.configuration).apply { fontScale = 2f })
        val snapshot = WidgetData.cached(context)!!
        val view = PvpWidgetRenderer.build(largeFont, PvpDensity.SMALL, snapshot, 1792548600000L)
            .apply(largeFont, FrameLayout(largeFont))
        assertEquals(View.GONE, view.findViewById<View>(R.id.pvp_front_label).visibility)
        assertEquals(View.GONE, view.findViewById<View>(R.id.pvp_status).visibility)
        PvpWidgetRenderer.build(context, PvpDensity.SMALL, snapshot, 1792548600000L).reapply(context, view)
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.pvp_front_label).visibility)
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.pvp_crystal_label).visibility)
        assertEquals(View.VISIBLE, view.findViewById<View>(R.id.pvp_status).visibility)
        assertEquals("尘封秘岩", view.findViewById<TextView>(R.id.pvp_front_current).text.toString())
        assertEquals((12 * context.resources.displayMetrics.density).toInt(), view.paddingLeft)
    }
}
