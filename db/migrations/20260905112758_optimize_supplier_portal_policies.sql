-- Applied to live Supabase: 2026-09-05 11:27:58 UTC
-- Consolidates overlapping permissive policies and removes a duplicate index.

begin;

drop index if exists public.idx_quotes_status_submitted;

drop policy if exists "staff read suppliers" on public.suppliers;
drop policy if exists "supplier read own supplier" on public.suppliers;
create policy "staff or supplier read suppliers"
on public.suppliers for select
to authenticated
using (public.is_staff() or profile_id = (select auth.uid()));

drop policy if exists "staff update suppliers" on public.suppliers;
drop policy if exists "supplier update own supplier" on public.suppliers;
create policy "staff or supplier update suppliers"
on public.suppliers for update
to authenticated
using (public.is_staff() or profile_id = (select auth.uid()))
with check (public.is_staff() or profile_id = (select auth.uid()));

drop policy if exists "staff read bids" on public.supplier_bids;
drop policy if exists "supplier read own bids" on public.supplier_bids;
create policy "staff or supplier read bids"
on public.supplier_bids for select
to authenticated
using (public.is_staff() or supplier_id = private.current_supplier_id());

drop policy if exists "staff insert bids" on public.supplier_bids;
drop policy if exists "supplier insert own bids" on public.supplier_bids;
create policy "staff or supplier insert bids"
on public.supplier_bids for insert
to authenticated
with check (
  public.is_staff()
  or (
    supplier_id = private.current_supplier_id()
    and private.quote_is_open_for_bidding(quote_id)
    and not is_awarded
  )
);

commit;
