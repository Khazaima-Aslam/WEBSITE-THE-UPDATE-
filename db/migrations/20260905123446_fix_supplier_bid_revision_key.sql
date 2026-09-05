begin;
alter table public.supplier_bids drop constraint if exists supplier_bids_quote_id_supplier_id_placed_at_key;
commit;
