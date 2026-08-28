# Hop Contract v1.13

## Contract products
Each exact hop product now has:
- Hemisphere: Northern or Southern
- Contract?: On or Off

Contract Off products still remain in recipes and projected demand, but their Recommended Contract and Final Contract are 0 kg and they are excluded from supplier CSV exports.

Existing HyperBoost / HyperBoost Oil products are switched Off by default by the v1.13 database migration.

## Hemisphere workflow
- Dashboard switches between Northern, Southern and All.
- Supplier exports are separate: Northern CSV and Southern CSV.
- Finalised annual snapshots retain the hemisphere and Contract On/Off status used at finalisation.
- Known NZ/Australian varieties are preclassified Southern and remain editable.

## Database
Run `supabase/v1.13-migration.sql` before deploying the frontend.
