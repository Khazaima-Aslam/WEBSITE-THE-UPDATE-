begin;

-- Keep automatically generated subtotal updates out of the human audit trail.
create or replace function private.audit_row_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id uuid;
begin
  if current_setting('cka.audit_suppress', true) = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id := nullif(v_old ->> 'id', '')::uuid;
  elsif tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_id := nullif(v_new ->> 'id', '')::uuid;
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_id := coalesce(nullif(v_new ->> 'id', '')::uuid, nullif(v_old ->> 'id', '')::uuid);
  end if;

  insert into public.admin_audit_log(actor_id, action, entity_type, entity_id, before_state, after_state)
  values (auth.uid(), tg_op, tg_table_name, v_id, v_old, v_new);

  return coalesce(new, old);
end;
$$;

create or replace function private.protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'admin'::public.user_role then
    if tg_op = 'DELETE' or new.role is distinct from 'admin'::public.user_role then
      if not exists (
        select 1 from public.profiles p
        where p.role = 'admin'::public.user_role and p.id <> old.id
      ) then
        raise exception 'The final administrator account cannot be demoted or deleted.' using errcode='23514';
      end if;
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_protect_last_admin_update on public.profiles;
create trigger trg_protect_last_admin_update before update of role on public.profiles
for each row execute function private.protect_last_admin();
drop trigger if exists trg_protect_last_admin_delete on public.profiles;
create trigger trg_protect_last_admin_delete before delete on public.profiles
for each row execute function private.protect_last_admin();

create or replace function private.validate_staff_assignment()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.assigned_to is not null and not exists (
    select 1 from public.profiles p
    where p.id=new.assigned_to and p.role in ('admin'::public.user_role,'staff'::public.user_role)
  ) then
    raise exception 'Assigned user must be an administrator or staff member.' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_quote_assignment on public.quotes;
create trigger trg_validate_quote_assignment before insert or update of assigned_to on public.quotes
for each row execute function private.validate_staff_assignment();
drop trigger if exists trg_validate_project_assignment on public.projects;
create trigger trg_validate_project_assignment before insert or update of assigned_to on public.projects
for each row execute function private.validate_staff_assignment();

create or replace function private.validate_quote_status_transition()
returns trigger language plpgsql set search_path=''
as $$
begin
  if old.status is not distinct from new.status then return new; end if;
  if not (
    (old.status='draft' and new.status in ('submitted','cancelled')) or
    (old.status='submitted' and new.status in ('bidding','quoted','confirmed','cancelled')) or
    (old.status='bidding' and new.status in ('quoted','confirmed','cancelled')) or
    (old.status='quoted' and new.status in ('bidding','confirmed','cancelled')) or
    (old.status='confirmed' and new.status in ('delivered','cancelled'))
  ) then
    raise exception 'Invalid quotation status transition: % -> %',old.status,new.status using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_quote_status_transition on public.quotes;
create trigger trg_validate_quote_status_transition before update of status on public.quotes
for each row execute function private.validate_quote_status_transition();

create or replace function private.validate_project_status_transition()
returns trigger language plpgsql set search_path=''
as $$
begin
  if old.status is distinct from new.status then
    if not (
      (old.status='received' and new.status in ('under_review','estimating','quoted','archived')) or
      (old.status='under_review' and new.status in ('estimating','quoted','archived')) or
      (old.status='estimating' and new.status in ('under_review','quoted','archived')) or
      (old.status='quoted' and new.status in ('estimating','awarded','archived')) or
      (old.status='awarded' and new.status in ('in_progress','archived')) or
      (old.status='in_progress' and new.status in ('completed','archived')) or
      (old.status='completed' and new.status='archived')
    ) then
      raise exception 'Invalid project status transition: % -> %',old.status,new.status using errcode='23514';
    end if;
  end if;
  if new.status='completed' then new.progress_pct:=100; end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_project_status_transition on public.projects;
create trigger trg_validate_project_status_transition before update of status,progress_pct on public.projects
for each row execute function private.validate_project_status_transition();

alter table public.quote_items add constraint quote_items_unit_price_nonnegative check(unit_price>=0) not valid;
alter table public.quote_items validate constraint quote_items_unit_price_nonnegative;
alter table public.quotes add constraint quotes_subtotal_nonnegative check(subtotal>=0) not valid;
alter table public.quotes validate constraint quotes_subtotal_nonnegative;
alter table public.projects
  add constraint projects_budget_min_nonnegative check(budget_min is null or budget_min>=0) not valid,
  add constraint projects_budget_max_nonnegative check(budget_max is null or budget_max>=0) not valid,
  add constraint projects_budget_ordered check(budget_min is null or budget_max is null or budget_min<=budget_max) not valid;
alter table public.projects validate constraint projects_budget_min_nonnegative;
alter table public.projects validate constraint projects_budget_max_nonnegative;
alter table public.projects validate constraint projects_budget_ordered;

create or replace function private.recalculate_quote_subtotal()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_prev text:=current_setting('cka.audit_suppress',true); v_quote_id uuid;
begin
  perform set_config('cka.audit_suppress','on',true);
  if tg_op in ('INSERT','UPDATE') then
    v_quote_id:=new.quote_id;
    update public.quotes q set subtotal=coalesce((select sum(i.line_total) from public.quote_items i where i.quote_id=v_quote_id),0),updated_at=now() where q.id=v_quote_id;
  end if;
  if tg_op in ('DELETE','UPDATE') and (tg_op='DELETE' or old.quote_id is distinct from new.quote_id) then
    v_quote_id:=old.quote_id;
    update public.quotes q set subtotal=coalesce((select sum(i.line_total) from public.quote_items i where i.quote_id=v_quote_id),0),updated_at=now() where q.id=v_quote_id;
  end if;
  perform set_config('cka.audit_suppress',coalesce(v_prev,''),true);
  return coalesce(new,old);
