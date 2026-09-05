begin;

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z0-9_]{2,80}$'),
  title text not null check (char_length(title) between 1 and 180),
  body text not null check (char_length(body) between 1 and 2000),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index uq_user_notifications_dedupe on public.user_notifications(user_id,dedupe_key) where dedupe_key is not null;
create index idx_user_notifications_user_created on public.user_notifications(user_id,created_at desc);
create index idx_user_notifications_unread on public.user_notifications(user_id,created_at desc) where read_at is null;
alter table public.user_notifications enable row level security;
revoke all on public.user_notifications from public,anon,authenticated;
grant select on public.user_notifications to authenticated;
grant update(read_at) on public.user_notifications to authenticated;
create policy "users read own notifications or staff read all" on public.user_notifications for select to authenticated
using(user_id=(select auth.uid()) or (select private.is_staff()));
create policy "users mark own notifications" on public.user_notifications for update to authenticated
using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null check(event_key ~ '^[a-z0-9_.-]{2,120}$'),
  aggregate_type text,
  aggregate_id uuid,
  recipient_user_id uuid references public.profiles(id) on delete set null,
  recipient_email text,
  recipient_phone text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check(status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0 check(attempts>=0),
  available_at timestamptz not null default now(),
  last_error text,
  processed_at timestamptz,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(recipient_user_id is not null or recipient_email is not null or recipient_phone is not null)
);
create unique index uq_notification_outbox_dedupe on public.notification_outbox(dedupe_key) where dedupe_key is not null;
create index idx_notification_outbox_pending on public.notification_outbox(status,available_at,created_at) where status in ('pending','failed');
create index idx_notification_outbox_recipient_user on public.notification_outbox(recipient_user_id,created_at desc) where recipient_user_id is not null;
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from public,anon,authenticated;
grant select on public.notification_outbox to authenticated;
create policy "staff read notification outbox" on public.notification_outbox for select to authenticated using((select private.is_staff()));
create trigger trg_touch_notification_outbox before update on public.notification_outbox for each row execute function public.touch_updated_at();

