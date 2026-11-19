-- Получатели уведомлений: один список вместо «Telegram в профиле» и «чат фирмы».
create table public.notify_targets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 60),
  channel text not null default 'telegram' check (channel in ('telegram')),
  address text not null check (address ~ '^-?\d{5,15}$'),
  scope text not null default 'all' check (scope in ('all', 'group', 'firms')),
  group_key text check (group_key is null or char_length(group_key) <= 80),
  company_ids uuid[] not null default '{}',
  mode text not null default 'now' check (mode in ('now', 'important', 'none')),
  morning time,
  evening time,
  enabled boolean not null default true,
  last_morning date,
  last_evening date,
  created_at timestamptz not null default now()
);
create index notify_targets_owner on public.notify_targets (owner_id);
alter table public.notify_targets enable row level security;
create policy notify_targets_own on public.notify_targets for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.notify_targets from anon;
grant select, insert, update, delete on public.notify_targets to authenticated;

-- фирмы получателя: только те, где его хозяин состоит сейчас; группа считается заново при каждой отправке
create or replace function private.notify_target_firms(t public.notify_targets) returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(c.id), '{}'::uuid[])
  from public.memberships m
  join public.companies c on c.id = m.company_id and c.archived_at is null
  where m.user_id = t.owner_id and (
    t.scope = 'all'
    or (t.scope = 'firms' and c.id = any(t.company_ids))
    or (t.scope = 'group' and case
      when t.group_key like 'c:%' then exists (
        select 1 from public.profiles p,
          jsonb_array_elements(case when jsonb_typeof(p.ui_prefs->'fgroups') = 'array' then p.ui_prefs->'fgroups' else '[]'::jsonb end) g
        where p.id = t.owner_id and g->>'id' = substr(t.group_key, 3) and jsonb_typeof(g->'ids') = 'array' and (g->'ids') ? c.id::text)
      when t.group_key = 'a:vat' then c.vat_payer is true
      when t.group_key = 'a:emp' then c.has_employees is true
      when t.group_key = 'a:susp' then coalesce(c.reports_suspended, false) and (c.reports_suspended_until is null or c.reports_suspended_until >= (now() at time zone 'Asia/Almaty')::date)
      when t.group_key in ('a:too', 'a:ip') then (t.group_key = 'a:too') = (
        case when coalesce(c.name, '') ~* '^\s*(ип|индивидуальн)' or coalesce(c.full_name, '') ~* '^\s*индивидуальн' then false
             when coalesce(c.name, '') ~* '^\s*(тоо|ао|товарищ|акционер)' then true
             else coalesce(c.bin, '') ~ '^\d{4}[456]' end)
      when t.group_key like 't:%' then substr(t.group_key, 3) = any(coalesce(c.tags, '{}'::text[]))
      else false end)
  )
$$;
revoke all on function private.notify_target_firms(public.notify_targets) from public, anon, authenticated;

-- кому слать новое сообщение робота прямо сейчас (вызывает функция tg-send)
create or replace function public.notify_event_targets(p_event uuid) returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(distinct t.address), '[]'::jsonb)
  from public.events e
  join public.memberships m on m.company_id = e.company_id
  join public.notify_targets t on t.owner_id = m.user_id and t.enabled and t.channel = 'telegram'
    and (t.mode = 'now' or (t.mode = 'important' and e.severity::text = 'critical'))
  join public.profiles p on p.id = t.owner_id and p.blocked_at is null and p.archived_at is null
  where e.id = p_event
    and (m.role::text = 'owner' or m.robot_ids is null or e.robot_id is null or e.robot_id = any(m.robot_ids))
    and e.company_id = any(private.notify_target_firms(t))
$$;
revoke all on function public.notify_event_targets(uuid) from public, anon, authenticated;
grant execute on function public.notify_event_targets(uuid) to service_role;

