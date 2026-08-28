# Hop Contract v1.17

## Choose visible 12-month forecast columns

The 12-month forecast now has a **Columns** control.

You can independently show or hide:
- Included
- Standard brew hL
- Last 12m hL
- Change %
- Forecast brews
- Brew forecast hL
- Additional hL/month
- Monthly × 12 hL
- Additional one-off hL
- Projected hL

Beer stays visible so each row remains identifiable.

Hidden columns are display-only:
- their stored values are not deleted
- they still contribute to projected hL
- they still contribute to hop demand
- changing visibility does not trigger a cloud data save

Your selection is remembered in local browser storage.

**Show all** restores every column.  
**Essentials** gives a compact working view.

## Database

No Supabase migration is required for v1.17. Keep the v1.16 database and deploy the v1.17 frontend only.
