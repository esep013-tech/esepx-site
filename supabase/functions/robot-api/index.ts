// API для роботов ESEP (UiPath и др.). Заголовок: x-robot-key
// jobs        {robot}                       -> фирмы, где робот готов к работе
// run_take    {robot, run_id?}              -> задание: дата проверки + фирмы (из очереди или плановое на все фирмы)
// run_finish  {robot, run_id, status, note} -> закрыть задание (done | error)
// event       {robot, bin|company_id, title, body, severity, file_url?, run_id?, table?, quiet?} -> сообщение в кабинет
//             quiet=true -> отчёт «для сведения»: сразу «выполнено», не попадает в счётчик новых (v8)
// status      {robot, bin|company_id, key, label, at?} -> тихая отметка у фирмы (без уведомлений), новая заменяет старую.
// eds         {robot, bin|company_id, valid_until:'yyyy-mm-dd'} -> срок действия ЭЦП в профиль фирмы (только робот может менять)
//             Фирмы нет в кабинете / БИН не 12 цифр -> {ok:true, updated:0} (робот не падает)
// error       {robot, text, bin|company_id?, firm?} -> ошибка во вкладку «Ошибки» (для роботов без run_take). Фирма не обязательна.
// Длинные формы собственности из 1С (Товарищество с ограниченной ответственностью...) сокращаются: ТОО, ИП, АО...
// v11: робот с robots.executor='server' работает на сервере кабинета — run_take/jobs для UiPath возвращают пустой список.
// v13: фирмы в архиве (companies.archived_at) роботы не видят; по БИН — только действующие фирмы,
//      а если таких несколько — та, где подключён этот робот.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { shortForms, shortDeep } from './short.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function lastDayPrevMonth(): string {
  const now = new Date(Date.now() + 5 * 3600e3);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

async function activeCompanies(robotId: string, only?: string[]) {
  let q = db.from('company_robots').select('company_id,is_trial,trial_until,companies!inner(name,full_name,bin,archived_at)')
    .eq('robot_id', robotId).eq('status', 'active').eq('enabled', true).is('companies.archived_at', null);
  if (only) q = q.in('company_id', only);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const now = Date.now();
  return (data ?? [])
    .filter((r: any) => !r.is_trial || !r.trial_until || Date.parse(r.trial_until) > now)
    .map((r: any) => ({ company_id: r.company_id, name: r.companies?.name, full_name: r.companies?.full_name, bin: r.companies?.bin, is_trial: r.is_trial, trial_until: r.trial_until }));
}

// действующие фирмы по БИН; если их несколько — оставляем те, где подключён этот робот
async function byBin(bin: string, robotId: string): Promise<string[]> {
  const { data: c } = await db.from('companies').select('id').eq('bin', bin).is('archived_at', null);
  const ids = (c ?? []).map((x: any) => x.id);
  if (ids.length < 2) return ids;
  const { data: l } = await db.from('company_robots').select('company_id').eq('robot_id', robotId).eq('status', 'active').in('company_id', ids);
  const linked = (l ?? []).map((x: any) => x.company_id);
  return linked.length ? linked : ids;
}

