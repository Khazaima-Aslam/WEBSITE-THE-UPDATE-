begin;

alter table public.quotes
  add column if not exists bidding_opened_at timestamptz,
  add column if not exists bidding_closes_at timestamptz,
  add column if not exists allow_partial_bids boolean not null default false,
  add column if not exists min_bid_validity_days smallint not null default 3,
  add column if not exists awarded_bid_id uuid;

alter table public.quotes
  add constraint quotes_min_bid_validity_days_check check (min_bid_validity_days between 1 and 30) not valid;
alter table public.quotes validate constraint quotes_min_bid_validity_days_check;

alter table public.supplier_bids
  add column if not exists status text not null default 'submitted',
  add column if not exists revision_no integer not null default 1,
  add column if not exists valid_until timestamptz,
  add column if not exists freight_included boolean not null default false,
  add column if not exists tax_included boolean not null default false,
  add column if not exists total_amount numeric(14,2),
  add column if not exists updated_at timestamptz not null default now();

update public.supplier_bids
set total_amount = rate
where total_amount is null;

alter table public.supplier_bids alter column total_amount set not null;

alter table public.supplier_bids
  add constraint supplier_bids_status_check check (status in ('submitted','withdrawn','awarded','rejected')) not valid,
  add constraint supplier_bids_revision_no_check check (revision_no > 0) not valid,
  add constraint supplier_bids_total_amount_check check (total_amount > 0) not valid,
  add constraint supplier_bids_valid_until_check check (valid_until is null or valid_until > placed_at) not valid;
alter table public.supplier_bids validate constraint supplier_bids_status_check;
alter table public.supplier_bids validate constraint supplier_bids_revision_no_check;
alter table public.supplier_bids validate constraint supplier_bids_total_amount_check;
alter table public.supplier_bids validate constraint supplier_bids_valid_until_check;

create unique index if not exists uq_supplier_bid_revision
  on public.supplier_bids(quote_id, supplier_id, revision_no);
create index if not exists idx_supplier_bids_quote_latest
  on public.supplier_bids(quote_id, supplier_id, revision_no desc);
create index if not exists idx_supplier_bids_status
  on public.supplier_bids(quote_id, status);

create table if not exists public.supplier_bid_items (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references public.supplier_bids(id) on delete cascade,
  quote_item_id uuid not null references public.quote_items(id) on delete restrict,
  unit_rate numeric(12,2) not null check (unit_rate > 0 and unit_rate <= 100000000),
  quantity_snapshot numeric(12,2) not null check (quantity_snapshot > 0),
  line_total numeric(14,2) generated always as (unit_rate * quantity_snapshot) stored,
  offered_brand text,
  availability_note text,
  created_at timestamptz not null default now(),
  unique (bid_id, quote_item_id)
);

alter table public.supplier_bid_items enable row level security;
revoke all on public.supplier_bid_items from anon, authenticated;
grant select on public.supplier_bid_items to authenticated;

drop policy if exists "staff or own supplier read bid items" on public.supplier_bid_items;
create policy "staff or own supplier read bid items"
on public.supplier_bid_items for select
to authenticated
using (
  private.is_staff()
  or exists (
    select 1 from public.supplier_bids sb
    where sb.id = supplier_bid_items.bid_id
      and sb.supplier_id = private.current_supplier_id()
  )
);

create index if not exists idx_supplier_bid_items_bid on public.supplier_bid_items(bid_id);
create index if not exists idx_supplier_bid_items_quote_item on public.supplier_bid_items(quote_item_id);

alter table public.quotes
  add constraint quotes_awarded_bid_id_fkey
  foreign key (awarded_bid_id) references public.supplier_bids(id) on delete set null;

create or replace function private.validate_awarded_bid_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.awarded_bid_id is not null and not exists (
    select 1 from public.supplier_bids sb
    where sb.id = new.awarded_bid_id
      and sb.quote_id = new.id
      and sb.is_awarded
      and sb.status = 'awarded'
  ) then
    raise exception 'Awarded bid must belong to this quotation and be marked awarded.' using errcode='23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_awarded_bid_reference on public.quotes;
