# Hop Contract v1.12

Hop Union Brewery annual hop-contract planning app.

## v1.12 changes

- Every beer with trailing-12-month brewed volume is Included in the forecast by default.
- Existing single-brew beers that had been automatically classified as One-off with 0 explicit hL are converted once to Seasonal, so their actual trailing-12-month volume contributes to the forecast.
- After the one-time v1.12 migration, the Included checkbox is authoritative: untick a beer when it should not appear in the next contract forecast.
- Supplier CSV export from the Dashboard contract-year bar.
  - Finalised year: exports frozen Final Contract kg.
  - Draft year: can export the current recommended quantities as a draft supplier proposal.
  - CSV columns: Variety, Format, Final Contract kg.
  - Zero-kg rows are excluded.
- Keeps v1.11 Recipe Usage snapshots from each Hop Stock row.
- Keeps the manual Save changes workflow and 60-second safety autosave.
- Fixes a duplicate-row display bug in the Recipe Usage modal.

## Database

No new SQL migration is required for v1.12. It uses the existing v1.10.3-compatible database schema and save function.

The one-time inclusion/type conversion is stored in the normal app state on the next successful Save changes.
