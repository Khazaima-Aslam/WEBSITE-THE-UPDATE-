-- CKA BuildStruct — verified production catalogue reconciliation
-- Applied to Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.
--
-- This migration is intentionally non-destructive:
-- - does not delete product/category/supplier rows
-- - does not delete Storage objects
-- - keeps project-uploads private
-- - uses the existing public product-images bucket for catalogue media
-- - keeps products.image_url as the canonical main image
-- - preserves product_images as optional gallery media

begin;

create schema if not exists private;

-- Supplier display data is needed by the public catalogue view, while the
-- suppliers table itself remains protected by RLS. Keep the helper out of the
-- exposed public schema and expose only its return values through the view.
create or replace function private.catalogue_supplier(p_supplier_id uuid)
returns table(company_name text, is_verified boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.company_name, s.is_verified
  from public.suppliers s
  where s.id = p_supplier_id;
$$;

revoke all on function private.catalogue_supplier(uuid) from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.catalogue_supplier(uuid) to anon, authenticated;

-- The catalogue view must obey the calling role's RLS policies.
create or replace view public.v_catalogue
with (security_invoker = true)
as
select
  p.id,
  p.sku,
  p.name,
  p.brand,
  p.unit,
  p.price,
  p.old_price,
  p.price_min,
  p.price_max,
  p.stock,
  p.quality,
  p.is_featured,
  p.display_order,
  p.rating,
  p.order_count,
  p.specifications,
  p.tags,
  p.price_checked_at,
  p.description,
  c.slug as category_slug,
  c.name as category_name,
  pc.name as parent_category,
  sup.company_name as supplier_name,
  sup.is_verified as supplier_verified,
  coalesce(
    p.image_url,
    (
      select i.url
      from public.product_images i
      where i.product_id = p.id
      order by i.position
      limit 1
    )
  ) as main_image,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object('url', imgs.url, 'alt', imgs.alt)
        order by imgs.position
      )
      from (
        select p.image_url as url, p.name as alt, -1::integer as position
        where p.image_url is not null and btrim(p.image_url) <> ''
        union all
        select i.url, coalesce(i.alt, p.name), i.position::integer
        from public.product_images i
        where i.product_id = p.id
          and (p.image_url is null or i.url <> p.image_url)
      ) imgs
    ),
    '[]'::jsonb
  ) as images,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'label', v.label,
          'grade', v.grade,
          'size', v.size,
          'price_delta', v.price_delta,
          'stock', v.stock
        )
        order by v.display_order
      )
      from public.product_variants v
      where v.product_id = p.id
    ),
    '[]'::jsonb
  ) as variants
from public.products p
join public.categories c on c.id = p.category_id
left join public.categories pc on pc.id = c.parent_id
left join lateral private.catalogue_supplier(p.supplier_id)
  sup(company_name, is_verified) on true
where p.is_active and c.is_active;

-- The public helper is no longer required after the view is switched to the
-- private helper.
drop function if exists public.catalogue_supplier(uuid);

-- Role helper functions are used internally by RLS. Anonymous callers should
-- not be able to invoke them as public RPC endpoints.
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Fix mutable search_path advisor finding on the shared timestamp trigger.
alter function public.touch_updated_at() set search_path = public, pg_temp;

-- site_content had RLS enabled without any policies.
drop policy if exists "public read content" on public.site_content;
create policy "public read content"
on public.site_content for select
to anon, authenticated
using (true);

drop policy if exists "staff write content" on public.site_content;
create policy "staff write content"
on public.site_content for all
to authenticated
using (public.is_staff())
with check (public.is_staff());

-- Product catalogue media belongs in the dedicated public product-images
-- bucket. Project/BOQ files remain in the private project-uploads bucket.
update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg','image/png','image/webp']::text[]
where id = 'product-images';

drop policy if exists "staff manage product-images" on storage.objects;
create policy "staff manage product-images"
on storage.objects for all
to authenticated
using (bucket_id = 'product-images' and public.is_staff())
with check (bucket_id = 'product-images' and public.is_staff());

-- Remove the obsolete policy that encouraged product media to be uploaded
-- inside the private project-uploads bucket.
drop policy if exists "id=""d9e7zq"" admin upload product images 763gf2_0" on storage.objects;

commit;
