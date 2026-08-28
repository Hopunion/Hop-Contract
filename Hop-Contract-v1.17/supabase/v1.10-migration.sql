-- Hop Contract v1.10 diagnostic migration
-- Run after v1.9.
-- Adds read-only diagnostics for save failures and clears the Security Definer View advisor warning.

begin;

-- The verification view should use the querying user's permissions/RLS,
-- not the view creator's privileges.
create or replace view public.hop_recipe_inventory_links
with (security_invoker = true)
as
select
  b.name as beer,
  bh.id as recipe_hop_id,
  bh.hop_name as recipe_hop,
  bh.kg_per_standard_brew,
  hi.id as inventory_id,
  hi.variety,
  hi.format,
  hi.current_stock_kg,
  hi.current_contract_remaining_kg
from public.beer_hops bh
join public.beers b on b.id = bh.beer_id
left join public.hop_inventory hi on hi.id = bh.hop_inventory_id;

grant select on public.hop_recipe_inventory_links to authenticated;

-- Make a genuinely stuck database save return a useful query-cancelled error
-- rather than leaving the browser on "Saving…" indefinitely.
alter function public.save_forecast_state(jsonb)
  set statement_timeout = '25s';

create or replace function public.diagnose_hop_contract(p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  duplicate_inventory jsonb;
  inventory_conflicts jsonb;
  duplicate_beers jsonb;
  duplicate_recipe_ids jsonb;
  missing_recipe_inventory integer := 0;
  lock_json jsonb;
  payload_inventory integer := 0;
  payload_beers integer := 0;
  payload_orders integer := 0;
  payload_recipe_lines integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    p_payload := '{}'::jsonb;
  end if;

  payload_inventory := case when jsonb_typeof(p_payload->'inventory')='array' then jsonb_array_length(p_payload->'inventory') else 0 end;
  payload_beers := case when jsonb_typeof(p_payload->'beers')='array' then jsonb_array_length(p_payload->'beers') else 0 end;
  payload_orders := case when jsonb_typeof(p_payload->'orders')='array' then jsonb_array_length(p_payload->'orders') else 0 end;

  if jsonb_typeof(p_payload->'beers')='array' then
    select count(*) into payload_recipe_lines
    from jsonb_array_elements(p_payload->'beers') b
    cross join lateral jsonb_array_elements(coalesce(b->'hops','[]'::jsonb)) h;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('name',name,'count',cnt)),'[]'::jsonb)
  into duplicate_inventory
  from (
    select lower(trim(i->>'variety')) as name, count(*) as cnt
    from jsonb_array_elements(coalesce(p_payload->'inventory','[]'::jsonb)) i
    where nullif(trim(i->>'variety'),'') is not null
    group by lower(trim(i->>'variety'))
    having count(*) > 1
  ) d;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payloadName',trim(i->>'variety'),
    'payloadId',i->>'id',
    'databaseId',hi.id::text,
    'databaseName',hi.hop_name
  )),'[]'::jsonb)
  into inventory_conflicts
  from jsonb_array_elements(coalesce(p_payload->'inventory','[]'::jsonb)) i
  join public.hop_inventory hi
    on lower(trim(hi.hop_name)) = lower(trim(i->>'variety'))
   and hi.id::text <> coalesce(i->>'id','');

  select coalesce(jsonb_agg(jsonb_build_object('name',name,'count',cnt)),'[]'::jsonb)
  into duplicate_beers
  from (
    select lower(trim(b->>'name')) as name, count(*) as cnt
    from jsonb_array_elements(coalesce(p_payload->'beers','[]'::jsonb)) b
    where nullif(trim(b->>'name'),'') is not null
    group by lower(trim(b->>'name'))
    having count(*) > 1
  ) d;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'count',cnt)),'[]'::jsonb)
  into duplicate_recipe_ids
  from (
    select h->>'id' as id, count(*) as cnt
    from jsonb_array_elements(coalesce(p_payload->'beers','[]'::jsonb)) b
    cross join lateral jsonb_array_elements(coalesce(b->'hops','[]'::jsonb)) h
    where nullif(h->>'id','') is not null
    group by h->>'id'
    having count(*) > 1
  ) d;

  select count(*) into missing_recipe_inventory
  from jsonb_array_elements(coalesce(p_payload->'beers','[]'::jsonb)) b
  cross join lateral jsonb_array_elements(coalesce(b->'hops','[]'::jsonb)) h
  where nullif(h->>'inventoryId','') is not null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_payload->'inventory','[]'::jsonb)) i
      where i->>'id' = h->>'inventoryId'
    );

  select to_jsonb(l) into lock_json
  from public.edit_locks l
  where l.lock_key='global';

  result := jsonb_build_object(
    'serverTime', now(),
    'authenticatedUserId', auth.uid(),
    'databaseCounts', jsonb_build_object(
      'beers',(select count(*) from public.beers),
      'recipeLines',(select count(*) from public.beer_hops),
      'inventory',(select count(*) from public.hop_inventory),
      'orders',(select count(*) from public.customer_orders),
      'contractYears',(select count(*) from public.contract_years)
    ),
    'payloadCounts', jsonb_build_object(
      'beers',payload_beers,
      'recipeLines',payload_recipe_lines,
      'inventory',payload_inventory,
      'orders',payload_orders
    ),
    'duplicateInventoryNamesInPayload', duplicate_inventory,
    'inventoryNameConflictsWithDatabase', inventory_conflicts,
    'duplicateBeerNamesInPayload', duplicate_beers,
    'duplicateRecipeIdsInPayload', duplicate_recipe_ids,
    'recipeLinksMissingFromPayloadInventory', missing_recipe_inventory,
    'editingLock', coalesce(lock_json,'null'::jsonb),
    'requiredColumns', jsonb_build_object(
      'currentContractTotalKg', exists(select 1 from information_schema.columns where table_schema='public' and table_name='hop_inventory' and column_name='current_contract_total_kg'),
      'supplierReceivedLast12mKg', exists(select 1 from information_schema.columns where table_schema='public' and table_name='hop_inventory' and column_name='supplier_received_last_12m_kg'),
      'contractYearPreviousUse', exists(select 1 from information_schema.columns where table_schema='public' and table_name='contract_year_hops' and column_name='previous_use_12m_kg'),
      'contractYearJanBalance', exists(select 1 from information_schema.columns where table_schema='public' and table_name='contract_year_hops' and column_name='contract_remaining_at_start_kg')
    ),
    'saveFunctionPresent', to_regprocedure('public.save_forecast_state(jsonb)') is not null,
    'readFunctionPresent', to_regprocedure('public.get_forecast_state()') is not null
  );

  return result;
end;
$$;

grant execute on function public.diagnose_hop_contract(jsonb) to authenticated;

insert into public.app_settings(key,value)
values('app',jsonb_build_object('version','1.10'))
on conflict(key) do update set value=excluded.value,updated_at=now();

commit;

