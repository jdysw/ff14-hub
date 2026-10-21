package uk.zhixia.ff14hub.widgets.widgets

import org.junit.Assert.assertEquals
import org.junit.Test

class RotationMathTest {
    private val frontline = listOf(
        "尘封秘岩（争夺战）","荣誉野（碎冰战）",
        "昂萨哈凯尔（竞争战）","沃刻其特（演习战）",
        "尘封秘岩（争夺战）","周边遗迹群（阵地战）",
        "昂萨哈凯尔（竞争战）","沃刻其特（演习战）"
    )
    private val crystal = listOf(
        "角力学校","火山之心","海岸斗场","九霄云上",
        "机关大殿","休兵书库","赤土红沙"
    )
    @Test fun frontlineOct21AndOct22() {
        val today = RotationMath.at(1792548600000L, 1792508400000L, 4,
            86400000L, frontline)
        assertEquals("尘封秘岩（争夺战）",today.current)
        assertEquals("周边遗迹群（阵地战）",today.next)
        val tomorrow = RotationMath.at(1792594800000L,1792508400000L,4,
            86400000L,frontline)
        assertEquals("周边遗迹群（阵地战）",tomorrow.current)
    }
    @Test fun crystalTurnsAtElevenBeijing() {
        val anchor=1792548000000L // 2026-10-21 02:00 UTC
        val current=RotationMath.at(anchor+600000L,anchor,6,3600000L,crystal)
        assertEquals("赤土红沙",current.current)
        assertEquals("角力学校",current.next)
        assertEquals(anchor+3600000L,current.changesAtMs)
        val next=RotationMath.at(anchor+3600000L,anchor,6,3600000L,crystal)
        assertEquals("角力学校",next.current)
    }
    @Test fun negativeStepsWrapWithoutDeviceTimezone() {
        val cycle=listOf("A","B","C")
        val older=RotationMath.at(0L, 3600000L,0,3600000L,cycle)
        assertEquals("C",older.current)
        assertEquals("A",older.next)
    }

    @Test fun boundaryMillisecondsAndFullCycle() {
        val anchor = 1792548000000L
        val hour = 3600000L
        assertEquals("休兵书库", RotationMath.at(anchor - 1, anchor, 6, hour, crystal).current)
        assertEquals(anchor, RotationMath.at(anchor - 1, anchor, 6, hour, crystal).changesAtMs)
        assertEquals("赤土红沙", RotationMath.at(anchor, anchor, 6, hour, crystal).current)
        assertEquals("赤土红沙", RotationMath.at(anchor + hour - 1, anchor, 6, hour, crystal).current)
        assertEquals("角力学校", RotationMath.at(anchor + hour, anchor, 6, hour, crystal).current)
        assertEquals("赤土红沙", RotationMath.at(anchor + 7 * hour, anchor, 6, hour, crystal).current)
    }

    @Test fun frontlineChangesAtBeijingTwentyThreeRegardlessOfTimezone() {
        val rollover = 1792594800000L // 2026-10-21 23:00 Asia/Shanghai
        val original = java.util.TimeZone.getDefault()
        try {
            for (zone in listOf("UTC", "America/Los_Angeles", "Asia/Tokyo")) {
                java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(zone))
                assertEquals("尘封秘岩（争夺战）", RotationMath.at(rollover - 1,
                    1792508400000L, 4, 86400000L, frontline).current)
                assertEquals("周边遗迹群（阵地战）", RotationMath.at(rollover,
                    1792508400000L, 4, 86400000L, frontline).current)
                assertEquals("周边遗迹群（阵地战）", RotationMath.at(rollover + 3600000L,
                    1792508400000L, 4, 86400000L, frontline).current)
            }
        } finally { java.util.TimeZone.setDefault(original) }
    }
}
