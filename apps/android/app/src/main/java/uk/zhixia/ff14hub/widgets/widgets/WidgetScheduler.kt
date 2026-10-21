package uk.zhixia.ff14hub.widgets.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import uk.zhixia.ff14hub.widgets.WidgetData
import java.util.concurrent.TimeUnit

/** WorkManager 不保证精确整点刷新；未来计划通知需另行实现独立调度。 */
class WidgetRefreshWorker(context: Context, params: WorkerParameters): Worker(context, params) {
    override fun doWork(): Result {
        val success = WidgetData.refresh(applicationContext)
        WidgetRenderer.updateAll(applicationContext)
        return if (success) Result.success() else Result.retry()
    }
}

object WidgetScheduler {
    private const val PERIODIC = "ff14_hub_widget_refresh_v1"

    fun start(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED).build()
        val periodic = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints).build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic)
    }

    fun refreshNow(context: Context) {
        val job = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueue(job)
    }

    fun stopIfUnused(context: Context) {
        if (WidgetRenderer.activeWidgetCount(context) == 0)
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
    }
}

abstract class HubWidgetProvider(private val kind: WidgetKind): AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        super.onUpdate(context, manager, ids)
        WidgetRenderer.updateIds(context, manager, ids, kind)
        WidgetScheduler.start(context)
        WidgetScheduler.refreshNow(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        WidgetScheduler.stopIfUnused(context)
    }
}

class FrontlineWidgetProvider: HubWidgetProvider(WidgetKind.FRONTLINE)
class CrystallineWidgetProvider: HubWidgetProvider(WidgetKind.CRYSTALLINE)
class FishWidgetProvider: HubWidgetProvider(WidgetKind.FISH)
class EventsWidgetProvider: HubWidgetProvider(WidgetKind.EVENTS)
class OverviewWidgetProvider: HubWidgetProvider(WidgetKind.OVERVIEW)
