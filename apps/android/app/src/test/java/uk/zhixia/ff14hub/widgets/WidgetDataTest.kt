package uk.zhixia.ff14hub.widgets

import android.content.Context
import android.app.AlarmManager
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.Shadows.shadowOf
import uk.zhixia.ff14hub.widgets.widgets.FrontlineWidgetProvider
import uk.zhixia.ff14hub.widgets.widgets.CrystallineWidgetProvider
import uk.zhixia.ff14hub.widgets.widgets.FishWidgetProvider
import uk.zhixia.ff14hub.widgets.widgets.PvpRolloverReceiver
import uk.zhixia.ff14hub.widgets.widgets.RotationMath

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetDataTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Before fun clear() {
        context.getSharedPreferences("widget_preferences", Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun snapshot(): JSONObject {
        val now = System.currentTimeMillis()
        fun rule(period: Long): JSONObject {
            val anchor = 1_792_512_000_000L
            val rotation = RotationMath.at(now, anchor, 0, period, listOf("A", "B", "C"))
            return JSONObject().put("anchorUtcMs", anchor).put("anchorIndex", 0)
                .put("periodMs", period).put("cycle", JSONArray(listOf("A", "B", "C")))
                .put("ruleVersion", "test-cn-v1").put("current", rotation.current)
                .put("next", rotation.next).put("startsAtMs", rotation.changesAtMs - period)
                .put("changesAtMs", rotation.changesAtMs)
        }
        return JSONObject().put("schemaVersion", 1).put("timezone", "Asia/Shanghai")
            .put("region", "cn").put("generatedAtMs", now).put("refreshAfterMs", now + 900_000)
            .put("staleAfterMs", now + 7_200_000)
            .put("pvp", JSONObject().put("frontline", rule(86_400_000)).put("crystalline", rule(3_600_000)))
            .put("fish", JSONObject().put("status", "selection_required").put("items", JSONArray()))
            .put("events", JSONObject().put("status", "ready").put("sourceCheckedAtMs", now)
                .put("items", JSONArray().put(JSONObject().put("id", "cn-only").put("title", "国服活动")
                    .put("startsAtMs", now - 1000).put("endsAtMs", now + 3600000))))
    }

    private fun seed(): JSONObject = snapshot().also {
        assertTrue(WidgetData.accept(context, it.toString(), WidgetData.selection(context)))
    }

    @Test fun unchangedSettingsKeepCompleteOfflineSnapshot() {
        val expected = seed()
        WidgetData.saveSettings(context, "cn", "")
        assertEquals(expected.toString(), WidgetData.cached(context).toString())
    }

    @Test fun changedSelectionPreservesPvpButIsolatesUnrelatedData() {
        val expected = seed().getJSONObject("pvp").toString()
        WidgetData.saveSettings(context, "global", "123")
        val cached = WidgetData.cached(context)!!
        assertEquals(expected, cached.getJSONObject("pvp").toString())
        assertEquals("global", cached.getString("region"))
        assertEquals("unavailable", cached.getJSONObject("fish").getString("status"))
        assertEquals(0, cached.getJSONObject("events").getJSONArray("items").length())
    }

    @Test fun settingsChangedAndChangedBackStillRejectOldResponse() {
        seed()
        val request = WidgetData.selection(context)
        val response = snapshot().toString()
        WidgetData.saveSettings(context, "global", "")
        WidgetData.saveSettings(context, "cn", "")
        assertFalse(WidgetData.accept(context, response, request))
        assertEquals(0, WidgetData.cached(context)!!.getJSONObject("events").getJSONArray("items").length())
    }

    @Test fun malformedRotationDoesNotReplaceSuccessfulCache() {
        val expected = seed().toString()
        for (field in listOf("periodMs", "anchorIndex", "cycle", "ruleVersion")) {
            val bad = snapshot()
            val rule = bad.getJSONObject("pvp").getJSONObject("crystalline")
            when (field) {
                "periodMs" -> rule.put(field, 0)
                "anchorIndex" -> rule.put(field, 99)
                "cycle" -> rule.put(field, JSONArray())
                else -> rule.put(field, "")
            }
            assertThrows(IllegalArgumentException::class.java) {
                WidgetData.accept(context, bad.toString(), WidgetData.selection(context))
            }
            assertEquals(expected, WidgetData.cached(context).toString())
        }
    }

    @Test fun unknownSchemaAndInconsistentCurrentMapAreRejected() {
        val bad = snapshot().put("schemaVersion", 2)
        assertThrows(IllegalArgumentException::class.java) {
            WidgetData.accept(context, bad.toString(), WidgetData.selection(context))
        }
        val mismatched = snapshot()
        mismatched.getJSONObject("pvp").getJSONObject("frontline").put("current", "wrong")
        assertThrows(IllegalArgumentException::class.java) {
            WidgetData.accept(context, mismatched.toString(), WidgetData.selection(context))
        }
        assertTrue(WidgetData.cached(context)!!.getBoolean("bundledRules"))
    }

    private fun bind(id: Int, provider: Class<*>) {
        val info = AppWidgetProviderInfo().apply { this.provider = ComponentName(context, provider) }
        shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(id, info)
    }

    @Test fun frontlineOnlySchedulesDailyBoundary() {
        val body = seed()
        bind(100, FrontlineWidgetProvider::class.java)
        PvpRolloverReceiver.schedule(context)
        val alarms = shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms
        assertEquals(1, alarms.size)
        assertEquals(body.getJSONObject("pvp").getJSONObject("frontline").getLong("changesAtMs"),
            alarms.single().triggerAtMs)
        assertTrue(alarms.single().isAllowWhileIdle)
    }

    @Test fun crystallineAndFrontlineShareOneAlarmAtEarliestBoundary() {
        val body = seed()
        bind(100, FrontlineWidgetProvider::class.java)
        bind(101, CrystallineWidgetProvider::class.java)
        PvpRolloverReceiver.schedule(context)
        PvpRolloverReceiver.schedule(context)
        val alarms = shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms
        assertEquals(1, alarms.size)
        assertEquals(body.getJSONObject("pvp").getJSONObject("crystalline").getLong("changesAtMs"),
            alarms.single().triggerAtMs)
    }

    @Test fun fishOnlyHasNoPvpAlarm() {
        seed()
        bind(100, FishWidgetProvider::class.java)
        PvpRolloverReceiver.schedule(context)
        assertTrue(shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.isEmpty())
    }

    @Test fun lostNetworkCacheStillSchedulesBundledOfflineRules() {
        seed()
        bind(100, FrontlineWidgetProvider::class.java)
        PvpRolloverReceiver.schedule(context)
        context.getSharedPreferences("widget_preferences", Context.MODE_PRIVATE).edit().clear().commit()
        PvpRolloverReceiver.schedule(context)
        assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
        assertTrue(WidgetData.cached(context)!!.getBoolean("bundledRules"))
    }

    @Test fun firstInstallWorksOfflineAndMalformedAssetCannotMasqueradeAsLiveData() {
        val cached = WidgetData.cached(context)!!
        assertTrue(cached.getBoolean("bundledRules"))
        assertEquals("unavailable", cached.getJSONObject("events").getString("status"))
        assertEquals("selection_required", cached.getJSONObject("fish").getString("status"))
        assertEquals("2026-10-21-cn-v1", cached.getJSONObject("pvp")
            .getJSONObject("frontline").getString("ruleVersion"))
    }
}
