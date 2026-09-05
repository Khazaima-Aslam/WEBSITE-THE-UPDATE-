begin;

create or replace function private.staff_catalogue_categories_impl()
returns table(
  id uuid,
  parent_id uuid,
  slug text,
  name text,
  description text,
  display_order smallint,
  is_active boolean,
  product_count bigint,
  child_count bigint
)
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not private.is_staff() then
    raise exception 'Staff access required.' using errcode='42501';
  end if;
  return query
  select c.id,c.parent_id,c.slug,c.name,c.description,c.display_order,c.is_active,
         (select count(*) from public.products p where p.category_id=c.id) as product_count,
         (select count(*) from public.categories ch where ch.parent_id=c.id) as child_count
  from public.categories c
  order by c.parent_id nulls first,c.display_order,c.name;
end;
$$;
revoke all on function private.staff_catalogue_categories_impl() from public,anon;
grant execute on function private.staff_catalogue_categories_impl() to authenticated;

create or replace function public.staff_catalogue_categories()
returns table(
  id uuid,
  parent_id uuid,
  slug text,
  name text,
  description text,
  display_order smallint,
  is_active boolean,
  product_count bigint,
  child_count bigint
)
language sql
stable
set search_path=private,public,pg_temp
as $$ select * from private.staff_catalogue_categories_impl(); $$;
revoke all on function public.staff_catalogue_categories() from public,anon;
grant execute on function public.staff_catalogue_categories() to authenticated;

