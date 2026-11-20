// Робот «Выписки банка»: запись ОДНОГО банковского документа в 1С по строке выписки (POST через OData).
// verify_jwt выключен: доступ проверяется внутри — вошедший пользователь с правом записи (bank_can_write) либо служебный ключ сервера.
// Вызов: { company_id, account, post, row: { n, date, dir, sum, bin, name, knp, purpose }, plan: { doc, op, name }, fill?: { cp_key, contract_key, cf_key } }
// fill — что пользователь выбрал в таблице: cp_key (или 'new' — создать контрагента), contract_key (или 'new' — создать договор вида «Прочее»), cf_key.
// Новый контрагент: название и БИН из выписки, полное наименование из КГД (секрет KGD_TOKEN), в корень справочника, комментарий «Создано роботом…».
// Порядок (правило: сначала GET, потом один POST): счёт фирмы → нет ли уже такого документа → контрагент по БИН → образец
// (последний проведённый документ того же вида с этим контрагентом и видом операции) → POST → GET-проверка → по настройке Post.
// Чего нет в 1С (контрагента, образца) — не выдумываем: возвращаем причину, строку решает пользователь.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '', PASS = Deno.env.get('ONEC_PASSWORD') || '', KGD_TOKEN = Deno.env.get('KGD_TOKEN') || '';
const MADE = 'Создано роботом ESEP из выписки банка';
const SETS: Record<string, { set: string; dir: string; name: string }> = {
  ppi: { set: 'Document_ПлатежноеПоручениеВходящее', dir: 'in', name: 'Платёжное поручение входящее' }, ppo: { set: 'Document_ПлатежноеПоручениеИсходящее', dir: 'out', name: 'Платёжное поручение исходящее' },
  poi: { set: 'Document_ПлатежныйОрдерПоступлениеДенежныхСредств', dir: 'in', name: 'Платёжный ордер (поступление)' }, poo: { set: 'Document_ПлатежныйОрдерСписаниеДенежныхСредств', dir: 'out', name: 'Платёжный ордер (списание)' },
};
const LATER = ['ПеречислениеЗаработнойПлаты', 'ПеречислениеПенсионныхВзносов', 'ПеречислениеСоциальныхОтчислений', 'ПеречислениеНалога'];
function basic() { const b = new TextEncoder().encode(USER + ':' + PASS); let s = ''; b.forEach((x) => (s += String.fromCharCode(x))); return 'Basic ' + btoa(s); }
async function call(base: string, path: string, method = 'GET', body?: unknown) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 50000);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/odata/standard.odata/' + path, { method, headers: { Accept: 'application/json', Authorization: basic(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const txt = await r.text(); let js: any = null; try { js = JSON.parse(txt); } catch { /* не JSON */ }
    const err = js && js['odata.error'] ? String(js['odata.error'].message?.value || '') : '';
    return { status: r.status, js, err: err || (r.ok ? '' : txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)) };
  } finally { clearTimeout(t); }
}
const q = (s: string) => encodeURIComponent(s);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!, sbSrv = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const sbUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any)), id = String(p.company_id || ''), row = p.row || {}, plan = p.plan || {}, fill = p.fill || {};
    const guid = (x: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || '')) ? String(x) : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return j({ ok: false, error: 'Не указана фирма' }, 400);
    const skey = req.headers.get('x-server-key') || ''; let who = 'сервер';
    if (skey) { const { data: ok } = await sbSrv.rpc('server_robot_key_ok', { p_key: skey }); if (!ok) return j({ ok: false, error: 'Нет доступа' }, 401); }
    else {
      const { data: u } = await sbUser.auth.getUser(); if (!u || !u.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
      const { data: can } = await sbUser.rpc('bank_can_write', { p_company: id }); if (!can) return j({ ok: false, error: 'Записывать в 1С могут владелец, главный бухгалтер и оператор 1С' }, 403);
      who = u.user.email || 'пользователь';
    }
    const { data: f } = await sbSrv.from('companies').select('id,name,onec_url').eq('id', id).maybeSingle();
    if (!f || !f.onec_url) return j({ ok: false, error: 'У фирмы не указан адрес 1С' });
    if (!USER || !PASS) return j({ ok: false, error: 'Логин и пароль 1С не заданы в секретах кабинета' });
    const base = f.onec_url as string, S = SETS[String(plan.doc || '')], sum = Math.round(Number(row.sum) * 100) / 100, date = String(row.date || ''), account = String(p.account || '').toUpperCase();
    if (!S || S.dir !== row.dir) return j({ ok: false, code: 'bad', error: 'Правило не подходит к строке: документ и направление платежа не совпадают' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(sum > 0) || !/^[A-Z0-9]{10,34}$/.test(account)) return j({ ok: false, code: 'bad', error: 'В строке нет даты, суммы или счёта' });
    const op = String(plan.op || '').replace(/[^A-Za-zА-Яа-яЁё]/g, ''), bin = String(row.bin || '').replace(/\D/g, ''), n = String(row.n || '').trim().slice(0, 30);
    if (LATER.includes(op)) return j({ ok: false, code: 'later', error: 'Зарплату, отчисления и налоги робот пока не записывает — появится следующим шагом' });

    // 1) счёт фирмы
    const a = await call(base, "Catalog_БанковскиеСчета?$format=json&$select=Ref_Key,Owner,Owner_Type,DeletionMark&$filter=" + q("НомерСчета eq '" + account + "'"));
    if (a.status !== 200) return j({ ok: false, error: '1С: ' + (a.err || 'ошибка ' + a.status) });
    const acc = (a.js.value || []).find((x: any) => /Организации/.test(x.Owner_Type || '') && !x.DeletionMark);
    if (!acc) return j({ ok: false, code: 'no_acc', error: 'В 1С нет банковского счёта ' + account });
    // 2) нет ли уже такого документа (тот же счёт, день, сумма)
    const d = await call(base, S.set + '?$format=json&$select=Ref_Key,Number,НомерВходящегоДокумента&$filter=' + q("Date ge datetime'" + date + "T00:00:00' and Date le datetime'" + date + "T23:59:59' and DeletionMark eq false and СчетОрганизации_Key eq guid'" + acc.Ref_Key + "' and СуммаДокумента eq " + sum));
    if (d.status !== 200) return j({ ok: false, error: '1С: ' + (d.err || 'ошибка ' + d.status) });
    const dup = (d.js.value || []).find((x: any) => !n || String(x['НомерВходящегоДокумента'] || '').trim() === n);
    if (dup) return j({ ok: false, code: 'dup', key: dup.Ref_Key, error: 'Такой документ в 1С уже есть: №' + String(dup.Number).replace(/^0+/, '') });
    // 3) контрагент: выбранный пользователем или по БИН
    let cp: any = null;
    if (guid(fill.cp_key)) { const c = await call(base, "Catalog_Контрагенты(guid'" + fill.cp_key + "')?$format=json&$select=Ref_Key,Description,ОсновнойДоговорКонтрагента_Key"); cp = c.status === 200 ? c.js : null; }
    else if (bin.length === 12) { const c = await call(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description,ОсновнойДоговорКонтрагента_Key&$filter=' + q("ИдентификационныйКодЛичности eq '" + bin + "' and DeletionMark eq false")); cp = c.status === 200 ? (c.js.value || [])[0] : null; }
    const made: string[] = [];
    if (!cp && fill.cp_key === 'new') {
      if (bin.length !== 12) return j({ ok: false, code: 'no_cp', error: 'Создать контрагента нельзя: в выписке нет БИН/ИИН' });
      const ul = Number(bin[4]) >= 4, short = String(row.name || '').replace(/\s+/g, ' ').trim().slice(0, 100) || bin;
      let full = '';
      if (KGD_TOKEN) { try { const ctl = new AbortController(), tt = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch('https://kgd.gov.kz/services/isnaportalsync/public/taxpayer-data?taxpayerCode=' + bin + '&taxpayerType=' + (ul ? 'UL' : 'IP'), { headers: { 'X-Portal-Token': KGD_TOKEN, Accept: 'application/json' }, signal: ctl.signal }); clearTimeout(tt);
        const x = (await r.json())?.taxpayerPortalSearchResponses?.[0]; if (x && x.messageResult === 'SUCCESS') full = String(x.name || (x.fullName && typeof x.fullName === 'object' ? [x.fullName.lastName, x.fullName.firstName, x.fullName.middleName].filter(Boolean).join(' ') : x.fullName) || ''); } catch { /* КГД не ответил — берём из выписки */ } }
      const ip = !ul && /(^|\s)(ИП|индивидуальн)/i.test(short + ' ' + full);
      const nc: any = { Description: short, 'НаименованиеПолное': (full || short).slice(0, 300), 'ИдентификационныйКодЛичности': bin, 'ЮрФизЛицо': ul || ip ? 'ЮрЛицо' : 'ФизЛицо', 'Комментарий': MADE + (full ? '; полное наименование из КГД' : '') + ' — отнесите в нужную папку' };
      if (ip) nc['ИндивидуальныйПредпринимательАдвокатЧастныйНотариус'] = true;
      const w0 = await call(base, 'Catalog_Контрагенты?$format=json', 'POST', nc);
      if ((w0.status !== 201 && w0.status !== 200) || !w0.js?.Ref_Key) return j({ ok: false, code: 'cp_write', error: '1С не создала контрагента: ' + (w0.err || 'ошибка ' + w0.status) });
      cp = { Ref_Key: w0.js.Ref_Key, Description: short, 'ОсновнойДоговорКонтрагента_Key': '' }; made.push('контрагент создан');
      await call(base, "Catalog_Контрагенты(guid'" + cp.Ref_Key + "')?$format=json", 'PATCH', { 'ГоловнойКонтрагент_Key': cp.Ref_Key });
    }
    if (!cp) return j({ ok: false, code: 'no_cp', error: bin.length === 12 ? 'Контрагента с БИН/ИИН ' + bin + ' нет в 1С' : 'Не выбран контрагент' });
    // 4) образец для счетов учёта: прошлый проведённый документ с этим контрагентом и видом операции; если нет — такой же документ с любым контрагентом
    const tq = (cpf: string) => S.set + '?$format=json&$top=1&$orderby=' + q('Date desc') + '&$filter=' + q("Posted eq true and DeletionMark eq false" + cpf + (op ? " and ВидОперации eq '" + op + "'" : ''));
    let t = await call(base, tq(" and Контрагент_Key eq guid'" + cp.Ref_Key + "'")), tpl = t.status === 200 ? (t.js.value || [])[0] : null, own = !!tpl;
    if (!tpl) { t = await call(base, tq('')); tpl = t.status === 200 ? (t.js.value || [])[0] : null; }
    if (!tpl) return j({ ok: false, code: 'no_tpl', error: 'В 1С ещё нет ни одного проведённого документа «' + S.name + '» с таким видом операции — внесите первый вручную' });
    const ZERO = '00000000-0000-0000-0000-000000000000', main = cp['ОсновнойДоговорКонтрагента_Key'] && cp['ОсновнойДоговорКонтрагента_Key'] !== ZERO ? cp['ОсновнойДоговорКонтрагента_Key'] : '';
    const t0 = (tpl['РасшифровкаПлатежа'] || [])[0] || {};
    let contract = fill.contract_key === 'new' ? '' : guid(fill.contract_key) || (own ? guid(t0['ДоговорКонтрагента_Key']) && t0['ДоговорКонтрагента_Key'] !== ZERO ? t0['ДоговорКонтрагента_Key'] : '' : '') || main;
    const needContract = ['ОплатаПоставщику', 'ОплатаПокупателя', 'ВозвратДенежныхСредствПоставщиком', 'ВозвратДенежныхСредствПокупателю'].includes(op);
    if (fill.contract_key === 'new') {
      const nd: any = { Owner_Key: cp.Ref_Key, Description: 'Договор (прочее)', 'ВидДоговора': 'Прочее', 'Комментарий': MADE };
      if (acc.Owner) nd['Организация_Key'] = acc.Owner;
      if (tpl['ВалютаДокумента_Key']) nd['ВалютаВзаиморасчетов_Key'] = tpl['ВалютаДокумента_Key'];
      const w1 = await call(base, 'Catalog_ДоговорыКонтрагентов?$format=json', 'POST', nd);
      if ((w1.status !== 201 && w1.status !== 200) || !w1.js?.Ref_Key) return j({ ok: false, code: 'contract_write', error: '1С не создала договор: ' + (w1.err || 'ошибка ' + w1.status) + (made.length ? ' (контрагент уже создан)' : '') });
      contract = w1.js.Ref_Key; made.push('договор создан');
    }
    if (needContract && !contract) return j({ ok: false, code: 'no_contract', error: 'У контрагента «' + cp.Description + '» не выбран договор' });

    // 5) новый документ = образец + данные строки выписки
    const doc: any = {};
    for (const [k, v] of Object.entries(tpl)) { if (k.includes('@') || k === 'Ref_Key' || k === 'DataVersion' || k === 'Number') continue; doc[k] = Array.isArray(v) ? [] : v; }
    const note = [MADE, ...made, plan.name ? 'правило: ' + String(plan.name).slice(0, 80) : '', own ? '' : 'счета учёта взяты из другого такого же документа — проверьте', p.note ? String(p.note).slice(0, 150) : ''].filter(Boolean).join('; ');
    doc['Контрагент_Key'] = cp.Ref_Key; if (!own && 'СчетКонтрагента_Key' in doc) doc['СчетКонтрагента_Key'] = ZERO;
    const nm = String(row.name || cp.Description || '').slice(0, 200);
    if (S.dir === 'out') { if ('РННПолучателя' in doc) doc['РННПолучателя'] = bin; if ('ТекстПолучателя' in doc) doc['ТекстПолучателя'] = nm; }
    else { if ('РННПлательщика' in doc) doc['РННПлательщика'] = bin; if ('ТекстПлательщика' in doc) doc['ТекстПлательщика'] = nm; }
    if (op) doc['ВидОперации'] = op;
    Object.assign(doc, { Date: date + 'T12:00:00', Posted: false, DeletionMark: false, 'СуммаДокумента': sum, 'НомерВходящегоДокумента': n, 'ДатаВходящегоДокумента': date + 'T00:00:00', 'НазначениеПлатежа': String(row.purpose || '').slice(0, 1000), 'Комментарий': note, 'Оплачено': true, 'СчетОрганизации_Key': acc.Ref_Key });
    for (const k of ['ДатаВыписки', 'ДатаВалютирования', 'ДатаОплаты']) if (k in tpl) doc[k] = date + 'T00:00:00';
    if ('КодНазначенияПлатежа' in tpl && row.knp) doc['КодНазначенияПлатежа'] = String(row.knp).slice(0, 3);
    const l0 = (tpl['РасшифровкаПлатежа'] || [])[0];
    if (l0) { const l: any = { ...l0 }; delete l.Ref_Key; const os = Number(l0['СуммаПлатежа']) || 0, ov = Number(l0['СуммаНДС']) || 0;
      Object.assign(l, { LineNumber: '1', 'СуммаПлатежа': sum, 'СуммаВзаиморасчетов': sum, 'СуммаНДС': own && os && ov ? Math.round(sum * ov / os * 100) / 100 : 0, 'СчетНаОплату_Key': ZERO, 'ДоговорКонтрагента_Key': contract || ZERO });
      if (guid(fill.cf_key)) l['СтатьяДвиженияДенежныхСредств_Key'] = fill.cf_key;
      doc['РасшифровкаПлатежа'] = [l]; }
    // 6) один POST, затем проверка GET
    const w = await call(base, S.set + '?$format=json', 'POST', doc);
    if (w.status !== 201 && w.status !== 200) return j({ ok: false, code: 'write', error: '1С не приняла документ: ' + (w.err || 'ошибка ' + w.status) });
    const key = w.js && w.js.Ref_Key; if (!key) return j({ ok: false, code: 'write', error: '1С не вернула ссылку на документ' });
    let postErr = '';
    if (p.post) { const ps = await call(base, S.set + "(guid'" + key + "')/Post?PostingModeOperational=false", 'POST'); if (ps.status !== 200) postErr = ps.err || 'ошибка ' + ps.status; }
    const g = await call(base, S.set + "(guid'" + key + "')?$format=json&$select=Ref_Key,Number,Date,Posted,СуммаДокумента");
    const r = g.js || {};
    return j({ ok: true, key, ot: S.set.replace('Document_', ''), type: S.name, number: String(r.Number || '').replace(/^0+/, ''), posted: !!r.Posted, sum: r['СуммаДокумента'], template: String(tpl.Number || '').replace(/^0+/, ''), own_template: own, made, cp: cp.Description, cp_key: cp.Ref_Key, contract_key: contract, post_error: postErr, by: who });
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) }, 200);
  }
});
