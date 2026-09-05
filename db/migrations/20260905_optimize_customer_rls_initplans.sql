-- CKA BuildStruct — verified customer RLS initialization optimization
-- Applied to Supabase project qrjglihvjhhemqoegqmt on 2026-09-05.

begin;

drop policy if exists "own quotes" on public.quotes;
create policy "own quotes"
on public.quotes for select
to public
using (customer_id = (select auth.uid()) or public.is_staff());

drop policy if exists "own projects" on public.projects;
create policy "own projects"
on public.projects for select
to public
using (customer_id = (select auth.uid()) or public.is_staff());

drop policy if exists "read own quote items" on public.quote_items;
create policy "read own quote items"
on public.quote_items for select
to public
using (
  exists (
    select 1
    from public.quotes q
    where q.id = quote_items.quote_id
      and (q.customer_id = (select auth.uid()) or public.is_staff())
  )
);

drop policy if exists "read own project files" on public.project_files;
create policy "read own project files"
on public.project_files for select
to public
using (
  public.is_staff()
  or exists (
    select 1 from public.projects p
    where p.id = project_files.project_id
      and p.customer_id = (select auth.uid())
  )
  or exists (
    select 1 from public.quotes q
    where q.id = project_files.quote_id
      and q.customer_id = (select auth.uid())
  )
);

drop policy if exists "insert own project files" on public.project_files;
create policy "insert own project files"
on public.project_files for insert
to public
with check (
  (select auth.uid()) is not null
  and uploaded_by = (select auth.uid())
  and (
    public.is_staff()
    or exists (
      select 1 from public.projects p
      where p.id = project_files.project_id
        and p.customer_id = (select auth.uid())
    )
    or exists (
      select 1 from public.quotes q
      where q.id = project_files.quote_id
        and q.customer_id = (select auth.uid())
    )
  )
);

commit;
