// Запуск процессов UiPath Orchestrator из кабинета ESEP (только администратор).
// Секреты: UIPATH_CLIENT_ID, UIPATH_CLIENT_SECRET (External Application, scopes: OR.Jobs OR.Execution.Read OR.Folders.Read)
// Необязательно: UIPATH_ORG (esep), UIPATH_TENANT (DefaultTenant), UIPATH_FOLDER_ID (6103440)
// action: processes -> список процессов папки;
//         jobs {name} -> последние 5 заданий процесса (статус, время, ошибка);
//         start {release_key, name} -> запустить 1 задание; если этот процесс уже идёт или ждёт робота — не запускаем второй раз
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

async function token(): Promise<string> {
  const r = await fetch('https://cloud.uipath.com/identity_/connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID!, client_secret: CSEC!, scope: 'OR.Jobs OR.Execution.Read OR.Folders.Read' }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error('UiPath не выдал доступ: ' + (t.error_description || t.error || r.status) + '. Проверьте App ID, App Secret и права приложения.');
  return t.access_token;
}
async function orch(path: string, tk: string, init: RequestInit = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { Authorization: 'Bearer ' + tk, 'X-UIPATH-OrganizationUnitId': FOLDER, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) } });
  const txt = await r.text(); let b: any = {}; try { b = JSON.parse(txt); } catch { b = { message: txt }; }
  if (!r.ok) throw new Error(friendly(b.message || b.errorMessage || String(r.status)));
  return b;
}
function friendly(m: string) {
  if (/robot|machine|runtime|license/i.test(m)) return 'Orchestrator не нашёл свободного робота для запуска: ' + m;
  if (/folder|permission|not authorized|forbidden/i.test(m)) return 'У приложения нет доступа к папке в Orchestrator: ' + m;
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
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const { data: adm } = await sb.rpc('am_i_admin');
    if (!adm) return j({ ok: false, error: 'Только для администратора ESEP' }, 403);
    const p = await req.json().catch(() => ({} as any));
    if (!CID || !CSEC) return j({ ok: false, need_setup: true, error: 'UiPath ещё не подключён к кабинету' });
    const tk = await token();
    if (p.action === 'processes') {
      const b = await orch("/odata/Releases?$select=Key,Name,ProcessKey,ProcessVersion,Description&$orderby=Name", tk);
      return j({ ok: true, processes: (b.value || []).map((x: any) => ({ key: x.Key, name: x.Name, process: x.ProcessKey, version: x.ProcessVersion })) });
    }
    if (p.action === 'jobs') {
      const name = String(p.name || ''); if (!name) return j({ ok: false, error: 'Не выбран процесс' }, 400);
      return j({ ok: true, jobs: await jobsOf(name, tk) });
    }
    if (p.action === 'start') {
      const key = String(p.release_key || ''), name = String(p.name || '');
      if (!/^[0-9a-f-]{36}$/i.test(key)) return j({ ok: false, error: 'Не выбран процесс' }, 400);
      // защита от двойного запуска: два робота с 1С и ЭЦП на одном компьютере мешают друг другу
      if (name) {
        const busy = (await jobsOf(name, tk, 10)).find((x: any) => ACTIVE.includes(x.state));
        if (busy) return j({ ok: false, busy: true, error: '«' + name + '» уже ' + (busy.state === 'Pending' ? 'ждёт свободного робота' : 'выполняется') + ' — второй раз не запускаю. Дождитесь окончания или остановите задание в Orchestrator.' });
      }
      const b = await orch('/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs', tk, { method: 'POST', body: JSON.stringify({ startInfo: { ReleaseKey: key, Strategy: 'ModernJobsCount', JobsCount: 1, InputArguments: '{}' } }) });
      const job = (b.value || [])[0] || {};
      return j({ ok: true, job_id: job.Id, state: job.State });
    }
    return j({ ok: false, error: 'action: processes, jobs или start' }, 400);
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) }, 200);
  }
});
