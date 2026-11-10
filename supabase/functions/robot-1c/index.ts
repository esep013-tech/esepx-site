// Серверные роботы ESEP: данные из облачной 1С через OData, без UiPath и Telegram.
// Вызывает база (триггер на новое задание robot_runs, заголовок x-server-key): { run_id }.
// Сейчас умеет: unpaid_invoices — «Неоплаченные счета на оплату» (неоплаченные и/или неотгруженные счета покупателям).
// Логин/пароль 1С — секреты ONEC_USER, ONEC_PASSWORD (как у onec-check).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const USER = Deno.env.get('ONEC_USER') || '';
const PASS = Deno.env.get('ONEC_PASSWORD') || '';
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const kzToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const dmy = (iso: string) => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';

function basic() {
  const b = new TextEncoder().encode(USER + ':' + PASS); let s = ''; b.forEach((x) => (s += String.fromCharCode(x)));
  return 'Basic ' + btoa(s);
}
async function odata(base: string, path: string) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/odata/standard.odata/' + path, { headers: { Accept: 'application/json', Authorization: basic() }, signal: ctl.signal });
    const txt = await r.text();
    if (r.status === 401) throw new Error('1С: нет такого пользователя или неверный пароль');
    if (r.status === 404 || r.status === 400) throw new Error('1С: объект не опубликован в OData или неверный запрос (HTTP ' + r.status + ')');
    if (!r.ok) throw new Error('1С ответила ошибкой ' + r.status + ': ' + txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
    try { return JSON.parse(txt).value || []; } catch { throw new Error('1С вернула не JSON'); }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('1С не ответила за 60 секунд');
    if (/1С/.test((e as Error).message)) throw e;
    throw new Error('1С недоступна: ' + (e as Error).message);
  } finally { clearTimeout(t); }
}

// ---------- Счета на оплату ----------
const PAY: Record<string, string> = { 'Оплачен': 'Оплачен', 'ОплаченЧастично': 'Оплачен частично', 'НеОплачен': 'Не оплачен' };
const SHIP: Record<string, string> = { 'Отгружен': 'Отгружен', 'ОтгруженЧастично': 'Отгружен частично', 'НеОтгружен': 'Не отгружен' };
async function invoices(base: string, fromDate?: string) {
  // счета с даты из настроек фирмы (по умолчанию 01.01 текущего года), без помеченных на удаление и без «отмена» в комментарии
  const from = (/^\d{4}-\d{2}-\d{2}$/.test(fromDate || '') ? fromDate : kzToday().slice(0, 4) + '-01-01') + 'T00:00:00';
  const docs = await odata(base, "Document_СчетНаОплатуПокупателю?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Комментарий,DeletionMark,Контрагент/Description&$expand=Контрагент"
    + "&$filter=" + encodeURIComponent("Date ge datetime'" + from + "' and DeletionMark eq false and substringof('отмена',Комментарий) eq false"));
  const sts = await odata(base, "InformationRegister_СтатусыДокументов?$format=json&$select=Документ,Статус,ДополнительныйСтатус&$filter="
    + encodeURIComponent("Документ_Type eq 'StandardODATA.Document_СчетНаОплатуПокупателю'"));
  const st: Record<string, any> = {}; sts.forEach((s: any) => { st[String(s['Документ'])] = s; });
  const items: any[] = [];
  for (const d of docs) {
    const s = st[d.Ref_Key] || {};
    const pay = PAY[s['Статус']] || (s['Статус'] ? String(s['Статус']) : 'Не оплачен');
    const ship = SHIP[s['ДополнительныйСтатус']] || (s['ДополнительныйСтатус'] ? String(s['ДополнительныйСтатус']) : 'Не отгружен');
    if (pay === 'Оплачен' && ship === 'Отгружен') continue; // полностью выполнен — не показываем
    items.push({
      key: d.Ref_Key, contractor: (d['Контрагент'] && d['Контрагент'].Description || 'Без контрагента').trim(),
      number: String(d.Number || '').replace(/^0+/, '') || String(d.Number || ''), date: String(d.Date || '').slice(0, 10),
      sum: Number(d['СуммаДокумента'] || 0), pay, ship, comment: (d['Комментарий'] || '').trim() || undefined,
    });
  }
  items.sort((a, b) => a.contractor.localeCompare(b.contractor, 'ru') || a.date.localeCompare(b.date));
  return { from: from.slice(0, 10), items };
}

