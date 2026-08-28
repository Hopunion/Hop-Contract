# Hop Contract v1.18.2

Frontend-only Recipe Usage popup redesign.

## Recipe Usage modal

The Recipe Usage popup is now designed as a large working panel:

- 80% viewport width
- 80% viewport height
- responsive fallback on smaller screens
- compact 24px title rather than oversized modal typography
- smaller explanatory copy
- compact four-item summary strip
- table uses the majority of the modal height
- smaller, more balanced table header/body fonts
- universal Columns / Reset controls are reduced in prominence inside the popup
- the table area scrolls independently instead of the entire dialog becoming cramped

The universal table show/hide/reorder system is unchanged.

## Database

No Supabase migration is required.
