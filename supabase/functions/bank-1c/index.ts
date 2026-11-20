// Робот «Выписки банка»: сверка выписки с 1С — ТОЛЬКО ЧТЕНИЕ (GET через OData), в 1С ничего не пишет.
// verify_jwt выключен: доступ проверяется внутри (вошедший пользователь + RLS, либо служебный ключ сервера).
// Вызов из кабинета (участник фирмы или администратор): { company_id, account, from, to, bins?: string[] }
//   account — номер счёта (ИИК) из выписки; from/to — период выписки (гггг-мм-дд); bins — БИН/ИИН контрагентов из выписки.
// Ответ: { ok, account_found, opening, closing, moves:[…], docs:[…], cps:{ бин: {key,name} } }
//   moves — движения по этому банковскому счёту из бухгалтерских проводок (любые документы: платёжки, ордера, касса, операции),
//           свёрнутые до «документ + приход/расход»; docs — банковские документы периода, в том числе непроведённые.
// Сами строки выписки на сервер не передаются и нигде не сохраняются. Секреты: ONEC_USER, ONEC_PASSWORD (как у onec-check).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '';
const PASS = Deno.env.get('ONEC_PASSWORD') || '';
const ZERO = '00000000-0000-0000-0000-000000000000';
const r2 = (n: number) => Math.round(n * 100) / 100;

function basic() {
  const b = new TextEncoder().encode(USER + ':' + PASS); let s = ''; b.forEach((x) => (s += String.fromCharCode(x)));
  return 'Basic ' + btoa(s);
}
async function odata(base: string, path: string): Promise<any[]> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 50000);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/odata/standard.odata/' + path, { headers: { Accept: 'application/json', Authorization: basic() }, signal: ctl.signal });
    const txt = await r.text();
    if (r.status === 401) throw new Error('1С: нет такого пользователя или неверный пароль');
    if (r.status === 404 || r.status === 400) throw new Error('1С: объект не опубликован в OData или неверный запрос (HTTP ' + r.status + ')');
    if (!r.ok) throw new Error('1С ответила ошибкой ' + r.status + ': ' + txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
    try { return JSON.parse(txt).value || []; } catch { throw new Error('1С вернула не JSON'); }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('1С не ответила за 50 секунд');
    if (/1С/.test((e as Error).message)) throw e;
    throw new Error('1С недоступна: ' + (e as Error).message);
  } finally { clearTimeout(t); }
}
const soft = async (p: Promise<any[]>) => { try { return await p; } catch { return null; } };
const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400e3).toISOString().slice(0, 10);

