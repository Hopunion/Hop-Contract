# Hop Contract v1.16

## Additive 12-month beer forecast

The 12-month beer forecast is now additive.

Projected 12-month hL =

1. trailing-12-month historical volume after beer % change and scenario
2. + Forecast brews × Standard brew hL
3. + Additional hL/month × 12
4. + Additional one-off hL

These inputs no longer replace one another.

### Examples

New 27 hL beer, no history, 3 forecast brews:
- 0 historical hL
- 3 × 27 hL
- Projected = 81 hL

Existing beer:
- historical forecast 200 hL
- 2 extra 27 hL brews = 54 hL
- 5 hL/month additional = 60 hL
- 20 hL one-off
- Projected = 334 hL

The current recipe is applied to the full projected hL, so all additional volume contributes to hop demand.

Likely repeat customer orders are no longer added to next-year forecast demand. Confirmed unfulfilled orders still remain useful for current stock/contract commitments.

## Database

Run `supabase/v1.16-migration.sql` before deploying v1.16. It adds `forecast_brews` to live beers and frozen annual beer snapshots.
