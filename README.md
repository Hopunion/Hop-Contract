# Hop Contract v0.8

Cloud-backed hop contract quantity forecaster for Hop Union Brewery.

## v0.8 changes

- Hop quantity lines are presented as **Variety + Format** without introducing a separate product/lot system.
- Each combination remains its own quantity record, e.g. `Citra / T90`, `Citra / T45`, `Citra / HyperBoost Oil`.
- Existing Supabase rows remain compatible because the stored hop key is still the combined display name (`Citra T45`).
- Beer recipe editing now has separate **Variety**, **Format**, and **kg per brew** fields.
- Recipe hop buttons show the variety, format, and quantity and still jump directly to the matching inventory row.
- Inventory has separate Variety and Format columns.
- Inventory can be sorted by Variety, Format, Stock, Contract left, Expected use, Carryover, Next-year demand, Calculated contract, Final contract, and price.
- Renaming an inventory variety/format also updates matching recipe references in the open app state.

## Database

No Supabase migration is required for v0.8. The existing `hop_name` field continues to store the combined quantity key.

Examples:

- `Citra T90`
- `Citra T45`
- `Citra HyperBoost Oil`

## Deploy

Commit the project to GitHub. Vercel should build it with `npm run build` and publish the `dist` directory.

Required Vercel environment variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