create or replace function private.enqueue_user_notification(p_user_id uuid,p_kind text,p_title text,p_body text,p_payload jsonb default '{}'::jsonb,p_dedupe_key text default null)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if p_user_id is null then return; end if;
  insert into public.user_notifications(user_id,kind,title,body,payload,dedupe_key)
  values(p_user_id,p_kind,p_title,p_body,coalesce(p_payload,'{}'::jsonb),p_dedupe_key)
  on conflict(user_id,dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

create or replace function private.enqueue_outbox(p_event_key text,p_aggregate_type text,p_aggregate_id uuid,p_recipient_user_id uuid,p_recipient_email text,p_recipient_phone text,p_payload jsonb default '{}'::jsonb,p_dedupe_key text default null)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if p_recipient_user_id is null and nullif(trim(coalesce(p_recipient_email,'')),'') is null and nullif(trim(coalesce(p_recipient_phone,'')),'') is null then return; end if;
  insert into public.notification_outbox(event_key,aggregate_type,aggregate_id,recipient_user_id,recipient_email,recipient_phone,payload,dedupe_key)
  values(p_event_key,p_aggregate_type,p_aggregate_id,p_recipient_user_id,nullif(lower(trim(coalesce(p_recipient_email,''))),''),nullif(trim(coalesce(p_recipient_phone,'')),''),coalesce(p_payload,'{}'::jsonb),p_dedupe_key)
  on conflict(dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

create or replace function private.notify_staff(p_kind text,p_title text,p_body text,p_payload jsonb,p_dedupe_prefix text)
returns void language plpgsql security definer set search_path=''
as $$
declare r record;
begin
  for r in select id from public.profiles where role in ('admin'::public.user_role,'staff'::public.user_role) loop
    perform private.enqueue_user_notification(r.id,p_kind,p_title,p_body,p_payload,case when p_dedupe_prefix is null then null else p_dedupe_prefix||':'||r.id::text end);
  end loop;
end;
$$;

create or replace function private.business_notification_trigger()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_supplier record;
begin
  if tg_table_name='quotes' then
    if tg_op='INSERT' then
      perform private.notify_staff('quote_received','New quotation request','Quotation '||new.reference||' has been submitted.',jsonb_build_object('quote_id',new.id,'reference',new.reference,'subtotal',new.subtotal),'staff:quote:new:'||new.id::text);
      if new.customer_id is not null then
        perform private.enqueue_user_notification(new.customer_id,'quote_received','Quotation received','Your quotation request '||new.reference||' has been received.',jsonb_build_object('quote_id',new.id,'reference',new.reference,'status',new.status),'customer:quote:new:'||new.id::text);
      else
        perform private.enqueue_outbox('quote.received','quote',new.id,null,new.contact_email,new.contact_phone,jsonb_build_object('reference',new.reference,'status',new.status),'external:quote:new:'||new.id::text);
      end if;
    elsif tg_op='UPDATE' and old.status is distinct from new.status then
      if new.customer_id is not null then
        perform private.enqueue_user_notification(new.customer_id,'quote_status','Quotation status updated','Quotation '||new.reference||' is now '||replace(new.status::text,'_',' ')||'.',jsonb_build_object('quote_id',new.id,'reference',new.reference,'old_status',old.status,'status',new.status),'customer:quote:status:'||new.id::text||':'||new.status::text);
      else
        perform private.enqueue_outbox('quote.status_changed','quote',new.id,null,new.contact_email,new.contact_phone,jsonb_build_object('reference',new.reference,'old_status',old.status,'status',new.status),'external:quote:status:'||new.id::text||':'||new.status::text);
      end if;
      if new.status='bidding' then
        for v_supplier in select s.profile_id,s.id from public.suppliers s where s.is_verified and s.profile_id is not null loop
          perform private.enqueue_user_notification(v_supplier.profile_id,'tender_open','New tender available','A new CKA procurement tender is open for supplier bidding.',jsonb_build_object('quote_id',new.id,'reference',new.reference),'supplier:tender:'||new.id::text||':'||v_supplier.id::text);
        end loop;
      end if;
    end if;
  elsif tg_table_name='projects' then
    if tg_op='INSERT' then
      perform private.notify_staff('project_received','New project request','Project '||new.reference||' has been submitted.',jsonb_build_object('project_id',new.id,'reference',new.reference),'staff:project:new:'||new.id::text);
      if new.customer_id is not null then
        perform private.enqueue_user_notification(new.customer_id,'project_received','Project request received','Your project request '||new.reference||' has been received.',jsonb_build_object('project_id',new.id,'reference',new.reference,'status',new.status),'customer:project:new:'||new.id::text);
      else
        perform private.enqueue_outbox('project.received','project',new.id,null,new.email,new.phone,jsonb_build_object('reference',new.reference,'status',new.status),'external:project:new:'||new.id::text);
      end if;
    elsif tg_op='UPDATE' and old.status is distinct from new.status then
      if new.customer_id is not null then
        perform private.enqueue_user_notification(new.customer_id,'project_status','Project status updated','Project '||new.reference||' is now '||replace(new.status::text,'_',' ')||'.',jsonb_build_object('project_id',new.id,'reference',new.reference,'old_status',old.status,'status',new.status,'progress_pct',new.progress_pct),'customer:project:status:'||new.id::text||':'||new.status::text);
      else
        perform private.enqueue_outbox('project.status_changed','project',new.id,null,new.email,new.phone,jsonb_build_object('reference',new.reference,'old_status',old.status,'status',new.status,'progress_pct',new.progress_pct),'external:project:status:'||new.id::text||':'||new.status::text);
      end if;
    end if;
  elsif tg_table_name='inquiries' and tg_op='INSERT' then
    perform private.notify_staff('inquiry_received','New inquiry','A new website inquiry has been received.',jsonb_build_object('inquiry_id',new.id,'subject',new.subject,'source',new.source),'staff:inquiry:new:'||new.id::text);
  elsif tg_table_name='supplier_applications' then
    if tg_op='INSERT' then
      perform private.notify_staff('supplier_application','New supplier application','Supplier application '||new.reference||' has been received.',jsonb_build_object('application_id',new.id,'reference',new.reference,'business_name',new.business_name),'staff:supplier_application:new:'||new.id::text);
      perform private.enqueue_outbox('supplier_application.received','supplier_application',new.id,null,new.email,new.phone,jsonb_build_object('reference',new.reference,'status',new.status),'external:supplier_application:new:'||new.id::text);
    elsif tg_op='UPDATE' and old.status is distinct from new.status then
      perform private.enqueue_outbox('supplier_application.status_changed','supplier_application',new.id,null,new.email,new.phone,jsonb_build_object('reference',new.reference,'old_status',old.status,'status',new.status),'external:supplier_application:status:'||new.id::text||':'||new.status);
    end if;
  elsif tg_table_name='supplier_bids' then
    if tg_op='INSERT' then
      perform private.notify_staff('supplier_bid','New supplier bid','A supplier bid has been submitted for a CKA quotation.',jsonb_build_object('bid_id',new.id,'quote_id',new.quote_id,'supplier_id',new.supplier_id,'rate',new.rate),'staff:bid:new:'||new.id::text);
    elsif tg_op='UPDATE' and not old.is_awarded and new.is_awarded then
      select s.profile_id,s.email,s.phone into v_supplier from public.suppliers s where s.id=new.supplier_id;
      if v_supplier.profile_id is not null then
        perform private.enqueue_user_notification(v_supplier.profile_id,'bid_awarded','Bid awarded','Your supplier bid has been awarded by CKA BuildStruct.',jsonb_build_object('bid_id',new.id,'quote_id',new.quote_id,'rate',new.rate),'supplier:bid:awarded:'||new.id::text);
      end if;
      perform private.enqueue_outbox('supplier_bid.awarded','supplier_bid',new.id,v_supplier.profile_id,v_supplier.email,v_supplier.phone,jsonb_build_object('bid_id',new.id,'quote_id',new.quote_id,'rate',new.rate),'external:supplier:bid:awarded:'||new.id::text);
    end if;
  end if;
  return coalesce(new,old);
end;
$$;

create trigger notify_quote_business_events after insert or update on public.quotes for each row execute function private.business_notification_trigger();
create trigger notify_project_business_events after insert or update on public.projects for each row execute function private.business_notification_trigger();
create trigger notify_inquiry_business_events after insert on public.inquiries for each row execute function private.business_notification_trigger();
create trigger notify_supplier_application_business_events after insert or update on public.supplier_applications for each row execute function private.business_notification_trigger();
create trigger notify_supplier_bid_business_events after insert or update on public.supplier_bids for each row execute function private.business_notification_trigger();

create or replace function public.mark_notification_read(p_notification_id uuid)
returns public.user_notifications language plpgsql set search_path=public,pg_temp
as $$
declare v_row public.user_notifications;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  update public.user_notifications set read_at=coalesce(read_at,now()) where id=p_notification_id and user_id=auth.uid() returning * into v_row;
  if v_row.id is null then raise exception 'Notification not found.' using errcode='P0002'; end if;
  return v_row;
end;
$$;
revoke all on function public.mark_notification_read(uuid) from public,anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;

create or replace function public.staff_outbox_summary()
returns jsonb language plpgsql stable set search_path=public,private,pg_temp
as $$
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  return jsonb_build_object('pending',(select count(*) from public.notification_outbox where status='pending'),'failed',(select count(*) from public.notification_outbox where status='failed'),'processing',(select count(*) from public.notification_outbox where status='processing'),'sent',(select count(*) from public.notification_outbox where status='sent'));
end;
$$;
revoke all on function public.staff_outbox_summary() from public,anon;
grant execute on function public.staff_outbox_summary() to authenticated;

do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_notifications') then
    alter publication supabase_realtime add table public.user_notifications;
  end if;
end $$;

commit;
