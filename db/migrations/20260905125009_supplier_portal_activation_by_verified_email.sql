begin;

alter table public.suppliers
  add column if not exists portal_email text;

create unique index if not exists uq_suppliers_portal_email_normalized
  on public.suppliers (lower(portal_email))
  where portal_email is not null and btrim(portal_email) <> '';

create or replace function public.admin_set_supplier_portal_email(
  p_supplier_id uuid,
  p_email text
)
returns public.suppliers
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  v_row public.suppliers;
  v_email text := lower(trim(coalesce(p_email,'')));
begin
  if not private.is_admin() then
    raise exception 'Administrator access required.' using errcode='42501';
  end if;

  select * into v_row
  from public.suppliers
  where id=p_supplier_id
  for update;

  if v_row.id is null then
    raise exception 'Supplier not found.' using errcode='P0002';
  end if;
  if not v_row.is_verified then
    raise exception 'Verify the supplier before preparing portal access.' using errcode='55000';
  end if;
  if v_row.profile_id is not null then
    raise exception 'This supplier is already linked to a portal account.' using errcode='55000';
  end if;
  if v_email='' or length(v_email)>160 or v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' collate "C" then
    raise exception 'Enter a valid portal email address.' using errcode='22023';
  end if;
  if exists (
    select 1 from public.suppliers s
    where s.id<>p_supplier_id
      and lower(s.portal_email)=v_email
  ) then
    raise exception 'That portal email is already reserved for another supplier.' using errcode='23505';
  end if;

  update public.suppliers
  set portal_email=v_email,
      updated_at=now()
  where id=p_supplier_id
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.admin_set_supplier_portal_email(uuid,text) from public,anon;
grant execute on function public.admin_set_supplier_portal_email(uuid,text) to authenticated;

create or replace function public.admin_link_supplier_matching_account(p_supplier_id uuid)
returns public.suppliers
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  v_supplier public.suppliers;
  v_profile public.profiles;
  v_matches integer;
begin
  if not private.is_admin() then
    raise exception 'Administrator access required.' using errcode='42501';
  end if;

  select * into v_supplier
  from public.suppliers
  where id=p_supplier_id
  for update;

  if v_supplier.id is null then
    raise exception 'Supplier not found.' using errcode='P0002';
  end if;
  if not v_supplier.is_verified then
    raise exception 'Only verified suppliers can receive portal access.' using errcode='55000';
  end if;
  if v_supplier.profile_id is not null then
    raise exception 'This supplier is already linked to a portal account.' using errcode='55000';
  end if;
  if nullif(trim(v_supplier.portal_email),'') is null then
    raise exception 'Set the supplier portal email before linking an account.' using errcode='55000';
  end if;

  select count(*) into v_matches
  from public.profiles p
  where lower(p.email)=lower(v_supplier.portal_email);

  if v_matches=0 then
    raise exception 'No customer account exists with the approved supplier portal email. Ask the supplier to create an account with that exact email first.' using errcode='P0002';
  elsif v_matches>1 then
    raise exception 'More than one profile matches the approved portal email. Resolve the duplicate before linking.' using errcode='23505';
  end if;

  select * into v_profile
  from public.profiles p
  where lower(p.email)=lower(v_supplier.portal_email)
  for update;

  if v_profile.role in ('admin'::public.user_role,'staff'::public.user_role) then
    raise exception 'Administrator/staff accounts cannot be converted into supplier accounts.' using errcode='23514';
  end if;
  if v_profile.role='supplier'::public.user_role then
    raise exception 'That account is already a supplier account.' using errcode='23505';
  end if;
  if exists (
    select 1 from public.suppliers s
    where s.profile_id=v_profile.id and s.id<>p_supplier_id
  ) then
    raise exception 'That account is already linked to another supplier.' using errcode='23505';
  end if;

  update public.suppliers
  set profile_id=v_profile.id,
      updated_at=now()
  where id=p_supplier_id
  returning * into v_supplier;

  update public.profiles
  set role='supplier'::public.user_role
  where id=v_profile.id;

  return v_supplier;
end;
$$;
revoke all on function public.admin_link_supplier_matching_account(uuid) from public,anon;
grant execute on function public.admin_link_supplier_matching_account(uuid) to authenticated;

commit;
