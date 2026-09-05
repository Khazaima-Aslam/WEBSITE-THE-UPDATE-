begin;

create table private.guest_tracking_attempts (
  id bigint generated always as identity primary key,
  key_hash text not null,
  attempted_at timestamptz not null default now()
);
create index idx_guest_tracking_attempts_key_time on private.guest_tracking_attempts(key_hash,attempted_at desc);
revoke all on private.guest_tracking_attempts from public,anon,authenticated;

create or replace function private.assert_guest_tracking_rate(p_kind text,p_reference text,p_phone text)
returns void language plpgsql security definer set search_path=''
as $$
declare v_headers jsonb:='{}'::jsonb; v_ip text:='unknown'; v_key text; v_count integer;
begin
  begin
    if nullif(current_setting('request.headers',true),'') is not null then v_headers:=current_setting('request.headers',true)::jsonb; end if;
  exception when others then v_headers:='{}'::jsonb; end;
  v_ip:=trim(split_part(coalesce(v_headers->>'x-forwarded-for',v_headers->>'cf-connecting-ip','unknown'),',',1));
  v_key:=encode(extensions.digest(coalesce(v_ip,'unknown')||'|'||lower(trim(coalesce(p_kind,'')))||'|'||lower(trim(coalesce(p_phone,''))),'sha256'),'hex');
  select count(*) into v_count from private.guest_tracking_attempts where key_hash=v_key and attempted_at>now()-interval '1 hour';
  if v_count>=30 then raise exception 'Too many tracking attempts. Please try again later.' using errcode='53400'; end if;
  insert into private.guest_tracking_attempts(key_hash) values(v_key);
end;
$$;

