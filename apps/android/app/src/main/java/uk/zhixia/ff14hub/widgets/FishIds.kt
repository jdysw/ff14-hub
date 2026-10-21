package uk.zhixia.ff14hub.widgets

/** 平台无关的鱼类关注 ID 规范化；Android 不保存个人登录信息或 WebDAV 凭据。 */
object FishIds {
    fun normalize(raw: String): String {
        if (raw.isBlank()) return ""
        val ids=raw.split(',').map { it.trim() }
        require(ids.size<=10 && ids.all { it.matches(Regex("[1-9][0-9]{0,9}")) &&
            it.toLongOrNull()?.let { value->value in 1..Int.MAX_VALUE.toLong() }==true }) {
            "鱼 ID 必须为最多 10 个逗号分隔的有效正整数"
        }
        require(ids.distinct().size==ids.size) { "请勿重复填写鱼 ID" }
        return ids.joinToString(",")
    }
}
