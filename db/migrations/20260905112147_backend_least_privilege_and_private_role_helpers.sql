-- CKA BuildStruct backend completion
-- Applied to live Supabase: 2026-09-05 11:21:47 UTC
-- Replaces legacy Data API grants with explicit least privilege and moves
-- privileged role checks out of the exposed public schema.

begin;

create schema if not exists private;
create schema if not exists extensions;

alter extension pg_trgm set schema extensions;
grant usage on schema extensions to anon, authenticated;

create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('admin','staff')
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function private.is_staff() from public, anon, authenticated;
revoke all on function private.is_admin() from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_staff() to authenticated;
grant execute on function private.is_admin() to authenticated;

create or replace function public.is_staff()
returns boolean
language sql
stable
security invoker
set search_path = private, public, pg_temp
as $$ select private.is_staff(); $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = private, public, pg_temp
as $$ select private.is_admin(); $$;

revoke all on function public.is_staff() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;

alter policy "admin delete inquiries" on public.inquiries to authenticated;
alter policy "staff read inquiries" on public.inquiries to authenticated;
alter policy "staff update inquiries" on public.inquiries to authenticated;

alter policy "staff delete project files" on public.project_files to authenticated;
alter policy "insert own project files" on public.project_files to authenticated;
alter policy "read own project files" on public.project_files to authenticated;
alter policy "staff update project files" on public.project_files to authenticated;

alter policy "admin delete projects" on public.projects to authenticated;
alter policy "staff insert projects" on public.projects to authenticated;
alter policy "own projects" on public.projects to authenticated;
alter policy "staff update projects" on public.projects to authenticated;

alter policy "staff delete quote items" on public.quote_items to authenticated;
alter policy "staff insert quote items" on public.quote_items to authenticated;
alter policy "read own quote items" on public.quote_items to authenticated;
alter policy "staff update quote items" on public.quote_items to authenticated;

alter policy "admin delete quotes" on public.quotes to authenticated;
alter policy "staff insert quotes" on public.quotes to authenticated;
alter policy "own quotes" on public.quotes to authenticated;
alter policy "staff update quotes" on public.quotes to authenticated;

alter policy "admin delete bids" on public.supplier_bids to authenticated;
alter policy "staff insert bids" on public.supplier_bids to authenticated;
alter policy "staff read bids" on public.supplier_bids to authenticated;
alter policy "staff update bids" on public.supplier_bids to authenticated;

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

grant select on public.categories,
                public.products,
                public.product_images,
                public.product_variants,
                public.site_content,
                public.v_catalogue
  to anon, authenticated;

grant select, insert, update on public.profiles to authenticated;

grant select, insert, update, delete on
  public.categories,
  public.products,
  public.product_images,
  public.product_variants,
  public.site_content,
  public.suppliers,
  public.quotes,
  public.quote_items,
  public.projects,
  public.project_files,
  public.supplier_bids,
  public.inquiries,
  public.supplier_applications,
  public.newsletter_subscribers
  to authenticated;

revoke execute on function public.submit_inquiry(text,text,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) from public, anon, authenticated;
revoke execute on function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) from public, anon, authenticated;
revoke execute on function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) from public, anon, authenticated;
revoke execute on function public.submit_supplier_application(text,text,text,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.subscribe_rate_list(text) from public, anon, authenticated;

grant execute on function public.submit_inquiry(text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) to anon, authenticated;
grant execute on function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) to anon, authenticated;
grant execute on function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) to anon, authenticated;
grant execute on function public.submit_supplier_application(text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.subscribe_rate_list(text) to anon, authenticated;

revoke execute on function public.guard_profile_role() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.protect_supplier_trust_fields() from public, anon, authenticated;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

commit;