create or replace function private.track_quote(p_reference text,p_phone text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_row public.quotes;
begin
  if coalesce(trim(p_reference),'')='' or coalesce(trim(p_phone),'')='' then raise exception 'Reference and phone number are required.' using errcode='22023'; end if;
  if length(p_reference)>80 or length(p_phone)>40 then raise exception 'Invalid tracking details.' using errcode='22023'; end if;
  perform private.assert_guest_tracking_rate('quote',p_reference,p_phone);
  select * into v_row from public.quotes where reference=trim(p_reference) and contact_phone=trim(p_phone) limit 1;
  if v_row.id is null then raise exception 'Request not found for the supplied tracking details.' using errcode='P0002'; end if;
  return jsonb_build_object('reference',v_row.reference,'status',v_row.status,'subtotal',v_row.subtotal,'submitted_at',v_row.submitted_at,'updated_at',v_row.updated_at);
end;
$$;

create or replace function private.track_project(p_reference text,p_phone text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_row public.projects;
begin
  if coalesce(trim(p_reference),'')='' or coalesce(trim(p_phone),'')='' then raise exception 'Reference and phone number are required.' using errcode='22023'; end if;
  if length(p_reference)>80 or length(p_phone)>40 then raise exception 'Invalid tracking details.' using errcode='22023'; end if;
  perform private.assert_guest_tracking_rate('project',p_reference,p_phone);
  select * into v_row from public.projects where reference=trim(p_reference) and phone=trim(p_phone) limit 1;
  if v_row.id is null then raise exception 'Request not found for the supplied tracking details.' using errcode='P0002'; end if;
  return jsonb_build_object('reference',v_row.reference,'status',v_row.status,'progress_pct',v_row.progress_pct,'project_name',v_row.project_name,'created_at',v_row.created_at,'updated_at',v_row.updated_at);
end;
$$;
grant execute on function private.track_quote(text,text) to anon,authenticated;
grant execute on function private.track_project(text,text) to anon,authenticated;

create or replace function public.track_quote(p_reference text,p_phone text)
returns jsonb language sql security invoker set search_path=''
as $$select private.track_quote(p_reference,p_phone);$$;
create or replace function public.track_project(p_reference text,p_phone text)
returns jsonb language sql security invoker set search_path=''
as $$select private.track_project(p_reference,p_phone);$$;
revoke all on function public.track_quote(text,text) from public;
revoke all on function public.track_project(text,text) from public;
grant execute on function public.track_quote(text,text) to anon,authenticated;
grant execute on function public.track_project(text,text) to anon,authenticated;

create or replace function private.customer_claim_quote(p_reference text,p_phone text)
returns public.quotes language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_row public.quotes;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles p where p.id=v_uid and p.role='customer') then raise exception 'Only a customer account can claim a quotation.' using errcode='42501'; end if;
  if coalesce(trim(p_reference),'')='' or coalesce(trim(p_phone),'')='' then raise exception 'Reference and phone number are required.' using errcode='22023'; end if;
  perform private.assert_guest_tracking_rate('claim_quote',p_reference,p_phone);
  select * into v_row from public.quotes where reference=trim(p_reference) and contact_phone=trim(p_phone) for update;
  if v_row.id is null then raise exception 'Request not found for the supplied details.' using errcode='P0002'; end if;
  if v_row.customer_id is not null and v_row.customer_id<>v_uid then raise exception 'This quotation is already linked to another account.' using errcode='42501'; end if;
  if v_row.customer_id is null then
    update public.quotes set customer_id=v_uid,updated_at=now() where id=v_row.id returning * into v_row;
    perform private.enqueue_user_notification(v_uid,'quote_claimed','Quotation linked','Quotation '||v_row.reference||' is now linked to your CKA account.',jsonb_build_object('quote_id',v_row.id,'reference',v_row.reference,'status',v_row.status),'customer:quote:claimed:'||v_row.id::text);
  end if;
  return v_row;
end;
$$;

create or replace function private.customer_claim_project(p_reference text,p_phone text)
returns public.projects language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_row public.projects;
begin
  if v_uid is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles p where p.id=v_uid and p.role='customer') then raise exception 'Only a customer account can claim a project.' using errcode='42501'; end if;
  if coalesce(trim(p_reference),'')='' or coalesce(trim(p_phone),'')='' then raise exception 'Reference and phone number are required.' using errcode='22023'; end if;
  perform private.assert_guest_tracking_rate('claim_project',p_reference,p_phone);
  select * into v_row from public.projects where reference=trim(p_reference) and phone=trim(p_phone) for update;
  if v_row.id is null then raise exception 'Request not found for the supplied details.' using errcode='P0002'; end if;
  if v_row.customer_id is not null and v_row.customer_id<>v_uid then raise exception 'This project is already linked to another account.' using errcode='42501'; end if;
  if v_row.customer_id is null then
    update public.projects set customer_id=v_uid,updated_at=now() where id=v_row.id returning * into v_row;
    perform private.enqueue_user_notification(v_uid,'project_claimed','Project linked','Project '||v_row.reference||' is now linked to your CKA account.',jsonb_build_object('project_id',v_row.id,'reference',v_row.reference,'status',v_row.status),'customer:project:claimed:'||v_row.id::text);
  end if;
  return v_row;
end;
$$;
grant execute on function private.customer_claim_quote(text,text) to authenticated;
grant execute on function private.customer_claim_project(text,text) to authenticated;

create or replace function public.customer_claim_quote(p_reference text,p_phone text)
returns public.quotes language sql security invoker set search_path=''
as $$select private.customer_claim_quote(p_reference,p_phone);$$;
create or replace function public.customer_claim_project(p_reference text,p_phone text)
returns public.projects language sql security invoker set search_path=''
as $$select private.customer_claim_project(p_reference,p_phone);$$;
revoke all on function public.customer_claim_quote(text,text) from public,anon;
revoke all on function public.customer_claim_project(text,text) from public,anon;
grant execute on function public.customer_claim_quote(text,text) to authenticated;
grant execute on function public.customer_claim_project(text,text) to authenticated;

create or replace function private.cleanup_guest_tracking_attempts()
returns bigint language plpgsql security definer set search_path=''
as $$
declare v_count bigint;
begin
  delete from private.guest_tracking_attempts where attempted_at<now()-interval '48 hours';
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

commit;
