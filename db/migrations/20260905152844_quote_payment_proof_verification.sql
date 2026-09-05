begin;

create table if not exists public.quote_payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  method public.payment_pref not null,
  amount numeric(14,2) not null check (amount > 0),
  transaction_reference text not null check (char_length(btrim(transaction_reference)) between 4 and 120),
  proof_bucket text not null default 'payment-proofs' check (proof_bucket = 'payment-proofs'),
  proof_path text not null check (char_length(btrim(proof_path)) between 10 and 500),
  status text not null default 'submitted' check (status in ('submitted','verified','rejected')),
  review_notes text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_payments_method_proof check (method in ('bank_transfer','jazzcash','easypaisa'))
);

create unique index if not exists uq_quote_payment_transaction on public.quote_payments(quote_id, method, lower(transaction_reference));
create index if not exists idx_quote_payments_quote_submitted on public.quote_payments(quote_id, submitted_at desc);
create index if not exists idx_quote_payments_customer_submitted on public.quote_payments(customer_id, submitted_at desc);
create index if not exists idx_quote_payments_pending on public.quote_payments(status, submitted_at) where status='submitted';

alter table public.quote_payments enable row level security;

drop policy if exists "customer read own quote payments" on public.quote_payments;
create policy "customer read own quote payments" on public.quote_payments
for select to authenticated
using (customer_id = auth.uid() or private.is_staff());

revoke all on public.quote_payments from anon, public;
grant select on public.quote_payments to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('payment-proofs','payment-proofs',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "payment proofs upload own" on storage.objects;
create policy "payment proofs upload own" on storage.objects
for insert to authenticated
with check (bucket_id='payment-proofs' and split_part(name,'/',1)=auth.uid()::text);

drop policy if exists "payment proofs read own or staff" on storage.objects;
create policy "payment proofs read own or staff" on storage.objects
for select to authenticated
using (bucket_id='payment-proofs' and (split_part(name,'/',1)=auth.uid()::text or private.is_staff()));

drop policy if exists "payment proofs delete unreferenced own or staff" on storage.objects;
create policy "payment proofs delete unreferenced own or staff" on storage.objects
for delete to authenticated
using (
  bucket_id='payment-proofs'
  and (
    private.is_staff()
    or (
      split_part(name,'/',1)=auth.uid()::text
      and not exists (
        select 1 from public.quote_payments qp
        where qp.proof_bucket='payment-proofs' and qp.proof_path=storage.objects.name
      )
    )
  )
);

drop policy if exists "staff manage payment proofs" on storage.objects;
create policy "staff manage payment proofs" on storage.objects
for all to authenticated
using (bucket_id='payment-proofs' and private.is_staff())
with check (bucket_id='payment-proofs' and private.is_staff());

create or replace function private.payment_required_amount(p_quote_id uuid)
returns numeric
language sql
stable
security definer
set search_path=''
as $$
  select coalesce(
    (select b.total_amount from public.supplier_bids b join public.quotes q2 on q2.awarded_bid_id=b.id where q2.id=p_quote_id),
    (select q.subtotal from public.quotes q where q.id=p_quote_id),
    0::numeric
  );
$$;
revoke all on function private.payment_required_amount(uuid) from public, anon;
grant execute on function private.payment_required_amount(uuid) to authenticated;

create or replace function public.customer_payment_overview()
returns table(
  quote_id uuid,
  reference text,
  quote_status public.quote_status,
  payment_pref public.payment_pref,
  required_amount numeric,
  verified_amount numeric,
  submitted_amount numeric,
  remaining_amount numeric,
  payments jsonb
)
language plpgsql
stable
security definer
set search_path=''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  return query
  select q.id,q.reference,q.status,q.payment_pref,
    private.payment_required_amount(q.id),
    coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id=q.id and p.status='verified'),0),
    coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id=q.id and p.status='submitted'),0),
    greatest(private.payment_required_amount(q.id)-coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id=q.id and p.status in ('submitted','verified')),0),0),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'method',p.method,'amount',p.amount,'transaction_reference',p.transaction_reference,
      'proof_bucket',p.proof_bucket,'proof_path',p.proof_path,'status',p.status,'review_notes',p.review_notes,
      'reviewed_at',p.reviewed_at,'submitted_at',p.submitted_at
    ) order by p.submitted_at desc) from public.quote_payments p where p.quote_id=q.id),'[]'::jsonb)
  from public.quotes q
  where q.customer_id=v_uid and q.status in ('confirmed'::public.quote_status,'delivered'::public.quote_status)
  order by q.submitted_at desc;
