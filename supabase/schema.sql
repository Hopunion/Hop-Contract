-- Hop Contract v0.6 consolidated schema reference.
-- For a NEW Supabase project only. The live Hop Contract project already has these migrations.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.beers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  standard_brew_hl numeric(10,2) not null check (standard_brew_hl > 0),
  forecast_type text not null default 'core' check (forecast_type in ('core','seasonal','monthly_fixed','one_off')),
  last_12_month_hl numeric(12,2) not null default 0 check (last_12_month_hl >= 0),
  forecast_change_pct numeric(8,2) not null default 0 check (forecast_change_pct >= -100),
  monthly_fixed_hl numeric(12,2) not null default 0 check (monthly_fixed_hl >= 0),
  one_off_hl numeric(12,2) not null default 0 check (one_off_hl >= 0),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.beer_hops (
  id uuid primary key default gen_random_uuid(),
  beer_id uuid not null references public.beers(id) on delete cascade,
  hop_name text not null,
  kg_per_standard_brew numeric(10,3) not null check (kg_per_standard_brew >= 0),
  addition_stage text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (beer_id, hop_name, addition_stage)
);

create table public.production_history (
  id uuid primary key default gen_random_uuid(),
  beer_id uuid not null references public.beers(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  brewed_hl numeric(12,2) not null check (brewed_hl >= 0),
  source text,
  notes text,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create table public.hop_inventory (
  id uuid primary key default gen_random_uuid(),
  hop_name text not null unique,
  current_stock_kg numeric(12,3) not null default 0 check (current_stock_kg >= 0),
  current_contract_remaining_kg numeric(12,3) not null default 0 check (current_contract_remaining_kg >= 0),
  expected_use_before_new_contract_kg numeric(12,3) not null default 0 check (expected_use_before_new_contract_kg >= 0),
  min_contract_kg numeric(12,3) not null default 0 check (min_contract_kg >= 0),
  rounding_increment_kg numeric(12,3) not null default 1 check (rounding_increment_kg > 0),
  safety_stock_pct numeric(8,2) not null default 0 check (safety_stock_pct >= 0),
  price_per_kg numeric(12,2) check (price_per_kg is null or price_per_kg >= 0),
  crop_year integer,
  supplier text,
  notes text,
  manual_contract_kg numeric(12,3) check (manual_contract_kg is null or manual_contract_kg >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  order_name text,
  customer_name text,
  beer_id uuid not null references public.beers(id) on delete restrict,
  packaging_type text not null check (packaging_type in ('can_330','can_440','keg_30','keg_50','cask_20','cask_40','custom')),
  unit_size_l numeric(10,3) not null check (unit_size_l > 0),
  confirmed_units integer not null default 0 check (confirmed_units >= 0),
  fulfilled_units integer not null default 0 check (fulfilled_units >= 0),
  likely_repeat_units_next_year integer not null default 0 check (likely_repeat_units_next_year >= 0),
  status text not null default 'confirmed' check (status in ('draft','provisional','confirmed','completed','cancelled')),
  delivery_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.forecast_snapshots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  snapshot jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.edit_locks (
  lock_key text primary key,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  session_id text not null,
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create trigger beers_set_updated_at before update on public.beers for each row execute function public.set_updated_at();
create trigger beer_hops_set_updated_at before update on public.beer_hops for each row execute function public.set_updated_at();
create trigger hop_inventory_set_updated_at before update on public.hop_inventory for each row execute function public.set_updated_at();
create trigger customer_orders_set_updated_at before update on public.customer_orders for each row execute function public.set_updated_at();
create trigger app_settings_set_updated_at before update on public.app_settings for each row execute function public.set_updated_at();

create index production_history_beer_idx on public.production_history(beer_id);
create index production_history_period_idx on public.production_history(period_start, period_end);
create index beer_hops_beer_idx on public.beer_hops(beer_id);
create index customer_orders_beer_idx on public.customer_orders(beer_id);
create index customer_orders_status_idx on public.customer_orders(status);

insert into public.app_settings (key, value) values
  ('forecast', jsonb_build_object('contract_year', extract(year from current_date)::int + 1, 'default_safety_stock_pct', 0)),
  ('app', jsonb_build_object('version', '0.6'));

alter table public.beers enable row level security;
alter table public.beer_hops enable row level security;
alter table public.production_history enable row level security;
alter table public.hop_inventory enable row level security;
alter table public.customer_orders enable row level security;
alter table public.app_settings enable row level security;
alter table public.forecast_snapshots enable row level security;
alter table public.edit_locks enable row level security;

create policy "authenticated users can read beers" on public.beers for select to authenticated using (true);
create policy "authenticated users can write beers" on public.beers for all to authenticated using (true) with check (true);
create policy "authenticated users can read beer_hops" on public.beer_hops for select to authenticated using (true);
create policy "authenticated users can write beer_hops" on public.beer_hops for all to authenticated using (true) with check (true);
create policy "authenticated users can read production_history" on public.production_history for select to authenticated using (true);
create policy "authenticated users can write production_history" on public.production_history for all to authenticated using (true) with check (true);
create policy "authenticated users can read hop_inventory" on public.hop_inventory for select to authenticated using (true);
create policy "authenticated users can write hop_inventory" on public.hop_inventory for all to authenticated using (true) with check (true);
create policy "authenticated users can read customer_orders" on public.customer_orders for select to authenticated using (true);
create policy "authenticated users can write customer_orders" on public.customer_orders for all to authenticated using (true) with check (true);
create policy "authenticated users can read app_settings" on public.app_settings for select to authenticated using (true);
create policy "authenticated users can write app_settings" on public.app_settings for all to authenticated using (true) with check (true);
create policy "authenticated users can read forecast_snapshots" on public.forecast_snapshots for select to authenticated using (true);
create policy "authenticated users can create forecast_snapshots" on public.forecast_snapshots for insert to authenticated with check (auth.uid() = created_by or created_by is null);
create policy "authenticated users can delete own forecast_snapshots" on public.forecast_snapshots for delete to authenticated using (auth.uid() = created_by or created_by is null);
create policy "authenticated users can read edit_locks" on public.edit_locks for select to authenticated using (true);
create policy "authenticated users can write edit_locks" on public.edit_locks for all to authenticated using (true) with check (true);

create or replace function public.get_forecast_state()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'version', '0.6',
    'settings', coalesce((select value from public.app_settings where key = 'forecast'), '{}'::jsonb),
    'beers', coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'batchHl', b.standard_brew_hl, 'active', b.active,
      'forecastType', case b.forecast_type when 'monthly_fixed' then 'monthly' when 'one_off' then 'oneoff' else b.forecast_type end,
      'last12Hl', b.last_12_month_hl, 'growthPct', b.forecast_change_pct,
      'monthlyHl', b.monthly_fixed_hl, 'oneOffHl', b.one_off_hl, 'notes', coalesce(b.notes,''),
      'hops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', bh.id, 'variety', bh.hop_name, 'kgPerBrew', bh.kg_per_standard_brew,
        'additionStage', coalesce(bh.addition_stage,''), 'notes', coalesce(bh.notes,'')) order by bh.hop_name)
        from public.beer_hops bh where bh.beer_id = b.id), '[]'::jsonb)
    ) order by b.name) from public.beers b), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', coalesce(o.order_name, o.customer_name, 'Customer order'),
      'customerName', coalesce(o.customer_name,''), 'beerId', o.beer_id,
      'packageKey', case o.packaging_type when 'can_330' then 'can330' when 'can_440' then 'can440' when 'keg_30' then 'keg30' when 'keg_50' then 'keg50' when 'cask_20' then 'cask20' when 'cask_40' then 'cask40' else 'custom' end,
      'unitSizeL', o.unit_size_l, 'confirmedUnits', o.confirmed_units, 'fulfilledUnits', o.fulfilled_units,
      'likelyRepeatUnits', o.likely_repeat_units_next_year, 'status', o.status,
      'deliveryDate', o.delivery_date, 'notes', coalesce(o.notes,'')) order by o.created_at)
      from public.customer_orders o where o.status <> 'cancelled'), '[]'::jsonb),
    'inventory', coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'variety', i.hop_name, 'stockKg', i.current_stock_kg,
      'contractKg', i.current_contract_remaining_kg, 'expectedUseKg', i.expected_use_before_new_contract_kg,
      'priceKg', coalesce(i.price_per_kg,0), 'roundingKg', i.rounding_increment_kg,
      'minContractKg', i.min_contract_kg, 'manualContractKg', i.manual_contract_kg,
      'safetyStockPct', i.safety_stock_pct, 'cropYear', i.crop_year,
      'supplier', coalesce(i.supplier,''), 'notes', coalesce(i.notes,'')) order by i.hop_name)
      from public.hop_inventory i), '[]'::jsonb)
  );
