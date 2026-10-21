package uk.zhixia.ff14hub.widgets.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import uk.zhixia.ff14hub.widgets.WidgetData

/**
 * 本机地图轮换事件：避免桌面仅靠 15 分钟联网刷新导致整点后地图文字过期。
 * 使用无需“精确闹钟”特殊权限的 setAndAllowWhileIdle；在省电模式下仍可能延迟。
 */
class PvpRolloverReceiver: BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION_ROTATION) return
        WidgetRenderer.updateAll(context)
        schedule(context)
    }
    companion object {
        private const val ACTION_ROTATION="uk.zhixia.ff14hub.widgets.PVP_ROLLOVER"
        private const val CODE=841
        private fun pending(context: Context): PendingIntent {
            val intent=Intent(context,PvpRolloverReceiver::class.java).apply { action=ACTION_ROTATION }
            return PendingIntent.getBroadcast(context,CODE,intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        fun schedule(context: Context) {
            val manager=context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val alarm=pending(context)
            if (WidgetRenderer.activeWidgetCount(context)==0) {
                manager.cancel(alarm)
                return
            }
            val snapshot=WidgetData.cached(context) ?: return
            val now=System.currentTimeMillis()
            val times=mutableListOf<Long>()
            for (mode in listOf("frontline","crystalline")) {
                try {
                    val rule=snapshot.getJSONObject("pvp").getJSONObject(mode)
                    val start=rule.getLong("anchorUtcMs")
                    val period=rule.getLong("periodMs")
                    if (period<=0) continue
                    val step=Math.floorDiv(now-start,period)
                    times.add(start+(step+1)*period)
                }catch (_: Exception) { /* 旧缓存格式不支持轮换，不安排闹钟 */ }
            }
            val next=times.filter { it>now }.minOrNull() ?: return
            // 下一轮换时刻到达即主动刷新。此处不创建系统通知、也不联网。
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,next,alarm)
        }
    }
}
