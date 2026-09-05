begin;
create index if not exists idx_quote_payments_reviewed_by
  on public.quote_payments(reviewed_by)
  where reviewed_by is not null;

drop policy if exists "customer read own quote payments" on public.quote_payments;
create policy "customer read own quote payments" on public.quote_payments
for select to authenticated
using (
  customer_id = (select auth.uid())
  or (select private.is_staff())
);
commit;
