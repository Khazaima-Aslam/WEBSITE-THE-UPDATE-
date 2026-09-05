create index if not exists idx_quotes_awarded_bid_id on public.quotes(awarded_bid_id) where awarded_bid_id is not null;
