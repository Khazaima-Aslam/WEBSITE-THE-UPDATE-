-- CKA BuildStruct backend completion
-- Applied to live Supabase: 2026-09-05 11:23:26 UTC
-- Adds staff work queues, status workflows, supplier review, bid award and
-- immutable audit history.

begin;

alter table public.quotes
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists internal_notes text;

alter table public.inquiries
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by uuid references public.profiles(id) on delete set null;

alter table public.supplier_applications
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null,
  add column if not exists review_notes text;

alter table public.project_files drop constraint if exists attached_to_something;
alter table public.project_files drop constraint if exists attached_to_one_parent;
alter table public.project_files
  add constraint attached_to_one_parent check (num_nonnulls(project_id, quote_id) = 1);

alter table public.supplier_bids drop constraint if exists supplier_bids_rate_check;
alter table public.supplier_bids
  add constraint supplier_bids_rate_check check (rate > 0),
  add constraint supplier_bids_delivery_days_check check (delivery_days is null or delivery_days >= 0);

create unique index if not exists uq_supplier_bids_one_award_per_quote
  on public.supplier_bids(quote_id)
  where is_awarded;

create index if not exists idx_quotes_status_submitted
  on public.quotes(status, submitted_at desc);
create index if not exists idx_quotes_assigned_to
  on public.quotes(assigned_to)
  where assigned_to is not null;
create index if not exists idx_inquiries_handled_created
  on public.inquiries(is_handled, created_at desc);
create index if not exists idx_inquiries_handled_by
  on public.inquiries(handled_by)
  where handled_by is not null;
create index if not exists idx_supplier_applications_supplier_id
  on public.supplier_applications(supplier_id)
  where supplier_id is not null;
create index if not exists idx_newsletter_active_subscribed
  on public.newsletter_subscribers(is_active, subscribed_at desc);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('INSERT','UPDATE','DELETE')),
  entity_type text not null,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

drop policy if exists "staff read audit log" on public.admin_audit_log;
create policy "staff read audit log"
on public.admin_audit_log for select
to authenticated
using (public.is_staff());

revoke all privileges on public.admin_audit_log from anon, authenticated;
grant select on public.admin_audit_log to authenticated;

create index if not exists idx_admin_audit_created
  on public.admin_audit_log(created_at desc);
create index if not exists idx_admin_audit_entity
  on public.admin_audit_log(entity_type, entity_id, created_at desc);
create index if not exists idx_admin_audit_actor
  on public.admin_audit_log(actor_id, created_at desc)
  where actor_id is not null;

create or replace function private.audit_row_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id := nullif(v_old ->> 'id', '')::uuid;
  elsif tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_id := nullif(v_new ->> 'id', '')::uuid;
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_id := coalesce(nullif(v_new ->> 'id', '')::uuid, nullif(v_old ->> 'id', '')::uuid);
  end if;

  insert into public.admin_audit_log(actor_id, action, entity_type, entity_id, before_state, after_state)
  values (auth.uid(), tg_op, tg_table_name, v_id, v_old, v_new);

  return coalesce(new, old);
end;
$$;

revoke all on function private.audit_row_mutation() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'products','categories','suppliers','quotes','projects','supplier_bids',
    'supplier_applications','inquiries','newsletter_subscribers'
  ] loop
    execute format('drop trigger if exists audit_%I_mutation on public.%I', t, t);
    execute format(
      'create trigger audit_%I_mutation after insert or update or delete on public.%I for each row execute function private.audit_row_mutation()',
      t, t
    );
  end loop;
end $$;

create or replace function public.staff_dashboard_summary()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_result jsonb;
begin
  if not private.is_staff() then
    raise exception 'Staff access required.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'quotes_submitted', (select count(*) from public.quotes where status = 'submitted'),
    'quotes_bidding', (select count(*) from public.quotes where status = 'bidding'),
    'projects_open', (select count(*) from public.projects where status not in ('completed','archived')),
    'inquiries_open', (select count(*) from public.inquiries where not is_handled),
    'supplier_applications_open', (select count(*) from public.supplier_applications where status in ('received','under_review')),
    'newsletter_active', (select count(*) from public.newsletter_subscribers where is_active),
    'products_active', (select count(*) from public.products where is_active),
    'suppliers_verified', (select count(*) from public.suppliers where is_verified)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.staff_dashboard_summary() from public, anon, authenticated;
grant execute on function public.staff_dashboard_summary() to authenticated;

create or replace function public.staff_update_quote(
  p_quote_id uuid,
  p_status public.quote_status default null,
  p_assigned_to uuid default null,
  p_internal_notes text default null
)
returns public.quotes
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_row public.quotes;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode = '42501'; end if;
  if p_internal_notes is not null and length(p_internal_notes) > 5000 then
    raise exception 'Internal notes exceed the maximum permitted length.' using errcode = '22001';
  end if;

  update public.quotes
  set status = coalesce(p_status, status),
      assigned_to = coalesce(p_assigned_to, assigned_to),
      internal_notes = coalesce(p_internal_notes, internal_notes),
      updated_at = now()
  where id = p_quote_id
  returning * into v_row;

  if v_row.id is null then raise exception 'Quote not found.' using errcode = 'P0002'; end if;
  return v_row;
end;
$$;

revoke execute on function public.staff_update_quote(uuid,public.quote_status,uuid,text) from public, anon, authenticated;
grant execute on function public.staff_update_quote(uuid,public.quote_status,uuid,text) to authenticated;

