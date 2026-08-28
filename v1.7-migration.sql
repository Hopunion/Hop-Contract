-- Hop Contract v1.7: annual contract years + immutable recipe snapshots
-- Run after the v1.5 migration. No hop lot / crop-year warehouse model is added.
--
-- Core rules:
--   * The live beers / beer_hops tables remain the CURRENT forward-looking recipes.
--   * Finalising a contract year takes an immutable snapshot of beer volume assumptions,
--     the exact recipe used, and the hop contract decision.
--   * A later recipe change never rewrites a finalised historic year.
--   * The FINAL contract from one year becomes Previous Contract for the next year.

begin;

create table if not exists public.contract_years (
  id uuid primary key default gen_random_uuid(),
  contract_year integer not null unique check (contract_year between 2000 and 2200),
  status text not null default 'draft' check (status in ('draft','finalised')),
  source_year_id uuid references public.contract_years(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid,
  finalised_at timestamptz,
  finalised_by uuid,
  notes text
);

create unique index if not exists contract_years_one_draft_idx
  on public.contract_years ((status)) where status = 'draft';

create table if not exists public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  beer_id uuid,
  beer_name text not null,
  version_label text not null,
  standard_brew_hl numeric(12,3) not null check (standard_brew_hl > 0),
  snapshot_purpose text not null default 'contract_year',
  created_at timestamptz not null default now(),
  created_by uuid,
  notes text
);

create index if not exists recipe_versions_beer_idx
  on public.recipe_versions(beer_id, created_at desc);

create table if not exists public.recipe_version_hops (
  id uuid primary key default gen_random_uuid(),
  recipe_version_id uuid not null references public.recipe_versions(id) on delete cascade,
  hop_inventory_id uuid,
  hop_name text not null,
  kg_per_standard_brew numeric(12,5) not null default 0 check (kg_per_standard_brew >= 0),
  addition_stage text,
  notes text
);

create index if not exists recipe_version_hops_version_idx
  on public.recipe_version_hops(recipe_version_id);

create table if not exists public.contract_year_beers (
  id uuid primary key default gen_random_uuid(),
  contract_year_id uuid not null references public.contract_years(id) on delete cascade,
  beer_id uuid,
  beer_name text not null,
  recipe_version_id uuid not null references public.recipe_versions(id) on delete restrict,
  baseline_last12_hl numeric(12,3) not null default 0 check (baseline_last12_hl >= 0),
  forecast_type text not null,
  forecast_change_pct numeric(9,3) not null default 0,
  scenario_adjustment_pct numeric(9,3) not null default 0,
  monthly_fixed_hl numeric(12,3) not null default 0,
  one_off_hl numeric(12,3) not null default 0,
  forecast_hl numeric(12,3) not null default 0 check (forecast_hl >= 0),
  unique(contract_year_id, beer_name)
);

create index if not exists contract_year_beers_year_idx
  on public.contract_year_beers(contract_year_id);

create table if not exists public.contract_year_hops (
  id uuid primary key default gen_random_uuid(),
  contract_year_id uuid not null references public.contract_years(id) on delete cascade,
  hop_inventory_id uuid,
  hop_name text not null,
  in_stock_kg numeric(12,3) not null default 0 check (in_stock_kg >= 0),
  on_contract_kg numeric(12,3) not null default 0 check (on_contract_kg >= 0),
  projected_use_kg numeric(12,3) not null default 0 check (projected_use_kg >= 0),
  previous_contract_kg numeric(12,3) not null default 0 check (previous_contract_kg >= 0),
  recommended_contract_kg numeric(12,3) not null default 0 check (recommended_contract_kg >= 0),
  final_contract_kg numeric(12,3) not null default 0 check (final_contract_kg >= 0),
  price_per_kg numeric(12,3) not null default 0 check (price_per_kg >= 0),
  unique(contract_year_id, hop_name)
);

create index if not exists contract_year_hops_year_idx
  on public.contract_year_hops(contract_year_id);
