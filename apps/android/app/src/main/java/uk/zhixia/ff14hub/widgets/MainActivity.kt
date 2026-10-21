package uk.zhixia.ff14hub.widgets

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
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
        label("FF14 Hub · Android 小部件",22f)
        label("长按手机桌面 → 小部件 → FF14 Hub，选择 PVP、鱼窗、活动或综合概览。")
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
        fun button(text: String, action: ()->Unit) {
            val button=Button(this).apply {
                this.text=text
                setOnClickListener{action()}
            }
            root.addView(button,LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
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
        label("PVP 离线轮换按服务端下发的时间锚点计算；鱼窗及活动以缓存有效期为准。对于时间待核实的鱼和公告，不会编造准确提醒。",12f)
        label("本阶段仅提供桌面小部件；鱼窗推送、钓获记录 WebDAV 同步及精准通知尚未接入 Android。",12f)
    }
}
