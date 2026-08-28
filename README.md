# Hop Contract v1.14

## Controlled hop formats

Hop formats are now configured centrally in **Settings → Hop formats**.

- Inventory Format is a true dropdown; free text is no longer accepted.
- Add, rename and remove allowed formats in Settings.
- Duplicate format names are blocked case-insensitively.
- A format cannot be removed while a current Hop Stock product uses it.
- Renaming a format updates current Hop Stock product names and keeps recipe UUID links intact.
- Existing formats are carried into the allowed list during the v1.14 upgrade.
- The selected format is persisted separately as `hopFormat`, so custom formats do not need to be guessed from the hop name after reload.

Default list:
T90, T45, Leaf, Freshpak, Cryo, HyperBoost, HyperBoost Oil, Incognito, Spectrum, Oil.

## Historic contract snapshots

The v1.14 migration adds `hop_format` to finalised annual hop snapshots. This keeps old supplier exports correct even if the Settings format list changes later.

## Update order

1. Run `supabase/v1.14-migration.sql`.
2. Deploy the v1.14 frontend.
