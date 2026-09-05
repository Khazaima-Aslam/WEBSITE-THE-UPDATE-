begin;

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
  if exists (
    select 1 from public.supplier_bids newer
    where newer.quote_id=v_bid.quote_id
      and newer.supplier_id=v_bid.supplier_id
      and newer.revision_no > v_bid.revision_no
  ) then
    raise exception 'Only the supplier''s latest bid revision can be awarded.' using errcode='55000';
  end if;
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

commit;