create trigger trg_validate_awarded_bid_reference
before insert or update of awarded_bid_id on public.quotes
for each row execute function private.validate_awarded_bid_reference();

create or replace function private.quote_is_open_for_bidding(p_quote_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quotes q
    where q.id = p_quote_id
      and q.status = 'bidding'::public.quote_status
      and q.bidding_opened_at is not null
      and q.bidding_opened_at <= now()
      and q.bidding_closes_at is not null
      and q.bidding_closes_at > now()
  );
$$;

create or replace function public.staff_open_bidding(
  p_quote_id uuid,
  p_closes_at timestamptz,
  p_allow_partial_bids boolean default false,
  p_min_validity_days smallint default 3
)
returns public.quotes
language plpgsql
set search_path = public, private, pg_temp
as $$
declare v_row public.quotes;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  if p_closes_at is null or p_closes_at < now() + interval '15 minutes' or p_closes_at > now() + interval '30 days' then
    raise exception 'Bidding close time must be between 15 minutes and 30 days from now.' using errcode='22023';
  end if;
  if p_min_validity_days is null or p_min_validity_days < 1 or p_min_validity_days > 30 then
    raise exception 'Minimum bid validity must be between 1 and 30 days.' using errcode='22023';
  end if;

  select * into v_row from public.quotes where id=p_quote_id for update;
  if v_row.id is null then raise exception 'Quote not found.' using errcode='P0002'; end if;
  if v_row.status not in ('submitted'::public.quote_status,'quoted'::public.quote_status) then
    raise exception 'Only submitted or quoted quotations can be opened for bidding.' using errcode='55000';
  end if;
  if not exists (select 1 from public.quote_items qi where qi.quote_id=p_quote_id) then
    raise exception 'Quotation has no line items to tender.' using errcode='55000';
  end if;

  update public.quotes
  set status='bidding'::public.quote_status,
      bidding_opened_at=now(),
      bidding_closes_at=p_closes_at,
      allow_partial_bids=coalesce(p_allow_partial_bids,false),
      min_bid_validity_days=p_min_validity_days,
      awarded_bid_id=null,
      updated_at=now()
  where id=p_quote_id
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.staff_open_bidding(uuid,timestamptz,boolean,smallint) from public, anon;
grant execute on function public.staff_open_bidding(uuid,timestamptz,boolean,smallint) to authenticated;

create or replace function public.staff_close_bidding(p_quote_id uuid)
returns public.quotes
language plpgsql
set search_path = public, private, pg_temp
as $$
declare v_row public.quotes;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  select * into v_row from public.quotes where id=p_quote_id for update;
  if v_row.id is null then raise exception 'Quote not found.' using errcode='P0002'; end if;
  if v_row.status <> 'bidding'::public.quote_status then raise exception 'Quotation is not open for bidding.' using errcode='55000'; end if;
  update public.quotes
  set status='quoted'::public.quote_status,
      bidding_closes_at=least(coalesce(bidding_closes_at,now()),now()),
      updated_at=now()
  where id=p_quote_id
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.staff_close_bidding(uuid) from public, anon;
grant execute on function public.staff_close_bidding(uuid) to authenticated;

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
  where private.quote_is_open_for_bidding(q.id)
  order by q.bidding_closes_at asc, q.submitted_at desc;
end;
$$;

revoke all on function private.supplier_open_tenders_impl() from public, anon;
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
  own_latest_bid jsonb
)
language sql
stable
set search_path = private, public, pg_temp
as $$ select * from private.supplier_open_tenders_impl(); $$;
revoke all on function public.supplier_open_tenders() from public, anon;
grant execute on function public.supplier_open_tenders() to authenticated;

create or replace function private.supplier_submit_bid_v2_impl(
  p_quote_id uuid,
  p_items jsonb,
  p_delivery_days smallint default null,
  p_terms text default null,
  p_valid_until timestamptz default null,
  p_freight_included boolean default false,
  p_tax_included boolean default false
)
returns public.supplier_bids
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supplier uuid;
  v_quote public.quotes;
  v_bid public.supplier_bids;
  v_item jsonb;
  v_quote_item public.quote_items;
  v_count integer;
  v_expected integer;
  v_revision integer;
  v_total numeric(14,2) := 0;
  v_rate numeric(12,2);
  v_valid_until timestamptz;
