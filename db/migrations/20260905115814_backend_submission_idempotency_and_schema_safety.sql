begin;

create table private.submission_idempotency (
  kind text not null,
  fingerprint text not null,
  reference text not null,
  created_at timestamptz not null default now(),
  primary key(kind,fingerprint)
);
create index idx_submission_idempotency_created on private.submission_idempotency(created_at);
revoke all on private.submission_idempotency from public,anon,authenticated;

create or replace function private.idempotency_lock_and_get(p_kind text,p_raw text,p_window interval default interval '10 minutes')
returns table(fingerprint text,existing_reference text)
language plpgsql security definer set search_path=''
as $$
declare v_fp text; v_ref text;
begin
  v_fp:=encode(extensions.digest(coalesce(p_raw,''),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_kind||':'||v_fp,0));
  select s.reference into v_ref from private.submission_idempotency s
  where s.kind=p_kind and s.fingerprint=v_fp and s.created_at>=now()-p_window;
  return query select v_fp,v_ref;
end;
$$;

create or replace function private.idempotency_store(p_kind text,p_fingerprint text,p_reference text)
returns void language sql security definer set search_path=''
as $$
insert into private.submission_idempotency(kind,fingerprint,reference,created_at)
values(p_kind,p_fingerprint,p_reference,now())
on conflict(kind,fingerprint) do update set reference=excluded.reference,created_at=excluded.created_at;
$$;

create unique index if not exists uq_project_files_storage_object on public.project_files(storage_bucket,storage_path);

