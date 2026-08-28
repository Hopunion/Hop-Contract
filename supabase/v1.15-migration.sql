-- Hop Contract v1.15 database migration
-- Run after v1.14.
-- Adds exact-product future contract mix and freezes strength/unit metadata in annual history.

begin;

alter table public.hop_inventory
  add column if not exists contract_mix_pct numeric(6,3);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.hop_inventory'::regclass
      and conname='hop_inventory_contract_mix_pct_check'
  ) then
    alter table public.hop_inventory
      add constraint hop_inventory_contract_mix_pct_check
      check (contract_mix_pct is null or (contract_mix_pct >= 0 and contract_mix_pct <= 100));
  end if;
end $$;

alter table public.contract_year_hops
  add column if not exists contract_mix_pct numeric(6,3),
  add column if not exists contract_unit text not null default 'kg',
  add column if not exists t90_eq_factor numeric(14,6) not null default 1;

commit;

create or replace function public.get_forecast_state()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'version', '1.15',
    'settings', coalesce((select value from public.app_settings where key = 'forecast'), '{}'::jsonb),
    'beers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id,
        'name', b.name,
        'batchHl', b.standard_brew_hl,
        'active', b.active,
        'forecastType', case b.forecast_type when 'monthly_fixed' then 'monthly' when 'one_off' then 'oneoff' else b.forecast_type end,
        'last12Hl', b.last_12_month_hl,
        'growthPct', b.forecast_change_pct,
        'monthlyHl', b.monthly_fixed_hl,
        'oneOffHl', b.one_off_hl,
        'notes', coalesce(b.notes,''),
        'hops', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', bh.id,
            'inventoryId', bh.hop_inventory_id,
            'variety', coalesce(hi.hop_name,bh.hop_name),
            'kgPerBrew', bh.kg_per_standard_brew,
            'additionStage', coalesce(bh.addition_stage,''),
            'notes', coalesce(bh.notes,'')
          ) order by coalesce(hi.hop_name,bh.hop_name))
          from public.beer_hops bh
          left join public.hop_inventory hi on hi.id = bh.hop_inventory_id
          where bh.beer_id = b.id
        ), '[]'::jsonb)
      ) order by b.name)
      from public.beers b
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'name', coalesce(o.order_name, o.customer_name, 'Customer order'),
        'customerName', coalesce(o.customer_name,''),
        'beerId', o.beer_id,
        'packageKey', case o.packaging_type
          when 'can_330' then 'can330'
          when 'can_440' then 'can440'
          when 'keg_30' then 'keg30'
          when 'keg_50' then 'keg50'
          when 'cask_20' then 'cask20'
          when 'cask_40' then 'cask40'
          else 'custom'
        end,
        'unitSizeL', o.unit_size_l,
        'confirmedUnits', o.confirmed_units,
        'fulfilledUnits', o.fulfilled_units,
        'likelyRepeatUnits', o.likely_repeat_units_next_year,
        'status', o.status,
        'deliveryDate', o.delivery_date,
        'notes', coalesce(o.notes,'')
      ) order by o.created_at)
      from public.customer_orders o
      where o.status <> 'cancelled'
    ), '[]'::jsonb),
    'inventory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'variety', i.hop_name,
        'hopVariety', coalesce(i.variety,public.hop_product_variety(i.hop_name)),
        'hopFormat', coalesce(i.format,public.hop_product_format(i.hop_name)),
        'hemisphere', coalesce(i.hemisphere,public.hop_product_hemisphere(i.hop_name)),
        'contractEnabled', coalesce(i.contract_enabled,true),
        'contractMixPct', i.contract_mix_pct,
        'stockKg', i.current_stock_kg,
        'contractTotalKg', i.current_contract_total_kg,
        'contractKg', i.current_contract_remaining_kg,
        'expectedUseKg', i.expected_use_before_new_contract_kg,
        'supplierReceived12Kg', i.supplier_received_last_12m_kg,
        'priceKg', coalesce(i.price_per_kg,0),
        'roundingKg', i.rounding_increment_kg,
        'minContractKg', i.min_contract_kg,
        'manualContractKg', i.manual_contract_kg,
        'safetyStockPct', i.safety_stock_pct,
        'cropYear', i.crop_year,
        'supplier', coalesce(i.supplier,''),
        'notes', coalesce(i.notes,'')
      ) order by coalesce(i.variety,i.hop_name), coalesce(i.format,''))
      from public.hop_inventory i
    ), '[]'::jsonb)
  );
