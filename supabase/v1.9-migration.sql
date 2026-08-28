-- Hop Contract v1.9 database migration
-- Run AFTER v1.8.
--
-- Adds the January contract-start bridge to frozen annual contract history and
-- replaces the live-state save RPC with a safer non-destructive upsert routine.
--
-- January rule:
--   * New contract begins 1 January of the contract year.
--   * Live app estimates use from the "Stock / contract as at" date to 1 January
--     from projected 12-month current-recipe demand.
--   * Physical stock is consumed first, then current contract remaining.
--   * Any pre-January shortfall is stored separately.
--   * Recommended new contract uses the projected stock + contract balance at
--     1 January, then rounds up to 5 kg in the app/finalisation workflow.

begin;

alter table public.contract_year_hops
  add column if not exists use_before_start_kg numeric(12,3) not null default 0
    check (use_before_start_kg >= 0),
  add column if not exists stock_at_start_kg numeric(12,3) not null default 0
    check (stock_at_start_kg >= 0),
  add column if not exists contract_remaining_at_start_kg numeric(12,3) not null default 0
    check (contract_remaining_at_start_kg >= 0),
  add column if not exists pre_start_shortfall_kg numeric(12,3) not null default 0
    check (pre_start_shortfall_kg >= 0);

commit;

-- Recipe lines are versioned by row UUID; duplicate use of the same hop product
-- is valid (for example separate whirlpool and dry-hop additions). The original
-- prototype uniqueness rule could make an otherwise valid autosave fail.
alter table public.beer_hops
  drop constraint if exists beer_hops_beer_id_hop_name_addition_stage_key;

-- ---------------------------------------------------------------------------
-- Finalised-year reader
-- ---------------------------------------------------------------------------

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
    'contractStartDate', make_date(y.contract_year,1,1),
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
        'previousUse12mKg', cyh.previous_use_12m_kg,
        'projectedUseKg', cyh.projected_use_kg,
        'useBeforeStartKg', cyh.use_before_start_kg,
        'stockAtStartKg', cyh.stock_at_start_kg,
        'contractRemainingAtStartKg', cyh.contract_remaining_at_start_kg,
        'preStartShortfallKg', cyh.pre_start_shortfall_kg,
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

-- ---------------------------------------------------------------------------
-- Finalise year and freeze January bridge values
-- ---------------------------------------------------------------------------

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
    if final_kg > 0 then final_kg := ceil(final_kg / 5.0) * 5.0; end if;

    insert into public.contract_year_hops(
      contract_year_id, hop_inventory_id, hop_name,
      in_stock_kg, on_contract_kg, previous_use_12m_kg, projected_use_kg,
      use_before_start_kg, stock_at_start_kg, contract_remaining_at_start_kg,
      pre_start_shortfall_kg, previous_contract_kg,
      recommended_contract_kg, final_contract_kg, price_per_kg
    ) values (
      y.id,
      nullif(h->>'inventoryId','')::uuid,
      coalesce(nullif(trim(h->>'hopName'),''),'Unknown hop'),
      greatest(coalesce((h->>'inStockKg')::numeric,0),0),
      greatest(coalesce((h->>'onContractKg')::numeric,0),0),
      greatest(coalesce((h->>'previousUse12mKg')::numeric,0),0),
      greatest(coalesce((h->>'projectedUseKg')::numeric,0),0),
      greatest(coalesce((h->>'useBeforeStartKg')::numeric,0),0),
      greatest(coalesce((h->>'stockAtStartKg')::numeric,0),0),
      greatest(coalesce((h->>'contractRemainingAtStartKg')::numeric,0),0),
      greatest(coalesce((h->>'preStartShortfallKg')::numeric,0),0),
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

grant execute on function public.get_contract_year_detail(uuid) to authenticated;
grant execute on function public.finalise_contract_year(uuid,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Safer live cloud save
-- ---------------------------------------------------------------------------
-- v1.5 deleted the entire inventory table and recreated it on every autosave.
-- v1.9 instead:
--   1) backs up current state,
--   2) clears only recipe/order child rows,
--   3) removes rows genuinely absent from the payload,
--   4) UPSERTS beers/inventory by UUID,
--   5) recreates current recipe/order child rows.
-- This is less fragile and preserves stable inventory IDs between saves.

