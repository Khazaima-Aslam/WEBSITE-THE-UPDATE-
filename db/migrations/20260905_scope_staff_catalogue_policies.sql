-- CKA BuildStruct — scope staff catalogue/supplier policies to authenticated users
-- Applied and verified on Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.
-- Anonymous v_catalogue verification after this migration: 89 rows, 0 missing images.

begin;

drop policy if exists "staff write products" on public.products;
create policy "staff write products"
on public.products for all
to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff write categories" on public.categories;
create policy "staff write categories"
on public.categories for all
to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff write product_images" on public.product_images;
create policy "staff write product_images"
on public.product_images for all
to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff write product_variants" on public.product_variants;
create policy "staff write product_variants"
on public.product_variants for all
to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff manage suppliers" on public.suppliers;
drop policy if exists "staff read suppliers" on public.suppliers;
drop policy if exists "staff update suppliers" on public.suppliers;
drop policy if exists "staff write suppliers" on public.suppliers;
drop policy if exists "admin delete suppliers" on public.suppliers;

create policy "staff read suppliers"
on public.suppliers for select
to authenticated
using (public.is_staff());

create policy "staff insert suppliers"
on public.suppliers for insert
to authenticated
with check (public.is_staff());

create policy "staff update suppliers"
on public.suppliers for update
to authenticated
using (public.is_staff())
with check (public.is_staff());

create policy "admin delete suppliers"
on public.suppliers for delete
to authenticated
using (public.is_admin());

commit;
