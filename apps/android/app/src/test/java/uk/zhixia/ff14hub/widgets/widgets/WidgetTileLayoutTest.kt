package uk.zhixia.ff14hub.widgets.widgets

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uk.zhixia.ff14hub.widgets.R
import uk.zhixia.ff14hub.widgets.SnapshotValidator
import uk.zhixia.ff14hub.widgets.WidgetData
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetTileLayoutTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val now = 1792548600000L
    private fun snapshot(): JSONObject = WidgetData.cached(context)!!.apply {
        remove("bundledRules")
        put("generatedAtMs", now).put("refreshAfterMs", now + 900000).put("staleAfterMs", now + 7200000)
        put("fish", JSONObject().put("status", "ready").put("items", JSONArray().put(JSONObject()
            .put("fishId", 7678).put("name", "扎尔艾拉").put("startsAtMs", now - 60000).put("endsAtMs", now + 1800000)
            .put("validationStatus", "unverified").put("candidateOnly", true))))
        put("events", JSONObject().put("status", "ready").put("sourceCheckedAtMs", now).put("items", JSONArray().put(JSONObject()
            .put("id", "test-event").put("title", "测试快照：守护天节限时活动").put("startsAtMs", now - 60000).put("endsAtMs", now + 86400000))))
        SnapshotValidator.validate(this, "cn", now)
    }
    private fun render(using: Context, kind: WidgetKind, width: Int, height: Int, payload: JSONObject = snapshot()): View {
        val root = WidgetRenderer.buildTile(using, kind, payload, now, width = width, height = height).apply(using, FrameLayout(using))
        val density = using.resources.displayMetrics.density
        val w = (width * density).toInt()
        val h = (height * density).toInt()
        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, w, h)
        return root
    }
    private fun inspect(view: View, parentTop: Int, limit: Int, description: String) {
        if (view.visibility != View.VISIBLE) return
        val top = parentTop + view.top
        if (view is TextView && view.text.isNotEmpty()) {
            assertTrue("$description clips ${view.text}: $top + ${view.height} > $limit", top + view.height <= limit)
            assertTrue("$description hides ${view.text}", view.height > 0)
            view.layout?.let { assertTrue("$description clips text line ${view.text}", it.height + view.paddingTop + view.paddingBottom <= view.height) }
        }
        if (view is ViewGroup) for (i in 0 until view.childCount) inspect(view.getChildAt(i), top, limit, description)
    }
    @Test fun tilesFitTheirStandardAndExpandedSizesWithLargeFonts() {
        for (night in listOf(false, true)) for (font in listOf(1f, 1.15f, 1.3f, 2f)) {
            val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
                fontScale = font
                uiMode = (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO) or Configuration.UI_MODE_TYPE_NORMAL
            })
            for (kind in listOf(WidgetKind.FISH, WidgetKind.EVENTS, WidgetKind.OVERVIEW)) {
                for ((w, h) in listOf(180 to 110, 250 to 170, 280 to 140, 280 to 200)) {
                    val root = render(using, kind, w, h)
                    inspect(root, 0, root.height, "$kind ${w}x$h font=$font night=$night")
                }
            }
        }
    }
    @Test fun compactWarningsRemainVisibleAndFullContentIsAccessible() {
        val fish = render(context, WidgetKind.FISH, 180, 110)
        assertTrue(fish.findViewById<TextView>(R.id.widget_secondary).text.contains("候选"))
        assertTrue(fish.contentDescription.contains("预测待核实"))
        val stale = render(context, WidgetKind.EVENTS, 180, 110, snapshot().put("staleAfterMs", now - 1))
        assertTrue(stale.findViewById<TextView>(R.id.widget_secondary).text.contains("过期"))
    }
    @Test fun genericTilesKeepTheirSurfaceWhenLauncherClearsRootBackground() {
        for (kind in listOf(WidgetKind.FISH, WidgetKind.EVENTS, WidgetKind.OVERVIEW)) {
            val root = render(context, kind, 250, 170)
            root.background = null
            val image = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
            try { root.draw(Canvas(image)); assertEquals(255, Color.alpha(image.getPixel(root.width / 2, root.height / 2))) }
            finally { image.recycle() }
        }
    }
    @Test fun onlyPvpDeclaresTwoByOneByDefault() {
        for (resource in listOf(R.xml.frontline_widget_info)) {
            context.resources.getXml(resource).use { xml ->
                while (xml.eventType != org.xmlpull.v1.XmlPullParser.START_TAG) xml.next()
                val namespace = "http://schemas.android.com/apk/res/android"
                assertEquals("2", xml.getAttributeValue(namespace, "targetCellWidth"))
                assertEquals("1", xml.getAttributeValue(namespace, "targetCellHeight"))
                assertEquals("56.0dip", xml.getAttributeValue(namespace, "minResizeHeight"))
            }
        }
        for (resource in listOf(R.xml.fish_widget_info, R.xml.events_widget_info, R.xml.overview_widget_info)) {
            context.resources.getXml(resource).use { xml ->
                while (xml.eventType != org.xmlpull.v1.XmlPullParser.START_TAG) xml.next()
                assertNull(xml.getAttributeValue("http://schemas.android.com/apk/res/android", "targetCellHeight"))
            }
        }
    }
    @Test fun nativeRenderingExportsVisualReviewSamples() {
        val directory = File("build/outputs/widget-gallery").apply { mkdirs() }
        for (night in listOf(false, true)) {
            val using = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
                uiMode = (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO) or Configuration.UI_MODE_TYPE_NORMAL
            })
            for (kind in listOf(WidgetKind.FISH, WidgetKind.EVENTS, WidgetKind.OVERVIEW)) {
                for ((width, height) in listOf(180 to 110, 280 to 200)) {
                    val view = render(using, kind, width, height)
                    val image = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                    try { view.draw(Canvas(image)); File(directory, "${if (night) "dark" else "light"}-${kind.name.lowercase()}-${width}x$height.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
                    finally { image.recycle() }
                }
            }
        }
    }
}
