-- Applied to live Supabase: 2026-09-05 11:26:12 UTC
-- QA caught a mid-function RLS permission loss when the role changed before
-- supplier.profile_id was linked. Link first, then transition the profile role.

create or replace function public.admin_link_supplier_account(
  p_supplier_id uuid,
  p_profile_id uuid
)
returns public.suppliers
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_supplier public.suppliers;
  v_profile public.profiles;
begin
  if not private.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = p_profile_id for update;
  if v_profile.id is null then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.suppliers
    where profile_id = p_profile_id and id <> p_supplier_id
  ) then
    raise exception 'This login is already linked to another supplier.' using errcode = '23505';
  end if;

  update public.suppliers
  set profile_id = p_profile_id, updated_at = now()
  where id = p_supplier_id
  returning * into v_supplier;

  if v_supplier.id is null then
    raise exception 'Supplier not found.' using errcode = 'P0002';
  end if;

  update public.profiles
  set role = 'supplier'
  where id = p_profile_id;

  return v_supplier;
end;
$$;

revoke execute on function public.admin_link_supplier_account(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_link_supplier_account(uuid,uuid) to authenticated;
