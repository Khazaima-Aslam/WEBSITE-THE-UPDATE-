begin;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

grant select,update on public.notification_outbox to service_role;

create or replace function public.system_claim_outbox_batch(p_limit integer default 50)
returns setof public.notification_outbox
language plpgsql security invoker set search_path=''
as $$
declare v_limit integer:=greatest(1,least(coalesce(p_limit,50),200));
begin
  return query
  with picked as (
    select o.id from public.notification_outbox o
    where o.status in ('pending','failed') and o.available_at<=now()
    order by o.available_at,o.created_at
    for update skip locked
    limit v_limit
  )
  update public.notification_outbox o
  set status='processing',attempts=o.attempts+1,last_error=null,updated_at=now()
  from picked p where o.id=p.id returning o.*;
end;
$$;
revoke all on function public.system_claim_outbox_batch(integer) from public,anon,authenticated;
grant execute on function public.system_claim_outbox_batch(integer) to service_role;

create or replace function public.system_mark_outbox_sent(p_outbox_id uuid)
returns boolean language plpgsql security invoker set search_path=''
as $$
declare v_count integer;
begin
  update public.notification_outbox
  set status='sent',processed_at=now(),last_error=null,updated_at=now()
  where id=p_outbox_id and status='processing';
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.system_mark_outbox_sent(uuid) from public,anon,authenticated;
grant execute on function public.system_mark_outbox_sent(uuid) to service_role;

create or replace function public.system_mark_outbox_failed(p_outbox_id uuid,p_error text,p_retry_seconds integer default 300)
returns boolean language plpgsql security invoker set search_path=''
as $$
declare v_count integer; v_delay integer:=greatest(30,least(coalesce(p_retry_seconds,300),86400));
begin
  update public.notification_outbox
  set status='failed',last_error=left(coalesce(p_error,'Delivery failed'),4000),
      available_at=now()+make_interval(secs=>v_delay),processed_at=null,updated_at=now()
  where id=p_outbox_id and status='processing';
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.system_mark_outbox_failed(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.system_mark_outbox_failed(uuid,text,integer) to service_role;

create or replace function private.cleanup_backend_ephemera()
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_tracking bigint; v_idem bigint; v_stale bigint;
begin
  update public.notification_outbox
  set status='failed',last_error=coalesce(last_error,'Recovered stale processing lease'),available_at=now(),updated_at=now()
  where status='processing' and updated_at<now()-interval '20 minutes';
  get diagnostics v_stale=row_count;
  delete from private.guest_tracking_attempts where attempted_at<now()-interval '48 hours'; get diagnostics v_tracking=row_count;
  delete from private.submission_idempotency where created_at<now()-interval '24 hours'; get diagnostics v_idem=row_count;
  return jsonb_build_object('stale_outbox_recovered',v_stale,'guest_tracking_deleted',v_tracking,'idempotency_deleted',v_idem);
end;
$$;

do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname in ('cka-backend-ephemera-cleanup','cka-cron-history-cleanup') loop
    perform cron.unschedule(r.jobid);
  end loop;
  perform cron.schedule('cka-backend-ephemera-cleanup','17 3 * * *','select private.cleanup_backend_ephemera();');
  perform cron.schedule('cka-cron-history-cleanup','37 3 * * 0',$cmd$delete from cron.job_run_details where start_time < now() - interval '30 days';$cmd$);
end $$;

commit;
