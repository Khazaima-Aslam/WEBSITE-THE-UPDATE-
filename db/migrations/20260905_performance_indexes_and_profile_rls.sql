-- CKA BuildStruct — verified performance indexes and profile RLS cleanup
-- Applied to Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.

begin;

create index if not exists idx_project_files_quote_id on public.project_files(quote_id);
create index if not exists idx_project_files_uploaded_by on public.project_files(uploaded_by);
create index if not exists idx_projects_assigned_to on public.projects(assigned_to);
create index if not exists idx_projects_customer_id on public.projects(customer_id);
create index if not exists idx_quote_items_product_id on public.quote_items(product_id);
create index if not exists idx_quote_items_variant_id on public.quote_items(variant_id);
create index if not exists idx_quotes_customer_id on public.quotes(customer_id);
create index if not exists idx_site_content_updated_by on public.site_content(updated_by);
create index if not exists idx_supplier_bids_supplier_id on public.supplier_bids(supplier_id);
create index if not exists idx_suppliers_profile_id on public.suppliers(profile_id);

drop policy if exists "own profile" on public.profiles;
drop policy if exists "users can read own profile" on public.profiles;
create policy "read own profile or staff"
on public.profiles for select
to authenticated
using (id = (select auth.uid()) or public.is_staff());

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
on public.profiles for insert
to authenticated
with check (id = (select auth.uid()));

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
on public.profiles for update
to authenticated
using (id = (select auth.uid()) or public.is_staff())
with check (id = (select auth.uid()) or public.is_staff());

commit;
