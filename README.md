# Hop Contract v1.15

## Strength-normalised transition planning

v1.15 lets current recipes stay unchanged while future contracts move between hop formats.

### Default equivalence
- T90: 1 kg = 1 kg T90-equivalent
- T45: 1 kg = 2 kg T90-equivalent
- HyperBoost: 1 L = 100 kg T90-equivalent
  - therefore 0.010 L / 10 mL = 1 kg T90-equivalent

The Settings → Hop formats & strength table controls the unit and equivalence factor.

### Contract mix
Every exact Hop Stock product now has **Contract mix %**.

The percentage is a share of that hop variety's T90-equivalent contract requirement, not a share of physical weight.

Where the same variety already has both T45 and T90, v1.15 initially sets:
- T45 = 25%
- T90 = 75%

Example: 100 kg T90-equivalent net requirement:
- 25% T45 contribution = 25 kg T90-eq = 12.5 kg physical T45
- 75% T90 contribution = 75 kg physical T90

Current physical stock and contract balances are converted to T90-equivalent and deducted before the new mix is allocated. Recipes are not rewritten.

Contract Off products (for example HyperBoost today) remain visible in recipe demand but are excluded from the contract pool. Turning Contract On later allows them to participate.

### Supplier export
Supplier CSV now exports:
- Variety
- Format
- Final Contract Amount
- Unit

### Database
Run `supabase/v1.15-migration.sql` before deploying the v1.15 frontend.