alter function private.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) rename to submit_quote_core;
alter function private.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) rename to submit_project_core;
alter function private.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) rename to submit_project_with_file_core;
alter function private.submit_inquiry(text,text,text,text,text,text) rename to submit_inquiry_core;
alter function private.submit_supplier_application(text,text,text,text,text,text,text) rename to submit_supplier_application_core;
revoke all on function private.submit_quote_core(text,text,jsonb,text,text,text,public.payment_pref,text) from public,anon,authenticated;
revoke all on function private.submit_project_core(text,text,text,text,text,text,text,numeric,numeric,date,text) from public,anon,authenticated;
revoke all on function private.submit_project_with_file_core(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) from public,anon,authenticated;
revoke all on function private.submit_inquiry_core(text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function private.submit_supplier_application_core(text,text,text,text,text,text,text) from public,anon,authenticated;

create function private.submit_quote(p_contact_name text,p_contact_phone text,p_items jsonb,p_contact_email text default null,p_delivery_city text default null,p_delivery_address text default null,p_payment_pref public.payment_pref default null,p_notes text default null)
returns text language plpgsql security definer set search_path=''
as $$
declare v_fp text; v_existing text; v_reference text; v_raw text;
begin
  v_raw:=jsonb_build_object('name',lower(trim(coalesce(p_contact_name,''))),'phone',trim(coalesce(p_contact_phone,'')),'email',lower(trim(coalesce(p_contact_email,''))),'city',lower(trim(coalesce(p_delivery_city,''))),'address',lower(trim(coalesce(p_delivery_address,''))),'payment',coalesce(p_payment_pref::text,''),'notes',trim(coalesce(p_notes,'')),'items',coalesce(p_items,'[]'::jsonb))::text;
  select fingerprint,existing_reference into v_fp,v_existing from private.idempotency_lock_and_get('quote',v_raw,interval '10 minutes');
  if v_existing is not null then return v_existing; end if;
  v_reference:=private.submit_quote_core(p_contact_name,p_contact_phone,p_items,p_contact_email,p_delivery_city,p_delivery_address,p_payment_pref,p_notes);
  perform private.idempotency_store('quote',v_fp,v_reference);
  return v_reference;
end;
$$;

create function private.submit_project(p_client_name text,p_phone text,p_email text default null,p_company text default null,p_project_name text default null,p_project_type text default null,p_location text default null,p_budget_min numeric default null,p_budget_max numeric default null,p_expected_completion date default null,p_scope text default null)
returns text language plpgsql security definer set search_path=''
as $$
declare v_fp text; v_existing text; v_reference text; v_raw text;
begin
  v_raw:=jsonb_build_object('name',lower(trim(coalesce(p_client_name,''))),'phone',trim(coalesce(p_phone,'')),'email',lower(trim(coalesce(p_email,''))),'company',lower(trim(coalesce(p_company,''))),'project_name',lower(trim(coalesce(p_project_name,''))),'project_type',lower(trim(coalesce(p_project_type,''))),'location',lower(trim(coalesce(p_location,''))),'budget_min',p_budget_min,'budget_max',p_budget_max,'completion',p_expected_completion,'scope',trim(coalesce(p_scope,'')),'customer_id',auth.uid())::text;
  select fingerprint,existing_reference into v_fp,v_existing from private.idempotency_lock_and_get('project',v_raw,interval '10 minutes');
  if v_existing is not null then return v_existing; end if;
  v_reference:=private.submit_project_core(p_client_name,p_phone,p_email,p_company,p_project_name,p_project_type,p_location,p_budget_min,p_budget_max,p_expected_completion,p_scope);
  perform private.idempotency_store('project',v_fp,v_reference);
  return v_reference;
end;
$$;

create function private.submit_project_with_file(p_client_name text,p_phone text,p_email text default null,p_company text default null,p_project_name text default null,p_project_type text default null,p_location text default null,p_budget_min numeric default null,p_budget_max numeric default null,p_expected_completion date default null,p_scope text default null,p_file_path text default null,p_file_name text default null,p_file_mime text default null,p_file_size bigint default null)
returns text language plpgsql security definer set search_path=''
as $$
declare v_fp text; v_existing text; v_reference text; v_raw text;
begin
  v_raw:=jsonb_build_object('name',lower(trim(coalesce(p_client_name,''))),'phone',trim(coalesce(p_phone,'')),'email',lower(trim(coalesce(p_email,''))),'company',lower(trim(coalesce(p_company,''))),'project_name',lower(trim(coalesce(p_project_name,''))),'project_type',lower(trim(coalesce(p_project_type,''))),'location',lower(trim(coalesce(p_location,''))),'budget_min',p_budget_min,'budget_max',p_budget_max,'completion',p_expected_completion,'scope',trim(coalesce(p_scope,'')),'file_path',trim(coalesce(p_file_path,'')),'file_name',trim(coalesce(p_file_name,'')),'file_mime',trim(coalesce(p_file_mime,'')),'file_size',p_file_size,'customer_id',auth.uid())::text;
  select fingerprint,existing_reference into v_fp,v_existing from private.idempotency_lock_and_get('project_with_file',v_raw,interval '10 minutes');
  if v_existing is not null then return v_existing; end if;
  if nullif(trim(coalesce(p_file_path,'')),'') is not null then
    select p.reference into v_existing from public.project_files pf join public.projects p on p.id=pf.project_id
    where pf.storage_bucket='project-uploads' and pf.storage_path=trim(p_file_path) and p.phone=trim(p_phone) limit 1;
    if v_existing is not null then perform private.idempotency_store('project_with_file',v_fp,v_existing); return v_existing; end if;
  end if;
  v_reference:=private.submit_project_with_file_core(p_client_name,p_phone,p_email,p_company,p_project_name,p_project_type,p_location,p_budget_min,p_budget_max,p_expected_completion,p_scope,p_file_path,p_file_name,p_file_mime,p_file_size);
  perform private.idempotency_store('project_with_file',v_fp,v_reference);
  return v_reference;
end;
$$;

create function private.submit_inquiry(p_name text,p_message text,p_email text default null,p_phone text default null,p_subject text default null,p_source text default 'contact_form')
returns boolean language plpgsql security definer set search_path=''
as $$
declare v_fp text; v_existing text; v_raw text;
begin
  v_raw:=jsonb_build_object('name',lower(trim(coalesce(p_name,''))),'message',trim(coalesce(p_message,'')),'email',lower(trim(coalesce(p_email,''))),'phone',trim(coalesce(p_phone,'')),'subject',lower(trim(coalesce(p_subject,''))),'source',coalesce(p_source,'contact_form'))::text;
  select fingerprint,existing_reference into v_fp,v_existing from private.idempotency_lock_and_get('inquiry',v_raw,interval '10 minutes');
  if v_existing is not null then return true; end if;
  perform private.submit_inquiry_core(p_name,p_message,p_email,p_phone,p_subject,p_source);
  perform private.idempotency_store('inquiry',v_fp,'ok');
  return true;
end;
$$;

create function private.submit_supplier_application(p_business_name text,p_contact_person text,p_phone text,p_email text default null,p_city text default null,p_category text default null,p_business_details text default null)
returns text language plpgsql security definer set search_path=''
as $$
declare v_fp text; v_existing text; v_reference text; v_raw text;
begin
  v_raw:=jsonb_build_object('business',lower(trim(coalesce(p_business_name,''))),'contact',lower(trim(coalesce(p_contact_person,''))),'phone',trim(coalesce(p_phone,'')),'email',lower(trim(coalesce(p_email,''))),'city',lower(trim(coalesce(p_city,''))),'category',lower(trim(coalesce(p_category,''))),'details',trim(coalesce(p_business_details,'')))::text;
  select fingerprint,existing_reference into v_fp,v_existing from private.idempotency_lock_and_get('supplier_application',v_raw,interval '30 minutes');
  if v_existing is not null then return v_existing; end if;
  v_reference:=private.submit_supplier_application_core(p_business_name,p_contact_person,p_phone,p_email,p_city,p_category,p_business_details);
  perform private.idempotency_store('supplier_application',v_fp,v_reference);
  return v_reference;
end;
$$;

revoke all on function private.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) from public;
revoke all on function private.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) from public;
revoke all on function private.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) from public;
revoke all on function private.submit_inquiry(text,text,text,text,text,text) from public;
revoke all on function private.submit_supplier_application(text,text,text,text,text,text,text) from public;
grant execute on function private.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) to anon,authenticated;
grant execute on function private.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) to anon,authenticated;
grant execute on function private.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) to anon,authenticated;
grant execute on function private.submit_inquiry(text,text,text,text,text,text) to anon,authenticated;
grant execute on function private.submit_supplier_application(text,text,text,text,text,text,text) to anon,authenticated;

