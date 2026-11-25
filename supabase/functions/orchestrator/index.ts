// Запуск процессов UiPath Orchestrator из кабинета ESEP (только администратор).
// Секреты: UIPATH_CLIENT_ID, UIPATH_CLIENT_SECRET (External Application, scopes: OR.Jobs, OR.Execution.Read)
// Необязательно: UIPATH_ORG (esep), UIPATH_TENANT (DefaultTenant), UIPATH_FOLDER_ID (6103440)
// action: processes -> список процессов папки (с названием робота в кабинете; переехавшие на сервер — hidden);
//         jobs {name} -> последние 5 заданий процесса (статус, время, ошибка);
//         start {release_key, name} -> запустить 1 задание; если этот процесс уже идёт или ждёт робота — не запускаем второй раз
// Для тех, кому администратор разрешил запуск UiPath (profiles.can_run_uipath), и для администратора:
//         diag_start {request_id} -> запустить «Диагностику» по отмеченным фирмам (список робот заберёт сам, sync_requests);
//         diag_state {request_id, job_id} -> состояние задания; закончилось — запрос закрывается
//         diag_stop {mode:'soft'|'kill', request_id?} -> soft: робот закончит текущую фирму и остановится (флаг robot_stops; задание в очереди — снимается);
//                                                       kill: задание прерывается немедленно
//         ls_start -> «Обновить» лицевые счета: сегодняшняя проверка ЛС по своим фирмам заново (RPC ls_refresh_request)
//                     и запуск «Мониторинга КН» как по расписанию (ПоРасписанию = true: робот берёт только то, что попросил кабинет)
//         ls_state {job_id} -> состояние этого задания (ждёт робота / работает / закончено / ошибка)
// По расписанию (база, заголовок x-server-key): только diag_start {request_id} — «Диагностика» каждый рабочий день в 07:00
//         (private.diag_schedule_kick). Робот не принял запуск — запрос закрывается с пометкой, отчёты по старым данным не строятся.
// Пользователям названия инструментов не показываем: «робот на компьютере ESEP».
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const ORG = Deno.env.get('UIPATH_ORG') || 'esep';
const TEN = Deno.env.get('UIPATH_TENANT') || 'DefaultTenant';
const FOLDER = Deno.env.get('UIPATH_FOLDER_ID') || '6103440';
const CID = Deno.env.get('UIPATH_CLIENT_ID');
const CSEC = Deno.env.get('UIPATH_CLIENT_SECRET');
const BASE = `https://cloud.uipath.com/${ORG}/${TEN}/orchestrator_`;
const ACTIVE = ['Pending', 'Running', 'Resumed', 'Suspended', 'Stopping', 'Terminating'];

