-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-edit-request.sql
--
--  Run once, after the earlier migrations.
--
--  Lets the person who sent a request change it afterwards: add the
--  detail they forgot, or raise the urgency because the situation got
--  worse. Only with the unguessable token handed back at creation, and
--  only while Haitham has not started yet - once he is on his way, the
--  request he is looking at must not change under him.
-- =====================================================================

begin;

create or replace function public.update_request_by_token(
  p_token       uuid,
  p_description text default null,
  p_priority    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row  public.service_requests;
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
begin
  select * into v_row from public.service_requests where public_token = p_token for update;
  if v_row is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  -- Pending only. Accepted means he has already planned around it.
  if v_row.status <> 'pending' then
    raise exception 'This request can no longer be changed' using errcode = '42501';
  end if;

  if p_priority is not null and p_priority not in ('normal', 'urgent', 'very_urgent') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;
  if v_desc is not null and char_length(v_desc) > 1000 then
    raise exception 'Please shorten the description' using errcode = '22023';
  end if;

  update public.service_requests
     set description = coalesce(v_desc, description),
         priority    = coalesce(p_priority, priority)
   where id = v_row.id
  returning * into v_row;

  -- Worth recording: a request that quietly became "very urgent" after
  -- the fact should be visible in its own history.
  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, null, 'pending', 'pending',
          'Updated by the requester (priority: ' || v_row.priority || ')');

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'description',    v_row.description,
    'priority',       v_row.priority,
    'status',         v_row.status
  );
end;
$fn$;

revoke all on function public.update_request_by_token(uuid, text, text) from public;
grant execute on function public.update_request_by_token(uuid, text, text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