// фирмы по company_id или БИН; пусто -> []
async function firmIds(p: Record<string, unknown>, robotId: string): Promise<string[] | null> {
  if (p.company_id) {
    const { data: c } = await db.from('companies').select('id').eq('id', String(p.company_id)).is('archived_at', null).maybeSingle();
    return c ? [c.id] : [];
  }
  const bin = String(p.bin ?? '').replace(/\D/g, '');
  if (bin.length !== 12) return null;
  return await byBin(bin, robotId);
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'Используйте POST' }, 405);
    const key = req.headers.get('x-robot-key') ?? '';
    if (!key.startsWith('esep_')) return json({ ok: false, error: 'Нет ключа x-robot-key' }, 401);
    const { data: valid } = await db.rpc('robot_api_check_key', { p_key: key });
    if (!valid) return json({ ok: false, error: 'Ключ не подходит или отозван' }, 401);

    let p: Record<string, unknown>;
    try { p = await req.json(); } catch { return json({ ok: false, error: 'Тело запроса должно быть JSON' }, 400); }
    const robotCode = String(p.robot ?? '');
    const { data: robot } = await db.from('robots').select('id,name,executor').eq('code', robotCode).maybeSingle();
    if (!robot) return json({ ok: false, error: 'Неизвестный робот: ' + robotCode }, 400);
    console.log('robot-api', p.action, robotCode, p.run_id ?? '', p.company_id ?? p.bin ?? '');

    // робот переехал на сервер кабинета: UiPath больше не берёт его задания и не создаёт плановые
    if (robot.executor === 'server' && (p.action === 'run_take' || p.action === 'jobs')) {
      return json({ ok: true, run_id: null, check_date: lastDayPrevMonth(), source: 'schedule', count: 0, companies: [], jobs: [], note: 'Робот работает на сервере кабинета — UiPath для него больше не нужен' });
    }

    if (p.action === 'jobs') {
      const jobs = await activeCompanies(robot.id);
      return json({ ok: true, robot: robotCode, count: jobs.length, jobs });
    }

    if (p.action === 'run_take') {
      let run: any = null;
      if (p.run_id) {
        const { data } = await db.from('robot_runs').select('*').eq('id', String(p.run_id)).eq('robot_id', robot.id).maybeSingle();
        if (!data) return json({ ok: false, error: 'Задание не найдено' }, 404);
        run = data;
      } else {
        const { data } = await db.from('robot_runs').select('*').eq('robot_id', robot.id).eq('status', 'queued').order('created_at').limit(1);
        run = data && data[0];
      }
      if (!run) {
        const all = await activeCompanies(robot.id);
        if (!all.length) return json({ ok: true, run_id: null, check_date: lastDayPrevMonth(), source: 'schedule', count: 0, companies: [] });
        const { data, error } = await db.from('robot_runs').insert({
          robot_id: robot.id, company_ids: all.map((c) => c.company_id), check_date: lastDayPrevMonth(), source: 'schedule', requested_by: null,
        }).select('*').single();
        if (error) return json({ ok: false, error: error.message }, 500);
        run = data;
      }
      await db.from('robot_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', run.id);
      const companies = await activeCompanies(robot.id, run.company_ids);
      return json({ ok: true, run_id: run.id, check_date: run.check_date, source: run.source, count: companies.length, companies });
    }

    if (p.action === 'run_finish') {
      const status = p.status === 'error' ? 'error' : 'done';
      const { error } = await db.from('robot_runs').update({ status, finished_at: new Date().toISOString(), note: p.note ? String(p.note).slice(0, 2000) : null })
        .eq('id', String(p.run_id ?? '')).eq('robot_id', robot.id);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    if (p.action === 'event') {
      const title = shortForms(String(p.title ?? '').trim());
      if (!title) return json({ ok: false, error: 'Нужен title' }, 400);
      const severity = ['info', 'warning', 'critical'].includes(String(p.severity)) ? String(p.severity) : 'info';
      let companyId = p.company_id ? String(p.company_id) : null;
      if (!companyId && p.bin) {
        const c = await byBin(String(p.bin).replace(/\D/g, ''), robot.id);
        if (c.length !== 1) return json({ ok: false, error: c.length > 1 ? 'Несколько фирм с этим БИН — передайте company_id' : 'Фирма с этим БИН не найдена (или в архиве)' }, 404);
        companyId = c[0];
      }
      if (!companyId) return json({ ok: false, error: 'Нужен bin или company_id' }, 400);
      const { data: firm } = await db.from('companies').select('archived_at').eq('id', companyId).maybeSingle();
      if (!firm || firm.archived_at) return json({ ok: false, error: 'Фирма в архиве — отчёт не принят' }, 409);
      const { data: link } = await db.from('company_robots').select('status').eq('company_id', companyId).eq('robot_id', robot.id).maybeSingle();
      if (!link || link.status !== 'active') return json({ ok: false, error: 'Робот не подключён к этой фирме или ещё не готов к работе' }, 409);
      const fileUrl = typeof p.file_url === 'string' && /^https:\/\//.test(p.file_url) ? p.file_url : null;
      let details: unknown = null;
      if (p.table && typeof p.table === 'object') {
        if (JSON.stringify(p.table).length > 500_000) return json({ ok: false, error: 'Таблица больше 500 КБ' }, 413);
        details = shortDeep(p.table);
      }
      const quiet = p.quiet === true || p.quiet === 'true';
      const { data: ev, error } = await db.from('events').insert({
        company_id: companyId, robot_id: robot.id, title: title.slice(0, 300),
        body: p.body ? shortForms(String(p.body)).slice(0, 8000) : null, severity, file_url: fileUrl, status: quiet ? 'done' : 'new',
        ...(quiet ? { done_at: new Date().toISOString() } : {}),
        run_id: p.run_id ? String(p.run_id) : null, details,
      }).select('id').single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, event_id: ev.id, quiet });
    }

    if (p.action === 'status') {
      const k = String(p.key ?? '').trim().toLowerCase();
      if (!/^[a-z0-9_]{1,40}$/.test(k)) return json({ ok: false, error: 'key: латиница, цифры и _, до 40 символов' }, 400);
      const label = shortForms(String(p.label ?? '').trim()).slice(0, 200);
      if (!label) return json({ ok: false, error: 'Нужен label' }, 400);
      const ids = await firmIds(p, robot.id);
      if (ids === null) return json({ ok: true, updated: 0, note: 'БИН/ИИН не из 12 цифр — пропущено' });
      if (!ids.length) return json({ ok: true, updated: 0, note: 'Этой фирмы нет в кабинете — пропущено' });
      const at = p.at && !isNaN(Date.parse(String(p.at))) ? new Date(String(p.at)).toISOString() : new Date().toISOString();
      const { error } = await db.from('robot_status').upsert(ids.map((id) => ({ company_id: id, robot_id: robot.id, key: k, label, at })), { onConflict: 'company_id,robot_id,key' });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, updated: ids.length });
    }

    if (p.action === 'eds') {
      const v = String(p.valid_until ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) return json({ ok: true, updated: 0, note: 'Дата ЭЦП не распознана (нужно yyyy-mm-dd) — пропущено' });
      const ids = await firmIds(p, robot.id);
      if (ids === null) return json({ ok: true, updated: 0, note: 'БИН/ИИН не из 12 цифр — пропущено' });
      if (!ids.length) return json({ ok: true, updated: 0, note: 'Этой фирмы нет в кабинете — пропущено' });
      const { error } = await db.from('companies').update({ eds_valid_until: v, eds_checked_at: new Date().toISOString() }).in('id', ids);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, updated: ids.length });
    }

    if (p.action === 'error') {
      const text = String(p.text ?? '').trim();
      if (!text) return json({ ok: false, error: 'Нужен text' }, 400);
      const firm = shortForms(String(p.firm ?? '').trim()).slice(0, 200);
      const ids = (p.company_id || p.bin) ? ((await firmIds(p, robot.id)) ?? []) : [];
      const now = new Date().toISOString();
      const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
      const { data: r, error } = await db.from('robot_runs').insert({
        robot_id: robot.id, company_ids: ids, check_date: today, source: 'schedule', requested_by: null,
        status: 'error', started_at: now, finished_at: now, note: ((firm ? firm + ': ' : '') + text).slice(0, 2000),
      }).select('id').single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, error_id: r.id, firms: ids.length });
    }

    return json({ ok: false, error: 'action: jobs, run_take, run_finish, event, status, eds или error' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
