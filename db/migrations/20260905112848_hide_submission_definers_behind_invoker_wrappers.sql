-- CKA BuildStruct backend completion
-- Applied to live Supabase: 2026-09-05 11:28:48 UTC
-- Keeps browser RPC names stable while moving privileged implementations into
-- the non-exposed private schema. Public endpoints are SECURITY INVOKER.

begin;

alter function public.submit_inquiry(text,text,text,text,text,text) set schema private;
alter function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) set schema private;
alter function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) set schema private;
alter function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) set schema private;
alter function public.submit_supplier_application(text,text,text,text,text,text,text) set schema private;
alter function public.subscribe_rate_list(text) set schema private;

revoke all on function private.submit_inquiry(text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function private.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) from public, anon, authenticated;
revoke all on function private.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) from public, anon, authenticated;
revoke all on function private.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) from public, anon, authenticated;
revoke all on function private.submit_supplier_application(text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function private.subscribe_rate_list(text) from public, anon, authenticated;

grant usage on schema private to anon, authenticated;
grant execute on function private.submit_inquiry(text,text,text,text,text,text) to anon, authenticated;
grant execute on function private.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) to anon, authenticated;
grant execute on function private.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) to anon, authenticated;
grant execute on function private.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) to anon, authenticated;
grant execute on function private.submit_supplier_application(text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function private.subscribe_rate_list(text) to anon, authenticated;

create function public.submit_inquiry(
  p_name text,
  p_message text,
  p_email text default null,
  p_phone text default null,
  p_subject text default null,
  p_source text default 'contact_form'
)
returns boolean
language sql
security invoker
set search_path = private, public, pg_temp
as $$
  select private.submit_inquiry(p_name,p_message,p_email,p_phone,p_subject,p_source);
$$;

create function public.submit_project(
  p_client_name text,
  p_phone text,
  p_email text default null,
  p_company text default null,
  p_project_name text default null,
  p_project_type text default null,
  p_location text default null,
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_expected_completion date default null,
  p_scope text default null
)
returns text
language sql
security invoker
set search_path = private, public, pg_temp
as $$
  select private.submit_project(p_client_name,p_phone,p_email,p_company,p_project_name,p_project_type,p_location,p_budget_min,p_budget_max,p_expected_completion,p_scope);
$$;

create function public.submit_project_with_file(
  p_client_name text,
  p_phone text,
  p_email text default null,
  p_company text default null,
  p_project_name text default null,
  p_project_type text default null,
  p_location text default null,
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_expected_completion date default null,
  p_scope text default null,
  p_file_path text default null,
  p_file_name text default null,
  p_file_mime text default null,
  p_file_size bigint default null
)
returns text
language sql
security invoker
set search_path = private, public, pg_temp
as $$
  select private.submit_project_with_file(p_client_name,p_phone,p_email,p_company,p_project_name,p_project_type,p_location,p_budget_min,p_budget_max,p_expected_completion,p_scope,p_file_path,p_file_name,p_file_mime,p_file_size);
$$;

create function public.submit_quote(
  p_contact_name text,
  p_contact_phone text,
  p_items jsonb,
  p_contact_email text default null,
  p_delivery_city text default null,
  p_delivery_address text default null,
  p_payment_pref public.payment_pref default null,
  p_notes text default null
)
returns text
language sql
security invoker
set search_path = private, public, pg_temp
as $$
  select private.submit_quote(p_contact_name,p_contact_phone,p_items,p_contact_email,p_delivery_city,p_delivery_address,p_payment_pref,p_notes);
$$;

create function public.submit_supplier_application(
  p_business_name text,
  p_contact_person text,
  p_phone text,
  p_email text default null,
  p_city text default null,
  p_category text default null,
  p_business_details text default null
)
returns text
language sql
security invoker
set search_path = private, public, pg_temp
as $$
  select private.submit_supplier_application(p_business_name,p_contact_person,p_phone,p_email,p_city,p_category,p_business_details);
$$;

create function public.subscribe_rate_list(p_email text)
returns boolean
language sql
security invoker
set search_path = private, public, pg_temp
as $$ select private.subscribe_rate_list(p_email); $$;

revoke execute on function public.submit_inquiry(text,text,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) from public, anon, authenticated;
revoke execute on function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) from public, anon, authenticated;
revoke execute on function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) from public, anon, authenticated;
revoke execute on function public.submit_supplier_application(text,text,text,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.subscribe_rate_list(text) from public, anon, authenticated;

grant execute on function public.submit_inquiry(text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.submit_project(text,text,text,text,text,text,text,numeric,numeric,date,text) to anon, authenticated;
grant execute on function public.submit_project_with_file(text,text,text,text,text,text,text,numeric,numeric,date,text,text,text,text,bigint) to anon, authenticated;
grant execute on function public.submit_quote(text,text,jsonb,text,text,text,public.payment_pref,text) to anon, authenticated;
grant execute on function public.submit_supplier_application(text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.subscribe_rate_list(text) to anon, authenticated;

commit;
