begin;

create or replace function private.supplier_bid_history_impl(p_limit integer default 200)
returns table(
  bid_id uuid,
  quote_id uuid,
  reference text,
  delivery_city text,
  revision_no integer,
  bid_status text,
  total_amount numeric,
  delivery_days smallint,
  valid_until timestamptz,
  freight_included boolean,
  tax_included boolean,
  terms text,
  is_awarded boolean,
  placed_at timestamptz,
  updated_at timestamptz,
  line_items jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_supplier uuid;
begin
  v_supplier := private.current_supplier_id();
  if v_supplier is null then raise exception 'Verified supplier access required.' using errcode='42501'; end if;
  return query
  select
    sb.id,q.id,q.reference,q.delivery_city,sb.revision_no,sb.status,sb.total_amount,
    sb.delivery_days,sb.valid_until,sb.freight_included,sb.tax_included,sb.terms,
    sb.is_awarded,sb.placed_at,sb.updated_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'quote_item_id',bi.quote_item_id,'name',qi.name_snapshot,'unit',qi.unit_snapshot,
        'quantity',bi.quantity_snapshot,'unit_rate',bi.unit_rate,'line_total',bi.line_total,
        'offered_brand',bi.offered_brand,'availability_note',bi.availability_note
      ) order by qi.id)
      from public.supplier_bid_items bi
      join public.quote_items qi on qi.id=bi.quote_item_id
      where bi.bid_id=sb.id
    ),'[]'::jsonb)
  from public.supplier_bids sb
  join public.quotes q on q.id=sb.quote_id
  where sb.supplier_id=v_supplier
  order by sb.placed_at desc,sb.revision_no desc
  limit greatest(1,least(coalesce(p_limit,200),500));
end;
$$;
revoke all on function private.supplier_bid_history_impl(integer) from public,anon;
grant execute on function private.supplier_bid_history_impl(integer) to authenticated;

create or replace function public.supplier_bid_history(p_limit integer default 200)
returns table(
  bid_id uuid,
  quote_id uuid,
  reference text,
  delivery_city text,
  revision_no integer,
  bid_status text,
  total_amount numeric,
  delivery_days smallint,
  valid_until timestamptz,
  freight_included boolean,
  tax_included boolean,
  terms text,
  is_awarded boolean,
  placed_at timestamptz,
  updated_at timestamptz,
  line_items jsonb
)
language sql
stable
set search_path=private,public,pg_temp
as $$ select * from private.supplier_bid_history_impl($1); $$;
revoke all on function public.supplier_bid_history(integer) from public,anon;
grant execute on function public.supplier_bid_history(integer) to authenticated;

commit;
