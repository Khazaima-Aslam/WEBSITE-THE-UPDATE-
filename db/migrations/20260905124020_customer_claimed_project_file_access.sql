begin;

drop policy if exists "project uploads read own or staff" on storage.objects;
create policy "project uploads read own staff or linked customer"
on storage.objects for select
to authenticated
using (
  bucket_id = 'project-uploads'
  and (
    owner_id = auth.uid()::text
    or (storage.foldername(name))[1] = auth.uid()::text
    or public.is_staff()
    or exists (
      select 1
      from public.project_files pf
      left join public.projects p on p.id = pf.project_id
      left join public.quotes q on q.id = pf.quote_id
      where pf.storage_bucket = 'project-uploads'
        and pf.storage_path = storage.objects.name
        and (p.customer_id = auth.uid() or q.customer_id = auth.uid())
    )
  )
);

commit;
