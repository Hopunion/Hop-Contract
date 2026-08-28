# Hop Contract v1.18.3

Frontend-only update.

## Last 12m hL now shows brew equivalents

Under each **Last 12m hL** field, the app now shows how many of that beer's standard brews the historical volume represents.

Calculation:

`Last 12m hL ÷ Standard brew hL`

Examples:
- 54 hL / 27 hL = 2.00 standard brews
- 80.58 hL / 27 hL = 2.98 standard brews
- 42 hL / 21 hL = 2.00 standard brews

The figure updates immediately when the Last 12m hL value is edited.

## Database

No Supabase migration is required.
