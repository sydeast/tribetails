package com.kinfolk.portal.screens.kintales

/** Tales feed column count at the shell breakpoint: 2-up on wide, 1 narrow. */
fun talesColumnCount(isWide: Boolean): Int = if (isWide) 2 else 1

/**
 * Round-robin distribution of feed items across [columns] columns —
 * the masonry-ish 2-col layout on wide keeps feed order reading across
 * rows (item 0 left, item 1 right, item 2 left, ...).
 */
fun <T> splitIntoColumns(items: List<T>, columns: Int): List<List<T>> {
    require(columns >= 1) { "columns must be >= 1, was $columns" }
    if (columns == 1) return listOf(items)
    val out = List(columns) { mutableListOf<T>() }
    items.forEachIndexed { i, item -> out[i % columns] += item }
    return out
}