create or replace function public.submit_quote(p_contact_name text,p_contact_phone text,p_items jsonb,p_contact_email text default null,p_delivery_city text default null,p_delivery_address text default null,p_payment_pref public.payment_pref default null,p_notes text default null)
returns text language sql security invoker set search_path='' as $$select private.submit_quote(p_contact_name,p_contact_phone,p_items,p_contact_email,p_delivery_city,p_delivery_address,p_payment_pref,p_notes);$$;
create or replace function public.submit_project(p_client_name text,p_phone text,p_email text default null,p_company text default null,p_project_name text default null,p_project_type text default null,p_location text default null,p_budget_min numeric default null,p_budget_max numeric default null,p_expected_completion date default null,p_scope text default null)
returns text language sql security invoker set search_path='' as $$select private.submit_project(p_client_name,p_phone,p_email,p_company,p_project_name,p_project_type,p_location,p_budget_min,p_budget_max,p_expected_completion,p_scope);$$;
create or replace function public.submit_project_with_file(p_client_name text,p_phone text,p_email text default null,p_company text default null,p_project_name text default null,p_project_type text default null,p_location text default null,p_budget_min numeric default null,p_budget_max numeric default null,p_expected_completion date default null,p_scope text default null,p_file_path text default null,p_file_name text default null,p_file_mime text default null,p_file_size bigint default null)
returns text language sql security invoker set search_path='' as $$select private.submit_project_with_file(p_client_name,p_phone,p_email,p_company,p_project_name,p_project_type,p_location,p_budget_min,p_budget_max,p_expected_completion,p_scope,p_file_path,p_file_name,p_file_mime,p_file_size);$$;
create or replace function public.submit_inquiry(p_name text,p_message text,p_email text default null,p_phone text default null,p_subject text default null,p_source text default 'contact_form')
returns boolean language sql security invoker set search_path='' as $$select private.submit_inquiry(p_name,p_message,p_email,p_phone,p_subject,p_source);$$;
create or replace function public.submit_supplier_application(p_business_name text,p_contact_person text,p_phone text,p_email text default null,p_city text default null,p_category text default null,p_business_details text default null)
returns text language sql security invoker set search_path='' as $$select private.submit_supplier_application(p_business_name,p_contact_person,p_phone,p_email,p_city,p_category,p_business_details);$$;

