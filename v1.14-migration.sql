-- Hop Contract v1.14 database migration
-- Adds explicit format storage to finalised annual contract snapshots.
-- Run after v1.13.

begin;

alter table public.contract_year_hops
  add column if not exists hop_format text not null default '';

-- Backfill known historic formats using the existing product parser.
update public.contract_year_hops
set hop_format=public.hop_product_format(hop_name)
where coalesce(hop_format,'')='';

commit;

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
values('app',jsonb_build_object('version','1.14'))
on conflict(key) do update set value=excluded.value,updated_at=now();

select jsonb_build_object(
  'historicHopFormat',
  exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='contract_year_hops' and column_name='hop_format')
) as v114_check;