create or replace function public.save_forecast_state(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b jsonb;
  h jsonb;
  o jsonb;
  i jsonb;
  pkg_type text;
  pkg_l numeric;
  inventory_uuid uuid;
  inventory_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'Invalid save payload';
  end if;
  if not (payload ? 'beers') or jsonb_typeof(payload->'beers') <> 'array' then
    raise exception 'Save payload is missing beers array';
  end if;
  if not (payload ? 'inventory') or jsonb_typeof(payload->'inventory') <> 'array' then
    raise exception 'Save payload is missing inventory array';
  end if;

  if (
       exists (select 1 from public.beers)
       or exists (select 1 from public.hop_inventory)
       or exists (select 1 from public.customer_orders)
     )
     and not exists (
       select 1
       from public.forecast_snapshots
       where name like 'Auto backup %'
         and created_at > now() - interval '15 minutes'
     ) then
    insert into public.forecast_snapshots(name, snapshot, created_by)
    values (
      'Auto backup ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      public.get_forecast_state(),
      auth.uid()
    );

    delete from public.forecast_snapshots
    where id in (
      select id from public.forecast_snapshots
      order by created_at desc
      offset 30
    );
  end if;

  -- Remove child rows first. Historical annual snapshots are separate tables.
  delete from public.beer_hops;
  delete from public.customer_orders;

  -- Remove live inventory entries genuinely removed in the app.
  delete from public.hop_inventory existing
  where not exists (
    select 1
    from jsonb_array_elements(payload->'inventory') i
    where nullif(i->>'id','') is not null
      and (i->>'id')::uuid = existing.id
  );

  -- Preserve historical production if a beer is removed from the live register:
  -- archive it rather than cascading away its production_history.
  update public.beers existing
  set active=false
  where not exists (
    select 1
    from jsonb_array_elements(payload->'beers') b
    where nullif(b->>'id','') is not null
      and (b->>'id')::uuid = existing.id
  )
  and exists (
    select 1 from public.production_history ph where ph.beer_id=existing.id
  );

  -- A beer with no historical production can be removed completely.
  delete from public.beers existing
  where not exists (
    select 1
    from jsonb_array_elements(payload->'beers') b
    where nullif(b->>'id','') is not null
      and (b->>'id')::uuid = existing.id
  )
  and not exists (
    select 1 from public.production_history ph where ph.beer_id=existing.id
  );

  -- Upsert beers by stable UUID.
  for b in select value from jsonb_array_elements(payload->'beers') loop
    insert into public.beers (
      id, name, standard_brew_hl, forecast_type, last_12_month_hl,
      forecast_change_pct, monthly_fixed_hl, one_off_hl, active, notes
    ) values (
      (b->>'id')::uuid,
      coalesce(nullif(trim(b->>'name'),''),'Unnamed beer'),
      greatest(coalesce((b->>'batchHl')::numeric,21),0.01),
      case b->>'forecastType'
        when 'monthly' then 'monthly_fixed'
        when 'oneoff' then 'one_off'
        when 'seasonal' then 'seasonal'
        else 'core'
      end,
      greatest(coalesce((b->>'last12Hl')::numeric,0),0),
      greatest(coalesce((b->>'growthPct')::numeric,0),-100),
      greatest(coalesce((b->>'monthlyHl')::numeric,0),0),
      greatest(coalesce((b->>'oneOffHl')::numeric,0),0),
      coalesce((b->>'active')::boolean,true),
      nullif(b->>'notes','')
    )
    on conflict (id) do update set
      name=excluded.name,
      standard_brew_hl=excluded.standard_brew_hl,
      forecast_type=excluded.forecast_type,
      last_12_month_hl=excluded.last_12_month_hl,
      forecast_change_pct=excluded.forecast_change_pct,
      monthly_fixed_hl=excluded.monthly_fixed_hl,
      one_off_hl=excluded.one_off_hl,
      active=excluded.active,
      notes=excluded.notes;
  end loop;

  -- Upsert inventory by stable UUID instead of wiping/recreating the table.
  for i in select value from jsonb_array_elements(payload->'inventory') loop
    if nullif(trim(i->>'variety'),'') is not null then
      insert into public.hop_inventory (
        id, hop_name, variety, format,
        current_stock_kg, current_contract_total_kg, current_contract_remaining_kg,
        expected_use_before_new_contract_kg, supplier_received_last_12m_kg,
        min_contract_kg, rounding_increment_kg, safety_stock_pct, price_per_kg,
        crop_year, supplier, notes, manual_contract_kg
      ) values (
        (i->>'id')::uuid,
        trim(i->>'variety'),
        coalesce(nullif(i->>'hopVariety',''), public.hop_product_variety(trim(i->>'variety'))),
        coalesce(nullif(i->>'hopFormat',''), public.hop_product_format(trim(i->>'variety'))),
        greatest(coalesce((i->>'stockKg')::numeric,0),0),
        greatest(coalesce((i->>'contractTotalKg')::numeric,0),0),
        greatest(coalesce((i->>'contractKg')::numeric,0),0),
        greatest(coalesce((i->>'expectedUseKg')::numeric,0),0),
        greatest(coalesce((i->>'supplierReceived12Kg')::numeric,0),0),
        greatest(coalesce((i->>'minContractKg')::numeric,0),0),
        greatest(coalesce((i->>'roundingKg')::numeric,5),0.01),
        greatest(coalesce((i->>'safetyStockPct')::numeric,0),0),
        nullif(i->>'priceKg','')::numeric,
        nullif(i->>'cropYear','')::integer,
        nullif(i->>'supplier',''),
        nullif(i->>'notes',''),
        nullif(i->>'manualContractKg','')::numeric
      )
      on conflict (id) do update set
        hop_name=excluded.hop_name,
        variety=excluded.variety,
        format=excluded.format,
        current_stock_kg=excluded.current_stock_kg,
        current_contract_total_kg=excluded.current_contract_total_kg,
        current_contract_remaining_kg=excluded.current_contract_remaining_kg,
        expected_use_before_new_contract_kg=excluded.expected_use_before_new_contract_kg,
        supplier_received_last_12m_kg=excluded.supplier_received_last_12m_kg,
        min_contract_kg=excluded.min_contract_kg,
        rounding_increment_kg=excluded.rounding_increment_kg,
        safety_stock_pct=excluded.safety_stock_pct,
        price_per_kg=excluded.price_per_kg,
        crop_year=excluded.crop_year,
        supplier=excluded.supplier,
        notes=excluded.notes,
        manual_contract_kg=excluded.manual_contract_kg;
    end if;
  end loop;

  -- Recreate the current forward-looking recipe lines.
  for b in select value from jsonb_array_elements(payload->'beers') loop
    for h in select value from jsonb_array_elements(coalesce(b->'hops','[]'::jsonb)) loop
      inventory_uuid := null;
      if nullif(h->>'inventoryId','') is not null then
        begin
          inventory_uuid := (h->>'inventoryId')::uuid;
        exception when invalid_text_representation then
          inventory_uuid := null;
        end;
      end if;

      select hi.hop_name into inventory_name
      from public.hop_inventory hi
      where hi.id=inventory_uuid;

      if inventory_uuid is not null or nullif(trim(h->>'variety'),'') is not null then
        insert into public.beer_hops(
          id, beer_id, hop_inventory_id, hop_name,
          kg_per_standard_brew, addition_stage, notes
        ) values (
          (h->>'id')::uuid,
          (b->>'id')::uuid,
          case when inventory_name is not null then inventory_uuid else null end,
          coalesce(inventory_name,nullif(trim(h->>'variety'),''),'Unlinked hop'),
          greatest(coalesce((h->>'kgPerBrew')::numeric,0),0),
          nullif(h->>'additionStage',''),
          nullif(h->>'notes','')
        );
      end if;
    end loop;
  end loop;

  -- Recreate current orders.
  for o in select value from jsonb_array_elements(coalesce(payload->'orders','[]'::jsonb)) loop
    pkg_type := case o->>'packageKey'
      when 'can330' then 'can_330'
      when 'can440' then 'can_440'
      when 'keg30' then 'keg_30'
      when 'keg50' then 'keg_50'
      when 'cask20' then 'cask_20'
      when 'cask40' then 'cask_40'
      else 'custom'
    end;

    pkg_l := case o->>'packageKey'
      when 'can330' then 0.33
      when 'can440' then 0.44
      when 'keg30' then 30
      when 'keg50' then 50
      when 'cask20' then 20
      when 'cask40' then 40
      else greatest(coalesce((o->>'unitSizeL')::numeric,1),0.001)
    end;

    if nullif(o->>'beerId','') is not null then
      insert into public.customer_orders(
        id, order_name, customer_name, beer_id, packaging_type,
        unit_size_l, confirmed_units, fulfilled_units,
        likely_repeat_units_next_year, status, delivery_date, notes
      ) values (
        (o->>'id')::uuid,
        nullif(o->>'name',''),
        nullif(o->>'customerName',''),
        (o->>'beerId')::uuid,
        pkg_type,
        pkg_l,
        greatest(coalesce((o->>'confirmedUnits')::integer,0),0),
        greatest(coalesce((o->>'fulfilledUnits')::integer,0),0),
        greatest(coalesce((o->>'likelyRepeatUnits')::integer,0),0),
        case when o->>'status' in ('draft','provisional','confirmed','completed','cancelled')
          then o->>'status' else 'confirmed' end,
        nullif(o->>'deliveryDate','')::date,
        nullif(o->>'notes','')
      );
    end if;
  end loop;

  insert into public.app_settings(key,value)
  values('forecast',coalesce(payload->'settings','{}'::jsonb))
  on conflict(key) do update set value=excluded.value,updated_at=now();

  insert into public.app_settings(key,value)
  values('app',jsonb_build_object('version','1.9'))
  on conflict(key) do update set value=excluded.value,updated_at=now();
end;
$$;

grant execute on function public.save_forecast_state(jsonb) to authenticated;

-- Verification
select
  column_name,
  data_type
from information_schema.columns
where table_schema='public'
  and table_name='contract_year_hops'
  and column_name in (
    'use_before_start_kg',
    'stock_at_start_kg',
    'contract_remaining_at_start_kg',
    'pre_start_shortfall_kg'
  )
order by column_name;