async function runInvoices(robot: any, run: any) {
  const { data: firms } = await db.from('companies').select('id,name,onec_url').in('id', run.company_ids);
  const { data: links } = await db.from('company_robots').select('company_id,status,enabled,settings').eq('robot_id', robot.id).in('company_id', run.company_ids);
  const okLink = new Set((links || []).filter((l: any) => l.status === 'active' && l.enabled).map((l: any) => l.company_id));
  const setOf: Record<string, any> = {}; (links || []).forEach((l: any) => { setOf[l.company_id] = l.settings || {}; });
  const errs: string[] = []; let done = 0;
  const list = (firms || []).filter((f: any) => okLink.has(f.id));
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (f: any) => {
      try {
        if (!f.onec_url) throw new Error('в профиле фирмы не указан адрес 1С');
        const r = await invoices(f.onec_url, setOf[f.id] && setOf[f.id].from);
        const n = r.items.length, today = kzToday();
        const sum = r.items.reduce((a, x) => a + x.sum, 0);
        const cnt = new Set(r.items.map((x) => x.contractor)).size;
        const money = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const { error } = await db.from('events').insert({
          company_id: f.id, robot_id: robot.id, run_id: run.id,
          title: n ? 'Необработанные счета на оплату с ' + dmy(r.from) + ': ' + n : 'Счета на оплату с ' + dmy(r.from) + ': все оплачены и отгружены',
          body: n ? n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'счёт' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'счёта' : 'счетов') + ' на ' + money(sum) + ' ₸ по ' + cnt + ' контрагентам: не оплачены и/или не отгружены. Счета с ' + dmy(r.from) + ', кроме счетов с «отмена» в комментарии.' : null,
          severity: n ? 'warning' : 'info', status: n ? 'new' : 'done', ...(n ? {} : { done_at: new Date().toISOString() }),
          details: { kind: 'invoices', date: today, from: r.from, items: r.items },
        });
        if (error) throw new Error(error.message);
        await db.from('robot_status').upsert({ company_id: f.id, robot_id: robot.id, key: 'invoices', label: n ? 'Счета на оплату с ' + dmy(r.from) + ': необработанных ' + n : 'Счета на оплату с ' + dmy(r.from) + ': все оплачены и отгружены', at: new Date().toISOString() }, { onConflict: 'company_id,robot_id,key' });
        done++;
      } catch (e) {
        errs.push(f.name + ': ' + (e as Error).message);
      }
    }));
  }
  const skipped = run.company_ids.length - list.length;
  const note = [done ? 'проверено фирм: ' + done : '', skipped ? 'пропущено (робот не готов к работе): ' + skipped : '', ...errs].filter(Boolean).join('; ');
  await db.from('robot_runs').update({ status: errs.length ? 'error' : 'done', finished_at: new Date().toISOString(), note: note.slice(0, 2000) || null }).eq('id', run.id);
}

