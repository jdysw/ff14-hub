package uk.zhixia.ff14hub.widgets.widgets

enum class PvpDensity { MINI, SMALL, MEDIUM, LARGE }

/** Sizes are launcher-reported dp, independent of screen pixels or the original preset. */
object PvpPresentation {
    const val LARGE_FONT_SCALE = 1.1f
    fun density(width: Float, height: Float, fontScale: Float = 1f): PvpDensity {
        val physical = when {
            width < 120 || height < 88 -> PvpDensity.MINI
            width >= 260 && height >= 240 -> PvpDensity.LARGE
            width >= 220 && height >= 120 -> PvpDensity.MEDIUM
            width >= 120 && height >= 220 -> PvpDensity.MEDIUM
            else -> PvpDensity.SMALL
        }
        // Larger system text gets fewer fields, rather than being shrunk to fit.
        return if (fontScale > LARGE_FONT_SCALE) when (physical) {
            PvpDensity.MINI -> PvpDensity.MINI
            PvpDensity.LARGE -> PvpDensity.MEDIUM
            else -> PvpDensity.SMALL
        } else physical
    }

    fun shortMap(name: String): String = name.substringBefore('（')
}
