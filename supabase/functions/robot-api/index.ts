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
// v14: Мониторинг КН — недельный цикл по фирме:
// kn_day   {robot:'kn_monitoring'} -> {run, run_day, firms_left} — есть ли сегодня работа (день проверки и не все фирмы готовы)
// kn_plan  {robot:'kn_monitoring', bin, force?} -> {ls_request, ls_process, kn, reports:[{form,period_text,due}], done}
// kn_step  {robot, bin, step:'ls_request'|'ls'|'kn'|'reports', status:'done'|'wait'|'error', note?}
// tax_docs {robot, bin, rows:[{столбец:значение}] | JSON-строка} -> разбор «Мои документы», итог в tax_filings,
//          тихая отметка tax_check, сообщение — только если срок прошёл или осталось ≤ 7 дней
// v22: sync_done {robot:'esf_diagnostics', onec_url|bin|company_id} -> задание серверной проверке по фирме (после синхронизации UiPath)
// v21: Apps Script (executor='apps_script'): run_take без run_id не создаёт плановое задание на все фирмы
// v19: отметка tax_check — заголовок за период + строка по каждой ФНО (номер, дата принятия, вид)
// v18: условные формы (328) — напоминание до срока «если был ввоз»
// v17: месячные формы (328.00) и «условные» формы — без отчёта не ошибка
// v16: tax_docs запоминает все формы фирмы (tax_form_seen → подсказки «добавить в профиль?»), учитывает несколько ОГД
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

// строка таблицы «Мои документы» (КН) → {form, period_key, status, kind, accepted, date, reg}
// столбцы ищем по названию, а если названий нет (Column-0…) — по содержимому
function parseKnDoc(r: any) {
  const vals: [string, string][] = Object.entries(r ?? {}).map(([k, v]) => [String(k), String(v ?? '').replace(/\s+/g, ' ').trim()]);
  const byKey = (re: RegExp, not?: RegExp) => vals.find(([k]) => re.test(k) && !(not && not.test(k)))?.[1] ?? '';
  const byVal = (re: RegExp) => vals.find(([, v]) => re.test(v))?.[1] ?? '';
  const name = byKey(/наимен/i) || byVal(/^\d{3}\.\d{2}\b/);
  const period = byKey(/период/i) || byVal(/(квартал|полугоди)/i) || '';
  const status = byKey(/^статус$/i) || byKey(/статус/i, /разнос/i) || byVal(/^(принят|не принят|отклон|в обработке|отозван)/i);
  const kind = byKey(/вид/i) || byVal(/^(первоначальная|очередная|дополнительная|ликвидационная|по уведомлению)/i);
  const reg = byKey(/рег/i);
  const ogd = [...new Set((byKey(/огд/i).match(/\d{4}/g) ?? []))].sort();
  const dateS = byKey(/дата/i) || byVal(/^\d{2}\.\d{2}\.\d{4}/);
  const fm = name.match(/(\d{3}\.\d{2})/);
  let period_key = '';
  const y = period.match(/(\d{4})/)?.[1];
  if (y) {
    const q = period.match(/(\d)\s*квартал/i), h = period.match(/(\d)\s*полугоди/i);
    const MON = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
    const mw = period.toLowerCase().match(/([а-я]+)/)?.[1] ?? '';
    const mi = mw ? MON.findIndex((x) => (x === 'ма' ? /^ма[йя]$/.test(mw) : mw.startsWith(x))) : -1;
    const mn = mi >= 0 ? mi + 1 : +(period.match(/^\s*(\d{1,2})[.\/]\d{4}\s*$/)?.[1] ?? 0);
    period_key = q ? `${y}-Q${q[1]}` : h ? `${y}-H${h[1]}` : mn >= 1 && mn <= 12 ? `${y}-M${String(mn).padStart(2, '0')}`
      : (/^\s*(год\s*)?\d{4}\s*(год)?\s*$/i.test(period) ? `${y}-Y` : '');
  }
  const dm = dateS.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const accepted = /^принят/i.test(status) && /^(первоначальн|очередн)/i.test(kind);
  const title = name.replace(/^\s*\d{3}\.\d{2}\s*/, '').trim();
  return { form: fm ? fm[1] : '', title, period_key, status, kind, accepted, reg, ogd, date: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null, raw: r };
}