// ---------- Доверенности под контролем ----------
// Незакрытые доверенности с даты из настроек фирмы (по умолчанию 01.01 текущего года), без помеченных на удаление и без «отмена» в комментарии.
// Закрыта = есть проведённое поступление (ПоступлениеТоваровУслуг), где документ-основание — эта доверенность
// или счёт поставщика — тот же, что основание доверенности. Срок действия прошёл → «Просрочена», иначе «Действительна».
async function powers(base: string, fromDate?: string) {
  const from = (/^\d{4}-\d{2}-\d{2}$/.test(fromDate || '') ? fromDate : kzToday().slice(0, 4) + '-01-01') + 'T00:00:00';
  const docs = await odata(base, "Document_Доверенность?$format=json&$select=Ref_Key,Number,Date,ДатаДействия,Комментарий,DeletionMark,ПоДокументу,НаПолучениеОт,ДокументОснование_Key,Контрагент/Description&$expand=Контрагент"
    + "&$filter=" + encodeURIComponent("Date ge datetime'" + from + "' and DeletionMark eq false and substringof('отмена',Комментарий) eq false"));
  const recs = await odata(base, "Document_ПоступлениеТоваровУслуг?$format=json&$select=ДокументОснование,ДокументОснование_Type,СчетНаОплатуПоставщика_Key&$filter="
    + encodeURIComponent("Posted eq true and Date ge datetime'" + from + "'"));
  const byPoa = new Set<string>(), byInv = new Set<string>();
  recs.forEach((r: any) => {
    if (r['ДокументОснование_Type'] === 'StandardODATA.Document_Доверенность' && r['ДокументОснование']) byPoa.add(String(r['ДокументОснование']));
    const inv = r['СчетНаОплатуПоставщика_Key']; if (inv && !/^0{8}-/.test(inv)) byInv.add(String(inv));
  });
  const today = kzToday();
  const items: any[] = [];
  for (const d of docs) {
    const basisKey = d['ДокументОснование_Key'];
    if (byPoa.has(d.Ref_Key) || (basisKey && !/^0{8}-/.test(basisKey) && byInv.has(basisKey))) continue; // закрыта
    const until = String(d['ДатаДействия'] || '').slice(0, 10);
    items.push({
      key: d.Ref_Key, contractor: ((d['Контрагент'] && d['Контрагент'].Description) || d['НаПолучениеОт'] || 'Без контрагента').trim(),
      number: String(d.Number || '').replace(/^0+/, '') || String(d.Number || ''), date: String(d.Date || '').slice(0, 10), until,
      status: until && until < today ? 'Просрочена' : 'Действительна', basis: (d['ПоДокументу'] || '').trim() || undefined,
      comment: (d['Комментарий'] || '').trim() || undefined,
    });
  }
  items.sort((a, b) => a.contractor.localeCompare(b.contractor, 'ru') || a.date.localeCompare(b.date));
  return { from: from.slice(0, 10), items };
}

async function runPowers(robot: any, run: any) {
  const { data: firms } = await db.from('companies').select('id,name,onec_url').in('id', run.company_ids);
  const { data: links } = await db.from('company_robots').select('company_id,status,enabled,settings').eq('robot_id', robot.id).in('company_id', run.company_ids);
  const okLink = new Set((links || []).filter((l: any) => l.status === 'active' && l.enabled).map((l: any) => l.company_id));
  const setOf: Record<string, any> = {}; (links || []).forEach((l: any) => { setOf[l.company_id] = l.settings || {}; });
  const errs: string[] = []; let done = 0;
  const list = (firms || []).filter((f: any) => okLink.has(f.id));
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (f: any) => {
      try {
        if (!f.onec_url) throw new Error('в профиле фирмы не указан адрес 1С');
        const r = await powers(f.onec_url, setOf[f.id] && setOf[f.id].from);
        const n = r.items.length, today = kzToday();
        const over = r.items.filter((x) => x.status === 'Просрочена').length;
        const cnt = new Set(r.items.map((x) => x.contractor)).size;
        const { error } = await db.from('events').insert({
          company_id: f.id, robot_id: robot.id, run_id: run.id,
          title: n ? 'Незакрытые доверенности с ' + dmy(r.from) + ': ' + n + (over ? ', просрочено ' + over : '') : 'Доверенности с ' + dmy(r.from) + ': все закрыты',
          body: n ? 'Просрочено: ' + over + ', действительны: ' + (n - over) + ' — по ' + cnt + ' контрагентам. По этим доверенностям нужно получить и отразить закрывающие документы. Доверенности с ' + dmy(r.from) + ', кроме «отмена» в комментарии.' : null,
          severity: n ? 'warning' : 'info', status: n ? 'new' : 'done', ...(n ? {} : { done_at: new Date().toISOString() }),
          details: { kind: 'poa', date: today, from: r.from, items: r.items },
        });
        if (error) throw new Error(error.message);
        await db.from('robot_status').upsert({ company_id: f.id, robot_id: robot.id, key: 'poa', label: n ? 'Доверенности с ' + dmy(r.from) + ': незакрытых ' + n + (over ? ', просрочено ' + over : '') : 'Доверенности с ' + dmy(r.from) + ': все закрыты', at: new Date().toISOString() }, { onConflict: 'company_id,robot_id,key' });
        done++;
      } catch (e) {
        errs.push(f.name + ': ' + (e as Error).message);
      }
    }));
  }
  const skipped = run.company_ids.length - list.length;
  const note = [done ? 'проверено фирм: ' + done : '', skipped ? 'пропущено (робот не готов к работе): ' + skipped : '', ...errs].filter(Boolean).join('; ');
  await db.from('robot_runs').update({ status: errs.length ? 'error' : 'done', finished_at: new Date().toISOString(), note: note.slice(0, 2000) || null }).eq('id', run.id);
}