-- данные для сводки: утром — что требует внимания, вечером — что сделано за день
create or replace function public.notify_digest_data(p_target uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare t public.notify_targets; f uuid[]; d date := (now() at time zone 'Asia/Almaty')::date;
  d0 timestamptz := (d::timestamp at time zone 'Asia/Almaty'); mine boolean; res jsonb; v jsonb;
begin
  select * into t from public.notify_targets where id = p_target;
  if not found or not t.enabled then return null; end if;
  if exists (select 1 from public.profiles p where p.id = t.owner_id and (p.blocked_at is not null or p.archived_at is not null)) then return null; end if;
  f := private.notify_target_firms(t);
  mine := exists (select 1 from public.profiles p where p.id = t.owner_id and btrim(coalesce(p.telegram_chat_id, '')) = t.address);
  res := jsonb_build_object('address', t.address, 'kind', p_kind, 'date', d, 'firms', coalesce(array_length(f, 1), 0), 'mine', mine);
  if coalesce(array_length(f, 1), 0) = 0 then return res; end if;

  -- неотработанные отчёты роботов по фирмам (только роботы, которые хозяину получателя доступны)
  select coalesce(jsonb_agg(x order by (x->>'crit')::int desc, (x->>'n')::int desc, x->>'name'), '[]'::jsonb) into v from (
    select jsonb_build_object('id', c.id, 'name', c.name, 'n', count(*), 'crit', count(*) filter (where e.severity::text = 'critical'),
      'titles', (array_agg(e.title order by (e.severity::text = 'critical') desc, e.created_at desc))[1:3]) x
    from public.events e
    join public.companies c on c.id = e.company_id
    join public.memberships m on m.company_id = e.company_id and m.user_id = t.owner_id
    where e.company_id = any(f) and e.status::text = 'new' and e.superseded_at is null and e.robot_id is not null
      and (m.role::text = 'owner' or m.robot_ids is null or e.robot_id = any(m.robot_ids))
    group by c.id, c.name) q;
  res := res || jsonb_build_object('open', v);

  if p_kind = 'morning' then
    select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'until', c.eds_valid_until) order by c.eds_valid_until), '[]'::jsonb) into v
    from public.companies c where c.id = any(f) and c.eds_valid_until is not null and c.eds_valid_until <= d + 14;
    res := res || jsonb_build_object('eds', v);
    if mine then
      -- отчётность к сдаче считается правами хозяина получателя
      perform set_config('request.jwt.claims', json_build_object('sub', t.owner_id, 'role', 'authenticated')::text, true);
      select coalesce(jsonb_agg(jsonb_build_object('title', a->>'title', 'name', i->>'name', 'due', i->>'due') order by i->>'due', a->>'title', i->>'name'), '[]'::jsonb) into v
      from jsonb_array_elements(coalesce(public.my_auto_tasks(), '[]'::jsonb)) a, jsonb_array_elements(coalesce(a->'items', '[]'::jsonb)) i
      where not coalesce((i->>'done')::boolean, false) and (i->>'due') is not null and (i->>'due')::date <= d + 3
        and ((i->>'company_id') is null or (i->>'company_id')::uuid = any(f));
      res := res || jsonb_build_object('due', v);
      select coalesce(jsonb_agg(jsonb_build_object('title', u.title, 'due', u.due_date) order by u.due_date), '[]'::jsonb) into v
      from public.user_tasks u where u.assignee_id = t.owner_id and u.status <> 'done' and u.due_date is not null and u.due_date <= d;
      res := res || jsonb_build_object('tasks', v);
    end if;
  else
    -- что сегодня проверили роботы
    select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v from (
      select jsonb_build_object('name', r.name, 'firms', count(distinct e.company_id), 'attn', count(distinct e.company_id) filter (where e.severity::text <> 'info')) x
      from public.events e
      join public.robots r on r.id = e.robot_id
      join public.memberships m on m.company_id = e.company_id and m.user_id = t.owner_id
      where e.company_id = any(f) and e.created_at >= d0
        and (m.role::text = 'owner' or m.robot_ids is null or e.robot_id = any(m.robot_ids))
      group by r.id, r.name) q;
    res := res || jsonb_build_object('robots', v);
    select to_jsonb(count(*)) into v from public.robot_runs rr where rr.created_at >= d0 and rr.status = 'error' and rr.company_ids && f;
    res := res || jsonb_build_object('run_errors', v);
    -- кто что сделал
    select coalesce(jsonb_agg(x order by ((x->>'marks')::int + (x->>'done')::int + (x->>'runs')::int) desc), '[]'::jsonb) into v from (
      select jsonb_build_object('name', coalesce(nullif(btrim(p.full_name), ''), 'Без имени'),
        'marks', count(*) filter (where a.kind = 'mark'), 'done', count(*) filter (where a.kind = 'done'),
        'runs', count(*) filter (where a.kind = 'run'), 'seen', count(*) filter (where a.kind = 'seen')) x
      from public.activity_log a join public.profiles p on p.id = a.actor
      where a.at >= d0 and a.company_id = any(f) and a.kind in ('mark', 'done', 'run', 'seen')
      group by p.id, p.full_name) q;
    res := res || jsonb_build_object('people', v);
    if mine then
      select coalesce(jsonb_agg(jsonb_build_object('title', u.title) order by u.done_at), '[]'::jsonb) into v
      from public.user_tasks u where u.status = 'done' and u.done_at >= d0 and (u.assignee_id = t.owner_id or u.created_by = t.owner_id);
      res := res || jsonb_build_object('tasks_done', v);
    end if;
  end if;
  return res;