// права приложения бывают выданы по-разному (OR.Jobs целиком или только .Read/.Write) — пробуем варианты по очереди
const SCOPES = ['OR.Jobs OR.Execution.Read', 'OR.Jobs OR.Execution', 'OR.Jobs.Write OR.Jobs.Read OR.Execution.Read', 'OR.Jobs.Write OR.Jobs.Read OR.Execution'];
async function token(): Promise<string> {
  let last = '';
  for (const scope of SCOPES) {
    const r = await fetch('https://cloud.uipath.com/identity_/connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID!, client_secret: CSEC!, scope }),
    });
    const t = await r.json().catch(() => ({}));
    if (r.ok && t.access_token) return t.access_token;
    last = t.error_description || t.error || String(r.status);
    if (t.error !== 'invalid_scope') break;
  }
  if (/invalid_scope/.test(last)) throw new Error('UiPath: у приложения «ESEP кабинет» не хватает прав. В Admin → External Applications → ESEP кабинет → Orchestrator API Access → вкладка Application scope(s) отметьте OR.Jobs и OR.Execution (или OR.Execution.Read) и сохраните.');
  throw new Error('UiPath не выдал доступ: ' + last + '. Проверьте App ID и App Secret.');
}
async function orch(path: string, tk: string, init: RequestInit = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { Authorization: 'Bearer ' + tk, 'X-UIPATH-OrganizationUnitId': FOLDER, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) } });
  const txt = await r.text(); let b: any = {}; try { b = JSON.parse(txt); } catch { b = { message: txt }; }
  if (!r.ok) throw new Error(friendly(b.message || b.errorMessage || String(r.status)));
  return b;
}
// как процесс называется в кабинете; null — робот переехал на сервер кабинета, в списке запуска его не показываем
const PROC: [RegExp, string | null][] = [
  [/ДтКт|Дт\.?\s?Кт|контрагент/i, null],
  [/Неоплач|счета на оплату|Доверен/i, null],
  [/Диагност/i, 'Синхронизация с ИС ЭСФ (для диагностики)'],
  // 25.11.2026: робот разделён на два; «Запрос ЛС» вручную не запускаем — лицевые счета запрашиваются один раз в день по расписанию
  [/Статист/i, 'Статистика — проверка отчётов по всем фирмам'],
  [/Запрос\s*\.?\s*ЛС/i, null],
  [/Проверка[\s.]*нового[\s.]*КН/i, null],   // старый робот, его работу делает «Мониторинг.КН» — в списке запуска не показываем (25.11.2026)
  [/Мониторинг/i, 'Мониторинг кабинета налогоплательщика (проверка КН)'],
  [/оригинал|Журнал/i, 'Журнал отсутствующих оригиналов'],
  [/налог|ЛС/i, 'Долги по налогам'],
];
function titleOf(name: string): { title: string; hidden: boolean } {
  for (const [re, t] of PROC) if (re.test(name)) return { title: t || name, hidden: t === null };
  return { title: name, hidden: false };
}
function friendly(m: string) {
  if (/robot|machine|runtime|license/i.test(m)) return 'Нет свободного робота на компьютере ESEP — проверьте, что компьютер включён.';
  if (/folder|permission|not authorized|forbidden/i.test(m)) return 'Кабинету не хватает прав на запуск робота: ' + m;
  return m;
}
async function jobsOf(name: string, tk: string, top = 5) {
  const flt = encodeURIComponent("ReleaseName eq '" + name.replace(/'/g, "''") + "'");
  const b = await orch('/odata/Jobs?$select=Id,State,CreationTime,StartTime,EndTime,Info,HostMachineName&$orderby=CreationTime desc&$top=' + top + '&$filter=' + flt, tk);
  return (b.value || []).map((x: any) => ({ id: x.Id, state: x.State, created: x.CreationTime, start: x.StartTime, end: x.EndTime, machine: x.HostMachineName,
    info: x.State === 'Faulted' || x.State === 'Stopped' ? String(x.Info || '').slice(0, 400) : undefined }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let late: null | ((m: string) => Promise<unknown>) = null;   // запуск по расписанию упал до старта — закрыть запрос
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any));
    // запуск по расписанию из базы: ключ сервера вместо входа пользователя, разрешён только diag_start
    const skey = req.headers.get('x-server-key') || '';
    let db: any = null;
    if (skey) {
      db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const { data: ok } = await db.rpc('server_robot_key_ok', { p_key: skey });
      if (!ok || p.action !== 'diag_start') return j({ ok: false, error: 'Нет доступа' }, 403);
      const rid0 = String(p.request_id || '');
      if (/^[0-9a-f-]{36}$/i.test(rid0)) late = (m) => db.from('sync_requests').update({ finished_at: new Date().toISOString(), note: 'по расписанию не запущено: ' + m.slice(0, 200) }).eq('id', rid0).is('finished_at', null).is('job_id', null);
    }
    const diag = p.action === 'diag_start' || p.action === 'diag_state' || p.action === 'diag_stop' || p.action === 'ls_start' || p.action === 'ls_state';
    const { data: adm } = db ? { data: true } : await sb.rpc(diag ? 'can_run_uipath' : 'am_i_admin');
    if (!adm) return j({ ok: false, error: diag ? (p.action === 'ls_start' || p.action === 'ls_state' ? 'Запуск робота вам не разрешён' : 'Запуск синхронизации с ИС ЭСФ вам не разрешён') : 'Только для администратора ESEP' }, 403);
    if (!CID || !CSEC) { if (late) await late('робот не подключён к кабинету'); return j({ ok: false, need_setup: true, error: 'UiPath ещё не подключён к кабинету' }); }
    const tk = await token();
    if (p.action === 'diag_start') {
      const rid = String(p.request_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(rid)) return j({ ok: false, error: 'Нет запроса на синхронизацию' }, 400);
      // по расписанию: не получилось запустить — запрос закрываем сразу, иначе он провисит 2 часа и не даст запустить вручную
      const drop = async (why: string) => { if (late) await late(why); };
        const b = await orch("/odata/Releases?$select=Key,Name&$filter=" + encodeURIComponent("contains(Name,'Диагностик')"), tk);
        const rel = (b.value || [])[0];
        if (!rel) { await drop('робот не найден'); return j({ ok: false, error: 'Робот синхронизации с ИС ЭСФ не найден на компьютере ESEP' }); }
        const busy = (await jobsOf(rel.Name, tk, 10)).find((x: any) => ACTIVE.includes(x.state));
        if (busy) { await drop('робот уже ' + (busy.state === 'Pending' ? 'ждёт в очереди' : 'работает')); return j({ ok: false, busy: true, error: 'Синхронизация с ИС ЭСФ уже ' + (busy.state === 'Pending' ? 'ждёт свободного робота' : 'выполняется') + ' — дождитесь окончания.' }); }
        const s = await orch('/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs', tk, { method: 'POST', body: JSON.stringify({ startInfo: { ReleaseKey: rel.Key, Strategy: 'ModernJobsCount', JobsCount: 1, InputArguments: '{}' } }) });
        const job = (s.value || [])[0] || {};
        if (job.Id) { if (db) await db.from('sync_requests').update({ job_id: job.Id }).eq('id', rid); else await sb.rpc('sync_request_job', { p_id: rid, p_job: job.Id }); }
        else await drop('робот не принял запуск');
        return j({ ok: true, job_id: job.Id, state: job.State, name: rel.Name });
    }
    if (p.action === 'ls_start') {
      const { data: q, error: qe } = await sb.rpc('ls_refresh_request');
      if (qe) return j({ ok: false, error: qe.message });
      if (!q || !q.firms) return j({ ok: false, error: 'Нет фирм, по которым можно обновить лицевые счета' });
      let b = await orch("/odata/Releases?$select=Key,Name&$filter=" + encodeURIComponent("contains(Name,'Мониторинг')"), tk);
      let rel = (b.value || [])[0];
      if (!rel) { b = await orch("/odata/Releases?$select=Key,Name&$filter=" + encodeURIComponent("contains(Name,'КН')"), tk); rel = (b.value || []).find((x: any) => !/КНП/.test(x.Name)); }
      if (!rel) return j({ ok: false, error: 'Робот «Мониторинг кабинета налогоплательщика» не найден на компьютере ESEP' });
      const busy = (await jobsOf(rel.Name, tk, 10)).find((x: any) => ACTIVE.includes(x.state));
      if (busy) return j({ ok: true, busy: true, firms: q.firms, name: rel.Name });
      const s = await orch('/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs', tk, { method: 'POST', body: JSON.stringify({ startInfo: { ReleaseKey: rel.Key, Strategy: 'ModernJobsCount', JobsCount: 1, InputArguments: JSON.stringify({ 'ПоРасписанию': true }) } }) });
      const job = (s.value || [])[0] || {};
      return j({ ok: true, job_id: job.Id, state: job.State, firms: q.firms, name: rel.Name });
    }
    if (p.action === 'ls_state') {
      const jid = Number(p.job_id || 0); if (!jid) return j({ ok: false, error: 'Нет задания' }, 400);
      const x = await orch('/odata/Jobs(' + jid + ')?$select=Id,State,Info,StartTime,EndTime,HostMachineName', tk);
      return j({ ok: true, state: x.State, start: x.StartTime, end: x.EndTime, over: !ACTIVE.includes(x.State), info: x.State === 'Faulted' || x.State === 'Stopped' ? String(x.Info || '').slice(0, 300) : undefined });
    }
    if (p.action === 'diag_state') {
      const rid = String(p.request_id || ''), jid = Number(p.job_id || 0);
      if (!/^[0-9a-f-]{36}$/i.test(rid) || !jid) return j({ ok: false, error: 'Нет задания' }, 400);
      const x = await orch('/odata/Jobs(' + jid + ')?$select=Id,State,Info,StartTime,EndTime', tk);
      const over = !ACTIVE.includes(x.State);
      if (over) await sb.rpc('sync_request_finish', { p_id: rid, p_note: x.State === 'Successful' ? null : 'робот закончил: ' + x.State + (x.Info ? ' — ' + String(x.Info).slice(0, 200) : '') });
      return j({ ok: true, state: x.State, over });
    }
    if (p.action === 'diag_stop') {
      const kill = p.mode === 'kill', rid = String(p.request_id || '');
      const b = await orch("/odata/Releases?$select=Key,Name&$filter=" + encodeURIComponent("contains(Name,'Диагностик')"), tk);
      const rel = (b.value || [])[0];
      const act = rel ? (await jobsOf(rel.Name, tk, 10)).filter((x: any) => ACTIVE.includes(x.state)) : [];
      // флаг для робота: в начале следующей фирмы он его увидит и дальше не пойдёт
      await sb.rpc('robot_stop_request', { p_robot_code: 'esf_diagnostics', p_note: kill ? 'прервано пользователем' : 'остановлено пользователем' });
      // жёстко — прерываем всё; мягко — снимаем только то, что ещё ждёт в очереди (работающий робот остановится сам)
      const ids = act.filter((x: any) => kill || x.state === 'Pending').map((x: any) => x.id);
      if (ids.length) await orch('/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs', tk, { method: 'POST', body: JSON.stringify({ jobIds: ids, strategy: kill ? 'Kill' : 'SoftStop' }) });
      const running = act.filter((x: any) => x.state !== 'Pending').length;
      if (/^[0-9a-f-]{36}$/i.test(rid) && (kill || !running)) await sb.rpc('sync_request_finish', { p_id: rid, p_note: kill ? 'прервано пользователем' : 'остановлено пользователем до начала работы' });
      return j({ ok: true, stopped: ids.length, running: kill ? 0 : running });
    }
    if (p.action === 'processes') {
      const b = await orch("/odata/Releases?$select=Key,Name,ProcessKey,ProcessVersion,Description&$orderby=Name", tk);
      return j({ ok: true, processes: (b.value || []).map((x: any) => ({ key: x.Key, name: x.Name, version: x.ProcessVersion, ...titleOf(x.Name) })) });
    }
    if (p.action === 'jobs') {
      const name = String(p.name || ''); if (!name) return j({ ok: false, error: 'Не выбран процесс' }, 400);
      return j({ ok: true, jobs: await jobsOf(name, tk) });
    }
    if (p.action === 'start') {
      const key = String(p.release_key || ''), name = String(p.name || '');
      if (!/^[0-9a-f-]{36}$/i.test(key)) return j({ ok: false, error: 'Не выбран робот' }, 400);
      if (name && titleOf(name).hidden) return j({ ok: false, error: 'Этот робот теперь работает на сервере кабинета — запустите его в «Запустить проверку» или в «Фирмы → Запуск и отчёты»' });
      // защита от двойного запуска: два робота с 1С и ЭЦП на одном компьютере мешают друг другу
      if (name) {
        const busy = (await jobsOf(name, tk, 10)).find((x: any) => ACTIVE.includes(x.state));
        if (busy) return j({ ok: false, busy: true, error: '«' + titleOf(name).title + '» уже ' + (busy.state === 'Pending' ? 'ждёт свободного робота' : 'выполняется') + ' — второй раз не запускаю. Дождитесь окончания.' });
      }
      const b = await orch('/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs', tk, { method: 'POST', body: JSON.stringify({ startInfo: { ReleaseKey: key, Strategy: 'ModernJobsCount', JobsCount: 1, InputArguments: '{}' } }) });
      const job = (b.value || [])[0] || {};
      return j({ ok: true, job_id: job.Id, state: job.State });
    }
    return j({ ok: false, error: 'action: processes, jobs, start, diag_start, diag_state, diag_stop, ls_start или ls_state' }, 400);
  } catch (e) {
    const m = String((e as Error).message ?? e);
    if (late) await late(m).catch(() => null);
    return j({ ok: false, error: /UiPath|Orchestrator|scope|App ID/i.test(m) ? 'Робот на компьютере ESEP сейчас недоступен. ' + m.replace(/UiPath|Orchestrator/g, 'робот') : m }, 200);
  }
});
