# Hop Contract v1.8

Hop Union Brewery annual hop-contract forecasting application.

## v1.8 — contract years and recipe history

v1.8 introduces permanent annual contract records without adding hop lots, crop-year warehousing, purchase orders or invoices.

### Contract years

- The Dashboard has a **Contract year** selector.
- Existing live planning becomes the first **2027 Draft** contract year when the migration is first run.
- A draft year uses:
  - latest actual trailing-12-month beer hL
  - that year's beer increase/decrease assumptions
  - the current live recipe
- **Finalise contract** opens a review of Recommended vs Final quantities.
- Final contract amounts are saved in 5 kg increments.
- A finalised year is immutable in the annual history.
- After finalising a year, **Create next contract year** becomes available.
- The prior year's **Final Contract** automatically becomes the new year's **Previous Contract**.
- Beer forecast increase/decrease percentages can either be copied forward or reset to zero when the new year is created.

### Recipe changes

The live `beers` / `beer_hops` records remain the current forward-looking recipe.

When a contract year is finalised, v1.8 creates an immutable recipe snapshot for every active beer and links that snapshot to the finalised annual forecast. Therefore:

- changing a beer recipe later changes future draft forecasts;
- a finalised 2027 forecast continues to show the exact recipe used for 2027;
- a 2028 contract can use a different recipe without rewriting 2027;
- historic recipe snapshots include standard brew hL and each hop quantity.

### Dashboard

Draft Dashboard columns remain deliberately simple:

- Hop
- In Stock
- On Contract
- Projected Use (12m)
- Previous Contract
- Recommended Contract

`Recommended Contract = max(0, Projected Use - In Stock - On Contract)`, rounded **up** to the next 5 kg.

For a finalised historic year the last column becomes **Final Contract** and the recorded recommendation remains available underneath it.

Dashboard and Inventory headers remain sticky, sortable, wrapped and resizable.

## Database upgrade

Run `supabase/v1.8-migration.sql` in Supabase SQL Editor **after the v1.5 migration** and before deploying the v1.8 frontend.

The migration adds:

- `contract_years`
- `contract_year_beers`
- `contract_year_hops`
- `recipe_versions`
- `recipe_version_hops`
- annual year/detail RPCs
- atomic contract finalisation

Historic snapshot rows intentionally store live beer/inventory UUIDs as snapshot identifiers without depending on destructive live-row foreign keys. This prevents a normal cloud save from damaging historical annual records.

## Normal forecast model

1. Historical brewed hL is volume history only.
2. Project each beer volume using its forecast method/increase/decrease.
3. Apply the **current recipe** to a draft year's projected beer volume.
4. Finalising freezes the beer assumptions, exact recipe and hop quantities used.
5. Supplier received last 12m remains a comparison only.
6. Previous Contract is comparison/history; In Stock and On Contract reduce the new recommendation.

## Authentication

Password recovery/change-password functionality remains included.

Supabase Authentication should have:

- Site URL: `https://hop-contract.vercel.app`
- Redirect URL: `https://hop-contract.vercel.app/**`

## Deliberately out of scope

- Hop lot tracking
- Crop-year stock management
- Warehouse movements
- Purchase ordering
- Invoices
