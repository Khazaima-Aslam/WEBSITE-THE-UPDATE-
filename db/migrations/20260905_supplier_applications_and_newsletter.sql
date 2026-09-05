-- CKA BuildStruct — supplier applications and daily-rate subscriptions
-- Applied and rollback-tested on Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.

begin;

create table if not exists public.supplier_applications (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  business_name text not null,
  contact_person text not null,
  phone text not null,
  email text,
  city text not null,
  category text not null,
  business_details text,
  status text not null default 'received' check (status in ('received','under_review','approved','rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null
);

create index if not exists idx_supplier_applications_status_submitted
  on public.supplier_applications(status, submitted_at desc);
create index if not exists idx_supplier_applications_reviewed_by
  on public.supplier_applications(reviewed_by);

alter table public.supplier_applications enable row level security;

create policy "staff read supplier applications"
on public.supplier_applications for select to authenticated
using (public.is_staff());

create policy "staff update supplier applications"
on public.supplier_applications for update to authenticated
using (public.is_staff()) with check (public.is_staff());

create sequence if not exists public.supplier_application_reference_seq start 1;

create or replace function public.submit_supplier_application(
  p_business_name text,
  p_contact_person text,
  p_phone text,
  p_email text default null,
  p_city text default null,
  p_category text default null,
  p_business_details text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference text;
begin
  if coalesce(trim(p_business_name),'')='' or coalesce(trim(p_contact_person),'')='' or coalesce(trim(p_phone),'')='' then
    raise exception 'Business name, contact person and phone are required.' using errcode='22023';
  end if;
  if coalesce(trim(p_city),'')='' or coalesce(trim(p_category),'')='' then
    raise exception 'City and main category are required.' using errcode='22023';
  end if;
  if length(p_business_name)>180 or length(p_contact_person)>120 or length(p_phone)>40
     or length(coalesce(p_email,''))>160 or length(p_city)>120 or length(p_category)>120
     or length(coalesce(p_business_details,''))>2000 then
    raise exception 'One or more supplier fields exceed the permitted length.' using errcode='22001';
  end if;
  if (select count(*) from public.supplier_applications
      where phone=trim(p_phone) and submitted_at > now()-interval '24 hours') >= 3 then
    raise exception 'Too many supplier registrations from this phone number today. Please contact CKA directly.' using errcode='53400';
  end if;

  v_reference := 'CKA-S-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.supplier_application_reference_seq')::text,4,'0');
  insert into public.supplier_applications(reference,business_name,contact_person,phone,email,city,category,business_details)
  values(
    v_reference, trim(p_business_name), trim(p_contact_person), trim(p_phone),
    nullif(trim(coalesce(p_email,'')),''), trim(p_city), trim(p_category),
    nullif(trim(coalesce(p_business_details,'')),'')
  );
  return v_reference;
end;
$$;
revoke all on function public.submit_supplier_application(text,text,text,text,text,text,text) from public;
grant execute on function public.submit_supplier_application(text,text,text,text,text,text,text) to anon, authenticated;

create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text generated always as (lower(trim(email))) stored,
  is_active boolean not null default true,
  source text not null default 'website',
  subscribed_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unique(email_normalized)
);

alter table public.newsletter_subscribers enable row level security;

create policy "staff read newsletter subscribers"
on public.newsletter_subscribers for select to authenticated
using (public.is_staff());

create policy "staff update newsletter subscribers"
on public.newsletter_subscribers for update to authenticated
using (public.is_staff()) with check (public.is_staff());

create or replace function public.subscribe_rate_list(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email,'')));
begin
  if v_email='' or v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' collate "C" then
    raise exception 'Enter a valid email address.' using errcode='22023';
  end if;
  if length(v_email)>160 then
    raise exception 'Email address is too long.' using errcode='22001';
  end if;

  insert into public.newsletter_subscribers(email,is_active,source,subscribed_at,unsubscribed_at)
  values(v_email,true,'website',now(),null)
  on conflict (email_normalized) do update
    set is_active=true, subscribed_at=now(), unsubscribed_at=null;
  return true;
end;
$$;
revoke all on function public.subscribe_rate_list(text) from public;
grant execute on function public.subscribe_rate_list(text) to anon, authenticated;

commit;
