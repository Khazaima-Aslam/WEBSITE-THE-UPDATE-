begin;
drop index if exists public.uq_quote_payment_transaction;
create unique index uq_quote_payment_transaction_active
  on public.quote_payments(quote_id, method, lower(transaction_reference))
  where status <> 'rejected';
commit;
