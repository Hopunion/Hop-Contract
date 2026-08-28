# Hop Contract v1.10

## Debug/save diagnostics release

v1.10 adds a dedicated **Debug log** page for diagnosing cloud-save failures without exposing passwords or auth tokens.

The log records:
- auth/session checks
- editing-lock checks
- cloud load RPC start/result
- autosave start/result and duration
- payload counts and approximate payload size
- full Supabase error message, Postgres code, details and hint
- request timeouts
- browser JavaScript errors/unhandled promise rejections

The **Run diagnostics** button tests auth, editing lock, `get_forecast_state`, and the new read-only database preflight RPC. The preflight checks duplicate inventory names, database name conflicts, duplicate beer names, duplicate recipe IDs, missing inventory links, required schema columns and key RPC availability.

**Test save now** runs the normal save path while logging every stage. **Copy debug log** copies the trace for pasting into ChatGPT.

## Database migration

Run `supabase/v1.10-migration.sql` after v1.9. It:
- creates `diagnose_hop_contract(jsonb)`
- sets a 25-second database statement timeout on `save_forecast_state` so a genuinely stuck save returns an explicit error
- recreates `hop_recipe_inventory_links` as a `security_invoker` view to clear the Supabase Security Definer View advisor warning
- records app schema version 1.10

## Update order

1. Run `supabase/v1.10-migration.sql` in Supabase SQL Editor.
2. Deploy the v1.10 frontend to GitHub/Vercel.
3. Open **Debug log** in Hop Contract.
4. Press **Run diagnostics**.
5. Make a small edit and press **Test save now**.
6. If it fails, press **Copy debug log** and paste the result into ChatGPT.