$$;

create or replace function public.save_forecast_state(payload jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  b jsonb; h jsonb; o jsonb; i jsonb; pkg_type text; pkg_l numeric;
begin
  if exists (select 1 from public.beers) or exists (select 1 from public.hop_inventory) or exists (select 1 from public.customer_orders) then
    insert into public.forecast_snapshots(name, snapshot, created_by)
    values ('Auto backup ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), public.get_forecast_state(), auth.uid());
    delete from public.forecast_snapshots where id in (
      select id from public.forecast_snapshots order by created_at desc offset 30
    );
  end if;

  delete from public.beer_hops;
  delete from public.customer_orders;
  delete from public.hop_inventory;

  for b in select value from jsonb_array_elements(coalesce(payload->'beers','[]'::jsonb)) loop
    insert into public.beers (id,name,standard_brew_hl,forecast_type,last_12_month_hl,forecast_change_pct,monthly_fixed_hl,one_off_hl,active,notes)
    values ((b->>'id')::uuid,coalesce(nullif(trim(b->>'name'),''),'Unnamed beer'),greatest(coalesce((b->>'batchHl')::numeric,21),0.01),
      case b->>'forecastType' when 'monthly' then 'monthly_fixed' when 'oneoff' then 'one_off' when 'seasonal' then 'seasonal' else 'core' end,
      greatest(coalesce((b->>'last12Hl')::numeric,0),0),greatest(coalesce((b->>'growthPct')::numeric,0),-100),
      greatest(coalesce((b->>'monthlyHl')::numeric,0),0),greatest(coalesce((b->>'oneOffHl')::numeric,0),0),coalesce((b->>'active')::boolean,true),nullif(b->>'notes',''))
    on conflict (id) do update set name=excluded.name,standard_brew_hl=excluded.standard_brew_hl,forecast_type=excluded.forecast_type,
      last_12_month_hl=excluded.last_12_month_hl,forecast_change_pct=excluded.forecast_change_pct,monthly_fixed_hl=excluded.monthly_fixed_hl,
      one_off_hl=excluded.one_off_hl,active=excluded.active,notes=excluded.notes;
  end loop;

  delete from public.beers existing where not exists (
    select 1 from jsonb_array_elements(coalesce(payload->'beers','[]'::jsonb)) b where (b->>'id')::uuid = existing.id
  );

  for b in select value from jsonb_array_elements(coalesce(payload->'beers','[]'::jsonb)) loop
    for h in select value from jsonb_array_elements(coalesce(b->'hops','[]'::jsonb)) loop
      if nullif(trim(h->>'variety'),'') is not null then
        insert into public.beer_hops (id,beer_id,hop_name,kg_per_standard_brew,addition_stage,notes)
        values ((h->>'id')::uuid,(b->>'id')::uuid,trim(h->>'variety'),greatest(coalesce((h->>'kgPerBrew')::numeric,0),0),nullif(h->>'additionStage',''),nullif(h->>'notes',''));
      end if;
    end loop;
  end loop;

  for i in select value from jsonb_array_elements(coalesce(payload->'inventory','[]'::jsonb)) loop
    if nullif(trim(i->>'variety'),'') is not null then
      insert into public.hop_inventory (id,hop_name,current_stock_kg,current_contract_remaining_kg,expected_use_before_new_contract_kg,min_contract_kg,rounding_increment_kg,safety_stock_pct,price_per_kg,crop_year,supplier,notes,manual_contract_kg)
      values ((i->>'id')::uuid,trim(i->>'variety'),greatest(coalesce((i->>'stockKg')::numeric,0),0),greatest(coalesce((i->>'contractKg')::numeric,0),0),
        greatest(coalesce((i->>'expectedUseKg')::numeric,0),0),greatest(coalesce((i->>'minContractKg')::numeric,0),0),greatest(coalesce((i->>'roundingKg')::numeric,1),0.01),
        greatest(coalesce((i->>'safetyStockPct')::numeric,0),0),nullif(i->>'priceKg','')::numeric,nullif(i->>'cropYear','')::integer,nullif(i->>'supplier',''),nullif(i->>'notes',''),nullif(i->>'manualContractKg','')::numeric);
    end if;
  end loop;

  for o in select value from jsonb_array_elements(coalesce(payload->'orders','[]'::jsonb)) loop
    pkg_type := case o->>'packageKey' when 'can330' then 'can_330' when 'can440' then 'can_440' when 'keg30' then 'keg_30' when 'keg50' then 'keg_50' when 'cask20' then 'cask_20' when 'cask40' then 'cask_40' else 'custom' end;
    pkg_l := case o->>'packageKey' when 'can330' then 0.33 when 'can440' then 0.44 when 'keg30' then 30 when 'keg50' then 50 when 'cask20' then 20 when 'cask40' then 40 else greatest(coalesce((o->>'unitSizeL')::numeric,1),0.001) end;
    if nullif(o->>'beerId','') is not null then
      insert into public.customer_orders (id,order_name,customer_name,beer_id,packaging_type,unit_size_l,confirmed_units,fulfilled_units,likely_repeat_units_next_year,status,delivery_date,notes)
      values ((o->>'id')::uuid,nullif(o->>'name',''),nullif(o->>'customerName',''),(o->>'beerId')::uuid,pkg_type,pkg_l,
        greatest(coalesce((o->>'confirmedUnits')::integer,0),0),greatest(coalesce((o->>'fulfilledUnits')::integer,0),0),greatest(coalesce((o->>'likelyRepeatUnits')::integer,0),0),
        case when o->>'status' in ('draft','provisional','confirmed','completed','cancelled') then o->>'status' else 'confirmed' end,
        nullif(o->>'deliveryDate','')::date,nullif(o->>'notes',''));
    end if;
  end loop;

  insert into public.app_settings (key,value) values ('forecast',coalesce(payload->'settings','{}'::jsonb))
    on conflict (key) do update set value=excluded.value,updated_at=now();
  insert into public.app_settings (key,value) values ('app',jsonb_build_object('version','0.6'))
    on conflict (key) do update set value=excluded.value,updated_at=now();
end;
$$;

grant execute on function public.get_forecast_state() to authenticated;
grant execute on function public.save_forecast_state(jsonb) to authenticated;
