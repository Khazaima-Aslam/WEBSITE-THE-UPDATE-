-- CKA BuildStruct — production catalogue reconciliation
-- Date: 2026-09-05
--
-- IMPORTANT
-- This migration is additive/non-destructive and is intended to reconcile the
-- repository with the already-running Supabase catalogue. It does NOT delete
-- products, categories, product images, storage objects, users or suppliers.
-- Review against the live Supabase schema before executing.

begin;

-- ---------------------------------------------------------------------------
-- 1. Official product shape used by the current admin editor
-- ---------------------------------------------------------------------------
-- Main image architecture:
--   products.image_url      = canonical/main product image
--   product_images          = optional additional gallery images
--
-- This keeps the already-tested products.image_url workflow while preserving
-- the normalized gallery table for future multi-image support.

alter table products add column if not exists image_url text;
alter table products add column if not exists quality text;
alter table products add column if not exists grade text;
alter table products add column if not exists size text;
alter table products add column if not exists badge text;

-- Useful guardrails without rewriting existing data.
do $$ begin
  alter table products
    add constraint products_rating_range
    check (rating is null or (rating >= 0 and rating <= 5));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Catalogue view aligned with the live admin/public product contract
-- ---------------------------------------------------------------------------
create or replace view v_catalogue as
select
  p.id,
  p.sku,
  p.name,
  p.brand,
  p.description,
  p.unit,
  p.quality,
  p.grade,
  p.size,
  p.badge,
  p.price,
  p.old_price,
  p.price_min,
  p.price_max,
  p.stock,
  p.is_featured,
  p.display_order,
  p.rating,
  p.order_count,
  p.specifications,
  p.tags,
  p.price_checked_at,
  p.image_url,
  c.id    as category_id,
  c.slug  as category_slug,
  c.name  as category_name,
  pc.id   as parent_category_id,
  pc.name as parent_category,
  s.id    as supplier_id,
  s.company_name as supplier_name,
  s.is_verified  as supplier_verified,

  -- Canonical main image first; fall back to legacy gallery position 0.
  coalesce(
    nullif(p.image_url, ''),
    (select i.url
       from product_images i
      where i.product_id = p.id
      order by i.position
      limit 1)
  ) as main_image,

  -- Gallery remains product_images. If no gallery rows exist, expose the
  -- canonical main image as a one-item array so older frontend code still works.
  coalesce(
    (select jsonb_agg(
       jsonb_build_object('url', i.url, 'alt', i.alt, 'position', i.position)
       order by i.position
     )
     from product_images i
     where i.product_id = p.id),
    case
      when nullif(p.image_url, '') is not null
        then jsonb_build_array(jsonb_build_object(
          'url', p.image_url,
          'alt', p.name,
          'position', 0
        ))
      else '[]'::jsonb
    end
  ) as images,

  coalesce(
    (select jsonb_agg(
       jsonb_build_object(
         'label', v.label,
         'grade', v.grade,
         'size', v.size,
         'price_delta', v.price_delta,
         'stock', v.stock
       ) order by v.display_order
     )
     from product_variants v
     where v.product_id = p.id),
    '[]'::jsonb
  ) as variants

from products p
join categories c       on c.id = p.category_id
left join categories pc on pc.id = c.parent_id
left join suppliers s   on s.id = p.supplier_id
where p.is_active;

-- ---------------------------------------------------------------------------
-- 3. Storage policies
-- ---------------------------------------------------------------------------
-- The old repository policy allowed anonymous INSERT anywhere in the bucket.
-- Keep public project/BOQ uploads working, but reserve product-images/ for
-- authenticated admin/staff users. Existing objects are untouched.

drop policy if exists "public upload project-uploads" on storage.objects;
create policy "public upload project-uploads"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'project-uploads'
  and coalesce((storage.foldername(name))[1], '') <> 'product-images'
);

drop policy if exists "admin upload product images" on storage.objects;
create policy "admin upload product images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'project-uploads'
  and (storage.foldername(name))[1] = 'product-images'
  and is_staff()
);

drop policy if exists "admin update product images" on storage.objects;
create policy "admin update product images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'project-uploads'
  and (storage.foldername(name))[1] = 'product-images'
  and is_staff()
)
with check (
  bucket_id = 'project-uploads'
  and (storage.foldername(name))[1] = 'product-images'
  and is_staff()
);

drop policy if exists "admin delete product images" on storage.objects;
create policy "admin delete product images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'project-uploads'
  and (storage.foldername(name))[1] = 'product-images'
  and is_staff()
);

-- Public read remains intentional for product catalogue imagery.
drop policy if exists "public read project-uploads" on storage.objects;
create policy "public read project-uploads"
on storage.objects
for select
using (bucket_id = 'project-uploads');

commit;
