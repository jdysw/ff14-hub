package uk.zhixia.ff14hub.widgets

import org.json.JSONObject
import uk.zhixia.ff14hub.widgets.widgets.RotationMath
import uk.zhixia.ff14hub.widgets.widgets.RotationResult

/** Validate before replacing a working cache, including every field used by RemoteViews. */
object SnapshotValidator {
    private const val MAX_TIME = 4_102_444_800_000L // 2100-01-01; avoids arithmetic overflow.
    private fun time(body: JSONObject, key: String): Long {
        val value = body.get(key)
        require(value is Number && value.toDouble().isFinite()) { "时间戳无效" }
        val ms = value.toLong()
        require(value.toDouble() == ms.toDouble() && ms in 0..MAX_TIME) { "时间戳无效" }
        return ms
    }

    fun rotation(rule: JSONObject, now: Long): RotationResult {
        val anchor = time(rule, "anchorUtcMs")
        val period = time(rule, "periodMs")
        require(period in 60_000..604_800_000) { "轮换周期无效" }
        val array = rule.getJSONArray("cycle")
        require(array.length() in 1..12)
        val cycle = (0 until array.length()).map { array.getString(it).also { name ->
            require(name.isNotBlank() && name.length <= 100)
        } }
        val index = rule.getInt("anchorIndex")
        require(rule.getDouble("anchorIndex") == index.toDouble())
        require(rule.getString("ruleVersion").let { it.isNotBlank() && it.length <= 100 })
        return RotationMath.at(now, anchor, index, period, cycle)
    }

    fun validate(body: JSONObject, region: String, now: Long) {
        require(body.getInt("schemaVersion") == 1 && body.getDouble("schemaVersion") == 1.0)
        require(body.getString("timezone") == "Asia/Shanghai")
        require(body.getString("region") == region)
        val generated = time(body, "generatedAtMs")
        val refresh = time(body, "refreshAfterMs")
        val stale = time(body, "staleAfterMs")
        require(generated > 0 && generated < refresh && refresh < stale)
        require(generated <= now + 300_000) { "服务器时间异常" }
        for (mode in listOf("frontline", "crystalline")) {
            val rule = body.getJSONObject("pvp").getJSONObject(mode)
            val calculated = rotation(rule, generated)
            require(rule.getString("current") == calculated.current)
            require(rule.getString("next") == calculated.next)
            require(time(rule, "changesAtMs") == calculated.changesAtMs)
            require(time(rule, "startsAtMs") == calculated.changesAtMs - rule.getLong("periodMs"))
        }
        val fish = body.getJSONObject("fish")
        require(fish.getString("status") in listOf("ready", "selection_required", "unavailable"))
        val fishes = fish.getJSONArray("items")
        require(fishes.length() <= 20)
        for (i in 0 until fishes.length()) {
            val item = fishes.getJSONObject(i)
            require(item.getLong("fishId") > 0 && item.getString("name").isNotBlank())
            require(time(item, "startsAtMs") < time(item, "endsAtMs"))
            require(item.getString("validationStatus") in listOf("verified", "unverified", "incomplete"))
            item.getBoolean("candidateOnly")
        }
        val events = body.getJSONObject("events")
        require(events.getString("status") in listOf("ready", "stale", "unavailable"))
        if (!events.isNull("sourceCheckedAtMs")) time(events, "sourceCheckedAtMs")
        val items = events.getJSONArray("items")
        require(items.length() <= 5)
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            require(item.getString("id").isNotBlank() && item.getString("title").isNotBlank())
            require(time(item, "startsAtMs") < time(item, "endsAtMs"))
        }
    }
}