create index if not exists contract_year_hops_inventory_idx
  on public.contract_year_hops(hop_inventory_id);

-- Historical tables are readable by authenticated users but are only written through RPCs.
alter table public.contract_years enable row level security;
alter table public.recipe_versions enable row level security;
alter table public.recipe_version_hops enable row level security;
alter table public.contract_year_beers enable row level security;
alter table public.contract_year_hops enable row level security;

drop policy if exists contract_years_read on public.contract_years;
create policy contract_years_read on public.contract_years for select to authenticated using (true);
drop policy if exists recipe_versions_read on public.recipe_versions;
create policy recipe_versions_read on public.recipe_versions for select to authenticated using (true);
drop policy if exists recipe_version_hops_read on public.recipe_version_hops;
create policy recipe_version_hops_read on public.recipe_version_hops for select to authenticated using (true);
drop policy if exists contract_year_beers_read on public.contract_year_beers;
create policy contract_year_beers_read on public.contract_year_beers for select to authenticated using (true);
drop policy if exists contract_year_hops_read on public.contract_year_hops;
create policy contract_year_hops_read on public.contract_year_hops for select to authenticated using (true);

-- Remove broad mutation policies if this migration is re-run after an experimental version.
drop policy if exists contract_years_all on public.contract_years;
drop policy if exists recipe_versions_all on public.recipe_versions;
drop policy if exists recipe_version_hops_all on public.recipe_version_hops;
drop policy if exists contract_year_beers_all on public.contract_year_beers;
drop policy if exists contract_year_hops_all on public.contract_year_hops;

-- A compact year list for the UI.
create or replace function public.get_contract_years()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', y.id,
    'year', y.contract_year,
    'status', y.status,
    'sourceYearId', y.source_year_id,
    'createdAt', y.created_at,
    'finalisedAt', y.finalised_at
  ) order by y.contract_year), '[]'::jsonb)
  from public.contract_years y
  where auth.uid() is not null;
$$;

-- Full immutable detail for a finalised year. Draft years intentionally use the live state.
create or replace function public.get_contract_year_detail(p_contract_year_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'id', y.id,
    'year', y.contract_year,
    'status', y.status,
    'sourceYearId', y.source_year_id,
    'finalisedAt', y.finalised_at,
    'beers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'beerId', cyb.beer_id,
        'name', cyb.beer_name,
        'baselineLast12Hl', cyb.baseline_last12_hl,
        'forecastType', cyb.forecast_type,
        'growthPct', cyb.forecast_change_pct,
        'scenarioAdjustmentPct', cyb.scenario_adjustment_pct,
        'monthlyHl', cyb.monthly_fixed_hl,
        'oneOffHl', cyb.one_off_hl,
        'forecastHl', cyb.forecast_hl,
        'recipeVersionId', rv.id,
        'recipeVersionLabel', rv.version_label,
        'standardBrewHl', rv.standard_brew_hl,
        'recipeHops', coalesce((
          select jsonb_agg(jsonb_build_object(
            'inventoryId', rvh.hop_inventory_id,
            'hopName', rvh.hop_name,
            'kgPerBrew', rvh.kg_per_standard_brew,
            'additionStage', coalesce(rvh.addition_stage,''),
            'notes', coalesce(rvh.notes,'')
          ) order by rvh.hop_name)
          from public.recipe_version_hops rvh
          where rvh.recipe_version_id = rv.id
        ), '[]'::jsonb)
      ) order by cyb.beer_name)
      from public.contract_year_beers cyb
      join public.recipe_versions rv on rv.id = cyb.recipe_version_id
      where cyb.contract_year_id = y.id
    ), '[]'::jsonb),
    'hops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'inventoryId', cyh.hop_inventory_id,
        'hopName', cyh.hop_name,
        'inStockKg', cyh.in_stock_kg,
        'onContractKg', cyh.on_contract_kg,
        'projectedUseKg', cyh.projected_use_kg,
        'previousContractKg', cyh.previous_contract_kg,
        'recommendedContractKg', cyh.recommended_contract_kg,
        'finalContractKg', cyh.final_contract_kg,
        'priceKg', cyh.price_per_kg
      ) order by cyh.hop_name)
      from public.contract_year_hops cyh
      where cyh.contract_year_id = y.id
    ), '[]'::jsonb)
  ) end
  from public.contract_years y
  where y.id = p_contract_year_id;
