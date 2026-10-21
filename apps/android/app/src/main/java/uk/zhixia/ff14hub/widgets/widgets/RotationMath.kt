package uk.zhixia.ff14hub.widgets.widgets

/** 可独立 JVM 测试的绝对 UTC 轮换计算，不依赖 Android 生命周期或设备时区。 */
data class RotationResult(val current:String,val next:String,val changesAtMs:Long)

object RotationMath {
    fun at(nowMs:Long,anchorUtcMs:Long,anchorIndex:Int,periodMs:Long,cycle:List<String>):RotationResult {
        require(periodMs>0 && cycle.isNotEmpty() && cycle.size<=12)
        require(anchorIndex in cycle.indices)
        val step=Math.floorDiv(nowMs-anchorUtcMs,periodMs)
        val index=Math.floorMod(step+anchorIndex.toLong(),cycle.size.toLong()).toInt()
        val changesAt=anchorUtcMs+(step+1)*periodMs
        return RotationResult(cycle[index],cycle[(index+1)%cycle.size],changesAt)
    }
}