begin
  v_supplier := private.current_supplier_id();
  if v_supplier is null then raise exception 'Verified supplier access required.' using errcode='42501'; end if;

  select * into v_quote from public.quotes where id=p_quote_id for update;
  if v_quote.id is null then raise exception 'Quotation not found.' using errcode='P0002'; end if;
  if not private.quote_is_open_for_bidding(p_quote_id) then raise exception 'This quotation is not currently open for bidding.' using errcode='55000'; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Bid items must be a JSON array.' using errcode='22023'; end if;
  v_count := jsonb_array_length(p_items);
  if v_count < 1 or v_count > 200 then raise exception 'A bid must contain between 1 and 200 line items.' using errcode='22023'; end if;
  select count(*) into v_expected from public.quote_items qi where qi.quote_id=p_quote_id;
  if not v_quote.allow_partial_bids and v_count <> v_expected then raise exception 'This tender requires pricing for every quotation line.' using errcode='22023'; end if;

  if (select count(*) from jsonb_array_elements(p_items) x) <>
     (select count(distinct x->>'quote_item_id') from jsonb_array_elements(p_items) x) then
    raise exception 'A quotation line may only appear once in a bid.' using errcode='22023';
  end if;

  if p_delivery_days is not null and (p_delivery_days < 0 or p_delivery_days > 365) then raise exception 'Delivery days must be between 0 and 365.' using errcode='22023'; end if;
  if p_terms is not null and length(p_terms) > 5000 then raise exception 'Bid terms exceed the maximum permitted length.' using errcode='22001'; end if;

  v_valid_until := coalesce(p_valid_until, v_quote.bidding_closes_at + make_interval(days => v_quote.min_bid_validity_days));
  if v_valid_until < v_quote.bidding_closes_at + make_interval(days => v_quote.min_bid_validity_days) then
    raise exception 'Bid validity must extend at least % day(s) beyond the bidding deadline.', v_quote.min_bid_validity_days using errcode='22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      select * into strict v_quote_item
      from public.quote_items qi
      where qi.id = nullif(v_item->>'quote_item_id','')::uuid
        and qi.quote_id = p_quote_id;
    exception when no_data_found then
      raise exception 'One or more bid lines do not belong to this tender.' using errcode='23503';
    end;

    begin v_rate := (v_item->>'unit_rate')::numeric; exception when others then raise exception 'Every bid line requires a numeric unit rate.' using errcode='22023'; end;
    if v_rate <= 0 or v_rate > 100000000 then raise exception 'Bid unit rates must be greater than zero and no more than PKR 100,000,000.' using errcode='22023'; end if;
    if length(coalesce(v_item->>'offered_brand','')) > 160 or length(coalesce(v_item->>'availability_note','')) > 500 then
      raise exception 'Bid line brand or availability text exceeds the permitted length.' using errcode='22001';
    end if;
    if v_rate * v_quote_item.quantity > 999999999999 then raise exception 'A bid line total is too large to process.' using errcode='22003'; end if;
    v_total := v_total + (v_rate * v_quote_item.quantity);
  end loop;

  if v_total <= 0 or v_total > 999999999999 then raise exception 'Bid total is outside the permitted range.' using errcode='22003'; end if;
  select coalesce(max(sb.revision_no),0)+1 into v_revision from public.supplier_bids sb where sb.quote_id=p_quote_id and sb.supplier_id=v_supplier;

  insert into public.supplier_bids(
    quote_id,supplier_id,rate,delivery_days,terms,is_awarded,status,revision_no,
    valid_until,freight_included,tax_included,total_amount,updated_at
  ) values (
    p_quote_id,v_supplier,v_total,p_delivery_days,nullif(trim(coalesce(p_terms,'')),''),false,'submitted',v_revision,
    v_valid_until,coalesce(p_freight_included,false),coalesce(p_tax_included,false),v_total,now()
  ) returning * into v_bid;

  insert into public.supplier_bid_items(bid_id,quote_item_id,unit_rate,quantity_snapshot,offered_brand,availability_note)
  select
    v_bid.id,
    qi.id,
    (x->>'unit_rate')::numeric,
    qi.quantity,
    nullif(trim(coalesce(x->>'offered_brand','')),''),
    nullif(trim(coalesce(x->>'availability_note','')),'')
  from jsonb_array_elements(p_items) x
  join public.quote_items qi on qi.id=(x->>'quote_item_id')::uuid and qi.quote_id=p_quote_id;

  return v_bid;
