# Hop Contract v0.6

Hop Union Brewery hop contract forecasting application.

## Stack

- Vite + vanilla JavaScript frontend
- Supabase Auth + PostgreSQL
- Vercel hosting

## Local run

```bash
npm install
npm run dev
```

## Vercel

Import this repository into Vercel. Framework preset: **Vite**. The normal build settings are:

- Build command: `npm run build`
- Output directory: `dist`

The app includes the current Supabase **publishable** URL/key as browser-safe defaults. You can alternatively add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel Environment Variables. Never add a Supabase secret/service-role key to the frontend or repository.

## Database

The live Supabase project already contains the operational data, including the seeded hop inventory and beer recipes. Those records do **not** belong in GitHub. `supabase/schema.sql` is a reproducible schema reference for a fresh project. Do not run it against the existing live project.

## Current live data

As of v0.6, Supabase contains the initial inventory imported from the contract forecast spreadsheet and five seeded beer recipes: Moose River, Bonville Pale, Scallywag, Maiden Voyage and Bloody Nora.