end;
$$;
revoke all on function public.customer_payment_overview() from public, anon;
grant execute on function public.customer_payment_overview() to authenticated;

create or replace function public.customer_submit_payment(
  p_quote_id uuid,
  p_method public.payment_pref,
  p_amount numeric,
  p_transaction_reference text,
  p_proof_path text
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_uid uuid := auth.uid();
  v_quote public.quotes;
  v_required numeric;
  v_claimed numeric;
  v_ref text := btrim(coalesce(p_transaction_reference,''));
  v_path text := btrim(coalesce(p_proof_path,''));
  v_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into v_quote from public.quotes where id=p_quote_id and customer_id=v_uid for update;
  if v_quote.id is null then raise exception 'Quotation not found for this account.' using errcode='P0002'; end if;
  if v_quote.status not in ('confirmed'::public.quote_status,'delivered'::public.quote_status) then
    raise exception 'Payment proof can only be submitted after the quotation is confirmed.' using errcode='55000';
  end if;
  if p_method not in ('bank_transfer'::public.payment_pref,'jazzcash'::public.payment_pref,'easypaisa'::public.payment_pref) then
    raise exception 'Payment proof is only supported for bank transfer, JazzCash or EasyPaisa.' using errcode='22023';
  end if;
  if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be greater than zero.' using errcode='22023'; end if;
  if char_length(v_ref) not between 4 and 120 then raise exception 'Enter a valid transaction/reference number.' using errcode='22023'; end if;
  if v_path='' or split_part(v_path,'/',1)<>v_uid::text or split_part(v_path,'/',2)<>p_quote_id::text then raise exception 'Payment proof path is invalid.' using errcode='22023'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id='payment-proofs' and o.name=v_path and o.owner=v_uid) then raise exception 'Uploaded payment proof was not found for this account.' using errcode='P0002'; end if;

  v_required := private.payment_required_amount(p_quote_id);
  if v_required<=0 then raise exception 'The confirmed quotation has no payable amount.' using errcode='55000'; end if;
  select coalesce(sum(amount),0) into v_claimed from public.quote_payments where quote_id=p_quote_id and status in ('submitted','verified');
  if p_amount > greatest(v_required-v_claimed,0) then raise exception 'Payment amount exceeds the remaining unsubmitted balance.' using errcode='22023'; end if;

  insert into public.quote_payments(quote_id,customer_id,method,amount,transaction_reference,proof_path)
  values(p_quote_id,v_uid,p_method,p_amount,v_ref,v_path)
  returning id into v_id;

  insert into public.user_notifications(user_id,kind,title,body,payload,dedupe_key)
  values(v_uid,'payment_submitted','Payment proof submitted',
    'CKA received your payment proof for quotation '||v_quote.reference||'. It is awaiting staff verification.',
    jsonb_build_object('quote_id',p_quote_id,'payment_id',v_id),
    'payment-submitted-'||v_id::text)
  on conflict do nothing;

  return v_id;
end;
$$;
revoke all on function public.customer_submit_payment(uuid,public.payment_pref,numeric,text,text) from public, anon;
grant execute on function public.customer_submit_payment(uuid,public.payment_pref,numeric,text,text) to authenticated;

