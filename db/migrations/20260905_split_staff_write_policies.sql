-- CKA BuildStruct — separate staff mutations from public SELECT policies
-- Applied to Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.

begin;

drop policy if exists "staff write products" on public.products;
create policy "staff insert products" on public.products for insert to authenticated with check (public.is_staff());
create policy "staff update products" on public.products for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff delete products" on public.products for delete to authenticated using (public.is_staff());

drop policy if exists "staff write categories" on public.categories;
create policy "staff insert categories" on public.categories for insert to authenticated with check (public.is_staff());
create policy "staff update categories" on public.categories for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff delete categories" on public.categories for delete to authenticated using (public.is_staff());

drop policy if exists "staff write product_images" on public.product_images;
create policy "staff insert product_images" on public.product_images for insert to authenticated with check (public.is_staff());
create policy "staff update product_images" on public.product_images for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff delete product_images" on public.product_images for delete to authenticated using (public.is_staff());

drop policy if exists "staff write product_variants" on public.product_variants;
create policy "staff insert product_variants" on public.product_variants for insert to authenticated with check (public.is_staff());
create policy "staff update product_variants" on public.product_variants for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff delete product_variants" on public.product_variants for delete to authenticated using (public.is_staff());

drop policy if exists "staff write content" on public.site_content;
create policy "staff insert content" on public.site_content for insert to authenticated with check (public.is_staff());
create policy "staff update content" on public.site_content for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff delete content" on public.site_content for delete to authenticated using (public.is_staff());

commit;
