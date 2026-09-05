begin;

create or replace function private.staff_catalogue_products_impl()
returns table(
  id uuid,
  sku text,
  category_id uuid,
  supplier_id uuid,
  name text,
  brand text,
  description text,
  unit text,
  price numeric,
  old_price numeric,
  price_min numeric,
  price_max numeric,
  stock public.stock_status,
  specifications jsonb,
  tags text[],
  is_featured boolean,
  display_order smallint,
  is_active boolean,
  rating numeric,
  order_count integer,
  price_checked_at timestamptz,
  quality public.product_quality,
  image_url text,
  category_name text,
  parent_category_id uuid,
  parent_category_name text,
  supplier_name text,
  images jsonb
)
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  return query
  select p.id,p.sku,p.category_id,p.supplier_id,p.name,p.brand,p.description,p.unit,p.price,p.old_price,p.price_min,p.price_max,
         p.stock,p.specifications,p.tags,p.is_featured,p.display_order,p.is_active,p.rating,p.order_count,p.price_checked_at,p.quality,p.image_url,
         c.name,pc.id,pc.name,s.company_name,
         coalesce((
           select jsonb_agg(jsonb_build_object('url',i.url,'alt',coalesce(i.alt,p.name),'position',i.position) order by i.position)
           from public.product_images i where i.product_id=p.id
         ),case when p.image_url is not null then jsonb_build_array(jsonb_build_object('url',p.image_url,'alt',p.name,'position',0)) else '[]'::jsonb end)
  from public.products p
  join public.categories c on c.id=p.category_id
  left join public.categories pc on pc.id=c.parent_id
  left join public.suppliers s on s.id=p.supplier_id
  order by p.is_active desc,p.display_order,p.name;
end;
$$;
revoke all on function private.staff_catalogue_products_impl() from public,anon;
grant execute on function private.staff_catalogue_products_impl() to authenticated;

create or replace function public.staff_catalogue_products()
returns table(
  id uuid,
  sku text,
  category_id uuid,
  supplier_id uuid,
  name text,
  brand text,
  description text,
  unit text,
  price numeric,
  old_price numeric,
  price_min numeric,
  price_max numeric,
  stock public.stock_status,
  specifications jsonb,
  tags text[],
  is_featured boolean,
  display_order smallint,
  is_active boolean,
  rating numeric,
  order_count integer,
  price_checked_at timestamptz,
  quality public.product_quality,
  image_url text,
  category_name text,
  parent_category_id uuid,
  parent_category_name text,
  supplier_name text,
  images jsonb
)
language sql
stable
set search_path=private,public,pg_temp
as $$ select * from private.staff_catalogue_products_impl(); $$;
revoke all on function public.staff_catalogue_products() from public,anon;
grant execute on function public.staff_catalogue_products() to authenticated;

commit;