create or replace function public.staff_quote_payment_overview(p_quote_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare v_result jsonb;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  if not exists(select 1 from public.quotes where id=p_quote_id) then raise exception 'Quotation not found.' using errcode='P0002'; end if;
  select jsonb_build_object(
    'quote_id',q.id,'reference',q.reference,'quote_status',q.status,'payment_pref',q.payment_pref,
    'required_amount',private.payment_required_amount(q.id),
    'verified_amount',coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id=q.id and p.status='verified'),0),
    'submitted_amount',coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id=q.id and p.status='submitted'),0),
    'remaining_amount',greatest(private.payment_required_amount(q.id)-coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id=q.id and p.status='verified'),0),0),
    'payments',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'method',p.method,'amount',p.amount,'transaction_reference',p.transaction_reference,
      'proof_bucket',p.proof_bucket,'proof_path',p.proof_path,'status',p.status,'review_notes',p.review_notes,
      'reviewed_by',p.reviewed_by,'reviewed_at',p.reviewed_at,'submitted_at',p.submitted_at
    ) order by p.submitted_at desc) from public.quote_payments p where p.quote_id=q.id),'[]'::jsonb)
  ) into v_result from public.quotes q where q.id=p_quote_id;
  return v_result;
end;
$$;
revoke all on function public.staff_quote_payment_overview(uuid) from public, anon;
grant execute on function public.staff_quote_payment_overview(uuid) to authenticated;

create or replace function public.staff_review_payment(
  p_payment_id uuid,
  p_decision text,
  p_review_notes text default null
)
returns public.quote_payments
language plpgsql
security definer
set search_path=''
as $$
declare
  v_payment public.quote_payments;
  v_quote public.quotes;
  v_required numeric;
  v_verified numeric;
  v_decision text := lower(btrim(coalesce(p_decision,'')));
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  if v_decision not in ('verified','rejected') then raise exception 'Decision must be verified or rejected.' using errcode='22023'; end if;
  select * into v_payment from public.quote_payments where id=p_payment_id for update;
  if v_payment.id is null then raise exception 'Payment submission not found.' using errcode='P0002'; end if;
  if v_payment.status<>'submitted' then raise exception 'Only submitted payment proofs can be reviewed.' using errcode='55000'; end if;
  select * into v_quote from public.quotes where id=v_payment.quote_id for update;
  if v_decision='verified' then
    v_required := private.payment_required_amount(v_payment.quote_id);
    select coalesce(sum(amount),0) into v_verified from public.quote_payments where quote_id=v_payment.quote_id and status='verified';
    if v_verified+v_payment.amount > v_required then raise exception 'Verifying this payment would exceed the confirmed payable amount.' using errcode='55000'; end if;
  end if;

  update public.quote_payments set
    status=v_decision,
    review_notes=nullif(btrim(coalesce(p_review_notes,'')),''),
    reviewed_by=auth.uid(), reviewed_at=now(), updated_at=now()
  where id=p_payment_id returning * into v_payment;

  insert into public.user_notifications(user_id,kind,title,body,payload,dedupe_key)
  values(v_payment.customer_id,'payment_'||v_decision,
    case when v_decision='verified' then 'Payment verified' else 'Payment proof needs attention' end,
    case when v_decision='verified'
      then 'Your payment of PKR '||to_char(v_payment.amount,'FM999G999G999G990D00')||' for quotation '||v_quote.reference||' was verified.'
      else 'Your payment proof for quotation '||v_quote.reference||' was rejected. Review the note and submit a corrected proof if needed.' end,
    jsonb_build_object('quote_id',v_payment.quote_id,'payment_id',v_payment.id,'decision',v_decision),
    'payment-review-'||v_payment.id::text||'-'||v_decision)
  on conflict do nothing;

  return v_payment;
end;
$$;
revoke all on function public.staff_review_payment(uuid,text,text) from public, anon;
grant execute on function public.staff_review_payment(uuid,text,text) to authenticated;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname='audit_quote_payments_mutation' and tgrelid='public.quote_payments'::regclass
  ) then
    create trigger audit_quote_payments_mutation
    after insert or update or delete on public.quote_payments
    for each row execute function private.audit_row_mutation();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='quote_payments'
  ) then
    alter publication supabase_realtime add table public.quote_payments;
  end if;
end $$;

commit;