$$;

-- Create one new draft year. Only one draft can exist at a time.
-- Returns the previous final contract quantities to seed the live Previous Contract column.
create or replace function public.create_contract_year(
  p_contract_year integer,
  p_source_year_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_year public.contract_years%rowtype;
  source_year public.contract_years%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_contract_year < 2000 or p_contract_year > 2200 then raise exception 'Invalid contract year'; end if;
  if exists(select 1 from public.contract_years where status='draft') then
    raise exception 'Finalise the existing draft contract year before creating another';
  end if;
  if exists(select 1 from public.contract_years where contract_year=p_contract_year) then
    raise exception 'Contract year % already exists', p_contract_year;
  end if;

  if p_source_year_id is not null then
    select * into source_year from public.contract_years where id=p_source_year_id;
    if source_year.id is null or source_year.status <> 'finalised' then
      raise exception 'Source contract year must be finalised';
    end if;
    if source_year.contract_year >= p_contract_year then
      raise exception 'Source year must be earlier than the new contract year';
    end if;
  end if;

  insert into public.contract_years(contract_year,status,source_year_id,created_by)
  values(p_contract_year,'draft',p_source_year_id,auth.uid())
  returning * into new_year;

  return jsonb_build_object(
    'id', new_year.id,
    'year', new_year.contract_year,
    'status', new_year.status,
    'sourceYearId', new_year.source_year_id,
    'previousContracts', case when p_source_year_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'inventoryId', h.hop_inventory_id,
        'hopName', h.hop_name,
        'finalContractKg', h.final_contract_kg
      ) order by h.hop_name)
      from public.contract_year_hops h
      where h.contract_year_id=p_source_year_id
    ), '[]'::jsonb) end
  );
end;
$$;