end;
$$;
revoke all on function private.supplier_submit_bid_v2_impl(uuid,jsonb,smallint,text,timestamptz,boolean,boolean) from public, anon;
grant execute on function private.supplier_submit_bid_v2_impl(uuid,jsonb,smallint,text,timestamptz,boolean,boolean) to authenticated;

create or replace function public.supplier_submit_bid_v2(
  p_quote_id uuid,
  p_items jsonb,
  p_delivery_days smallint default null,
  p_terms text default null,
  p_valid_until timestamptz default null,
  p_freight_included boolean default false,
  p_tax_included boolean default false
)
returns public.supplier_bids
language sql
set search_path = private, public, pg_temp
as $$
  select private.supplier_submit_bid_v2_impl($1,$2,$3,$4,$5,$6,$7);
$$;
revoke all on function public.supplier_submit_bid_v2(uuid,jsonb,smallint,text,timestamptz,boolean,boolean) from public, anon;
grant execute on function public.supplier_submit_bid_v2(uuid,jsonb,smallint,text,timestamptz,boolean,boolean) to authenticated;

create or replace function private.supplier_withdraw_bid_impl(p_bid_id uuid)
returns public.supplier_bids
language plpgsql
security definer
set search_path = ''
as $$
declare v_supplier uuid; v_bid public.supplier_bids;
begin
  v_supplier := private.current_supplier_id();
  if v_supplier is null then raise exception 'Verified supplier access required.' using errcode='42501'; end if;
  select * into v_bid from public.supplier_bids where id=p_bid_id and supplier_id=v_supplier for update;
  if v_bid.id is null then raise exception 'Bid not found.' using errcode='P0002'; end if;
  if v_bid.is_awarded or v_bid.status='awarded' then raise exception 'An awarded bid cannot be withdrawn.' using errcode='55000'; end if;
  if not private.quote_is_open_for_bidding(v_bid.quote_id) then raise exception 'Bids can only be withdrawn while the tender is open.' using errcode='55000'; end if;
  update public.supplier_bids set status='withdrawn',updated_at=now() where id=p_bid_id returning * into v_bid;
  return v_bid;
end;
$$;
revoke all on function private.supplier_withdraw_bid_impl(uuid) from public, anon;
grant execute on function private.supplier_withdraw_bid_impl(uuid) to authenticated;

create or replace function public.supplier_withdraw_bid(p_bid_id uuid)
returns public.supplier_bids
language sql
set search_path = private, public, pg_temp
as $$ select private.supplier_withdraw_bid_impl($1); $$;
revoke all on function public.supplier_withdraw_bid(uuid) from public, anon;
grant execute on function public.supplier_withdraw_bid(uuid) to authenticated;

