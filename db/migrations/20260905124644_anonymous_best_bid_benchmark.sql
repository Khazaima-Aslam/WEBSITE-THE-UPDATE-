begin;

drop function if exists public.supplier_open_tenders();
drop function if exists private.supplier_open_tenders_impl();

create function private.supplier_open_tenders_impl()
returns table(
  quote_id uuid,
  reference text,
  delivery_city text,
  bidding_opened_at timestamptz,
  bidding_closes_at timestamptz,
  allow_partial_bids boolean,
  min_bid_validity_days smallint,
  items jsonb,
  supplier_count bigint,
  best_current_total numeric,
  best_delivery_days smallint,
  best_is_own boolean,
  own_latest_bid jsonb
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
    q.id,
    q.reference,
    q.delivery_city,
    q.bidding_opened_at,
    q.bidding_closes_at,
    q.allow_partial_bids,
    q.min_bid_validity_days,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id',qi.id,
        'name',qi.name_snapshot,
        'unit',qi.unit_snapshot,
        'quantity',qi.quantity
      ) order by qi.id)
      from public.quote_items qi where qi.quote_id=q.id
    ),'[]'::jsonb),
    (select count(distinct sb.supplier_id) from public.supplier_bids sb where sb.quote_id=q.id and sb.status <> 'withdrawn'),
    best.total_amount,
    best.delivery_days,
    (best.supplier_id = v_supplier),
    (
      select jsonb_build_object(
        'bid_id',sb.id,'revision_no',sb.revision_no,'status',sb.status,
        'total_amount',sb.total_amount,'delivery_days',sb.delivery_days,
        'valid_until',sb.valid_until,'freight_included',sb.freight_included,
        'tax_included',sb.tax_included,'placed_at',sb.placed_at,'updated_at',sb.updated_at
      )
      from public.supplier_bids sb
      where sb.quote_id=q.id and sb.supplier_id=v_supplier
      order by sb.revision_no desc limit 1
    )
  from public.quotes q
  left join lateral (
    with latest as (
      select distinct on (sb.supplier_id)
        sb.supplier_id,sb.total_amount,sb.delivery_days,sb.status,sb.revision_no
      from public.supplier_bids sb
      where sb.quote_id=q.id
      order by sb.supplier_id,sb.revision_no desc
    )
    select l.supplier_id,l.total_amount,l.delivery_days
    from latest l
    where l.status='submitted'
    order by l.total_amount asc,l.delivery_days asc nulls last
    limit 1
  ) best on true
  where private.quote_is_open_for_bidding(q.id)
  order by q.bidding_closes_at asc, q.submitted_at desc;
end;
$$;

revoke all on function private.supplier_open_tenders_impl() from public,anon;
grant execute on function private.supplier_open_tenders_impl() to authenticated;

create function public.supplier_open_tenders()
returns table(
  quote_id uuid,
  reference text,
  delivery_city text,
  bidding_opened_at timestamptz,
  bidding_closes_at timestamptz,
  allow_partial_bids boolean,
  min_bid_validity_days smallint,
  items jsonb,
  supplier_count bigint,
  best_current_total numeric,
  best_delivery_days smallint,
  best_is_own boolean,
  own_latest_bid jsonb
)
language sql
stable
set search_path=private,public,pg_temp
as $$ select * from private.supplier_open_tenders_impl(); $$;
revoke all on function public.supplier_open_tenders() from public,anon;
grant execute on function public.supplier_open_tenders() to authenticated;

commit;
