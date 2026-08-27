# Hop Contract v1.0

Production baseline for Hop Union Brewery hop contract forecasting.

## v1.0 highlights
- Persistent editing session across normal page refreshes.
- Draggable/resizable Hop Inventory columns; widths persist per browser.
- Inventory search, format filter and sortable headings.
- Base / Conservative / Growth / Custom forecast scenarios.
- Scenario overlays only Core and Seasonal forecasts; Monthly/fixed and One-off stay explicit.
- Per-beer include/exclude control in the 12-month forecast.
- Small/single-beer hop review flags and clearer manual-vs-calculated contract variance.
- Dashboard largest hop requirements and largest beer forecasts.
- Named forecast snapshots in addition to automatic pre-save backups.
- Clickable hop recipe buttons still jump to the exact inventory quantity line.

## Deliberately out of scope
- Hop lot tracking
- Crop-year stock management
- Warehouse movements
- Purchase ordering
- Invoices

## Deployment
This is a Vite application. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel.

No Supabase migration is required when upgrading from v0.8: scenario settings are stored in the existing `app_settings` JSON and the rest of v1.0 is frontend behaviour.
