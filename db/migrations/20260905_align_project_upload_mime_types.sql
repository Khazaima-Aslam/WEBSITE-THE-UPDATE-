-- CKA BuildStruct — align project upload MIME types with the public form
-- Applied to Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.

begin;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf','text/csv','image/jpeg','image/png','image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/acad','application/x-acad','application/autocad_dwg',
  'application/dwg','application/x-dwg','image/vnd.dwg','application/dxf',
  'application/octet-stream','application/zip','application/x-zip-compressed'
]::text[]
where id='project-uploads';

create or replace function public.submit_project_with_file(
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
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference text;
  v_project_id uuid;
  v_kind public.file_kind;
  v_object_exists boolean;
begin
  v_reference := public.submit_project(
    p_client_name, p_phone, p_email, p_company, p_project_name,
    p_project_type, p_location, p_budget_min, p_budget_max,
    p_expected_completion, p_scope
  );

  if nullif(trim(coalesce(p_file_path,'')), '') is null then
    return v_reference;
  end if;

  if p_file_path !~ '^projects/[0-9a-fA-F-]{36}-[^/]+$' then
    raise exception 'Invalid project upload path.' using errcode='22023';
  end if;
  if coalesce(length(p_file_name),0) < 1 or length(p_file_name) > 255 then
    raise exception 'Invalid project upload file name.' using errcode='22023';
  end if;
  if p_file_size is null or p_file_size < 1 or p_file_size > 10485760 then
    raise exception 'Project upload must be between 1 byte and 10 MB.' using errcode='22023';
  end if;
  if coalesce(p_file_mime,'') not in (
    'application/pdf','text/csv','application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip','application/x-zip-compressed',
    'image/jpeg','image/png','image/webp','application/octet-stream',
    'image/vnd.dwg','application/acad','application/x-acad',
    'application/autocad_dwg','application/dwg','application/x-dwg','application/dxf'
  ) then
    raise exception 'Unsupported project upload type.' using errcode='22023';
  end if;

  select exists (
    select 1 from storage.objects o
    where o.bucket_id='project-uploads'
      and o.name=p_file_path
      and o.created_at > now() - interval '1 hour'
  ) into v_object_exists;
  if not v_object_exists then
    raise exception 'Uploaded project file was not found.' using errcode='23503';
  end if;

  if exists (
    select 1 from public.project_files pf
    where pf.storage_bucket='project-uploads' and pf.storage_path=p_file_path
  ) then
    raise exception 'This uploaded file is already attached to a project.' using errcode='23505';
  end if;

  select p.id into v_project_id from public.projects p where p.reference=v_reference;

  v_kind := case
    when p_file_name ~* '\.dwg$' then 'drawing_dwg'::public.file_kind
    when p_file_name ~* '\.pdf$' then 'drawing_pdf'::public.file_kind
    when coalesce(p_file_mime,'') like 'image/%' then 'image'::public.file_kind
    when p_file_name ~* '\.zip$' then 'archive'::public.file_kind
    when p_file_name ~* '\.(xls|xlsx|csv)$' then 'boq'::public.file_kind
    else 'document'::public.file_kind
  end;

  insert into public.project_files(
    project_id, kind, original_name, storage_bucket, storage_path,
    mime_type, size_bytes, uploaded_by
  ) values (
    v_project_id, v_kind, trim(p_file_name), 'project-uploads', trim(p_file_path),
    nullif(trim(coalesce(p_file_mime,'')), ''), p_file_size, auth.uid()
  );

  return v_reference;
end;
$$;

commit;
