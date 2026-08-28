# Hop Contract v1.6

Hop Union Brewery hop-contract forecasting application.

## v1.6 changes

- Added **Current contract total kg** to Hop Inventory.
- Dashboard compares the current/previous contract total with the recommended new contract:
  - current contract total
  - recommended new contract
  - difference kg
  - difference %
- Dashboard hop-contract and beer-forecast tables now behave like Inventory:
  - sortable column headings
  - wrapped/taller header rows
  - draggable column widths
  - widths remembered in the browser
  - horizontal scrolling rather than squeezed columns
- Inventory and Dashboard table headers are **sticky** while scrolling.
- Normal edits now **auto-save to Supabase** after a short pause.
- `Save to cloud` and `Refresh data` have been removed from the main toolbar.
- `Save now` and `Reload cloud copy` remain under **Data & backup** for troubleshooting only.
- Automatic database backup snapshots are throttled to avoid creating a snapshot for every auto-save.
- Added `Leaf` and `Freshpak` as recognised hop formats.

## Forecast model

Historical brewing and recipes remain deliberately separated:

1. Historical brewed hL is the volume baseline only.
2. Core/Seasonal forecast volume = last-12-month hL adjusted by beer growth and scenario.
3. Monthly/fixed and one-off forecasts remain explicit.
4. Current recipe only is applied to future forecast hL.
5. Supplier received last 12m is a comparison only.
6. Current contract total is a comparison against the next recommended contract; it does not alter the forecast calculation.
7. Current contract **remaining** is still part of projected carryover.

## Database upgrade

Run `supabase/v1.6-migration.sql` in Supabase SQL Editor before deploying the v1.6 frontend.

The migration is cumulative from the existing v1.2 database and:
- adds `current_contract_total_kg`
- includes it in cloud load/save
- recognises Leaf and Freshpak formats
- throttles automatic backup snapshots to at most one every 15 minutes during auto-save

For a new database, run `supabase/schema.sql` and then `supabase/v1.6-migration.sql`.

## Authentication

Password recovery/change-password functionality from v1.3 is retained.

Supabase Authentication should allow:

- Site URL: `https://hop-contract.vercel.app`
- Redirect URL: `https://hop-contract.vercel.app/**`

## Deliberately out of scope

- Hop lot tracking
- Crop-year stock management
- Warehouse movements
- Purchase ordering
- Invoices


## v1.6 dashboard simplification

The Dashboard hop table now contains only: Hop, In Stock, On Contract, Projected Use (12m), Previous Contract, and Recommended Contract. Projected Use uses trailing-12-month beer volume plus the agreed beer forecast adjustment and the current recipe. Recommended Contract is max(0, Projected Use - In Stock - On Contract), always rounded up to the next 5 kg. Previous Contract is comparison-only. Dashboard and Inventory headers remain sticky, sortable, wrapped and resizable.
