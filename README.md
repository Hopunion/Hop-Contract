# Hop Contract v1.4

Hop Union Brewery hop-contract forecasting application.

## v1.3 forecasting rule
Historical brewing and recipe data are deliberately separated:

1. **Historical brewed hL = volume baseline only.**
2. Core/Seasonal forecast volume = last-12-month hL adjusted by beer growth and the selected scenario.
3. Monthly/fixed and One-off forecasts remain explicit volumes.
4. **Current recipe only** is applied to the forward forecast hL to calculate future hop demand.
5. The app never assumes the current recipe was the recipe used historically.

## Supplier receipt cross-check
Hop Inventory now includes **Supplier received last 12m kg**.

The app also displays **Last 12m equivalent · current recipe**, which is calculated as:

`historical beer hL × today's current recipe kg/hL`

This is only a comparison against supplier receipts. It does **not** change stock, carryover, forecast demand or the calculated contract quantity.

## Recipe/inventory linking
Recipe lines continue to select the exact Hop Inventory item by UUID. Forecast roll-up now uses that inventory UUID rather than relying on product-name text matching.

## Existing v1.0/v1.1 features retained
- Persistent editing lock across normal refreshes
- Resizable Inventory columns
- Search, format filter and sortable Inventory
- Base / Conservative / Growth / Custom scenarios
- Core / Seasonal / Monthly-fixed / One-off forecasting
- Current stock + current contract + expected use before new contract
- Confirmed and likely-repeat customer orders
- Minimum contract and rounding quantities
- Manual final contract override
- Named snapshots + automatic 30-save backups
- Clickable recipe hops that jump to exact Inventory items

## Deliberately out of scope
- Hop lot tracking
- Crop-year stock management
- Warehouse movements
- Purchase ordering
- Invoices

## Deployment
Configure these Vercel variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

### Database upgrade
Run `supabase/v1.3-migration.sql` in Supabase SQL Editor **before** deploying the v1.3 frontend.

The v1.3 migration is cumulative and is safe to run on the existing v1.0/v1.1 Hop Contract database. It adds the supplier-receipt field and recreates the cloud save/load functions for v1.3.

For a completely new database, run `supabase/schema.sql` first and then `supabase/v1.3-migration.sql`.


## v1.3 authentication changes

- Added **Forgot password?** on the sign-in screen using Supabase recovery email.
- Recovery links return to the app and show a **Set new password** form.
- Signed-in users can use **Change password** from the sidebar.
- Supabase session persistence is explicitly enabled with browser local storage.
- Sign-in and account-creation forms now use the correct browser autocomplete semantics to improve password-manager support.
- The app never stores readable passwords in its own database. Supabase Auth stores/verifies credentials securely.

No database migration is required for v1.3. The Supabase Authentication redirect URL must allow `https://hop-contract.vercel.app/**`.


## v1.4 inventory header layout

- Inventory column headings now wrap onto multiple lines instead of clipping or forcing overly-wide columns.
- The Inventory header row is taller to accommodate wrapped headings.
- Draggable column resizing remains enabled.
- No Supabase/database migration is required for v1.4.
