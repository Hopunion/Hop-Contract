# Hop Contract v1.9

Hop Union Brewery annual hop-contract forecasting app.

## v1.9

### January contract start
Annual hop contracts are treated as starting on **1 January** of the selected contract year.

For each hop the draft forecast now:

1. calculates Projected Use (12m) from forecast beer hL × the current recipe;
2. converts that annual requirement to an average daily usage rate;
3. estimates usage from the app's **Stock / contract as at** date to 1 January;
4. assumes physical stock is consumed first, then the current contract balance;
5. shows estimated stock and contract remaining at 1 January;
6. flags any quantity likely to run short before January;
7. calculates the new annual contract from the projected January opening position;
8. rounds the Recommended Contract **up to the nearest 5 kg**.

A pre-January shortage is deliberately separate from the new annual contract because the new contract does not start until January.

When a contract year is finalised, the January bridge figures are frozen with the annual contract history.

### Save reliability
v1.9 replaces the prototype live save routine with a safer UUID-based upsert routine. It no longer wipes and recreates all live inventory rows on every autosave.

The migration also removes the old recipe uniqueness rule that could reject legitimate repeated hop additions and protects historical production from being cascaded away during a normal live-state save.

If a cloud save fails, **Save problem** is clickable and shows the exact database error. The same error is also visible under **Data & backup**.

### Version display
The HTML shell now correctly displays v1.9. Earlier v1.8 packages still showed v1.7 in the sidebar even when the v1.8 JavaScript was running.

## Upgrade from v1.8

Because the current app is reporting a save problem, use this order:

1. **Keep the current Hop Contract browser tab open.**
2. Run `supabase/v1.9-migration.sql` in the Supabase SQL Editor.
3. Return to the existing app tab and wait for autosave to retry, or use **Data & backup → Save now**.
4. Confirm the top status changes to **Saved / Cloud · saved**.
5. Only then deploy the v1.9 frontend files to GitHub/Vercel.

This order gives any edits currently sitting in the browser a chance to save before the frontend reloads.

## Forecast model

Historical beer production remains **volume only**. Current recipe versions are used only for forward hop demand. Finalised contract years retain immutable recipe snapshots, so later recipe changes do not alter old contract forecasts.

## Not included

The app intentionally does not add hop lots, crop-year warehouse management, purchase ordering or invoices.
