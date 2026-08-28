# Hop Contract v1.15.1

## Contract-mix rollback

v1.15.1 removes the automatic strength-normalised T45/T90/HyperBoost contract-mix feature introduced in v1.15.

Hop products are again treated as independent exact products:
- T90 is forecast from recipes that currently use T90.
- T45 is forecast from recipes that currently use T45.
- HyperBoost is forecast from recipes that currently use HyperBoost.
- No automatic conversion is made between formats.
- Change a recipe manually when you actually change the product on brewday.

This keeps contract planning directly auditable against the live recipe database.

## Features retained

- Controlled hop Format list in Settings.
- Format dropdowns rather than free text.
- Exact-product Contract On/Off.
- Northern / Southern hemisphere separation.
- Separate Northern / Southern supplier CSV exports.
- Recipe Usage snapshot for each exact hop product.
- Manual Save changes workflow.
- Duplicate-product protection.
- All historically brewed beers Included by default unless manually unticked.

## Database

No rollback migration is required.

If the v1.15 Supabase migration has already been run, the additional `contract_mix_pct`, `contract_unit`, and `t90_eq_factor` columns can safely remain in the database. v1.15.1 simply does not use them.

Keep the existing v1.14/v1.15-compatible database functions and deploy this frontend.
