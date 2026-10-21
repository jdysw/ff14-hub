package uk.zhixia.ff14hub.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class FishIdsTest {
    @Test fun normalizesAndCapsSelectedFish() {
        assertEquals("",FishIds.normalize("  "))
        assertEquals("101,202",FishIds.normalize(" 101 , 202 "))
        assertEquals((1..10).joinToString(","),FishIds.normalize((1..10).joinToString(",")))
    }

    @Test fun refusesDuplicatesInvalidAndOversizedLists() {
        for (input in listOf("1,1","0","-1","abc","1,",",1","12345678901",
            "2147483648",(1..11).joinToString(","))) {
            assertThrows(IllegalArgumentException::class.java) { FishIds.normalize(input) }
        }
    }
}