revoke all on function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) from public;
revoke all on function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) from public;
revoke all on function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) from public;
revoke all on function public.submit_inquiry(text,text,text,text,text,text) from public;
revoke all on function public.submit_supplier_application(text,text,text,text,text,text,text) from public;
grant execute on function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) to anon,authenticated;
grant execute on function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) to anon,authenticated;
grant execute on function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) to anon,authenticated;
grant execute on function public.submit_inquiry(text,text,text,text,text,text) to anon,authenticated;
grant execute on function public.submit_supplier_application(text,text,text,text,text,text,text) to anon,authenticated;

create or replace function private.cleanup_backend_ephemera()
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_tracking bigint; v_idem bigint;
begin
  delete from private.guest_tracking_attempts where attempted_at<now()-interval '48 hours'; get diagnostics v_tracking=row_count;
  delete from private.submission_idempotency where created_at<now()-interval '24 hours'; get diagnostics v_idem=row_count;
  return jsonb_build_object('guest_tracking_deleted',v_tracking,'idempotency_deleted',v_idem);
end;
$$;
grant execute on function private.cleanup_backend_ephemera() to authenticated;

create or replace function public.staff_run_backend_maintenance()
returns jsonb language plpgsql security invoker set search_path=''
as $$begin if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if; return private.cleanup_backend_ephemera(); end;$$;
revoke all on function public.staff_run_backend_maintenance() from public,anon;
grant execute on function public.staff_run_backend_maintenance() to authenticated;

create or replace function public.staff_backend_health()
returns jsonb language plpgsql stable security invoker set search_path=''
as $$
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  return jsonb_build_object(
    'active_products',(select count(*) from public.products where is_active),
    'open_quotes',(select count(*) from public.quotes where status not in ('delivered','cancelled')),
    'open_projects',(select count(*) from public.projects where status not in ('completed','archived')),
    'unhandled_inquiries',(select count(*) from public.inquiries where not is_handled),
    'pending_supplier_applications',(select count(*) from public.supplier_applications where status in ('received','under_review')),
    'outbox_pending',(select count(*) from public.notification_outbox where status='pending'),
    'outbox_failed',(select count(*) from public.notification_outbox where status='failed'),
    'oldest_pending_outbox',(select min(created_at) from public.notification_outbox where status='pending'),
    'last_audit_at',(select max(created_at) from public.admin_audit_log)
  );
end;
$$;
revoke all on function public.staff_backend_health() from public,anon;
grant execute on function public.staff_backend_health() to authenticated;

create or replace function private.auto_enable_public_rls()
returns event_trigger language plpgsql security definer set search_path=pg_catalog
as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() where command_tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') and object_type in ('table','partitioned table') loop
    if cmd.schema_name='public' then
      begin execute format('alter table if exists %s enable row level security',cmd.object_identity);
      exception when others then raise log 'CKA auto-RLS failed for %: %',cmd.object_identity,sqlerrm; end;
    end if;
  end loop;
end;
$$;
drop event trigger if exists cka_auto_enable_public_rls;
create event trigger cka_auto_enable_public_rls on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') execute function private.auto_enable_public_rls();

commit;
