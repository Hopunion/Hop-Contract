# Hop Contract v1.11

Hop Union Brewery annual hop-contract planner.

## v1.11

- Adds **Recipe usage** from each Hop Stock item. Click the `X recipes` link to see every current beer using that exact Variety + Format, kg/brew, standard brew hL, kg/hL, forecast hL and projected 12-month kg contribution.
- Adds a permanent top-bar **Save changes** button. Routine field edits no longer re-render the table when the field loses focus.
- Manual save recalculates the page but restores the same page/table vertical and horizontal scroll positions.
- Delayed autosave remains as a 60-second safety backup.
- Prevents creation of duplicate exact Variety + Format entries.
- Detects existing duplicate inventory rows before save and provides **Merge duplicates**. Recipe links are repointed to the retained inventory UUID.
- Keeps the v1.10 Debug Log.

## Database

No new database migration is required beyond the v1.10.3 schema-sync / v1.10.2 save-function hotfixes already applied.