create or replace function private.staff_save_catalogue_product_impl(
  p_product jsonb,
  p_images jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid;
  v_existing boolean := false;
  v_category_id uuid;
  v_category_parent uuid;
  v_name text;
  v_unit text;
  v_price numeric;
  v_old_price numeric;
  v_price_min numeric;
  v_price_max numeric;
  v_rating numeric;
  v_quality public.product_quality;
  v_stock public.stock_status;
  v_specs jsonb;
  v_tags text[];
  v_supplier_id uuid;
  v_main_image text;
  v_image jsonb;
  v_pos integer := 0;
begin
  if not private.is_staff() then
    raise exception 'Staff access required.' using errcode='42501';
  end if;
  if p_product is null or jsonb_typeof(p_product) <> 'object' then
    raise exception 'Product payload must be an object.' using errcode='22023';
  end if;
  if p_images is null then p_images := '[]'::jsonb; end if;
  if jsonb_typeof(p_images) <> 'array' then
    raise exception 'Product images must be an array.' using errcode='22023';
  end if;
  if jsonb_array_length(p_images) > 12 then
    raise exception 'A product can have at most 12 gallery images.' using errcode='22023';
  end if;

  v_name := btrim(coalesce(p_product->>'name',''));
  v_unit := btrim(coalesce(p_product->>'unit',''));
  if v_name='' or length(v_name)>220 then raise exception 'Product name is required and must be 220 characters or fewer.' using errcode='22023'; end if;
  if v_unit='' or length(v_unit)>80 then raise exception 'Unit is required and must be 80 characters or fewer.' using errcode='22023'; end if;

  begin v_category_id := nullif(p_product->>'category_id','')::uuid; exception when others then raise exception 'A valid subcategory is required.' using errcode='22023'; end;
  select c.parent_id into v_category_parent from public.categories c where c.id=v_category_id and c.is_active;
  if not found then raise exception 'Selected category does not exist or is inactive.' using errcode='22023'; end if;
  if v_category_parent is null then raise exception 'Products must be assigned to a subcategory, not a root category.' using errcode='22023'; end if;

  begin v_price := coalesce(nullif(p_product->>'price','')::numeric,0); exception when others then raise exception 'Current price must be numeric.' using errcode='22023'; end;
  if v_price < 0 then raise exception 'Current price cannot be negative.' using errcode='22023'; end if;
  begin v_old_price := nullif(p_product->>'old_price','')::numeric; exception when others then raise exception 'Old price must be numeric.' using errcode='22023'; end;
  begin v_price_min := nullif(p_product->>'price_min','')::numeric; exception when others then raise exception 'Minimum market price must be numeric.' using errcode='22023'; end;
  begin v_price_max := nullif(p_product->>'price_max','')::numeric; exception when others then raise exception 'Maximum market price must be numeric.' using errcode='22023'; end;
  if v_old_price is not null and v_old_price < 0 then raise exception 'Old price cannot be negative.' using errcode='22023'; end if;
  if v_price_min is not null and v_price_min < 0 then raise exception 'Minimum market price cannot be negative.' using errcode='22023'; end if;
  if v_price_max is not null and v_price_max < 0 then raise exception 'Maximum market price cannot be negative.' using errcode='22023'; end if;
  if v_price_min is not null and v_price_max is not null and v_price_min>v_price_max then raise exception 'Minimum market price cannot exceed maximum market price.' using errcode='22023'; end if;

  begin v_rating := nullif(p_product->>'rating','')::numeric; exception when others then raise exception 'Rating must be numeric.' using errcode='22023'; end;
  if v_rating is not null and (v_rating<0 or v_rating>5) then raise exception 'Rating must be between 0 and 5.' using errcode='22023'; end if;
  begin v_quality := coalesce(nullif(p_product->>'quality',''),'A')::public.product_quality; exception when others then raise exception 'Quality must be A, B or C.' using errcode='22023'; end;
  begin v_stock := coalesce(nullif(p_product->>'stock',''),'in_stock')::public.stock_status; exception when others then raise exception 'Invalid availability status.' using errcode='22023'; end;

  v_specs := coalesce(p_product->'specifications','{}'::jsonb);
  if jsonb_typeof(v_specs) <> 'object' then raise exception 'Specifications must be an object.' using errcode='22023'; end if;
  select coalesce(array_agg(value), '{}'::text[]) into v_tags from jsonb_array_elements_text(coalesce(p_product->'tags','[]'::jsonb));

  begin v_supplier_id := nullif(p_product->>'supplier_id','')::uuid; exception when others then raise exception 'Invalid supplier selection.' using errcode='22023'; end;
  if v_supplier_id is not null and not exists(select 1 from public.suppliers where id=v_supplier_id) then raise exception 'Selected supplier does not exist.' using errcode='22023'; end if;

  if jsonb_array_length(p_images)>0 then
    v_image := p_images->0;
    v_main_image := btrim(case when jsonb_typeof(v_image)='string' then trim(both '"' from v_image::text) else coalesce(v_image->>'url','') end);
    if v_main_image='' then v_main_image := null; end if;
  end if;

  begin v_id := nullif(p_product->>'id','')::uuid; exception when others then raise exception 'Invalid product ID.' using errcode='22023'; end;
  if v_id is not null then
    select true into v_existing from public.products where id=v_id for update;
    if not coalesce(v_existing,false) then raise exception 'Product no longer exists.' using errcode='P0002'; end if;
    update public.products set
      sku=nullif(upper(btrim(coalesce(p_product->>'sku',''))),''),
      category_id=v_category_id,
      supplier_id=v_supplier_id,
      name=v_name,
      brand=nullif(btrim(coalesce(p_product->>'brand','')),''),
      description=nullif(btrim(coalesce(p_product->>'description','')),''),
      unit=v_unit,
      price=v_price,
      old_price=v_old_price,
      price_min=v_price_min,
      price_max=v_price_max,
      stock=v_stock,
      specifications=v_specs,
      tags=v_tags,
      is_featured=coalesce((p_product->>'is_featured')::boolean,false),
      display_order=coalesce(nullif(p_product->>'display_order','')::smallint,0),
      rating=v_rating,
      quality=v_quality,
      image_url=v_main_image,
      price_checked_at=case when price is distinct from v_price then now() else price_checked_at end,
      is_active=coalesce((p_product->>'is_active')::boolean,true)
    where id=v_id;
  else
    insert into public.products(
      sku,category_id,supplier_id,name,brand,description,unit,price,old_price,price_min,price_max,
      stock,specifications,tags,is_featured,display_order,rating,quality,image_url,price_checked_at,is_active
    ) values (
      nullif(upper(btrim(coalesce(p_product->>'sku',''))),''),v_category_id,v_supplier_id,v_name,
      nullif(btrim(coalesce(p_product->>'brand','')),''),nullif(btrim(coalesce(p_product->>'description','')),''),
      v_unit,v_price,v_old_price,v_price_min,v_price_max,v_stock,v_specs,v_tags,
      coalesce((p_product->>'is_featured')::boolean,false),coalesce(nullif(p_product->>'display_order','')::smallint,0),
      v_rating,v_quality,v_main_image,now(),coalesce((p_product->>'is_active')::boolean,true)
    ) returning id into v_id;
  end if;

  delete from public.product_images where product_id=v_id;
  for v_image in select value from jsonb_array_elements(p_images)
  loop
    v_main_image := btrim(case when jsonb_typeof(v_image)='string' then trim(both '"' from v_image::text) else coalesce(v_image->>'url','') end);
    if v_main_image<>'' then
      insert into public.product_images(product_id,url,alt,position)
      values(v_id,v_main_image,nullif(btrim(coalesce(v_image->>'alt',v_name)),''),v_pos::smallint);
      v_pos := v_pos + 1;
    end if;
  end loop;

  return v_id;
end;
$$;
revoke all on function private.staff_save_catalogue_product_impl(jsonb,jsonb) from public,anon;
grant execute on function private.staff_save_catalogue_product_impl(jsonb,jsonb) to authenticated;

create or replace function public.staff_save_catalogue_product(p_product jsonb,p_images jsonb default '[]'::jsonb)
returns uuid
language sql
set search_path=private,public,pg_temp
as $$ select private.staff_save_catalogue_product_impl($1,$2); $$;
revoke all on function public.staff_save_catalogue_product(jsonb,jsonb) from public,anon;
grant execute on function public.staff_save_catalogue_product(jsonb,jsonb) to authenticated;

create or replace function private.staff_save_category_impl(
  p_id uuid,
  p_parent_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_display_order smallint,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid := p_id;
  v_name text := btrim(coalesce(p_name,''));
  v_slug text := lower(btrim(coalesce(p_slug,'')));
  v_parent_parent uuid;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  if v_name='' or length(v_name)>120 then raise exception 'Category name is required and must be 120 characters or fewer.' using errcode='22023'; end if;
  if p_parent_id is not null then
    if p_id is not null and p_parent_id=p_id then raise exception 'A category cannot be its own parent.' using errcode='22023'; end if;
    select parent_id into v_parent_parent from public.categories where id=p_parent_id and is_active;
    if not found then raise exception 'Parent category does not exist or is inactive.' using errcode='22023'; end if;
    if v_parent_parent is not null then raise exception 'Only one subcategory level is supported.' using errcode='22023'; end if;
    if p_id is not null and exists(select 1 from public.categories where parent_id=p_id) then
      raise exception 'A category with children cannot be converted into a subcategory.' using errcode='55000';
    end if;
  end if;
  if not coalesce(p_is_active,true) and p_id is not null and exists(select 1 from public.categories where parent_id=p_id and is_active) then
    raise exception 'Deactivate child categories before deactivating this parent category.' using errcode='55000';
  end if;
  if coalesce(p_is_active,true) and p_parent_id is not null and not exists(select 1 from public.categories where id=p_parent_id and is_active) then
    raise exception 'Activate the parent category first.' using errcode='55000';
  end if;

  if v_slug='' then
    v_slug := trim(both '-' from regexp_replace(lower(v_name),'[^a-z0-9]+','-','g'));
  else
    v_slug := trim(both '-' from regexp_replace(v_slug,'[^a-z0-9]+','-','g'));
  end if;
  if v_slug='' or length(v_slug)>120 then raise exception 'Category slug is invalid.' using errcode='22023'; end if;

  if p_id is null then
    insert into public.categories(parent_id,slug,name,description,display_order,is_active)
    values(p_parent_id,v_slug,v_name,nullif(btrim(coalesce(p_description,'')),''),coalesce(p_display_order,0),coalesce(p_is_active,true))
    returning id into v_id;
  else
    if not exists(select 1 from public.categories where id=p_id for update) then raise exception 'Category not found.' using errcode='P0002'; end if;
    update public.categories set parent_id=p_parent_id,slug=v_slug,name=v_name,
      description=nullif(btrim(coalesce(p_description,'')),''),display_order=coalesce(p_display_order,0),is_active=coalesce(p_is_active,true)
    where id=p_id;
  end if;
  return v_id;
end;
$$;
revoke all on function private.staff_save_category_impl(uuid,uuid,text,text,text,smallint,boolean) from public,anon;
grant execute on function private.staff_save_category_impl(uuid,uuid,text,text,text,smallint,boolean) to authenticated;

create or replace function public.staff_save_category(
  p_id uuid default null,
  p_parent_id uuid default null,
  p_name text default null,
  p_slug text default null,
  p_description text default null,
  p_display_order smallint default 0,
  p_is_active boolean default true
)
returns uuid
language sql
set search_path=private,public,pg_temp
as $$ select private.staff_save_category_impl($1,$2,$3,$4,$5,$6,$7); $$;
revoke all on function public.staff_save_category(uuid,uuid,text,text,text,smallint,boolean) from public,anon;
grant execute on function public.staff_save_category(uuid,uuid,text,text,text,smallint,boolean) to authenticated;

create or replace function private.staff_delete_category_impl(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  perform 1 from public.categories where id=p_id for update;
  if not found then raise exception 'Category not found.' using errcode='P0002'; end if;
  if exists(select 1 from public.products where category_id=p_id) then raise exception 'This category still has products. Move or deactivate those products first.' using errcode='55000'; end if;
  if exists(select 1 from public.categories where parent_id=p_id) then raise exception 'This category still has subcategories. Delete or move them first.' using errcode='55000'; end if;
  delete from public.categories where id=p_id;
  return true;
end;
$$;
revoke all on function private.staff_delete_category_impl(uuid) from public,anon;
grant execute on function private.staff_delete_category_impl(uuid) to authenticated;

create or replace function public.staff_delete_category(p_id uuid)
returns boolean
language sql
set search_path=private,public,pg_temp
as $$ select private.staff_delete_category_impl($1); $$;
revoke all on function public.staff_delete_category(uuid) from public,anon;
grant execute on function public.staff_delete_category(uuid) to authenticated;

commit;