// конец периода и предыдущий период по ключу '2026-Q3' / '2026-H1' / '2025-Y'
function periodEnd(k: string): string {
  const m = k.match(/^(\d{4})-(M|Q|H|Y)(\d{0,2})$/); if (!m) return '';
  const y = +m[1], n = +(m[3] || 0);
  const mon = m[2] === 'M' ? n : m[2] === 'Q' ? n * 3 : m[2] === 'H' ? n * 6 : 12;
  return new Date(Date.UTC(y, mon, 0)).toISOString().slice(0, 10);
}
function prevKey(k: string): string {
  const m = k.match(/^(\d{4})-(M|Q|H|Y)(\d{0,2})$/); if (!m) return '';
  const y = +m[1], n = +(m[3] || 0);
  if (m[2] === 'M') return n > 1 ? `${y}-M${String(n - 1).padStart(2, '0')}` : `${y - 1}-M12`;
  if (m[2] === 'Q') return n > 1 ? `${y}-Q${n - 1}` : `${y - 1}-Q4`;
  if (m[2] === 'H') return n > 1 ? `${y}-H1` : `${y - 1}-H2`;
  return `${y - 1}-Y`;
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
      // v21: роботы на Apps Script (Kaspi) по своему расписанию работают сами — плановое задание в кабинете не создаём
      // и чужое задание из очереди не отдаём; задание получают только по номеру (кнопка «Запустить» → doPost)
      if (robot.executor === 'apps_script' && !p.run_id) {
        return json({ ok: true, run_id: null, source: 'schedule', count: 0, companies: [], note: 'Плановый запуск идёт по расписанию скрипта — задание в кабинете не создаётся' });
      }
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

    // v22: UiPath синхронизировал фирму с ИС ЭСФ → сразу серверная проверка через OData (esf_diagnostics)
    if (p.action === 'sync_done') {
      if (robot.executor !== 'server') return json({ ok: false, error: 'Робот «' + robot.name + '» не работает на сервере кабинета' }, 400);
      // фирму можно указать адресом базы 1С (в Access у UiPath нет БИН): сравниваем без https://, www., # и / на конце
      const norm = (u: unknown) => String(u ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#\/\s]+$/, '');
      let ids: string[] | null;
      if (p.onec_url && !p.bin && !p.company_id) {
        const { data: all } = await db.from('companies').select('id,onec_url').is('archived_at', null).not('onec_url', 'is', null);
        ids = (all ?? []).filter((c: any) => norm(c.onec_url) === norm(p.onec_url)).map((c: any) => c.id);
      } else ids = await firmIds(p, robot.id);
      if (ids === null) return json({ ok: false, error: 'Нужен onec_url, bin (12 цифр) или company_id' }, 400);
      if (!ids.length) return json({ ok: true, run_id: null, note: 'Фирмы с такой базой 1С / БИН нет в кабинете' });
      const act = await activeCompanies(robot.id, ids);
      if (!act.length) return json({ ok: true, run_id: null, note: 'Робот у фирмы не подключён или не готов к работе' });
      const { data: run, error } = await db.from('robot_runs').insert({
        robot_id: robot.id, company_ids: act.map((c) => c.company_id), check_date: new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10),
        source: 'schedule', requested_by: null, note: 'после синхронизации с ИС ЭСФ',
      }).select('id').single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, run_id: run.id, firm: act[0].name, note: 'Проверка через OData запущена — отчёт появится в кабинете через несколько секунд' });
    }

    // ---- v14: Мониторинг КН — недельный цикл (пн 00:05 + повторы), кабинет решает, что делать по фирме ----
    // kn_day {robot} -> {run, run_day, firms_left}: один быстрый вопрос в начале запуска — есть ли сегодня работа
    if (p.action === 'kn_day') {
      const { data, error } = await db.rpc('kn_day', { p_robot: robot.id });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, ...(data as Record<string, unknown>) });
    }
    if (p.action === 'kn_plan' || p.action === 'kn_step' || p.action === 'tax_docs') {
      const ids = await firmIds(p, robot.id);
      if (!ids || !ids.length) {
        // фирмы нет в кабинете — робот делает всё как раньше, без отчётности
        if (p.action === 'kn_plan') return json({ ok: true, known: false, ls_request: true, ls_process: true, kn: true, reports: [], done: false });
        return json({ ok: true, known: false, note: 'Этой фирмы нет в кабинете — пропущено' });
      }
      const companyId = ids[0];
      if (p.action === 'kn_plan') {
        const { data, error } = await db.rpc('kn_plan', { p_company: companyId, p_force: p.force === true || p.force === 'true' });
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true, known: true, company_id: companyId, ...(data as Record<string, unknown>) });
      }
      if (p.action === 'kn_step') {
        const step = String(p.step ?? ''), st = String(p.status ?? 'done');
        if (!['ls_request', 'ls', 'kn', 'reports'].includes(step)) return json({ ok: false, error: 'step: ls_request, ls, kn или reports' }, 400);
        if (!['done', 'wait', 'error'].includes(st)) return json({ ok: false, error: 'status: done, wait или error' }, 400);
        const { error } = await db.rpc('kn_step', { p_company: companyId, p_step: step, p_status: st, p_note: p.note ? String(p.note).slice(0, 400) : null });
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true });
      }
      // tax_docs: таблица «Мои документы → Налоговая отчётность» как есть (rows: [{столбец: значение}] или JSON-строка)
      let rows: any = p.rows;
      if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = null; } }
      if (!Array.isArray(rows)) return json({ ok: false, error: 'Нужен rows — массив строк таблицы' }, 400);
      const docs = rows.map(parseKnDoc).filter((d: any) => d.form);
      // что фирма сдавала: последняя сдача по каждой форме → подсказки «добавить в профиль?»
      const latest: Record<string, any> = {};
      for (const d of docs) {
        const cur = latest[d.form], e = periodEnd(d.period_key) || d.date || '';
        if (!cur || e > cur._e || (e === cur._e && (d.date ?? '') > (cur.date ?? ''))) latest[d.form] = { ...d, _e: e };
      }
      const seen = Object.values(latest).map((d: any) => ({
        company_id: companyId, form_code: d.form, form_title: d.title || null, last_period_key: d.period_key || null, last_date: d.date,
        ogd: [...new Set(docs.filter((x: any) => x.form === d.form && x.period_key === d.period_key).flatMap((x: any) => x.ogd))].sort(),
        updated_at: new Date().toISOString(),
      }));
      if (seen.length) await db.from('tax_form_seen').upsert(seen, { onConflict: 'company_id,form_code' });
      const { data: plan } = await db.rpc('kn_plan', { p_company: companyId, p_force: false });
      const want: any[] = (plan as any)?.reports ?? [];
      const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
      const result: any[] = [];
      for (const w of want) {
        const mine = docs.filter((d: any) => d.form === w.form && d.period_key === w.period_key);
        const accDocs = mine.filter((d: any) => d.accepted);
        // несколько ОГД (напр. 700 в 3 налоговые): ждём принятые отчёты во все ОГД, куда сдавали в прошлом периоде
        const pk = prevKey(w.period_key);
        const expOgd = [...new Set(docs.filter((d: any) => d.form === w.form && d.period_key === pk && d.accepted).flatMap((d: any) => d.ogd))].sort() as string[];
        const accOgd = [...new Set(accDocs.flatMap((d: any) => d.ogd))].sort() as string[];
        const missOgd = expOgd.filter((o) => !accOgd.includes(o));
        const ok = accDocs.length > 0 && missOgd.length === 0 ? accDocs[0] : null;
        const best = accDocs[0] ?? mine[0];
        await db.from('tax_filings').upsert({
          company_id: companyId, form_code: w.form, period_key: w.period_key, accepted: !!ok,
          ogd_expected: expOgd.length > 1 ? expOgd : null, ogd_accepted: expOgd.length > 1 ? accOgd : null,
          doc_date: best?.date ?? null, doc_kind: best?.kind ?? null, doc_status: best?.status ?? null, reg_no: best?.reg ?? null,
          raw: best?.raw ?? null, checked_at: new Date().toISOString(),
        }, { onConflict: 'company_id,form_code,period_key' });
        const days = Math.round((Date.parse(w.due) - Date.parse(today)) / 864e5);
        const ogdNote = expOgd.length > 1 ? `ОГД принято ${expOgd.length - missOgd.length} из ${expOgd.length}` + (missOgd.length ? `, нет ${missOgd.join(', ')}` : '') : '';
        result.push({ form: w.form, name: w.name, period: w.period_text, due: w.due, accepted: !!ok, days, conditional: !!w.conditional, acc_date: ok?.date ?? null, acc_kind: ok?.kind ?? null,
          found: best ? [best.status + (best.kind ? ', ' + best.kind : ''), ogdNote].filter(Boolean).join('; ') : null });
      }
      const dRu = (d: string) => d.split('-').reverse().join('.');
      // условные формы (328 — только если был ввоз): после срока отсутствие отчёта — не ошибка; до срока — напоминание «если был ввоз»
      const late = result.filter((r) => !r.accepted && !r.conditional && r.days < 0);
      const soon = result.filter((r) => !r.accepted && r.days >= 0 && r.days <= 7);
      const must = result.filter((r) => !r.conditional || r.accepted);
      const acc = must.filter((r) => r.accepted).length;
      // отметка в карточке робота: заголовок + по строке на каждую ФНО (✓ принят · • к сдаче · ! срок прошёл)
      const pers = [...new Set(must.map((r) => r.period))];
      const head = must.length ? `Налоговая отчётность${pers.length === 1 ? ' за ' + pers[0] : ''} — принято ${acc} из ${must.length}` : 'Налоговая отчётность: в этот срок проверять нечего';
      const formLine = (r: any) => {
        const t = `ФНО ${r.form}${pers.length > 1 ? ' за ' + r.period : ''}`;
        if (r.accepted) return `✓ ${t} — принят${r.acc_date ? ' ' + dRu(r.acc_date) : ''}${r.acc_kind ? ', ' + String(r.acc_kind).toLowerCase() : ''}`;
        return (r.days < 0 ? '! ' : '• ') + t + (r.days < 0 ? ` — не найден, срок был ${dRu(r.due)}` : ` — к сдаче до ${dRu(r.due)}`) + (r.found ? ` (в КН: ${r.found})` : '');
      };
      const label = [head, ...must.map(formLine)].join('\n');
      await db.from('robot_status').upsert({ company_id: companyId, robot_id: robot.id, key: 'tax_check', label, at: new Date().toISOString() }, { onConflict: 'company_id,robot_id,key' });
      if (late.length || soon.length) {
        const line = (r: any) => `ФНО ${r.form} за ${r.period} — ` + (r.days < 0 ? `срок был ${dRu(r.due)}` : (r.days === 0 ? 'срок сегодня' : `срок ${dRu(r.due)}, осталось дней: ${r.days}`)) + (r.found ? ` (в КН: ${r.found})` : ' (в КН не найден)') + (r.conditional ? ' — если был ввоз товаров из ЕАЭС' : '');
        const body = [late.length ? '🔴 Не сдано в срок:\n' + late.map(line).join('\n') : '', soon.length ? '🟠 Скоро срок:\n' + soon.map(line).join('\n') : '']
          .filter(Boolean).join('\n\n') + '\n\nПроверено в кабинете налогоплательщика («Мои документы»): нужен статус «Принят» с видом «Первоначальная» или «Очередная».';
        await db.from('events').insert({ company_id: companyId, robot_id: robot.id, severity: late.length ? 'critical' : 'warning', status: 'new',
          title: late.length ? `Налоговый отчёт не сдан в срок: ${late.map((r) => r.form).join(', ')}` : `Скоро срок сдачи: ${soon.map((r) => r.form).join(', ')}`,
          body, details: { kind: 'tax_check', items: result } });
      }
      await db.rpc('kn_step', { p_company: companyId, p_step: 'reports', p_status: 'done', p_note: null });
      return json({ ok: true, rows: rows.length, recognized: docs.length, checked: result.length, accepted: acc, late: late.length, soon: soon.length, result });
    }

    return json({ ok: false, error: 'action: jobs, run_take, run_finish, event, status, eds, error, sync_done, kn_day, kn_plan, kn_step или tax_docs' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