create or replace function public.staff_update_project(
  p_project_id uuid,
  p_status public.project_status default null,
  p_progress_pct smallint default null,
  p_assigned_to uuid default null,
  p_notes text default null
)
returns public.projects
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_row public.projects;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode = '42501'; end if;
  if p_progress_pct is not null and (p_progress_pct < 0 or p_progress_pct > 100) then
    raise exception 'Progress must be between 0 and 100.' using errcode = '22023';
  end if;
  if p_notes is not null and length(p_notes) > 8000 then
    raise exception 'Project notes exceed the maximum permitted length.' using errcode = '22001';
  end if;

  update public.projects
  set status = coalesce(p_status, status),
      progress_pct = coalesce(p_progress_pct, progress_pct),
      assigned_to = coalesce(p_assigned_to, assigned_to),
      notes = coalesce(p_notes, notes),
      updated_at = now()
  where id = p_project_id
  returning * into v_row;

  if v_row.id is null then raise exception 'Project not found.' using errcode = 'P0002'; end if;
  return v_row;
end;
$$;

revoke execute on function public.staff_update_project(uuid,public.project_status,smallint,uuid,text) from public, anon, authenticated;
grant execute on function public.staff_update_project(uuid,public.project_status,smallint,uuid,text) to authenticated;

create or replace function public.staff_set_inquiry_handled(
  p_inquiry_id uuid,
  p_handled boolean default true
)
returns public.inquiries
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_row public.inquiries;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode = '42501'; end if;

  update public.inquiries
  set is_handled = p_handled,
      handled_at = case when p_handled then now() else null end,
      handled_by = case when p_handled then auth.uid() else null end
  where id = p_inquiry_id
  returning * into v_row;

  if v_row.id is null then raise exception 'Inquiry not found.' using errcode = 'P0002'; end if;
  return v_row;
end;
$$;

revoke execute on function public.staff_set_inquiry_handled(uuid,boolean) from public, anon, authenticated;
grant execute on function public.staff_set_inquiry_handled(uuid,boolean) to authenticated;

create or replace function public.staff_review_supplier_application(
  p_application_id uuid,
  p_decision text,
  p_review_notes text default null
)
returns public.supplier_applications
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_app public.supplier_applications;
  v_supplier_id uuid;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode = '42501'; end if;
  if p_decision not in ('under_review','approved','rejected') then
    raise exception 'Decision must be under_review, approved, or rejected.' using errcode = '22023';
  end if;
  if p_review_notes is not null and length(p_review_notes) > 5000 then
    raise exception 'Review notes exceed the maximum permitted length.' using errcode = '22001';
  end if;

  select * into v_app from public.supplier_applications where id = p_application_id for update;
  if v_app.id is null then raise exception 'Supplier application not found.' using errcode = 'P0002'; end if;

  v_supplier_id := v_app.supplier_id;
  if p_decision = 'approved' and v_supplier_id is null then
    select s.id into v_supplier_id
    from public.suppliers s
    where lower(trim(s.company_name)) = lower(trim(v_app.business_name))
      and coalesce(trim(s.phone), '') = coalesce(trim(v_app.phone), '')
    order by s.created_at limit 1;

    if v_supplier_id is null then
      insert into public.suppliers(company_name,contact_person,phone,email,city,is_verified,notes)
      values (v_app.business_name,v_app.contact_person,v_app.phone,v_app.email,v_app.city,false,
              'Created from supplier application ' || v_app.reference)
      returning id into v_supplier_id;
    end if;
  end if;

  update public.supplier_applications
  set status = p_decision,
      supplier_id = v_supplier_id,
      review_notes = p_review_notes,
      reviewed_by = auth.uid(),
      reviewed_at = case when p_decision in ('approved','rejected') then now() else null end
  where id = p_application_id
  returning * into v_app;

  return v_app;
end;
$$;

revoke execute on function public.staff_review_supplier_application(uuid,text,text) from public, anon, authenticated;
grant execute on function public.staff_review_supplier_application(uuid,text,text) to authenticated;

create or replace function public.staff_set_supplier_verification(
  p_supplier_id uuid,
  p_verified boolean,
  p_reliability_pct smallint default null,
  p_notes text default null
)
returns public.suppliers
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_row public.suppliers;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode = '42501'; end if;
  if p_reliability_pct is not null and (p_reliability_pct < 0 or p_reliability_pct > 100) then
    raise exception 'Reliability must be between 0 and 100.' using errcode = '22023';
  end if;

  update public.suppliers
  set is_verified = p_verified,
      verified_at = case when p_verified then coalesce(verified_at, now()) else null end,
      reliability_pct = coalesce(p_reliability_pct, reliability_pct),
      notes = coalesce(p_notes, notes),
      updated_at = now()
  where id = p_supplier_id
  returning * into v_row;

  if v_row.id is null then raise exception 'Supplier not found.' using errcode = 'P0002'; end if;
  return v_row;
end;
$$;

revoke execute on function public.staff_set_supplier_verification(uuid,boolean,smallint,text) from public, anon, authenticated;
grant execute on function public.staff_set_supplier_verification(uuid,boolean,smallint,text) to authenticated;

create or replace function public.staff_award_bid(p_bid_id uuid)
returns public.supplier_bids
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_bid public.supplier_bids;
  v_quote_id uuid;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode = '42501'; end if;

  select quote_id into v_quote_id from public.supplier_bids where id = p_bid_id for update;
  if v_quote_id is null then raise exception 'Bid not found.' using errcode = 'P0002'; end if;

  update public.supplier_bids set is_awarded = false where quote_id = v_quote_id and is_awarded;
  update public.supplier_bids set is_awarded = true where id = p_bid_id returning * into v_bid;
  update public.quotes set status = 'confirmed', updated_at = now() where id = v_quote_id;
  return v_bid;
end;
$$;

revoke execute on function public.staff_award_bid(uuid) from public, anon, authenticated;
grant execute on function public.staff_award_bid(uuid) to authenticated;

commit;