$$;

-- Cloud save writes inventory first, then recipe lines, so the FK is valid.





grant execute on function public.get_forecast_state() to authenticated;

create or replace function public.save_forecast_state(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_beer jsonb;
  v_hop jsonb;
  v_order jsonb;
  v_inventory jsonb;
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
  delete from public.beer_hops where id is not null;
  delete from public.customer_orders where id is not null;

  -- Remove live inventory entries genuinely removed in the app.
  delete from public.hop_inventory existing
  where not exists (
    select 1
    from jsonb_array_elements(payload->'inventory') as inv_elem(value)
    where nullif(inv_elem.value->>'id','') is not null
      and (inv_elem.value->>'id')::uuid = existing.id
  );

  -- Preserve historical production if a beer is removed from the live register:
  -- archive it rather than cascading away its production_history.
  update public.beers existing
  set active=false
  where not exists (
    select 1
    from jsonb_array_elements(payload->'beers') as beer_elem(value)
    where nullif(beer_elem.value->>'id','') is not null
      and (beer_elem.value->>'id')::uuid = existing.id
  )
  and exists (
    select 1 from public.production_history ph where ph.beer_id=existing.id
  );

  -- A beer with no historical production can be removed completely.
  delete from public.beers existing
  where not exists (
    select 1
    from jsonb_array_elements(payload->'beers') as beer_elem(value)
    where nullif(beer_elem.value->>'id','') is not null
      and (beer_elem.value->>'id')::uuid = existing.id
  )
  and not exists (
    select 1 from public.production_history ph where ph.beer_id=existing.id
  );

  -- Upsert beers by stable UUID.
  for v_beer in select value from jsonb_array_elements(payload->'beers') loop
    insert into public.beers (
      id, name, standard_brew_hl, forecast_type, last_12_month_hl,
      forecast_change_pct, monthly_fixed_hl, one_off_hl, active, notes
    ) values (
      (v_beer->>'id')::uuid,
      coalesce(nullif(trim(v_beer->>'name'),''),'Unnamed beer'),
      greatest(coalesce((v_beer->>'batchHl')::numeric,21),0.01),
      case v_beer->>'forecastType'
        when 'monthly' then 'monthly_fixed'
        when 'oneoff' then 'one_off'
        when 'seasonal' then 'seasonal'
        else 'core'
      end,
      greatest(coalesce((v_beer->>'last12Hl')::numeric,0),0),
      greatest(coalesce((v_beer->>'growthPct')::numeric,0),-100),
      greatest(coalesce((v_beer->>'monthlyHl')::numeric,0),0),
      greatest(coalesce((v_beer->>'oneOffHl')::numeric,0),0),
      coalesce((v_beer->>'active')::boolean,true),
      nullif(v_beer->>'notes','')
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
  for v_inventory in select value from jsonb_array_elements(payload->'inventory') loop
    if nullif(trim(v_inventory->>'variety'),'') is not null then
      insert into public.hop_inventory (
        id, hop_name, variety, format, hemisphere, contract_enabled, contract_mix_pct,
        current_stock_kg, current_contract_total_kg, current_contract_remaining_kg,
        expected_use_before_new_contract_kg, supplier_received_last_12m_kg,
        min_contract_kg, rounding_increment_kg, safety_stock_pct, price_per_kg,
        crop_year, supplier, notes, manual_contract_kg
      ) values (
        (v_inventory->>'id')::uuid,
        trim(v_inventory->>'variety'),
        coalesce(nullif(v_inventory->>'hopVariety',''), public.hop_product_variety(trim(v_inventory->>'variety'))),
        coalesce(nullif(v_inventory->>'hopFormat',''), public.hop_product_format(trim(v_inventory->>'variety'))),
        case when lower(coalesce(nullif(v_inventory->>'hemisphere',''), public.hop_product_hemisphere(trim(v_inventory->>'variety'))))='southern' then 'Southern' else 'Northern' end,
        coalesce((v_inventory->>'contractEnabled')::boolean,true),
        case when nullif(v_inventory->>'contractMixPct','') is null then null else least(100,greatest(0,(v_inventory->>'contractMixPct')::numeric)) end,
        greatest(coalesce((v_inventory->>'stockKg')::numeric,0),0),
        greatest(coalesce((v_inventory->>'contractTotalKg')::numeric,0),0),
        greatest(coalesce((v_inventory->>'contractKg')::numeric,0),0),
        greatest(coalesce((v_inventory->>'expectedUseKg')::numeric,0),0),
        greatest(coalesce((v_inventory->>'supplierReceived12Kg')::numeric,0),0),
        greatest(coalesce((v_inventory->>'minContractKg')::numeric,0),0),
        greatest(coalesce((v_inventory->>'roundingKg')::numeric,5),0.01),
        greatest(coalesce((v_inventory->>'safetyStockPct')::numeric,0),0),
        nullif(v_inventory->>'priceKg','')::numeric,
        nullif(v_inventory->>'cropYear','')::integer,
        nullif(v_inventory->>'supplier',''),
        nullif(v_inventory->>'notes',''),
        nullif(v_inventory->>'manualContractKg','')::numeric
      )
      on conflict (id) do update set
        hop_name=excluded.hop_name,
        variety=excluded.variety,
        format=excluded.format,
        hemisphere=excluded.hemisphere,
        contract_enabled=excluded.contract_enabled,
        contract_mix_pct=excluded.contract_mix_pct,
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
  for v_beer in select value from jsonb_array_elements(payload->'beers') loop
    for v_hop in select value from jsonb_array_elements(coalesce(v_beer->'hops','[]'::jsonb)) loop
      inventory_uuid := null;
      if nullif(v_hop->>'inventoryId','') is not null then
        begin
          inventory_uuid := (v_hop->>'inventoryId')::uuid;
        exception when invalid_text_representation then
          inventory_uuid := null;
        end;
      end if;

      select hi.hop_name into inventory_name
      from public.hop_inventory hi
      where hi.id=inventory_uuid;

      if inventory_uuid is not null or nullif(trim(v_hop->>'variety'),'') is not null then
        insert into public.beer_hops(
          id, beer_id, hop_inventory_id, hop_name,
          kg_per_standard_brew, addition_stage, notes
        ) values (
          (v_hop->>'id')::uuid,
          (v_beer->>'id')::uuid,
          case when inventory_name is not null then inventory_uuid else null end,
          coalesce(inventory_name,nullif(trim(v_hop->>'variety'),''),'Unlinked hop'),
          greatest(coalesce((v_hop->>'kgPerBrew')::numeric,0),0),
          nullif(v_hop->>'additionStage',''),
          nullif(v_hop->>'notes','')
        );
      end if;
    end loop;
  end loop;

  -- Recreate current orders.
  for v_order in select value from jsonb_array_elements(coalesce(payload->'orders','[]'::jsonb)) loop
    pkg_type := case v_order->>'packageKey'
      when 'can330' then 'can_330'
      when 'can440' then 'can_440'
      when 'keg30' then 'keg_30'
      when 'keg50' then 'keg_50'
      when 'cask20' then 'cask_20'
      when 'cask40' then 'cask_40'
      else 'custom'
    end;

    pkg_l := case v_order->>'packageKey'
      when 'can330' then 0.33
      when 'can440' then 0.44
      when 'keg30' then 30
      when 'keg50' then 50
      when 'cask20' then 20
      when 'cask40' then 40
      else greatest(coalesce((v_order->>'unitSizeL')::numeric,1),0.001)
    end;

    if nullif(v_order->>'beerId','') is not null then
      insert into public.customer_orders(
        id, order_name, customer_name, beer_id, packaging_type,
        unit_size_l, confirmed_units, fulfilled_units,
        likely_repeat_units_next_year, status, delivery_date, notes
      ) values (
        (v_order->>'id')::uuid,
        nullif(v_order->>'name',''),
        nullif(v_order->>'customerName',''),
        (v_order->>'beerId')::uuid,
        pkg_type,
        pkg_l,
        greatest(coalesce((v_order->>'confirmedUnits')::integer,0),0),
        greatest(coalesce((v_order->>'fulfilledUnits')::integer,0),0),
        greatest(coalesce((v_order->>'likelyRepeatUnits')::integer,0),0),
        case when v_order->>'status' in ('draft','provisional','confirmed','completed','cancelled')
          then v_order->>'status' else 'confirmed' end,
        nullif(v_order->>'deliveryDate','')::date,
        nullif(v_order->>'notes','')
      );
    end if;
  end loop;

  insert into public.app_settings(key,value)
  values('forecast',coalesce(payload->'settings','{}'::jsonb))
  on conflict(key) do update set value=excluded.value,updated_at=now();

  insert into public.app_settings(key,value)
  values('app',jsonb_build_object('version','1.15'))
  on conflict(key) do update set value=excluded.value,updated_at=now();
end;
$$;









grant execute on function public.save_forecast_state(jsonb) to authenticated;
alter function public.save_forecast_state(jsonb) set statement_timeout='25s';

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
        'hopFormat', coalesce(cyh.hop_format,''),
        'hemisphere', cyh.hemisphere,
        'contractEnabled', cyh.contract_enabled,
        'contractMixPct', cyh.contract_mix_pct,
        'contractUnit', cyh.contract_unit,
        't90EqFactor', cyh.t90_eq_factor,
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
    if coalesce((h->>'contractEnabled')::boolean,true)=false then final_kg := 0; end if;
    if final_kg > 0 then final_kg := ceil(final_kg / 5.0) * 5.0; end if;

    insert into public.contract_year_hops(
      contract_year_id, hop_inventory_id, hop_name, hop_format, hemisphere, contract_enabled,
      contract_mix_pct, contract_unit, t90_eq_factor,
      in_stock_kg, on_contract_kg, previous_use_12m_kg, projected_use_kg,
      use_before_start_kg, stock_at_start_kg, contract_remaining_at_start_kg,
      pre_start_shortfall_kg, previous_contract_kg,
      recommended_contract_kg, final_contract_kg, price_per_kg
    ) values (
      y.id,
      nullif(h->>'inventoryId','')::uuid,
      coalesce(nullif(trim(h->>'hopName'),''),'Unknown hop'),
      coalesce(nullif(trim(h->>'hopFormat'),''), public.hop_product_format(coalesce(h->>'hopName',''))),
      case when lower(coalesce(nullif(h->>'hemisphere',''),public.hop_product_hemisphere(coalesce(h->>'hopName',''))))='southern' then 'Southern' else 'Northern' end,
      coalesce((h->>'contractEnabled')::boolean,true),
      case when nullif(h->>'contractMixPct','') is null then null else least(100,greatest(0,(h->>'contractMixPct')::numeric)) end,
      coalesce(nullif(trim(h->>'contractUnit'),''),'kg'),
      greatest(coalesce((h->>'t90EqFactor')::numeric,1),0.000001),
      greatest(coalesce((h->>'inStockKg')::numeric,0),0),
      greatest(coalesce((h->>'onContractKg')::numeric,0),0),
      greatest(coalesce((h->>'previousUse12mKg')::numeric,0),0),
      greatest(coalesce((h->>'projectedUseKg')::numeric,0),0),
      greatest(coalesce((h->>'useBeforeStartKg')::numeric,0),0),
      greatest(coalesce((h->>'stockAtStartKg')::numeric,0),0),
      greatest(coalesce((h->>'contractRemainingAtStartKg')::numeric,0),0),
      greatest(coalesce((h->>'preStartShortfallKg')::numeric,0),0),
      greatest(coalesce((h->>'previousContractKg')::numeric,0),0),
      case when coalesce((h->>'contractEnabled')::boolean,true)=false then 0 else greatest(coalesce((h->>'recommendedContractKg')::numeric,0),0) end,
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

insert into public.app_settings(key,value)
values('app',jsonb_build_object('version','1.15'))
on conflict(key) do update set value=excluded.value,updated_at=now();

select jsonb_build_object(
  'inventoryContractMix',
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='hop_inventory' and column_name='contract_mix_pct'),
  'historyContractMix',
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='contract_year_hops' and column_name='contract_mix_pct'),
  'historyContractUnit',
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='contract_year_hops' and column_name='contract_unit'),
  'historyT90EqFactor',
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='contract_year_hops' and column_name='t90_eq_factor')
) as v115_check;
