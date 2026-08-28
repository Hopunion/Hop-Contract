-- Hop Contract v1.1
-- Recipe hops are selected from Hop Inventory by UUID.
-- Safe to run once on an existing v1.0 database. Statements are written
-- defensively so rerunning the structural part is harmless.

begin;

-- Structured variety / format fields remain alongside hop_name for compatibility.
alter table public.hop_inventory
  add column if not exists variety text,
  add column if not exists format text;

create or replace function public.hop_product_format(product_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(product_name,'') ~* '\s+HyperBoost Oil$' then 'HyperBoost Oil'
    when coalesce(product_name,'') ~* '\s+HyperBoost$' then 'HyperBoost'
    when coalesce(product_name,'') ~* '\s+Incognito$' then 'Incognito'
    when coalesce(product_name,'') ~* '\s+Spectrum$' then 'Spectrum'
    when coalesce(product_name,'') ~* '\s+Cryo$' then 'Cryo'
    when coalesce(product_name,'') ~* '\s+T90$' then 'T90'
    when coalesce(product_name,'') ~* '\s+T45$' then 'T45'
    when coalesce(product_name,'') ~* '\s+Oil$' then 'Oil'
    else ''
  end;
$$;

create or replace function public.hop_product_variety(product_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select trim(
    case public.hop_product_format(product_name)
      when 'HyperBoost Oil' then regexp_replace(coalesce(product_name,''), '\s+HyperBoost Oil$', '', 'i')
      when 'HyperBoost' then regexp_replace(coalesce(product_name,''), '\s+HyperBoost$', '', 'i')
      when 'Incognito' then regexp_replace(coalesce(product_name,''), '\s+Incognito$', '', 'i')
      when 'Spectrum' then regexp_replace(coalesce(product_name,''), '\s+Spectrum$', '', 'i')
      when 'Cryo' then regexp_replace(coalesce(product_name,''), '\s+Cryo$', '', 'i')
      when 'T90' then regexp_replace(coalesce(product_name,''), '\s+T90$', '', 'i')
      when 'T45' then regexp_replace(coalesce(product_name,''), '\s+T45$', '', 'i')
      when 'Oil' then regexp_replace(coalesce(product_name,''), '\s+Oil$', '', 'i')
      else coalesce(product_name,'')
    end
  );
$$;

update public.hop_inventory
set
  variety = public.hop_product_variety(hop_name),
  format = public.hop_product_format(hop_name)
where variety is null or format is null;

create index if not exists hop_inventory_variety_format_idx
  on public.hop_inventory (lower(variety), lower(format));

alter table public.beer_hops
  add column if not exists hop_inventory_id uuid
  references public.hop_inventory(id)
  on delete set null;

update public.beer_hops bh
set hop_inventory_id = hi.id
from public.hop_inventory hi
where bh.hop_inventory_id is null
  and lower(trim(bh.hop_name)) = lower(trim(hi.hop_name));

create index if not exists beer_hops_inventory_idx
  on public.beer_hops(hop_inventory_id);

-- Cloud load now returns the exact inventory UUID on each recipe line.
create or replace function public.get_forecast_state()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'version', '1.1',
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
        'stockKg', i.current_stock_kg,
        'contractKg', i.current_contract_remaining_kg,
        'expectedUseKg', i.expected_use_before_new_contract_kg,
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
create or replace function public.save_forecast_state(payload jsonb)
returns void
language plpgsql
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
  if exists (select 1 from public.beers)
     or exists (select 1 from public.hop_inventory)
     or exists (select 1 from public.customer_orders) then
    insert into public.forecast_snapshots(name, snapshot, created_by)
    values ('Auto backup ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), public.get_forecast_state(), auth.uid());

    delete from public.forecast_snapshots
    where id in (
      select id from public.forecast_snapshots
      order by created_at desc
      offset 30
    );
  end if;

  delete from public.beer_hops;
  delete from public.customer_orders;
  delete from public.hop_inventory;

  -- Upsert beers first.
  for b in select value from jsonb_array_elements(coalesce(payload->'beers','[]'::jsonb)) loop
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
      name = excluded.name,
      standard_brew_hl = excluded.standard_brew_hl,
      forecast_type = excluded.forecast_type,
      last_12_month_hl = excluded.last_12_month_hl,
      forecast_change_pct = excluded.forecast_change_pct,
      monthly_fixed_hl = excluded.monthly_fixed_hl,
      one_off_hl = excluded.one_off_hl,
      active = excluded.active,
      notes = excluded.notes;
  end loop;

  delete from public.beers existing
  where not exists (
    select 1
    from jsonb_array_elements(coalesce(payload->'beers','[]'::jsonb)) b
    where (b->>'id')::uuid = existing.id
  );

  -- Inventory must exist before beer_hops because recipes now reference it.
  for i in select value from jsonb_array_elements(coalesce(payload->'inventory','[]'::jsonb)) loop
    if nullif(trim(i->>'variety'),'') is not null then
      insert into public.hop_inventory (
        id, hop_name, variety, format,
        current_stock_kg, current_contract_remaining_kg,
        expected_use_before_new_contract_kg, min_contract_kg,
        rounding_increment_kg, safety_stock_pct, price_per_kg,
        crop_year, supplier, notes, manual_contract_kg
      ) values (
        (i->>'id')::uuid,
        trim(i->>'variety'),
        coalesce(nullif(i->>'hopVariety',''), public.hop_product_variety(trim(i->>'variety'))),
        coalesce(nullif(i->>'hopFormat',''), public.hop_product_format(trim(i->>'variety'))),
        greatest(coalesce((i->>'stockKg')::numeric,0),0),
        greatest(coalesce((i->>'contractKg')::numeric,0),0),
        greatest(coalesce((i->>'expectedUseKg')::numeric,0),0),
        greatest(coalesce((i->>'minContractKg')::numeric,0),0),
        greatest(coalesce((i->>'roundingKg')::numeric,1),0.01),
        greatest(coalesce((i->>'safetyStockPct')::numeric,0),0),
        nullif(i->>'priceKg','')::numeric,
        nullif(i->>'cropYear','')::integer,
        nullif(i->>'supplier',''),
        nullif(i->>'notes',''),
        nullif(i->>'manualContractKg','')::numeric
      );
    end if;
  end loop;

  -- Recipe lines now carry inventoryId. Old unlinked lines are still preserved.
  for b in select value from jsonb_array_elements(coalesce(payload->'beers','[]'::jsonb)) loop
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
      where hi.id = inventory_uuid;

      if inventory_uuid is not null or nullif(trim(h->>'variety'),'') is not null then
        insert into public.beer_hops (
          id, beer_id, hop_inventory_id, hop_name,
          kg_per_standard_brew, addition_stage, notes
        ) values (
          (h->>'id')::uuid,
          (b->>'id')::uuid,
          case when inventory_name is not null then inventory_uuid else null end,
          coalesce(inventory_name, nullif(trim(h->>'variety'),''), 'Unlinked hop'),
          greatest(coalesce((h->>'kgPerBrew')::numeric,0),0),
          nullif(h->>'additionStage',''),
          nullif(h->>'notes','')
        );
      end if;
    end loop;
  end loop;

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
      insert into public.customer_orders (
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

  insert into public.app_settings (key, value)
  values ('forecast', coalesce(payload->'settings','{}'::jsonb))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  insert into public.app_settings (key, value)
  values ('app', jsonb_build_object('version','1.1'))
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

grant execute on function public.get_forecast_state() to authenticated;
grant execute on function public.save_forecast_state(jsonb) to authenticated;

-- Verification uses a direct join so no extra API-facing view is required.

commit;

-- Verification: any UNLINKED lines should be reviewed in the recipe editor.
select
  b.name as beer,
  bh.hop_name as recipe_hop,
  hi.variety,
  hi.format,
  bh.kg_per_standard_brew,
  case when bh.hop_inventory_id is null then 'UNLINKED' else 'LINKED' end as inventory_link
from public.beer_hops bh
join public.beers b on b.id = bh.beer_id
left join public.hop_inventory hi on hi.id = bh.hop_inventory_id
order by b.name, bh.hop_name;