const HANDLERS: Record<string, (robot: any, run: any) => Promise<void>> = { unpaid_invoices: runInvoices, powers_of_attorney: runPowers };

async function handleRun(runId: string) {
  const { data: run } = await db.from('robot_runs').select('*').eq('id', runId).maybeSingle();
  if (!run || run.status !== 'queued') return;
  const { data: robot } = await db.from('robots').select('id,code,name,executor').eq('id', run.robot_id).maybeSingle();
  const h = robot && robot.executor === 'server' ? HANDLERS[robot.code] : null;
  // занять задание (только если всё ещё в очереди — защита от двойного запуска)
  const { data: took } = await db.from('robot_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', run.id).eq('status', 'queued').select('id');
  if (!took || !took.length) return;
  if (!h) { await db.from('robot_runs').update({ status: 'error', finished_at: new Date().toISOString(), note: 'Серверный робот для «' + (robot?.name || '?') + '» не найден' }).eq('id', run.id); return; }
  if (!USER || !PASS) { await db.from('robot_runs').update({ status: 'error', finished_at: new Date().toISOString(), note: 'Логин и пароль 1С не заданы в секретах кабинета' }).eq('id', run.id); return; }
  try { await h(robot, run); }
  catch (e) { await db.from('robot_runs').update({ status: 'error', finished_at: new Date().toISOString(), note: String((e as Error).message).slice(0, 2000) }).eq('id', run.id); }
}

Deno.serve(async (req) => {
  try {
    const key = req.headers.get('x-server-key') || '';
    const { data: ok } = key ? await db.rpc('server_robot_key_ok', { p_key: key }) : { data: false };
    if (!ok) return json({ ok: false, error: 'Нет доступа' }, 401);
    const p = await req.json().catch(() => ({} as any));
    // служебная разведка OData (только GET, только по ключу сервера): ответ 1С сохраняется в private.probe
    if (p.probe && p.company_id && typeof p.path === 'string') {
      const { data: f } = await db.from('companies').select('onec_url').eq('id', String(p.company_id)).maybeSingle();
      if (!f || !f.onec_url) return json({ ok: false, error: 'нет адреса 1С' }, 404);
      const r = await fetch(f.onec_url.replace(/\/+$/, '') + '/odata/standard.odata/' + p.path, { headers: { Accept: 'application/json', Authorization: basic() } });
      const txt = await r.text();
      await db.rpc('probe_save', { p_company: String(p.company_id), p_path: p.path, p_status: r.status, p_body: txt });
      return json({ ok: true, status: r.status, len: txt.length });
    }
    const runId = String(p.run_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, error: 'Нужен run_id' }, 400);
    // отвечаем сразу, работа идёт в фоне
    // @ts-ignore EdgeRuntime есть в Supabase
    EdgeRuntime.waitUntil(handleRun(runId));
    return json({ ok: true, accepted: runId });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