end $$;
revoke all on function public.notify_digest_data(uuid, text) from public, anon, authenticated;
grant execute on function public.notify_digest_data(uuid, text) to service_role;

-- раз в 10 минут: у кого подошло время сводки — попросить tg-send собрать и отправить (один раз в день на каждую)
create or replace function private.notify_digest_kick() returns int
language plpgsql security definer set search_path to '' as $$
declare nowl timestamp := now() at time zone 'Asia/Almaty'; d date := nowl::date; tm time := nowl::time; r record; v_key text; n int := 0;
begin
  select v into v_key from private.settings where k = 'server_robot_key';
  for r in update public.notify_targets set last_morning = d
    where enabled and morning is not null and tm >= morning and (tm - morning) < interval '3 hours' and (last_morning is null or last_morning < d) returning id loop
    perform net.http_post(url := 'https://tmmzufjavpczqgyxbgeh.supabase.co/functions/v1/tg-send',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-server-key', v_key),
      body := jsonb_build_object('digest', r.id, 'kind', 'morning'), timeout_milliseconds := 20000);
    n := n + 1;
  end loop;
  for r in update public.notify_targets set last_evening = d
    where enabled and evening is not null and tm >= evening and (tm - evening) < interval '3 hours' and (last_evening is null or last_evening < d) returning id loop
    perform net.http_post(url := 'https://tmmzufjavpczqgyxbgeh.supabase.co/functions/v1/tg-send',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-server-key', v_key),
      body := jsonb_build_object('digest', r.id, 'kind', 'evening'), timeout_milliseconds := 20000);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function private.notify_digest_kick() from public, anon, authenticated;

-- перенос нынешних настроек: личный Telegram — как было; чаты фирм — выключенными (галочки и были выключены)
insert into public.notify_targets (owner_id, title, address, scope, mode, enabled)
select p.id, 'Мой Telegram', btrim(p.telegram_chat_id), 'all', 'now', coalesce(p.telegram_notify, false)
from public.profiles p where btrim(coalesce(p.telegram_chat_id, '')) ~ '^-?\d{5,15}$';
insert into public.notify_targets (owner_id, title, address, scope, company_ids, mode, enabled)
select c.owner_id, 'Чат фирм (перенесён из профилей фирм)', btrim(c.telegram_chat_id), 'firms', array_agg(c.id), 'now', bool_or(coalesce(c.telegram_notify, false))
from public.companies c
where c.archived_at is null and c.owner_id is not null and btrim(coalesce(c.telegram_chat_id, '')) ~ '^-?\d{5,15}$'
  and not exists (select 1 from public.notify_targets t where t.owner_id = c.owner_id and t.address = btrim(c.telegram_chat_id))
group by c.owner_id, btrim(c.telegram_chat_id);

-- новое сообщение робота будит tg-send, только если у кого-то из людей фирмы есть включённый получатель
create or replace function private.tg_notify_kick() returns trigger
language plpgsql security definer set search_path to '' as $function$
declare v_key text; v_cd date;
begin
  if new.robot_id is null or new.status <> 'new' then return new; end if;
  if exists (select 1 from public.robots r where r.id = new.robot_id and r.code = 'kn_monitoring') then
    v_cd := private.kn_cycle_day(new.company_id);
    if v_cd is not null
       and exists (select 1 from public.kn_cycle k where k.company_id = new.company_id and k.week = v_cd and k.notified_at is null)
       and not coalesce((public.kn_plan(new.company_id, false)->>'done')::boolean, false) then
      return new;
    end if;
  end if;
  if not exists (select 1 from public.memberships m join public.notify_targets t on t.owner_id = m.user_id
                 where m.company_id = new.company_id and t.enabled and t.mode <> 'none') then return new; end if;
  select v into v_key from private.settings where k = 'server_robot_key';
  perform net.http_post(
    url := 'https://tmmzufjavpczqgyxbgeh.supabase.co/functions/v1/tg-send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-server-key', v_key),
    body := jsonb_build_object('event_id', new.id),
    timeout_milliseconds := 5000);
  return new;
end $function$;

select cron.schedule('notify-digest', '*/10 * * * *', 'select private.notify_digest_kick()');