-- Finalisation is atomic. It freezes the exact beer assumptions, current recipes and hop decision.
create or replace function public.finalise_contract_year(
  p_contract_year_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  y public.contract_years%rowtype;
  b jsonb;
  h jsonb;
  rh jsonb;
  rv_id uuid;
  final_kg numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into y from public.contract_years where id=p_contract_year_id for update;
  if y.id is null then raise exception 'Contract year not found'; end if;
  if y.status <> 'draft' then raise exception 'Contract year % is already finalised', y.contract_year; end if;

  -- Defensive cleanup allows a failed transaction to be safely retried.
  delete from public.contract_year_hops where contract_year_id=y.id;
  delete from public.contract_year_beers where contract_year_id=y.id;

  for b in select value from jsonb_array_elements(coalesce(p_payload->'beers','[]'::jsonb)) loop
    insert into public.recipe_versions(
      beer_id, beer_name, version_label, standard_brew_hl,
      snapshot_purpose, created_by, notes
    ) values (
      nullif(b->>'beerId','')::uuid,
      coalesce(nullif(trim(b->>'name'),''),'Unnamed beer'),
      coalesce(nullif(trim(b->>'recipeVersionLabel'),''), 'Contract '||y.contract_year||' snapshot'),
      greatest(coalesce((b->>'standardBrewHl')::numeric,0),0.01),
      'contract_year', auth.uid(),
      'Immutable recipe used for '||y.contract_year||' hop contract forecast'
    ) returning id into rv_id;

    for rh in select value from jsonb_array_elements(coalesce(b->'recipeHops','[]'::jsonb)) loop
      insert into public.recipe_version_hops(
        recipe_version_id, hop_inventory_id, hop_name,
        kg_per_standard_brew, addition_stage, notes
      ) values (
        rv_id,
        nullif(rh->>'inventoryId','')::uuid,
        coalesce(nullif(trim(rh->>'hopName'),''),'Unlinked hop'),
        greatest(coalesce((rh->>'kgPerBrew')::numeric,0),0),
        nullif(rh->>'additionStage',''),
        nullif(rh->>'notes','')
      );
    end loop;

    insert into public.contract_year_beers(
      contract_year_id, beer_id, beer_name, recipe_version_id,
      baseline_last12_hl, forecast_type, forecast_change_pct,
      scenario_adjustment_pct, monthly_fixed_hl, one_off_hl, forecast_hl
    ) values (
      y.id,
      nullif(b->>'beerId','')::uuid,
      coalesce(nullif(trim(b->>'name'),''),'Unnamed beer'),
      rv_id,
      greatest(coalesce((b->>'baselineLast12Hl')::numeric,0),0),
      coalesce(nullif(b->>'forecastType',''),'core'),
      coalesce((b->>'growthPct')::numeric,0),
      coalesce((b->>'scenarioAdjustmentPct')::numeric,0),
      greatest(coalesce((b->>'monthlyHl')::numeric,0),0),
      greatest(coalesce((b->>'oneOffHl')::numeric,0),0),
      greatest(coalesce((b->>'forecastHl')::numeric,0),0)
    );
  end loop;

  for h in select value from jsonb_array_elements(coalesce(p_payload->'hops','[]'::jsonb)) loop
    final_kg := greatest(coalesce((h->>'finalContractKg')::numeric,0),0);
    -- Contract quantities are always stored in 5 kg increments.
    if final_kg > 0 then final_kg := ceil(final_kg / 5.0) * 5.0; end if;

    insert into public.contract_year_hops(
      contract_year_id, hop_inventory_id, hop_name,
      in_stock_kg, on_contract_kg, projected_use_kg,
      previous_contract_kg, recommended_contract_kg, final_contract_kg,
      price_per_kg
    ) values (
      y.id,
      nullif(h->>'inventoryId','')::uuid,
      coalesce(nullif(trim(h->>'hopName'),''),'Unknown hop'),
      greatest(coalesce((h->>'inStockKg')::numeric,0),0),
      greatest(coalesce((h->>'onContractKg')::numeric,0),0),
      greatest(coalesce((h->>'projectedUseKg')::numeric,0),0),
      greatest(coalesce((h->>'previousContractKg')::numeric,0),0),
      greatest(coalesce((h->>'recommendedContractKg')::numeric,0),0),
      final_kg,
      greatest(coalesce((h->>'priceKg')::numeric,0),0)
    );
  end loop;

  update public.contract_years
  set status='finalised', finalised_at=now(), finalised_by=auth.uid()
  where id=y.id;

  insert into public.forecast_snapshots(name,snapshot,created_by)
  values('Final contract '||y.contract_year, coalesce(p_payload,'{}'::jsonb), auth.uid());

  return public.get_contract_year_detail(y.id);
end;
$$;

grant execute on function public.get_contract_years() to authenticated;
grant execute on function public.get_contract_year_detail(uuid) to authenticated;
grant execute on function public.create_contract_year(integer,uuid) to authenticated;
grant execute on function public.finalise_contract_year(uuid,jsonb) to authenticated;

-- Create the first draft year from the live app forecast year if annual history does not exist yet.
insert into public.contract_years(contract_year,status,created_by)
select
  coalesce(nullif((s.value->>'forecastYear')::integer,0), 2027),
  'draft',
  auth.uid()
from public.app_settings s
where s.key='forecast'
  and not exists(select 1 from public.contract_years)
on conflict (contract_year) do nothing;

-- If no forecast settings row exists, still initialise the current planned contract year.
insert into public.contract_years(contract_year,status,created_by)
select 2027,'draft',auth.uid()
where not exists(select 1 from public.contract_years)
on conflict (contract_year) do nothing;

insert into public.app_settings(key,value)
values('app',jsonb_build_object('version','1.7'))
on conflict(key) do update set value=excluded.value,updated_at=now();

commit;

-- Verification
select contract_year,status,created_at,finalised_at
from public.contract_years
order by contract_year;
