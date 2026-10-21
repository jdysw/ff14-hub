package uk.zhixia.ff14hub.widgets

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection

data class SearchFish(val id: Int, val name: String)

/** 仅查询公开鱼类目录；不涉及工作空间登录或同步凭据。仅从后台线程调用。 */
object FishCatalogSearch {
    fun search(region: String, keyword: String): List<SearchFish> {
        require(region == "cn" || region == "global")
        require(keyword.isNotBlank() && keyword.length <= 60)
        val escaped=URLEncoder.encode(keyword,"UTF-8")
        val url=URL("${WidgetData.apiOrigin}/api/v1/fish?region=$region&text=$escaped&limit=30")
        val connection=url.openConnection() as HttpsURLConnection
        return try {
            connection.instanceFollowRedirects=false
            connection.connectTimeout=8_000
            connection.readTimeout=12_000
            connection.setRequestProperty("Accept","application/json")
            require(connection.responseCode==200) { "鱼类目录 HTTP ${connection.responseCode}" }
            require(connection.contentType?.contains("application/json",true)==true)
            val output=ByteArrayOutputStream()
            connection.inputStream.use { input->
                val buffer=ByteArray(4096)
                while(true){
                    val n=input.read(buffer)
                    if(n<0)break
                    require(output.size()+n<=512*1024) { "鱼类目录响应过大" }
                    output.write(buffer,0,n)
                }
            }
            val fish=JSONObject(output.toString("UTF-8")).getJSONArray("fish")
            (0 until fish.length()).map { index ->
                val entry=fish.getJSONObject(index)
                SearchFish(entry.getInt("id"),entry.getString("name"))
            }.distinctBy { it.id }
        } finally {
            connection.disconnect()
        }
    }
}
