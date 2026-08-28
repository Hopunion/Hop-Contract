# Hop Contract v1.18

## Universal table template

v1.18 replaces the forecast-only column picker with one reusable table-view system.

Every table in the app automatically gets:
- show / hide individual columns
- drag-to-reorder columns
- arrow buttons for precise reordering
- Show all
- Reset table
- the existing drag-to-resize widths on managed tables

It applies automatically to the Dashboard, finalised Dashboard, Beer Register, 12-month forecast, Orders, Hop Inventory, Cloud Snapshots, Recipe Usage popup and Finalise Contract popup.

The implementation scans normal HTML tables with a header row, so future tables inherit the same controls without building another custom column picker.

### Browser-local preferences

Column visibility and order are display preferences only. They do not alter or save brewery data. Preferences are remembered in that browser.

The v1.17 12-month forecast visibility choice is migrated automatically into the new universal preference system.

### Opaque menu

The Columns menu now has a fully opaque white background, no backdrop transparency, and a high z-index.

## Database

No Supabase migration is required for v1.18. Keep the v1.16 database and deploy the v1.18 frontend only.
