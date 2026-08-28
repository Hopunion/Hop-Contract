# Hop Contract v1.18.1

Frontend-only hotfix.

## Column menu opacity fix

The column chooser is now forced to a fully opaque white background.

The fix covers both:
- the legacy v1.17 `Show columns` menu
- the v1.18 universal `Columns & order` menu

The menu also gets its own high stacking context so sticky table headers and cells cannot render through or above it.

## Important

If the screen still says **Show columns** and has an **Essentials** button, that is the old v1.17 interface.

v1.18+ should show the universal **Columns & order** interface with drag handles and reorder controls.

After deployment, hard-refresh the page so the browser does not reuse the old cached CSS/JavaScript.

## Database

No Supabase migration is required.