end;
$$;
drop trigger if exists trg_recalculate_quote_subtotal on public.quote_items;
create trigger trg_recalculate_quote_subtotal after insert or update or delete on public.quote_items
for each row execute function private.recalculate_quote_subtotal();

create or replace function private.validate_supplier_profile_link()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_profile_id uuid;
begin
  if tg_table_name='suppliers' then v_profile_id:=coalesce(new.profile_id,old.profile_id); else v_profile_id:=coalesce(new.id,old.id); end if;
  if v_profile_id is not null
    and exists(select 1 from public.suppliers s where s.profile_id=v_profile_id)
    and not exists(select 1 from public.profiles p where p.id=v_profile_id and p.role='supplier') then
    raise exception 'A supplier-linked profile must have the supplier role.' using errcode='23514';
  end if;
  return coalesce(new,old);
end;
$$;
drop trigger if exists trg_validate_supplier_profile_link_supplier on public.suppliers;
create constraint trigger trg_validate_supplier_profile_link_supplier after insert or update of profile_id on public.suppliers
deferrable initially deferred for each row execute function private.validate_supplier_profile_link();
drop trigger if exists trg_validate_supplier_profile_link_profile on public.profiles;
create constraint trigger trg_validate_supplier_profile_link_profile after update of role on public.profiles
deferrable initially deferred for each row execute function private.validate_supplier_profile_link();

create or replace function public.admin_link_supplier_account(p_supplier_id uuid,p_profile_id uuid)
returns public.suppliers language plpgsql set search_path=public,private,pg_temp
as $$
declare v_supplier public.suppliers; v_profile public.profiles;
begin
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  select * into v_profile from public.profiles where id=p_profile_id for update;
  if v_profile.id is null then raise exception 'Profile not found.' using errcode='P0002'; end if;
  if v_profile.role in ('admin','staff') then raise exception 'Administrator/staff accounts cannot be converted into supplier accounts. Use a dedicated supplier login.' using errcode='23514'; end if;
  select * into v_supplier from public.suppliers where id=p_supplier_id for update;
  if v_supplier.id is null then raise exception 'Supplier not found.' using errcode='P0002'; end if;
  if not v_supplier.is_verified then raise exception 'Only a verified supplier can be linked to a supplier login.' using errcode='23514'; end if;
  if v_supplier.profile_id is not null and v_supplier.profile_id<>p_profile_id then raise exception 'This supplier is already linked to another login.' using errcode='23505'; end if;
  if exists(select 1 from public.suppliers where profile_id=p_profile_id and id<>p_supplier_id) then raise exception 'This login is already linked to another supplier.' using errcode='23505'; end if;
  update public.suppliers set profile_id=p_profile_id,updated_at=now() where id=p_supplier_id returning * into v_supplier;
  update public.profiles set role='supplier' where id=p_profile_id;
  return v_supplier;
end;
$$;
revoke all on function public.admin_link_supplier_account(uuid,uuid) from public,anon;
grant execute on function public.admin_link_supplier_account(uuid,uuid) to authenticated;

create or replace function public.admin_unlink_supplier_account(p_supplier_id uuid)
returns public.suppliers language plpgsql set search_path=public,private,pg_temp
as $$
declare v_supplier public.suppliers; v_profile_id uuid;
begin
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  select * into v_supplier from public.suppliers where id=p_supplier_id for update;
  if v_supplier.id is null then raise exception 'Supplier not found.' using errcode='P0002'; end if;
  v_profile_id:=v_supplier.profile_id;
  update public.suppliers set profile_id=null,updated_at=now() where id=p_supplier_id returning * into v_supplier;
  if v_profile_id is not null then update public.profiles set role='customer' where id=v_profile_id and role='supplier'; end if;
  return v_supplier;
end;
$$;
revoke all on function public.admin_unlink_supplier_account(uuid) from public,anon;
grant execute on function public.admin_unlink_supplier_account(uuid) to authenticated;

create or replace function public.staff_assign_quote(p_quote_id uuid,p_assigned_to uuid)
returns public.quotes language plpgsql set search_path=public,private,pg_temp
as $$
declare v_row public.quotes;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  update public.quotes set assigned_to=p_assigned_to,updated_at=now() where id=p_quote_id returning * into v_row;
  if v_row.id is null then raise exception 'Quote not found.' using errcode='P0002'; end if;
  return v_row;
end;
$$;
revoke all on function public.staff_assign_quote(uuid,uuid) from public,anon;
grant execute on function public.staff_assign_quote(uuid,uuid) to authenticated;

create or replace function public.staff_assign_project(p_project_id uuid,p_assigned_to uuid)
returns public.projects language plpgsql set search_path=public,private,pg_temp
as $$
declare v_row public.projects;
begin
  if not private.is_staff() then raise exception 'Staff access required.' using errcode='42501'; end if;
  update public.projects set assigned_to=p_assigned_to,updated_at=now() where id=p_project_id returning * into v_row;
  if v_row.id is null then raise exception 'Project not found.' using errcode='P0002'; end if;
  return v_row;
end;
$$;
revoke all on function public.staff_assign_project(uuid,uuid) from public,anon;
grant execute on function public.staff_assign_project(uuid,uuid) to authenticated;

commit;
