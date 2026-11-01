package com.kinfolk.portal.screens.tribe
/** How one card's part of the page Save went. [Failed.message] is the card's own sentence, ready to show. */
sealed interface CardSaveResult {
    data object Ok : CardSaveResult
    data class Failed(val message: String) : CardSaveResult
}
/**
 * What a card hands the Tribe Profile page so the page's one Save Changes can
 * save it too (#1324). The card keeps its own form state and its own callable;
 * the page only asks "do you have edits?" and "save them", then reports the
 * answer on the single status line. The card draws no Save button of its own.
 * The twin of portal web's `components/cardSave.ts`.
 *
 * A plain holder, not compose state: the card re-points both members on every
 * composition (a `SideEffect`), so the page always reads the current form.
 */
class CardSaveHandle {
    var dirty: Boolean = false
    var save: suspend () -> CardSaveResult = { CardSaveResult.Ok }
}
