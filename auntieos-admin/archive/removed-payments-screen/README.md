# Removed standalone Payments screen (punch list #11, 2026-06-07)

The standalone Payments screen was removed from AuntieOS nav: payment info now lives on the
paid invoice's detail (record-payment + the per-invoice Payments panel). These files are kept
verbatim in case Payments needs to return as its own screen.

To restore: move the files back under web/composeApp/src and android/app/src at the paths in
their package declarations, re-add the nav entry (web Destination.Payments + Route slug + App
render branch; android Screen.AdminPayments + composable + an AdminData/nav entry), and re-add
the screenshot captures.
The pure filter helpers `PaymentMethodFilter` + `paymentsSearchFilter` (web) were NOT archived:
they are shared + unit-tested (ClientFilterHelpersTest), so they stay in src at
`web/composeApp/src/commonMain/.../screens/payments/PaymentsFilters.kt`. The archived
`PaymentsScreen.kt` still contains copies; on restore, delete the duplicate definitions from
`PaymentsScreen.kt` and let it use `PaymentsFilters.kt` (same package). Android's
`paymentsSearchFilter` / `paymentInvoiceLabel` were screen-only (their tests moved here too),
so they archived cleanly with the screen.
