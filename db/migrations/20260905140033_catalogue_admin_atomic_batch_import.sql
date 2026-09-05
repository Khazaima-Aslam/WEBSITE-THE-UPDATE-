begin;

create or replace function private.staff_import_catalogue_products_impl(p_rows jsonb)
returns uuid[]
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row jsonb;
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
  v_count integer;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' then raise exception 'Import payload must be an array.' using errcode='22023'; end if;
  v_count := jsonb_array_length(p_rows);
  if v_count=0 then return v_ids; end if;
  if v_count>500 then raise exception 'A single import is limited to 500 products.' using errcode='22023'; end if;
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row)<>'object' or not (v_row ? 'product') then raise exception 'Every import row must contain a product object.' using errcode='22023'; end if;
    v_id := private.staff_save_catalogue_product_impl(v_row->'product',coalesce(v_row->'images','[]'::jsonb));
    v_ids := array_append(v_ids,v_id);
  end loop;
  return v_ids;
end;
$$;
revoke all on function private.staff_import_catalogue_products_impl(jsonb) from public,anon;
grant execute on function private.staff_import_catalogue_products_impl(jsonb) to authenticated;

create or replace function public.staff_import_catalogue_products(p_rows jsonb)
returns uuid[]
language sql
set search_path=private,public,pg_temp
as $$ select private.staff_import_catalogue_products_impl($1); $$;
revoke all on function public.staff_import_catalogue_products(jsonb) from public,anon;
grant execute on function public.staff_import_catalogue_products(jsonb) to authenticated;

commit;
