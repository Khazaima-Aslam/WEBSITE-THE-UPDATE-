-- CKA BuildStruct backend completion
-- Applied to live Supabase: 2026-09-05 11:25:29 UTC
-- Adds verified supplier account access, sanitized tenders, bidding, customer
-- summary access and Realtime publication for operational status changes.

begin;

create unique index if not exists uq_suppliers_profile_id
  on public.suppliers(profile_id)
  where profile_id is not null;

drop policy if exists "supplier read own supplier" on public.suppliers;
create policy "supplier read own supplier"
on public.suppliers for select
to authenticated
using (profile_id = (select auth.uid()));

drop policy if exists "supplier update own supplier" on public.suppliers;
create policy "supplier update own supplier"
on public.suppliers for update
to authenticated
using (profile_id = (select auth.uid()))
with check (profile_id = (select auth.uid()));

create or replace function private.current_supplier_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id
  from public.suppliers s
  join public.profiles p on p.id = s.profile_id
  where s.profile_id = auth.uid()
    and p.role = 'supplier'
    and s.is_verified
  limit 1;
$$;

create or replace function private.quote_is_open_for_bidding(p_quote_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.quotes q
    where q.id = p_quote_id and q.status = 'bidding'
  );
$$;

revoke all on function private.current_supplier_id() from public, anon, authenticated;
revoke all on function private.quote_is_open_for_bidding(uuid) from public, anon, authenticated;
grant execute on function private.current_supplier_id() to authenticated;
grant execute on function private.quote_is_open_for_bidding(uuid) to authenticated;

drop policy if exists "supplier read own bids" on public.supplier_bids;
create policy "supplier read own bids"
on public.supplier_bids for select
to authenticated
using (supplier_id = private.current_supplier_id());

drop policy if exists "supplier insert own bids" on public.supplier_bids;
create policy "supplier insert own bids"
on public.supplier_bids for insert
to authenticated
with check (
  supplier_id = private.current_supplier_id()
  and private.quote_is_open_for_bidding(quote_id)
  and not is_awarded
);

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
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode = '42501'; end if;

  select * into v_profile from public.profiles where id = p_profile_id for update;
  if v_profile.id is null then raise exception 'Profile not found.' using errcode = 'P0002'; end if;

  if exists (select 1 from public.suppliers where profile_id = p_profile_id and id <> p_supplier_id) then
    raise exception 'This login is already linked to another supplier.' using errcode = '23505';
  end if;

  update public.profiles set role = 'supplier' where id = p_profile_id;
  update public.suppliers set profile_id = p_profile_id, updated_at = now()
  where id = p_supplier_id returning * into v_supplier;

  if v_supplier.id is null then raise exception 'Supplier not found.' using errcode = 'P0002'; end if;
  return v_supplier;
end;
$$;

revoke execute on function public.admin_link_supplier_account(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_link_supplier_account(uuid,uuid) to authenticated;

create or replace function private.supplier_open_tenders_impl()
returns table(
  quote_id uuid,
  reference text,
  delivery_city text,
  submitted_at timestamptz,
  items jsonb,
  bid_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_supplier uuid;
begin
  v_supplier := private.current_supplier_id();
  if v_supplier is null then raise exception 'Verified supplier access required.' using errcode = '42501'; end if;

  return query
  select q.id,q.reference,q.delivery_city,q.submitted_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', qi.id,
        'name', qi.name_snapshot,
        'unit', qi.unit_snapshot,
        'quantity', qi.quantity
      ) order by qi.id)
      from public.quote_items qi
      where qi.quote_id = q.id
    ), '[]'::jsonb) as items,
    (select count(*) from public.supplier_bids sb where sb.quote_id = q.id) as bid_count
  from public.quotes q
  where q.status = 'bidding'
  order by q.submitted_at desc;
end;
$$;

revoke all on function private.supplier_open_tenders_impl() from public, anon, authenticated;
grant execute on function private.supplier_open_tenders_impl() to authenticated;

create or replace function public.supplier_open_tenders()
returns table(
  quote_id uuid,
  reference text,
  delivery_city text,
  submitted_at timestamptz,
  items jsonb,
  bid_count bigint
)
language sql
stable
security invoker
set search_path = private, public, pg_temp
as $$ select * from private.supplier_open_tenders_impl(); $$;

revoke execute on function public.supplier_open_tenders() from public, anon, authenticated;
grant execute on function public.supplier_open_tenders() to authenticated;

create or replace function public.supplier_submit_bid(
  p_quote_id uuid,
  p_rate numeric,
  p_delivery_days smallint default null,
  p_terms text default null
)
returns public.supplier_bids
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_supplier_id uuid;
  v_bid public.supplier_bids;
begin
  v_supplier_id := private.current_supplier_id();
  if v_supplier_id is null then raise exception 'Verified supplier access required.' using errcode = '42501'; end if;
  if not private.quote_is_open_for_bidding(p_quote_id) then
    raise exception 'This quotation is not open for bidding.' using errcode = '55000';
  end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Bid rate must be greater than zero.' using errcode = '22023'; end if;
  if p_delivery_days is not null and p_delivery_days < 0 then raise exception 'Delivery days cannot be negative.' using errcode = '22023'; end if;
  if p_terms is not null and length(p_terms) > 5000 then raise exception 'Bid terms exceed the maximum permitted length.' using errcode = '22001'; end if;

  insert into public.supplier_bids(quote_id,supplier_id,rate,delivery_days,terms)
  values (p_quote_id,v_supplier_id,p_rate,p_delivery_days,p_terms)
  returning * into v_bid;

  return v_bid;
end;
$$;

revoke execute on function public.supplier_submit_bid(uuid,numeric,smallint,text) from public, anon, authenticated;
grant execute on function public.supplier_submit_bid(uuid,numeric,smallint,text) to authenticated;

create or replace function public.customer_portal_summary()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode = '42501'; end if;

  return jsonb_build_object(
    'quotes_total', (select count(*) from public.quotes where customer_id = v_uid),
    'quotes_open', (select count(*) from public.quotes where customer_id = v_uid and status not in ('delivered','cancelled')),
    'projects_total', (select count(*) from public.projects where customer_id = v_uid),
    'projects_open', (select count(*) from public.projects where customer_id = v_uid and status not in ('completed','archived'))
  );
end;
$$;

revoke execute on function public.customer_portal_summary() from public, anon, authenticated;
grant execute on function public.customer_portal_summary() to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='quotes') then
      alter publication supabase_realtime add table public.quotes;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='projects') then
      alter publication supabase_realtime add table public.projects;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='supplier_bids') then
      alter publication supabase_realtime add table public.supplier_bids;
    end if;
  end if;
end $$;

commit;
