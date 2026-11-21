// Робот «Выписки банка»: запись ОДНОГО банковского документа в 1С по строке выписки (POST через OData).
// verify_jwt выключен: доступ проверяется внутри — вошедший пользователь с правом записи (bank_can_write) либо служебный ключ сервера.
// Вызов: { company_id, account, post, row: { n, date, dir, sum, bin, name, knp, purpose }, plan: { doc, op, name }, fill?: { cp_key, contract_key, cf_key, acc_key } }
// fill — что пользователь выбрал в таблице: cp_key (или 'new' — создать контрагента), contract_key (или 'new' — создать договор вида «Прочее»), cf_key, acc_key (счёт учёта у «прочих» операций).
// Образца нет (такого документа в базе ещё не было) — документ собирается сам: шапка из любого банковского документа этого счёта,
// счета расчётов — по плану счетов (покупатели 1210/3510, поставщики 3310/1710), у «прочих» — счёт из строки; субконто — по видам субконто счёта.
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
// поля, которые есть только у исходящих (проверено по базе ИП БС ЕСЕП 21.11.2026): у входящих их нет — 1С не примет документ с ними
const HAS: Record<string, string[]> = { ppi: [], poi: [], ppo: ['РННПлательщика', 'РННПолучателя', 'ТекстПлательщика', 'ТекстПолучателя', 'КодНазначенияПлатежа', 'ДатаВалютирования'], poo: ['РННПлательщика', 'РННПолучателя', 'ТекстПлательщика', 'ТекстПолучателя'] };
const SIB: Record<string, string> = { ppi: 'poi', poi: 'ppi', ppo: 'poo', poo: 'ppo' };
// счета расчётов по виду операции (основной, авансы) — если в базе ещё не было такого документа
const CODES: Record<string, [string, string]> = { ОплатаПокупателя: ['1210', '3510'], ВозвратДенежныхСредствПокупателю: ['1210', '3510'], ОплатаПоставщику: ['3310', '1710'], ВозвратДенежныхСредствПоставщиком: ['3310', '1710'] };
// виды субконто (предопределённые, одинаковые во всех базах Бухгалтерии для Казахстана 3.0): контрагенты, договоры
const SUB_CP = '25d9067b-0d96-4f0d-a5fd-12d29fba60b8', SUB_CT = '9cb2d824-2779-426d-9e06-76c73f8cff50';
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
    const { data: f } = await sbSrv.from('companies').select('id,name,full_name,bin,onec_url').eq('id', id).maybeSingle();
    if (!f || !f.onec_url) return j({ ok: false, error: 'У фирмы не указан адрес 1С' });
    if (!USER || !PASS) return j({ ok: false, error: 'Логин и пароль 1С не заданы в секретах кабинета' });
    const base = f.onec_url as string, S = SETS[String(plan.doc || '')], sum = Math.round(Number(row.sum) * 100) / 100, date = String(row.date || ''), account = String(p.account || '').toUpperCase();
    if (!S || S.dir !== row.dir) return j({ ok: false, code: 'bad', error: 'Правило не подходит к строке: документ и направление платежа не совпадают' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(sum > 0) || !/^[A-Z0-9]{10,34}$/.test(account)) return j({ ok: false, code: 'bad', error: 'В строке нет даты, суммы или счёта' });
    const op = String(plan.op || '').replace(/[^A-Za-zА-Яа-яЁё]/g, ''), bin = String(row.bin || '').replace(/\D/g, ''), n = String(row.n || '').trim().slice(0, 30);
    if (LATER.includes(op)) return j({ ok: false, code: 'later', error: 'Зарплату, отчисления и налоги робот пока не записывает — появится следующим шагом' });

    // 1) счёт фирмы
    const a = await call(base, "Catalog_БанковскиеСчета?$format=json&$select=Ref_Key,Owner,Owner_Type,DeletionMark,ВалютаДенежныхСредств_Key&$filter=" + q("НомерСчета eq '" + account + "'"));
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
    let src: any = null, hdr: any = null, hdrSame = false, hdrAcc = false;
    const chartCache: Record<string, string> = {};
    const chart = async (code: string) => { if (code in chartCache) return chartCache[code]; const c = await call(base, 'ChartOfAccounts_Типовой?$format=json&$select=Ref_Key,Code&$filter=' + q("Code eq '" + code + "'")); return (chartCache[code] = c.status === 200 ? String(((c.js.value || [])[0] || {}).Ref_Key || '') : ''); };
    if (!tpl) { t = await call(base, tq('')); tpl = t.status === 200 ? (t.js.value || [])[0] : null; }
    // образца с таким видом операции нет — собираем документ сам (built): шапка из любого банковского документа этого счёта
    let built = false;
    if (!tpl) {
      const sib = SIB[String(plan.doc)], any = (set: string, f = '') => set + '?$format=json&$top=1&$orderby=' + q('Date desc') + '&$filter=' + q('Posted eq true and DeletionMark eq false' + f);
      // счета учёта — из документа-соседа (поручение ↔ ордер) с тем же видом операции, если такой есть
      const ts = await call(base, any(SETS[sib].set, op ? " and ВидОперации eq '" + op + "'" : '')); src = ts.status === 200 ? (ts.js.value || [])[0] || null : null;
      for (const [set, f] of [[S.set, " and СчетОрганизации_Key eq guid'" + acc.Ref_Key + "'"], [SETS[sib].set, " and СчетОрганизации_Key eq guid'" + acc.Ref_Key + "'"], [S.set, ''], [SETS[sib].set, '']] as [string, string][]) {
        const h = await call(base, any(set, f)); hdr = h.status === 200 ? (h.js.value || [])[0] || null : null; if (hdr) { hdrSame = set === S.set; hdrAcc = !!f; break; }
      }
      built = true;
      if (/^Прочее/.test(op) && !guid(fill.acc_key) && !(src && guid(src['СчетУчетаРасчетовСКонтрагентомБУ_Key']) && src['СчетУчетаРасчетовСКонтрагентомБУ_Key'] !== '00000000-0000-0000-0000-000000000000'))
        return j({ ok: false, code: 'need_acc', error: 'Прошлого такого документа в 1С нет — выберите в строке «Счёт учёта»' + (made.length ? ' (контрагент уже создан)' : '') });
    }
    const ZERO = '00000000-0000-0000-0000-000000000000', PROCH = /^Прочее/.test(op), main = cp['ОсновнойДоговорКонтрагента_Key'] && cp['ОсновнойДоговорКонтрагента_Key'] !== ZERO ? cp['ОсновнойДоговорКонтрагента_Key'] : '';
    const t0 = ((tpl || {})['РасшифровкаПлатежа'] || [])[0] || {};
    let contract = fill.contract_key === 'new' ? '' : guid(fill.contract_key) || (own ? guid(t0['ДоговорКонтрагента_Key']) && t0['ДоговорКонтрагента_Key'] !== ZERO ? t0['ДоговорКонтрагента_Key'] : '' : '') || main;
    const needContract = ['ОплатаПоставщику', 'ОплатаПокупателя', 'ВозвратДенежныхСредствПоставщиком', 'ВозвратДенежныхСредствПокупателю'].includes(op);
    if (fill.contract_key === 'new') {
      const nd: any = { Owner_Key: cp.Ref_Key, Description: 'Договор (прочее)', 'ВидДоговора': 'Прочее', 'Комментарий': MADE };
      if (acc.Owner) nd['Организация_Key'] = acc.Owner;
      const cur = (tpl || hdr || {})['ВалютаДокумента_Key'] || acc['ВалютаДенежныхСредств_Key']; if (cur) nd['ВалютаВзаиморасчетов_Key'] = cur;
      const w1 = await call(base, 'Catalog_ДоговорыКонтрагентов?$format=json', 'POST', nd);
      if ((w1.status !== 201 && w1.status !== 200) || !w1.js?.Ref_Key) return j({ ok: false, code: 'contract_write', error: '1С не создала договор: ' + (w1.err || 'ошибка ' + w1.status) + (made.length ? ' (контрагент уже создан)' : '') });
      contract = w1.js.Ref_Key; made.push('договор создан');
    }
    if (needContract && !contract) return j({ ok: false, code: 'no_contract', error: 'У контрагента «' + cp.Description + '» не выбран договор' });

    // 5) новый документ = образец + данные строки выписки (или собранный сам, если образца нет)
    const doc: any = {};
    const has = (k: string) => (tpl ? k in tpl : (HAS[String(plan.doc)] || []).includes(k));
    const nm = String(row.name || cp.Description || '').slice(0, 200);
    if (tpl) { for (const [k, v] of Object.entries(tpl)) { if (k.includes('@') || ['Ref_Key', 'DataVersion', 'Number', 'Автор_Key', 'Ответственный_Key'].includes(k)) continue; doc[k] = Array.isArray(v) ? [] : v; } }
    else {
      // шапка: организация, валюта, вид учёта НУ, счёт денег (1030) — из найденного документа; остальное заполняем сами
      const h = hdr || {};
      Object.assign(doc, { 'Организация_Key': acc.Owner, 'ВалютаДокумента_Key': h['ВалютаДокумента_Key'] || acc['ВалютаДенежныхСредств_Key'], 'УчитыватьКПН': h['УчитыватьКПН'] !== false });
      if (h['ВидУчетаНУ_Key']) doc['ВидУчетаНУ_Key'] = h['ВидУчетаНУ_Key'];
      doc['СчетБанк_Key'] = hdrAcc && h['СчетБанк_Key'] ? h['СчетБанк_Key'] : await chart('1030');
      if (!doc['СчетБанк_Key']) return j({ ok: false, code: 'no_acc', error: 'В плане счетов 1С не найден счёт 1030' });
      if (S.dir === 'out') { doc['РННПлательщика'] = String(f.bin || ''); doc['ТекстПлательщика'] = hdrSame && h['ТекстПлательщика'] ? h['ТекстПлательщика'] : String(f.full_name || f.name || '').slice(0, 200); }
      if (has('ДатаВалютирования')) doc['ДатаВалютирования'] = date + 'T00:00:00';
    }
    const note = [MADE, ...made, plan.name ? 'правило: ' + String(plan.name).slice(0, 80) : '', built ? 'прошлого такого документа в 1С не было — документ собран роботом, проверьте счета учёта' : own ? '' : 'счета учёта взяты из другого такого же документа — проверьте', p.note ? String(p.note).slice(0, 150) : ''].filter(Boolean).join('; ');
    doc['Контрагент_Key'] = cp.Ref_Key; if (!own && 'СчетКонтрагента_Key' in doc) doc['СчетКонтрагента_Key'] = ZERO;
    if (S.dir === 'out') { if (has('РННПолучателя')) doc['РННПолучателя'] = bin; if (has('ТекстПолучателя')) doc['ТекстПолучателя'] = nm; }
    else { if (has('РННПлательщика')) doc['РННПлательщика'] = bin; if (has('ТекстПлательщика')) doc['ТекстПлательщика'] = nm; }
    if (op) doc['ВидОперации'] = op;
    Object.assign(doc, { Date: date + 'T12:00:00', Posted: false, DeletionMark: false, 'СуммаДокумента': sum, 'НомерВходящегоДокумента': n, 'ДатаВходящегоДокумента': date + 'T00:00:00', 'НазначениеПлатежа': String(row.purpose || '').slice(0, 1000), 'Комментарий': note, 'Оплачено': true, 'СчетОрганизации_Key': acc.Ref_Key });
    doc['ДатаВыписки'] = date + 'T00:00:00'; for (const k of ['ДатаВалютирования', 'ДатаОплаты']) if (k in doc) doc[k] = date + 'T00:00:00';
    if (row.knp && has('КодНазначенияПлатежа')) doc['КодНазначенияПлатежа'] = String(row.knp).slice(0, 3);
    // строка расшифровки
    const l0 = tpl ? (tpl['РасшифровкаПлатежа'] || [])[0] : null, s0 = src ? (src['РасшифровкаПлатежа'] || [])[0] || {} : {}, h0 = hdr ? (hdr['РасшифровкаПлатежа'] || [])[0] || {} : {};
    const l: any = l0 ? { ...l0 } : { 'Сделка': '', 'Сделка_Type': 'StandardODATA.Undefined', 'КурсВзаиморасчетов': 1, 'КратностьВзаиморасчетов': '1', 'СтавкаНДС_Key': s0['СтавкаНДС_Key'] || h0['СтавкаНДС_Key'] || ZERO,
      'СчетУчетаРасчетовСКонтрагентомБУ_Key': ZERO, 'СчетУчетаРасчетовПоАвансам_Key': ZERO, 'СчетУчетаРасчетовСКонтрагентомНУ_Key': ZERO, 'СтатьяДвиженияДенежныхСредств_Key': ZERO };
    delete l.Ref_Key; const os = Number(l0 && l0['СуммаПлатежа']) || 0, ov = Number(l0 && l0['СуммаНДС']) || 0;
    Object.assign(l, { LineNumber: '1', 'СуммаПлатежа': sum, 'СуммаВзаиморасчетов': sum, 'СуммаНДС': own && os && ov ? Math.round(sum * ov / os * 100) / 100 : 0, 'СчетНаОплату_Key': ZERO, 'ДоговорКонтрагента_Key': contract || ZERO });
    if (!tpl && !PROCH) {
      // счета расчётов: из документа-соседа с тем же видом операции, иначе по плану счетов
      const [cb, ca] = CODES[op] || [];
      l['СчетУчетаРасчетовСКонтрагентомБУ_Key'] = guid(s0['СчетУчетаРасчетовСКонтрагентомБУ_Key']) && s0['СчетУчетаРасчетовСКонтрагентомБУ_Key'] !== ZERO ? s0['СчетУчетаРасчетовСКонтрагентомБУ_Key'] : cb ? await chart(cb) || ZERO : ZERO;
      l['СчетУчетаРасчетовПоАвансам_Key'] = guid(s0['СчетУчетаРасчетовПоАвансам_Key']) && s0['СчетУчетаРасчетовПоАвансам_Key'] !== ZERO ? s0['СчетУчетаРасчетовПоАвансам_Key'] : ca ? await chart(ca) || ZERO : ZERO;
      if (cb && l['СчетУчетаРасчетовСКонтрагентомБУ_Key'] === ZERO) return j({ ok: false, code: 'no_acc', error: 'В плане счетов 1С не найден счёт ' + cb });
    }
    // «прочие» операции: счёт учёта и статья — в шапке документа; счёт — выбранный в строке, иначе из образца или соседа
    if (PROCH) {
      const ak = guid(fill.acc_key) || (tpl && guid(tpl['СчетУчетаРасчетовСКонтрагентомБУ_Key']) && tpl['СчетУчетаРасчетовСКонтрагентомБУ_Key'] !== ZERO ? tpl['СчетУчетаРасчетовСКонтрагентомБУ_Key'] : '')
        || (src && guid(src['СчетУчетаРасчетовСКонтрагентомБУ_Key']) && src['СчетУчетаРасчетовСКонтрагентомБУ_Key'] !== ZERO ? src['СчетУчетаРасчетовСКонтрагентомБУ_Key'] : '');
      if (!ak) return j({ ok: false, code: 'need_acc', error: 'Прошлого такого документа в 1С нет — выберите в строке «Счёт учёта»' });
      if (!tpl || ak !== tpl['СчетУчетаРасчетовСКонтрагентомБУ_Key']) {
        const ca = await call(base, "ChartOfAccounts_Типовой(guid'" + ak + "')?$format=json&$select=Ref_Key,Code,СчетНУ_Key,ExtDimensionTypes");
        if (ca.status !== 200) return j({ ok: false, code: 'no_acc', error: 'Счёт учёта не найден в плане счетов 1С' });
        doc['СчетУчетаРасчетовСКонтрагентомБУ_Key'] = ak; doc['СчетУчетаРасчетовСКонтрагентомНУ_Key'] = guid(ca.js['СчетНУ_Key']) || ZERO;
        const side = S.dir === 'out' ? 'Дт' : 'Кт', ed = ca.js.ExtDimensionTypes || [];
        for (const pfx of ['БУ', 'НУ']) for (let i = 1; i <= 3; i++) {
          const tk = (ed[i - 1] || {}).ExtDimensionType_Key, nmF = 'Субконто' + side + pfx + i;
          const val = tk === SUB_CP ? [cp.Ref_Key, 'StandardODATA.Catalog_Контрагенты'] : tk === SUB_CT && contract ? [contract, 'StandardODATA.Catalog_ДоговорыКонтрагентов'] : ['', 'StandardODATA.Undefined'];
          doc[nmF] = val[0]; doc[nmF + '_Type'] = val[1];
        }
      } else {
        // образец с тем же счётом: контрагент и договор в субконто — свои
        const side = S.dir === 'out' ? 'Дт' : 'Кт';
        for (const pfx of ['БУ', 'НУ']) for (let i = 1; i <= 3; i++) { const nmF = 'Субконто' + side + pfx + i, ty = String(doc[nmF + '_Type'] || '');
          if (/Контрагенты$/.test(ty)) doc[nmF] = cp.Ref_Key; else if (/ДоговорыКонтрагентов$/.test(ty)) { if (contract) doc[nmF] = contract; else { doc[nmF] = ''; doc[nmF + '_Type'] = 'StandardODATA.Undefined'; } } }
      }
      if (guid(fill.cf_key)) doc['СтатьяДвиженияДенежныхСредств_Key'] = fill.cf_key;
      l['СтатьяДвиженияДенежныхСредств_Key'] = ZERO;
    } else if (guid(fill.cf_key)) l['СтатьяДвиженияДенежныхСредств_Key'] = fill.cf_key;
    doc['РасшифровкаПлатежа'] = [l];
    // автор и ответственный — пользователь «Робот» этой базы (из образца не копируем — там тот, кто делал образец)
    { const u = await call(base, 'Catalog_Пользователи?$format=json&$select=Ref_Key,Description,DeletionMark&$filter=' + q("substringof('Робот', Description) eq true and DeletionMark eq false"));
      const rb = u.status === 200 ? (u.js.value || []).find((x: any) => /^робот/i.test(String(x.Description || '').trim())) || (u.js.value || [])[0] : null;
      if (rb) { doc['Автор_Key'] = rb.Ref_Key; doc['Ответственный_Key'] = rb.Ref_Key; } }
    // 6) один POST, затем проверка GET
    const w = await call(base, S.set + '?$format=json', 'POST', doc);
    if (w.status !== 201 && w.status !== 200) return j({ ok: false, code: 'write', error: '1С не приняла документ: ' + (w.err || 'ошибка ' + w.status) });
    const key = w.js && w.js.Ref_Key; if (!key) return j({ ok: false, code: 'write', error: '1С не вернула ссылку на документ' });
    let postErr = '';
    if (p.post) { const ps = await call(base, S.set + "(guid'" + key + "')/Post?PostingModeOperational=false", 'POST'); if (ps.status !== 200) postErr = ps.err || 'ошибка ' + ps.status; }
    const g = await call(base, S.set + "(guid'" + key + "')?$format=json&$select=Ref_Key,Number,Date,Posted,СуммаДокумента");
    const r = g.js || {};
    return j({ ok: true, key, ot: S.set.replace('Document_', ''), type: S.name, number: String(r.Number || '').replace(/^0+/, ''), posted: !!r.Posted, sum: r['СуммаДокумента'], template: tpl ? String(tpl.Number || '').replace(/^0+/, '') : '', own_template: own, built, made, cp: cp.Description, cp_key: cp.Ref_Key, contract_key: contract, post_error: postErr, by: who });
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) }, 200);
  }
});
