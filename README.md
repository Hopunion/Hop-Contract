# Hop Contract v1.12.1

Frontend hotfix for v1.12.

- Restores the missing **Save changes** button in the top bar.
- Fixes the startup JavaScript failure that prevented navigation and page buttons from responding.
- Makes the Save changes listener defensive so a missing optional control cannot stop later event handlers from attaching.
- Keeps all v1.12 forecast-inclusion, supplier export, recipe-usage and manual-save features.

No Supabase migration is required.
