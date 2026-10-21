package uk.zhixia.ff14hub.widgets

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.graphics.Color
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import uk.zhixia.ff14hub.widgets.widgets.FrontlineWidgetProvider
import uk.zhixia.ff14hub.widgets.widgets.CrystallineWidgetProvider
import uk.zhixia.ff14hub.widgets.widgets.PvpLargeWidgetProvider
import uk.zhixia.ff14hub.widgets.widgets.WidgetRenderer
import uk.zhixia.ff14hub.widgets.widgets.WidgetScheduler

/** 无账号、无后台秘密：只配置区服和公开鱼 ID，其余详情在 FF14 Hub 网页管理。 */
class MainActivity: Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dp = resources.displayMetrics.density
        val padding = (20*dp).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding,padding,padding,padding)
        }
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
        fun label(text: String, size: Float = 15f): TextView = TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(Color.rgb(39,58,80))
            setPadding(0,(8*dp).toInt(),0,(8*dp).toInt())
            root.addView(this)
        }
        fun button(text: String, action: ()->Unit) {
            val button=Button(this).apply {
                this.text=text
                setOnClickListener{action()}
            }
            root.addView(button,LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        fun pin(provider: Class<*>) {
            val manager = AppWidgetManager.getInstance(this)
            if (manager.isRequestPinAppWidgetSupported)
                manager.requestPinAppWidget(ComponentName(this, provider), null, null)
            else Toast.makeText(this, "请长按桌面，在系统小部件列表中添加", Toast.LENGTH_LONG).show()
        }
        label("FF14 Hub · Android 小部件",22f)
        label("长按手机桌面 → 小部件 → FF14 Hub，选择 PVP、鱼窗、活动或综合概览。")
        button("添加 PVP 战场 · 小（2×2）") { pin(FrontlineWidgetProvider::class.java) }
        button("添加 PVP 战场 · 中（4×2）") { pin(CrystallineWidgetProvider::class.java) }
        button("添加 PVP 战场 · 大（4×4）") { pin(PvpLargeWidgetProvider::class.java) }
        button("预览三种尺寸") { startActivity(Intent(this, PvpPreviewActivity::class.java)) }
        label("同一组件可自由缩放，按实际空间自动切换信息密度。国服前线每日 23:00 换图，水晶冲突每小时整点换图。", 13f)
        label("关注鱼区服（PVP 轮换目前仅按国服规则；活动仅提供国服公共日历）")
        val region=Spinner(this)
        region.adapter=ArrayAdapter(this,android.R.layout.simple_spinner_dropdown_item,listOf("国服","国际服"))
        region.setSelection(if(WidgetData.region(this)=="cn")0 else 1)
        root.addView(region,LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
        label("关注鱼 ID（最多 10 个，逗号分隔；留空时鱼窗会提示配置）")
        val ids=EditText(this).apply {
            hint="如：123,456"
            setSingleLine(true)
            setText(WidgetData.fishIds(this@MainActivity))
        }
        root.addView(ids,LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
        val status=label("桌面数据会在网络可用时后台更新（通常不早于 15 分钟；系统可能延迟）。",13f)
        label("也可以按鱼名搜索，直接添加到关注列表")
        val fishSearch=EditText(this).apply {
            hint="输入鱼类名称"
            setSingleLine(true)
        }
        root.addView(fishSearch,LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
        button("搜索鱼名并添加关注") {
            val keyword=fishSearch.text.toString().trim()
            if(keyword.isEmpty()||keyword.length>60){
                status.text="请输入 1～60 字的鱼类名称"
            }else{
                status.text="正在读取公开鱼类目录…"
                val selectedRegion=if(region.selectedItemPosition==0)"cn" else "global"
                Thread {
                    val result=runCatching{FishCatalogSearch.search(selectedRegion,keyword)}
                    runOnUiThread {
                        if(!isDestroyed){
                            result.onSuccess { fish ->
                                if(fish.isEmpty())status.text="未检索到匹配的鱼类"
                                else {
                                    val names=fish.map{ "${it.name}（ID ${it.id}）" }.toTypedArray()
                                    AlertDialog.Builder(this@MainActivity)
                                        .setTitle("选择关注鱼（最多 10 种）")
                                        .setItems(names) { _,position ->
                                            val selected=fish[position]
                                            try {
                                                val original=ids.text.toString().trim()
                                                val next=if(original.isEmpty())selected.id.toString()
                                                    else "$original,${selected.id}"
                                                ids.setText(WidgetData.normalizeFishIds(next))
                                                status.text="已选择 ${selected.name}，点击“保存设置并刷新”生效"
                                            }catch(error:IllegalArgumentException){
                                                status.text=error.message?:"关注鱼数量达到上限"
                                            }
                                        }.setNegativeButton("取消",null).show()
                                    status.text="找到 ${fish.size} 种鱼，请选择"
                                }
                            }.onFailure { error ->
                                status.text="鱼类搜索失败：${error.message?.take(80)?:"网络异常"}"
                            }
                        }
                    }
                }.start()
            }
        }
        button("保存设置并刷新"){ 
            try {
                WidgetData.saveSettings(this,if(region.selectedItemPosition==0)"cn" else "global",
                    ids.text.toString())
                WidgetRenderer.updateAll(this)
                WidgetScheduler.refreshNow(this)
                status.text="设置已保存在本机，正在后台请求新数据。联网后小部件自动更新。"
            }catch(error:IllegalArgumentException){
                status.text=error.message ?: "设置格式不正确"
            }
        }
        button("立即刷新桌面数据"){
            WidgetScheduler.refreshNow(this)
            status.text="已提交后台刷新请求，请稍后查看桌面。"
        }
        button("打开 FF14 Hub 网站"){
            startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(WidgetData.SITE)))
        }
        label("PVP 首次离线也可使用内置国服规则，联网后自动校验更新；鱼窗及活动以缓存有效期为准。对于时间待核实的鱼和公告，不会编造准确提醒。",12f)
        label("本阶段仅提供桌面小部件；鱼窗推送、钓获记录 WebDAV 同步及精准通知尚未接入 Android。",12f)
    }
}