// банковские документы 1С: код для кабинета → объект OData, название, тип для ссылки «открыть в 1С»
const DOCS: Record<string, { set: string; name: string; dir: 'in' | 'out' }> = {
  ppi: { set: 'Document_ПлатежноеПоручениеВходящее', name: 'Платёжное поручение входящее', dir: 'in' },
  ppo: { set: 'Document_ПлатежноеПоручениеИсходящее', name: 'Платёжное поручение исходящее', dir: 'out' },
  poi: { set: 'Document_ПлатежныйОрдерПоступлениеДенежныхСредств', name: 'Платёжный ордер (поступление)', dir: 'in' },
  poo: { set: 'Document_ПлатежныйОрдерСписаниеДенежныхСредств', name: 'Платёжный ордер (списание)', dir: 'out' },
};
const TYPE_RU: Record<string, string> = { ПриходныйКассовыйОрдер: 'Приходный кассовый ордер', РасходныйКассовыйОрдер: 'Расходный кассовый ордер', ОперацияБух: 'Операция (бухгалтерская)', ОплатаОтПокупателяПлатежнойКартой: 'Оплата от покупателя платёжной картой' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sbUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any));
    const id = String(p.company_id || ''), account = String(p.account || '').toUpperCase().trim(), from = String(p.from || ''), to = String(p.to || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return j({ ok: false, error: 'Не указана фирма' }, 400);
    if (!/^[A-Z0-9]{10,34}$/.test(account)) return j({ ok: false, error: 'Не указан номер счёта' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return j({ ok: false, error: 'Не указан период выписки' }, 400);
    if (Date.parse(to) - Date.parse(from) > 400 * 86400e3) return j({ ok: false, error: 'Период выписки больше года — загрузите выписку по частям' }, 400);
    // кто спрашивает: пользователь кабинета (RLS: фирму видит только её участник или администратор) либо сам сервер по служебному ключу (проверки)
    const skey = req.headers.get('x-server-key') || '';
    let reader = sbUser;
    if (skey) {
      const sbSrv = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const { data: ok } = await sbSrv.rpc('server_robot_key_ok', { p_key: skey });
      if (!ok) return j({ ok: false, error: 'Нет доступа' }, 401);
      reader = sbSrv;
    } else {
      const { data: u } = await sbUser.auth.getUser();
      if (!u || !u.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
    }
    const { data: f } = await reader.from('companies').select('id,name,bin,onec_url').eq('id', id).maybeSingle();
    if (!f) return j({ ok: false, error: 'Фирма не найдена или нет доступа' }, 403);
    if (!f.onec_url) return j({ ok: false, code: 'no_1c', error: 'В профиле фирмы не указан адрес 1С — сверить выписку с 1С нельзя' });
    if (!USER || !PASS) return j({ ok: false, error: 'Логин и пароль 1С не заданы в секретах кабинета' });
    const base = f.onec_url as string;

    // 1) банковский счёт фирмы в 1С
    const accs = await odata(base, "Catalog_БанковскиеСчета?$format=json&$select=Ref_Key,Description,Owner,Owner_Type,DeletionMark,НомерСчета&$filter=" + encodeURIComponent("НомерСчета eq '" + account + "'"));
    const acc = accs.find((a) => /Организации/.test(a.Owner_Type || '') && !a.DeletionMark) || accs.find((a) => /Организации/.test(a.Owner_Type || ''));
    if (!acc) return j({ ok: true, account_found: false, firm: f.name });
    const k = acc.Ref_Key as string, cast = "cast(guid'" + k + "', 'Catalog_БанковскиеСчета')";

    // 2) остатки на начало и конец, проводки по счёту, банковские документы периода
    const balQ = (d: string) => "AccountingRegister_Типовой/Balance(Period=datetime'" + d + "T00:00:00')?$format=json&$select=Account_Key,ExtDimension1,СуммаBalance&$filter=" + encodeURIComponent('ExtDimension1 eq ' + cast);
    const recSel = '&$select=Period,Recorder,Recorder_Type,Сумма,ExtDimensionDr1,ExtDimensionCr1,Содержание';
    const recQ = "AccountingRegister_Типовой/RecordsWithExtDimensions(StartPeriod=datetime'" + from + "T00:00:00',EndPeriod=datetime'" + to + "T23:59:59')?$format=json" + recSel;
    const docQ = (set: string) => set + '?$format=json&$select=Ref_Key,Number,Date,Posted,DeletionMark,СуммаДокумента,НомерВходящегоДокумента,ДатаВходящегоДокумента,ВидОперации,НазначениеПлатежа,Контрагент_Key&$filter='
      + encodeURIComponent("Date ge datetime'" + from + "T00:00:00' and Date le datetime'" + to + "T23:59:59' and DeletionMark eq false and СчетОрганизации_Key eq guid'" + k + "'");
    const codes = Object.keys(DOCS);
    const [b0, b1, recF, ...dl] = await Promise.all([
      soft(odata(base, balQ(from))), soft(odata(base, balQ(nextDay(to)))),
      soft(odata(base, recQ + '&$filter=' + encodeURIComponent('ExtDimensionDr1 eq ' + cast + ' or ExtDimensionCr1 eq ' + cast))),
      ...codes.map((c) => soft(odata(base, docQ(DOCS[c].set)))),
    ]);
    // если отбор по счёту в проводках 1С не принял — берём все проводки периода и отбираем сами
    const recs = recF || await soft(odata(base, recQ));
    const sumBal = (b: any[] | null) => b ? r2(b.filter((x) => x.ExtDimension1 === k).reduce((a, x) => a + Number(x['СуммаBalance'] || 0), 0)) : null;

    const docs: any[] = [], docBy: Record<string, any> = {};
    codes.forEach((c, i) => (dl[i] || []).forEach((d: any) => {
      const o = { code: c, type: DOCS[c].name, ot: DOCS[c].set.replace('Document_', ''), dir: DOCS[c].dir, key: d.Ref_Key, number: String(d.Number || '').replace(/^0+/, ''), date: String(d.Date || '').slice(0, 10), posted: !!d.Posted, sum: Number(d['СуммаДокумента'] || 0),
        in_no: String(d['НомерВходящегоДокумента'] || '').trim(), in_date: String(d['ДатаВходящегоДокумента'] || '').slice(0, 10), op: d['ВидОперации'] || '', purpose: String(d['НазначениеПлатежа'] || '').replace(/\s+/g, ' ').trim().slice(0, 300), cp: d['Контрагент_Key'] || '' };
      docs.push(o); docBy[o.key] = o;
    }));
    // движения: один документ + направление = одна сумма (зарплатные платёжки дают много проводок)
    const mv: Record<string, any> = {};
    (recs || []).forEach((x: any) => {
      const dr = x.ExtDimensionDr1 === k, cr = x.ExtDimensionCr1 === k; if (!dr && !cr) return;
      const add = (dir: 'in' | 'out') => { const id2 = x.Recorder + '|' + dir, t = String(x.Recorder_Type || '').replace('StandardODATA.Document_', ''), d = docBy[x.Recorder];
        const m = mv[id2] || (mv[id2] = { key: x.Recorder, dir, sum: 0, date: String(x.Period || '').slice(0, 10), type: d ? d.type : (TYPE_RU[t] || t), ot: t, code: d ? d.code : '', number: d ? d.number : '', in_no: d ? d.in_no : '', text: String(x['Содержание'] || '').slice(0, 120) });
        m.sum = r2(m.sum + Number(x['Сумма'] || 0)); };
      if (dr) add('in'); if (cr) add('out');
    });

    // 3) контрагенты из выписки по БИН/ИИН: есть ли в 1С
    const bins = [...new Set((Array.isArray(p.bins) ? p.bins : []).map((b: unknown) => String(b).replace(/\D/g, '')).filter((b: string) => b.length === 12))].slice(0, 400) as string[];
    const cps: Record<string, { key: string; name: string }> = {};
    for (let i = 0; i < bins.length; i += 25) {
      const part = bins.slice(i, i + 25), flt = part.map((b) => "ИдентификационныйКодЛичности eq '" + b + "'").join(' or ');
      const rows = await soft(odata(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description,DeletionMark,ИдентификационныйКодЛичности&$filter=' + encodeURIComponent(flt)));
      (rows || []).forEach((c: any) => { const b = String(c['ИдентификационныйКодЛичности'] || '').trim(); if (b && (!cps[b] || !c.DeletionMark)) cps[b] = { key: c.Ref_Key, name: c.Description }; });
    }
    // названия контрагентов у банковских документов (для подсказки в таблице)
    const need = [...new Set(docs.map((d) => d.cp).filter((x) => x && x !== ZERO))].slice(0, 200) as string[];
    const names: Record<string, string> = {}; Object.values(cps).forEach((c) => (names[c.key] = c.name));
    const miss = need.filter((x) => !names[x]);
    for (let i = 0; i < miss.length; i += 25) {
      const rows = await soft(odata(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description&$filter=' + encodeURIComponent(miss.slice(i, i + 25).map((x) => "Ref_Key eq guid'" + x + "'").join(' or '))));
      (rows || []).forEach((c: any) => (names[c.Ref_Key] = c.Description));
    }
    docs.forEach((d) => { d.cp_name = names[d.cp] || ''; delete d.cp; });

    return j({ ok: true, account_found: true, firm: f.name, account_name: acc.Description, opening: sumBal(b0), closing: sumBal(b1), moves_ok: !!recs, moves: Object.values(mv), docs, cps });
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) }, 200);
  }
});