create or replace function public.staff_bid_comparison(p_quote_id uuid)
returns table(
  bid_id uuid,
  supplier_id uuid,
  supplier_name text,
  supplier_reliability smallint,
  revision_no integer,
  bid_status text,
  total_amount numeric,
  delivery_days smallint,
  valid_until timestamptz,
  freight_included boolean,
  tax_included boolean,
  terms text,
  placed_at timestamptz,
  line_count bigint,
  tender_line_count bigint,
  is_complete boolean,
  is_awarded boolean,
  line_items jsonb
)
language plpgsql
stable
set search_path = public, private, pg_temp
as $$
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  return query
  with latest as (
    select distinct on (sb.supplier_id) sb.*
    from public.supplier_bids sb
    where sb.quote_id=p_quote_id
    order by sb.supplier_id,sb.revision_no desc
  ), tender as (
    select count(*)::bigint cnt from public.quote_items qi where qi.quote_id=p_quote_id
  )
  select
    l.id,s.id,s.company_name,s.reliability_pct,l.revision_no,l.status,l.total_amount,
    l.delivery_days,l.valid_until,l.freight_included,l.tax_included,l.terms,l.placed_at,
    (select count(*) from public.supplier_bid_items bi where bi.bid_id=l.id),
    tender.cnt,
    ((select count(*) from public.supplier_bid_items bi where bi.bid_id=l.id)=tender.cnt),
    l.is_awarded,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'quote_item_id',bi.quote_item_id,'name',qi.name_snapshot,'unit',qi.unit_snapshot,
        'quantity',bi.quantity_snapshot,'unit_rate',bi.unit_rate,'line_total',bi.line_total,
        'offered_brand',bi.offered_brand,'availability_note',bi.availability_note
      ) order by qi.id)
      from public.supplier_bid_items bi
      join public.quote_items qi on qi.id=bi.quote_item_id
      where bi.bid_id=l.id
    ),'[]'::jsonb)
  from latest l
  join public.suppliers s on s.id=l.supplier_id
  cross join tender
  order by l.is_awarded desc,(l.status='submitted') desc,l.total_amount asc nulls last,s.reliability_pct desc nulls last;
end;
$$;
revoke all on function public.staff_bid_comparison(uuid) from public, anon;
grant execute on function public.staff_bid_comparison(uuid) to authenticated;

create or replace function public.staff_award_bid(p_bid_id uuid)
returns public.supplier_bids
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  v_bid public.supplier_bids;
  v_quote public.quotes;
  v_line_count bigint;
  v_tender_count bigint;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  select * into v_bid from public.supplier_bids where id=p_bid_id for update;
  if v_bid.id is null then raise exception 'Bid not found.' using errcode='P0002'; end if;
  if v_bid.status <> 'submitted' or v_bid.is_awarded then raise exception 'Only a submitted, unawarded bid can be selected.' using errcode='55000'; end if;
  if v_bid.valid_until is not null and v_bid.valid_until < now() then raise exception 'This bid has expired.' using errcode='55000'; end if;
  select * into v_quote from public.quotes where id=v_bid.quote_id for update;
  if v_quote.status not in ('bidding'::public.quote_status,'quoted'::public.quote_status) then raise exception 'Quotation is not in a bid-awardable state.' using errcode='55000'; end if;

  select count(*) into v_line_count from public.supplier_bid_items where bid_id=v_bid.id;
  select count(*) into v_tender_count from public.quote_items where quote_id=v_bid.quote_id;
  if not v_quote.allow_partial_bids and v_line_count <> v_tender_count then raise exception 'This bid does not cover every required tender line.' using errcode='55000'; end if;

  update public.supplier_bids
  set is_awarded=false,
      status=case when id=p_bid_id then 'awarded' else case when status='submitted' then 'rejected' else status end end,
      updated_at=now()
  where quote_id=v_bid.quote_id;

  update public.supplier_bids set is_awarded=true,status='awarded',updated_at=now() where id=p_bid_id returning * into v_bid;

  update public.quotes
  set awarded_bid_id=p_bid_id,status='confirmed'::public.quote_status,
      bidding_closes_at=least(coalesce(bidding_closes_at,now()),now()),updated_at=now()
  where id=v_bid.quote_id;

  return v_bid;
end;
$$;
revoke all on function public.staff_award_bid(uuid) from public, anon;
grant execute on function public.staff_award_bid(uuid) to authenticated;

revoke execute on function public.supplier_submit_bid(uuid,numeric,smallint,text) from public, anon, authenticated;

drop trigger if exists trg_audit_supplier_bid_items on public.supplier_bid_items;
create trigger trg_audit_supplier_bid_items
after insert or update or delete on public.supplier_bid_items
for each row execute function private.audit_row_mutation();

alter publication supabase_realtime add table public.supplier_bid_items;

commit;
