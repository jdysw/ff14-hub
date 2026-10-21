package uk.zhixia.ff14hub.widgets.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import uk.zhixia.ff14hub.widgets.WidgetData
import uk.zhixia.ff14hub.widgets.SnapshotValidator

/**
 * 本机地图轮换事件：避免桌面仅靠 15 分钟联网刷新导致整点后地图文字过期。
 * 使用无需“精确闹钟”特殊权限的 setAndAllowWhileIdle；在省电模式下仍可能延迟。
 */
class PvpRolloverReceiver: BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action !in setOf(ACTION_ROTATION, Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED,
                Intent.ACTION_TIMEZONE_CHANGED)) return
        WidgetRenderer.updateAll(context)
        schedule(context)
        if (WidgetRenderer.activeWidgetCount(context) > 0) WidgetScheduler.start(context)
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
            // Cancel first: missing/invalid cache must not leave an obsolete alarm armed.
            manager.cancel(alarm)
            val modes = WidgetRenderer.activePvpModes(context)
            if (modes.isEmpty()) return
            val snapshot=WidgetData.cached(context) ?: return
            val now=System.currentTimeMillis()
            val times=mutableListOf<Long>()
            for (mode in modes) {
                try {
                    val rule=snapshot.getJSONObject("pvp").getJSONObject(mode)
                    times.add(SnapshotValidator.rotation(rule, now).changesAtMs)
                }catch (_: Exception) { /* 旧缓存格式不支持轮换，不安排闹钟 */ }
            }
            val next=times.filter { it>now }.minOrNull() ?: return
            // 下一轮换时刻到达即主动刷新。此处不创建系统通知、也不联网。
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,next,alarm)
        }
    }
}
