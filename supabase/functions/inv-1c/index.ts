// Робот «Счета поставщиков»: счёт на оплату от поставщика → «Счёт на оплату поставщика» в 1С, по нему платёжное поручение исходящее и доверенность.
// verify_jwt выключен: доступ проверяется внутри (вошедший пользователь; запись — bank_can_write).
// Действия:
//   Обычный счёт из 1С кабинет разбирает сам, в браузере (cabinet/inv.js); ИИ — только если счёт нестандартный и разобрать не вышло.
//   read  { text }  — разбор текста счёта ИИ. Текст приходит из браузера уже без реквизитов: БИН, ИИК, БИК, телефоны и почта заменены
//                     метками [БИН1], [ИИК1]… (правило: номера счетов, телефоны и почту в ИИ не передавать). Здесь — вторая проверка.
//                     Сканы и фото кабинет не принимает (ИИ увидел бы реквизиты).
//   match { company_id, bin, name, iik, contract_no, number, date, items:[{name, unit, service}] } — только GET: поставщик по БИН, договоры,
//                     нет ли уже такого счёта, 5 ближайших позиций номенклатуры, заглушка «Внести», кому доверенность, счета фирмы.
//   write { company_id, inv, bin, name, iik, bik, cp_key, contract_key, contract_no, contract_date, items:[{key|'stub', name, unit, qty, price, sum, service}],
//           make:{ pp, poa }, acc_key, person_key, days, inv_key? } — запись: (поставщик, договор, заглушка — что надо создать) → счёт → платёжка → доверенность.
//   nom   { company_id, fields:{ name, full, parent, kind, ngroup, unit, rate, service } } — новая карточка номенклатуры по анкете (один POST).
//           Каждый POST один раз; не получилось — остановка с причиной и списком того, что уже создано. Документы не проводятся.
// Ничего из счёта в базе кабинета не хранится — после работы кабинет очищает экран.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '', PASS = Deno.env.get('ONEC_PASSWORD') || '', KEY = Deno.env.get('OPENAI_API_KEY') || '';
const MODELS = [...new Set([Deno.env.get('OPENAI_MODEL') || '', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'].filter(Boolean))];
const MADE = 'Создано роботом ESEP из счёта поставщика';
const STUB = 'Внести';
const ZERO = '00000000-0000-0000-0000-000000000000';
const SUB_CP = '25d9067b-0d96-4f0d-a5fd-12d29fba60b8', SUB_CT = '9cb2d824-2779-426d-9e06-76c73f8cff50';
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
const guid = (x: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || '')) ? String(x) : '';
const okW = (w: any) => (w.status === 201 || w.status === 200) && w.js?.Ref_Key;
const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const norm = (s: string) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/["'«»“”„()\[\],.;:!?*№#+]/g, ' ').replace(/\s+/g, ' ').trim();
const tri = (s: string) => { const t = '  ' + s + ' ', m = new Set<string>(); for (let i = 0; i < t.length - 2; i++) m.add(t.slice(i, i + 3)); return m; };
function sim(a: string, b: string) {
  const A = norm(a), B = norm(b); if (!A || !B) return 0; if (A === B) return 1;
  const ta = new Set(A.split(' ')), tb = new Set(B.split(' ')); let c = 0; ta.forEach((x) => { if (tb.has(x)) c++; });
  const ga = tri(A), gb = tri(B); let g = 0; ga.forEach((x) => { if (gb.has(x)) g++; });
  return 0.55 * (2 * c / (ta.size + tb.size)) + 0.45 * (2 * g / (ga.size + gb.size));
}
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dLong = (d: string) => { const [y, m, dd] = d.split('-'); return dd + ' ' + MONTHS[Number(m) - 1] + ' ' + y + ' г.'; };
const dShort = (d: string) => d ? d.split('-').reverse().join('.') : '';
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);   // Казахстан, UTC+5
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
// вторая проверка перед ИИ: всё, что похоже на ИИК, БИК, БИН/ИИН, телефон или почту, — заменяем меткой
const mask = (t: string) => String(t || '')
  .replace(/KZ\s?\d{2}(?:\s?[0-9A-Z]){16}/gi, '[ИИК]').replace(/\b[A-Z]{4}KZ[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g, '[БИК]')
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[ПОЧТА]').replace(/(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[ТЕЛ]')
  .replace(/(?<!\d)\d{12}(?!\d)/g, '[БИН]');

const PROMPT = `Ты читаешь текст счёта на оплату от поставщика (Казахстан). Реквизиты в тексте заменены метками ([БИН1], [ИИК1], [БИК1] и т.п.) — так и должно быть.
Верни ТОЛЬКО JSON такого вида:
{"number":"номер счёта","date":"ГГГГ-ММ-ДД","supplier":"название поставщика как в счёте","supplier_bin":"метка БИН поставщика, например [БИН1], или пусто","supplier_iik":"метка ИИК поставщика (бенефициара) или пусто","supplier_bik":"метка БИК банка поставщика или пусто","buyer_bin":"метка БИН покупателя или пусто","contract_no":"номер договора, если указан, иначе пусто","contract_date":"ГГГГ-ММ-ДД или пусто","knp":"КНП, если указан, иначе пусто","vat_rate":число (16, 12, 0) или null если без НДС,"vat_included":true/false,"vat_sum":число или null,"total":число — итог к оплате,"items":[{"name":"наименование как в счёте","unit":"ед. изм. как в счёте","qty":число,"price":число,"sum":число,"service":true если это работа или услуга}]}
Числа — без пробелов, точка как разделитель. Ничего не выдумывай: чего нет в тексте — пусто или null. Позиции — все строки таблицы товаров, без строк «Итого», «НДС», «Всего».`;

async function ai(text: string) {
  const messages = [{ role: 'system', content: PROMPT }, { role: 'user', content: text.slice(0, 30000) }];
  let last = '';
  for (const model of MODELS) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: 'json_object' } }) });
    const js = await r.json().catch(() => ({}));
    if (r.ok && js.choices?.[0]?.message?.content) { try { return JSON.parse(js.choices[0].message.content); } catch { last = 'ИИ вернул не JSON'; continue; } }
    last = js.error?.message || 'ошибка ' + r.status; if (r.status !== 404 && !/model/i.test(last)) break;
  }
  throw new Error('ИИ не прочитал счёт: ' + last);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!, sbSrv = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const sbUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any)), act = String(p.action || '');
    // служебный ключ сервера — только для проверки подбора (match, только чтение); всё остальное — от вошедшего администратора
    const skey = req.headers.get('x-server-key') || ''; let srv = false;
    if (skey && act === 'match') { const { data: ok } = await sbSrv.rpc('server_robot_key_ok', { p_key: skey }); if (!ok) return j({ ok: false, error: 'Нет доступа' }, 401); srv = true; }
    const { data: u } = srv ? { data: { user: { email: 'сервер' } } } as any : await sbUser.auth.getUser(); if (!u || !u.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
    if (!srv) { const { data: adm } = await sbUser.rpc('am_i_admin'); if (!adm) return j({ ok: false, error: 'Раздел пока в настройке' }, 403); }

    if (act === 'read') {
      if (!KEY) return j({ ok: false, error: 'ИИ не подключён: в секретах сервера нет ключа OPENAI_API_KEY' });
      const t = mask(String(p.text || '')); if (t.replace(/\s/g, '').length < 40) return j({ ok: false, error: 'В файле почти нет текста — похоже на скан. Пришлите счёт PDF из программы, Excel или Word.' });
      const x = await ai(t);
      const items = (Array.isArray(x.items) ? x.items : []).map((i: any) => ({ name: String(i.name || '').trim().slice(0, 300), unit: String(i.unit || '').trim().slice(0, 20), qty: Number(i.qty) || 0, price: r2(i.price), sum: r2(i.sum), service: !!i.service })).filter((i: any) => i.name);
      return j({ ok: true, inv: { number: String(x.number || '').trim().slice(0, 30), date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) ? x.date : '', supplier: String(x.supplier || '').trim().slice(0, 200), supplier_bin: String(x.supplier_bin || ''), supplier_iik: String(x.supplier_iik || ''), supplier_bik: String(x.supplier_bik || ''), buyer_bin: String(x.buyer_bin || ''), contract_no: String(x.contract_no || '').trim().slice(0, 50), contract_date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.contract_date)) ? x.contract_date : '', knp: String(x.knp || '').replace(/\D/g, '').slice(0, 3), vat_rate: x.vat_rate == null ? null : Number(x.vat_rate), vat_included: x.vat_included !== false, vat_sum: x.vat_sum == null ? null : r2(x.vat_sum), total: r2(x.total), items } });
    }

    const id = String(p.company_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return j({ ok: false, error: 'Не указана фирма' }, 400);
    const { data: can } = srv ? { data: true } : await sbUser.rpc('bank_can_write', { p_company: id }); if (!can) return j({ ok: false, error: 'Записывать в 1С могут владелец, главный бухгалтер и оператор 1С' }, 403);
    const { data: f } = await sbSrv.from('companies').select('id,name,full_name,bin,onec_url').eq('id', id).maybeSingle();
    if (!f || !f.onec_url) return j({ ok: false, error: 'У фирмы не указан адрес 1С' });
    if (!USER || !PASS) return j({ ok: false, error: 'Логин и пароль 1С не заданы в секретах кабинета' });
    const base = f.onec_url as string, bin = String(p.bin || '').replace(/\D/g, '');
    const get = async (path: string) => { const r = await call(base, path); if (r.status !== 200) throw new Error('1С: ' + (r.err || 'ошибка ' + r.status)); return r.js; };
    const list = async (path: string) => ((await get(path)).value || []) as any[];
    const cpByBin = async () => bin.length === 12 ? (await list('Catalog_Контрагенты?$format=json&$select=Ref_Key,Description,НаименованиеПолное,ОсновнойДоговорКонтрагента_Key&$filter=' + q("ИдентификационныйКодЛичности eq '" + bin + "' and DeletionMark eq false")))[0] || null : null;
    const tplInv = async () => (await list('Document_СчетНаОплатуПоставщика?$format=json&$top=1&$orderby=' + q('Date desc') + '&$filter=' + q('DeletionMark eq false')))[0] || null;
    const firmAccs = async (org: string) => org ? await list('Catalog_БанковскиеСчета?$format=json&$select=Ref_Key,НомерСчета,Description,Банк_Key,ВалютаДенежныхСредств_Key&$filter=' + q("Owner eq cast(guid'" + org + "', 'Catalog_Организации') and DeletionMark eq false")) : [];
    const orgKey = async (tpl: any) => tpl?.['Организация_Key'] || ((await list('Catalog_Организации?$format=json&$top=1&$select=Ref_Key&$filter=' + q('DeletionMark eq false')))[0] || {}).Ref_Key || '';
    const contractsOf = async (ck: string) => (await list('Catalog_ДоговорыКонтрагентов?$format=json&$select=Ref_Key,Description,НомерДоговора,ДатаДоговора,ВидДоговора&$filter=' + q("Owner_Key eq guid'" + ck + "' and DeletionMark eq false and IsFolder eq false"))).map((c: any) => ({ key: c.Ref_Key, name: c.Description, no: String(c['НомерДоговора'] || '').trim(), kind: c['ВидДоговора'] }));
    const pickContract = (cs: any[], no: string, main: string) => {
      const n = norm(no); const hit = n ? cs.find((c) => norm(c.no) === n || norm(c.name).includes(n)) : null;
      return hit ? hit.key : main && cs.some((c) => c.key === main) ? main : (cs.find((c) => c.kind === 'СПоставщиком') || cs[0] || {}).key || '';
    };

    if (act === 'match') {
      const tpl = await tplInv(), org = await orgKey(tpl), cp = await cpByBin();
      const contracts = cp ? await contractsOf(cp.Ref_Key) : [];
      const num = String(p.number || '').trim();
      const dup = cp && num ? (await list('Document_СчетНаОплатуПоставщика?$format=json&$top=1&$select=Ref_Key,Number,Date&$filter=' + q("Контрагент_Key eq guid'" + cp.Ref_Key + "' and НомерВходящегоДокумента eq '" + num.replace(/'/g, "''") + "' and DeletionMark eq false")))[0] || null : null;
      // номенклатура (все позиции, без папок) — для точного совпадения и 5 ближайших
      const nom: any[] = []; for (let s = 0; s < 40000; s += 5000) { const part = await list('Catalog_Номенклатура?$format=json&$top=5000&$skip=' + s + '&$select=Ref_Key,Description,Услуга,БазоваяЕдиницаИзмерения_Key&$filter=' + q('IsFolder eq false and DeletionMark eq false')); nom.push(...part); if (part.length < 5000) break; }
      const units = await list('Catalog_КлассификаторЕдиницИзмерения?$format=json&$select=Ref_Key,Description');
      const uName = (k: string) => (units.find((x: any) => x.Ref_Key === k) || {}).Description || '';
      const stub = nom.find((x) => norm(x.Description) === norm(STUB)) || null;
      const items = (Array.isArray(p.items) ? p.items : []).slice(0, 200).map((it: any) => {
        const n = norm(it.name), exact = nom.find((x) => norm(x.Description) === n) || null;
        const cand = exact ? [] : nom.map((x) => ({ x, s: sim(it.name, x.Description) })).filter((o) => o.s >= 0.2).sort((a, b) => b.s - a.s).slice(0, 5).map((o) => ({ key: o.x.Ref_Key, name: o.x.Description, unit: uName(o.x['БазоваяЕдиницаИзмерения_Key']), service: !!o.x['Услуга'], score: Math.round(o.s * 100) }));
        return { exact: exact ? { key: exact.Ref_Key, name: exact.Description, unit: uName(exact['БазоваяЕдиницаИзмерения_Key']), service: !!exact['Услуга'] } : null, cand };
      });
      // кому доверенность: люди из последних доверенностей фирмы
      const poas = await list('Document_Доверенность?$format=json&$top=30&$orderby=' + q('Date desc') + '&$select=ФизЛицо_Key&$filter=' + q('DeletionMark eq false'));
      const pk = [...new Set(poas.map((x: any) => x['ФизЛицо_Key']).filter((k: string) => k && k !== ZERO))].slice(0, 8), persons: any[] = [];
      for (const k of pk) { const r = await call(base, "Catalog_ФизическиеЛица(guid'" + k + "')?$format=json&$select=Ref_Key,Description"); if (r.status === 200) persons.push({ key: k, name: r.js.Description }); }
      if (!persons.length) (await list('Catalog_ФизическиеЛица?$format=json&$top=30&$select=Ref_Key,Description&$filter=' + q('IsFolder eq false and DeletionMark eq false'))).forEach((x: any) => persons.push({ key: x.Ref_Key, name: x.Description }));
      const accs = (await firmAccs(org)).map((a: any) => ({ key: a.Ref_Key, no: a['НомерСчета'], name: a.Description }));
      const lastPp = (await list('Document_ПлатежноеПоручениеИсходящее?$format=json&$top=1&$orderby=' + q('Date desc') + '&$select=СчетОрганизации_Key&$filter=' + q("DeletionMark eq false and ВидОперации eq 'ОплатаПоставщику'")))[0];
      const accKey = (lastPp && accs.some((a) => a.key === lastPp['СчетОрганизации_Key']) ? lastPp['СчетОрганизации_Key'] : '') || (tpl && accs.some((a) => a.key === tpl['СтруктурнаяЕдиница']) ? tpl['СтруктурнаяЕдиница'] : '') || (accs[0] || {}).key || '';
      const iiks = cp ? (await list('Catalog_БанковскиеСчета?$format=json&$select=НомерСчета&$filter=' + q("Owner eq cast(guid'" + cp.Ref_Key + "', 'Catalog_Контрагенты') and DeletionMark eq false"))).map((x: any) => x['НомерСчета']) : [];
      // справочники для анкеты «Создать номенклатуру»
      const groups = (await list('Catalog_Номенклатура?$format=json&$select=Ref_Key,Description,Parent_Key&$filter=' + q('IsFolder eq true and DeletionMark eq false'))).map((x: any) => ({ key: x.Ref_Key, name: x.Description, parent: x.Parent_Key }));
      const kinds = (await list('Catalog_ВидыНоменклатуры?$format=json&$select=Ref_Key,Description,Услуга&$filter=' + q('DeletionMark eq false')).catch(() => [])).map((x: any) => ({ key: x.Ref_Key, name: x.Description, service: !!x['Услуга'] }));
      const ngroups = (await list('Catalog_НоменклатурныеГруппы?$format=json&$select=Ref_Key,Description&$filter=' + q('DeletionMark eq false')).catch(() => [])).map((x: any) => ({ key: x.Ref_Key, name: x.Description }));
      const rates = (await list('Catalog_СтавкиНДС?$format=json&$select=Ref_Key,Description,Ставка&$filter=' + q('DeletionMark eq false'))).map((x: any) => ({ key: x.Ref_Key, name: x.Description, rate: Number(x['Ставка']) || 0 }));
      // что обычно ставят в этой базе: по последнему счёту поставщика
      const t0 = ((tpl || {})['Товары'] || [])[0] || ((tpl || {})['Услуги'] || [])[0];
      const ref = t0 && guid(t0['Номенклатура_Key']) ? (await call(base, "Catalog_Номенклатура(guid'" + t0['Номенклатура_Key'] + "')?$format=json&$select=Parent_Key,ВидНоменклатуры_Key,НоменклатурнаяГруппа_Key,СтавкаНДС_Key,БазоваяЕдиницаИзмерения_Key")).js : null;
      const dict = { groups, kinds, ngroups, rates, units: units.map((x: any) => ({ key: x.Ref_Key, name: x.Description })), def: ref ? { parent: ref.Parent_Key, kind: ref['ВидНоменклатуры_Key'], ngroup: ref['НоменклатурнаяГруппа_Key'], rate: ref['СтавкаНДС_Key'], unit: ref['БазоваяЕдиницаИзмерения_Key'] } : {} };
      return j({ ok: true, dict, cp: cp ? { key: cp.Ref_Key, name: cp.Description } : null, contracts, contract_key: cp ? pickContract(contracts, String(p.contract_no || ''), cp['ОсновнойДоговорКонтрагента_Key']) : '',
        dup: dup ? { key: dup.Ref_Key, number: String(dup.Number).replace(/^0+/, ''), date: String(dup.Date).slice(0, 10) } : null, items, stub: stub ? { key: stub.Ref_Key, name: stub.Description } : null,
        persons, accs, acc_key: accKey, vat: tpl ? { use: tpl['УчитыватьНДС'] !== false, incl: tpl['СуммаВключаетНДС'] !== false } : null, has_tpl: !!tpl, iik_known: iiks.includes(String(p.iik || '').toUpperCase()) });
    }

    if (act === 'nom') {
      const x = p.fields || {}, name = String(x.name || '').replace(/\s+/g, ' ').trim();
      if (name.length < 2) return j({ ok: false, error: 'Укажите наименование' });
      const ex = (await list('Catalog_Номенклатура?$format=json&$top=1&$select=Ref_Key,Description&$filter=' + q("Description eq '" + name.slice(0, 100).replace(/'/g, "''") + "' and DeletionMark eq false")))[0];
      if (ex) return j({ ok: true, key: ex.Ref_Key, name: ex.Description, existed: true });
      const nn: any = { Description: name.slice(0, 100), 'НаименованиеПолное': String(x.full || name).slice(0, 1000), 'Услуга': !!x.service, 'Комментарий': MADE + ' — анкета в кабинете, ' + (u.user.email || '') };
      if (guid(x.parent)) nn['Parent_Key'] = x.parent; if (guid(x.kind)) nn['ВидНоменклатуры_Key'] = x.kind; if (guid(x.ngroup)) nn['НоменклатурнаяГруппа_Key'] = x.ngroup;
      if (guid(x.unit)) nn['БазоваяЕдиницаИзмерения_Key'] = x.unit; if (guid(x.rate)) nn['СтавкаНДС_Key'] = x.rate;
      const w = await call(base, 'Catalog_Номенклатура?$format=json', 'POST', nn);
      if (!okW(w)) return j({ ok: false, error: '1С не создала номенклатуру: ' + (w.err || 'ошибка ' + w.status) });
      return j({ ok: true, key: w.js.Ref_Key, name: nn.Description, created: true });
    }
    if (act !== 'write') return j({ ok: false, error: 'Неизвестное действие' }, 400);
    // ---------- запись ----------
    const inv = p.inv || {}, make = p.make || {}, made: string[] = [], who = u.user.email || 'пользователь';
    const number = String(inv.number || '').trim().slice(0, 30), idate = /^\d{4}-\d{2}-\d{2}$/.test(String(inv.date)) ? String(inv.date) : '';
    const rows = (Array.isArray(p.items) ? p.items : []).filter((i: any) => i && i.name && Number(i.qty) > 0).slice(0, 200);
    if (!number || !idate) return j({ ok: false, error: 'В счёте нет номера или даты' });
    if (!rows.length && !guid(p.inv_key)) return j({ ok: false, error: 'В счёте нет позиций' });
    const fail = (error: string, extra: any = {}) => j({ ok: false, error, made, ...extra });
    const tpl = await tplInv(), org = await orgKey(tpl);
    if (!org) return fail('В 1С не найдена организация');
    const accs = await firmAccs(org), acc = accs.find((a: any) => a.Ref_Key === guid(p.acc_key)) || accs[0];
    if (!acc) return fail('У организации в 1С нет банковского счёта');
    const cur = tpl?.['ВалютаДокумента_Key'] || acc['ВалютаДенежныхСредств_Key'];
    // автор и ответственный — пользователь «Робот»
    const robot = (await list('Catalog_Пользователи?$format=json&$select=Ref_Key,Description&$filter=' + q("substringof('Робот', Description) eq true and DeletionMark eq false")))[0];
    const stamp = (d: any) => { if (robot) { d['Автор_Key'] = robot.Ref_Key; d['Ответственный_Key'] = robot.Ref_Key; } return d; };

    // 1) поставщик
    let cp: any = await cpByBin();
    if (!cp && p.cp_key === 'new') {
      if (bin.length !== 12) return fail('Создать поставщика нельзя: в счёте нет БИН/ИИН');
      const short = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 100) || bin, ul = Number(bin[4]) >= 4, ip = !ul && /(^|\s)(ИП|индивидуальн)/i.test(short);
      const nc: any = { Description: short, 'НаименованиеПолное': short, 'ИдентификационныйКодЛичности': bin, 'ЮрФизЛицо': ul || ip ? 'ЮрЛицо' : 'ФизЛицо', 'Комментарий': MADE + ' — отнесите в нужную папку' };
      if (ip) nc['ИндивидуальныйПредпринимательАдвокатЧастныйНотариус'] = true;
      const w = await call(base, 'Catalog_Контрагенты?$format=json', 'POST', nc);
      if (!okW(w)) return fail('1С не создала поставщика: ' + (w.err || 'ошибка ' + w.status));
      cp = { Ref_Key: w.js.Ref_Key, Description: short, 'ОсновнойДоговорКонтрагента_Key': '' }; made.push('поставщик «' + short + '» создан');
      await call(base, "Catalog_Контрагенты(guid'" + cp.Ref_Key + "')?$format=json", 'PATCH', { 'ГоловнойКонтрагент_Key': cp.Ref_Key });
    }
    if (!cp) return fail(bin.length === 12 ? 'Поставщика с БИН/ИИН ' + bin + ' нет в 1С' : 'В счёте нет БИН/ИИН поставщика');
    // 2) договор — только этого поставщика
    const cs = await contractsOf(cp.Ref_Key), cno = String(p.contract_no || '').trim().slice(0, 50), cdt = /^\d{4}-\d{2}-\d{2}$/.test(String(p.contract_date)) ? String(p.contract_date) : '';
    let contract = guid(p.contract_key) && cs.some((c) => c.key === p.contract_key) ? String(p.contract_key) : p.contract_key === 'new' ? '' : pickContract(cs, cno, cp['ОсновнойДоговорКонтрагента_Key']);
    if (!contract) {
      const nd: any = { Owner_Key: cp.Ref_Key, Description: cno ? 'Договор №' + cno + (cdt ? ' от ' + dShort(cdt) : '') : 'Без договора', 'ВидДоговора': 'СПоставщиком', 'Организация_Key': org, 'Комментарий': MADE };
      if (cno) nd['НомерДоговора'] = cno; if (cdt) nd['ДатаДоговора'] = cdt + 'T00:00:00'; if (cur) nd['ВалютаВзаиморасчетов_Key'] = cur;
      const w = await call(base, 'Catalog_ДоговорыКонтрагентов?$format=json', 'POST', nd);
      if (!okW(w)) return fail('1С не создала договор: ' + (w.err || 'ошибка ' + w.status));
      contract = w.js.Ref_Key; made.push('договор «' + nd.Description + '» создан');
    }
    const ctrName = (cs.find((c) => c.key === contract) || {}).name || (cno ? 'Договор №' + cno : '');

    // 3) ставки НДС, единицы, номенклатура
    const rates = await list('Catalog_СтавкиНДС?$format=json&$select=Ref_Key,Description,Ставка,ДляОсвобожденногоОборота,МестоРеализацииНеРК&$filter=' + q('DeletionMark eq false'));
    const vr = inv.vat_rate == null || Number(inv.vat_rate) === 0 && !inv.vat_sum ? null : Number(inv.vat_rate);
    const rate = vr == null ? rates.find((x: any) => x['ДляОсвобожденногоОборота']) : rates.find((x: any) => Number(x['Ставка']) === vr && !x['ДляОсвобожденногоОборота'] && !x['МестоРеализацииНеРК']);
    const incl = inv.vat_included !== false, vatOf = (s: number) => vr ? r2(incl ? s * vr / (100 + vr) : s * vr / 100) : 0;
    const units = await list('Catalog_КлассификаторЕдиницИзмерения?$format=json&$select=Ref_Key,Description,НаименованиеПолное');
    const unitKey = (u: string) => { const n = norm(u).replace(/\s/g, ''); if (!n) return ''; const m = units.find((x: any) => norm(x.Description).replace(/\s/g, '') === n || norm(x['НаименованиеПолное']).replace(/\s/g, '') === n) || units.find((x: any) => n.startsWith(norm(x.Description).replace(/\s/g, '')) && norm(x.Description).length >= 2); return m ? m.Ref_Key : ''; };
    const t0 = ((tpl || {})['Товары'] || [])[0] || ((tpl || {})['Услуги'] || [])[0];
    const refNom = t0 && guid(t0['Номенклатура_Key']) ? (await call(base, "Catalog_Номенклатура(guid'" + t0['Номенклатура_Key'] + "')?$format=json&$select=ВидНоменклатуры_Key,НоменклатурнаяГруппа_Key,БазоваяЕдиницаИзмерения_Key")).js : null;
    const nomCache: Record<string, any> = {};
    const nomInfo = async (k: string) => nomCache[k] || (nomCache[k] = (await call(base, "Catalog_Номенклатура(guid'" + k + "')?$format=json&$select=Ref_Key,Description,Услуга,БазоваяЕдиницаИзмерения_Key,СтавкаНДС_Key")).js || {});
    const newNom = async (name: string, unit: string, service: boolean, comment: string) => {
      const nn: any = { Description: name.slice(0, 100), 'НаименованиеПолное': name.slice(0, 1000), 'Услуга': service, 'Комментарий': comment };
      const uk = unitKey(unit) || refNom?.['БазоваяЕдиницаИзмерения_Key']; if (uk) nn['БазоваяЕдиницаИзмерения_Key'] = uk;
      if (refNom?.['ВидНоменклатуры_Key']) nn['ВидНоменклатуры_Key'] = refNom['ВидНоменклатуры_Key']; if (refNom?.['НоменклатурнаяГруппа_Key']) nn['НоменклатурнаяГруппа_Key'] = refNom['НоменклатурнаяГруппа_Key'];
      if (rate) nn['СтавкаНДС_Key'] = rate.Ref_Key;
      const w = await call(base, 'Catalog_Номенклатура?$format=json', 'POST', nn); if (!okW(w)) throw new Error('1С не создала номенклатуру «' + name.slice(0, 60) + '»: ' + (w.err || 'ошибка ' + w.status));
      return { Ref_Key: w.js.Ref_Key, Description: nn.Description, 'Услуга': service, 'БазоваяЕдиницаИзмерения_Key': uk || '' };
    };
    let stubNom: any = null;
    const getStub = async () => {
      if (stubNom) return stubNom;
      const s = (await list('Catalog_Номенклатура?$format=json&$top=1&$select=Ref_Key,Description,Услуга,БазоваяЕдиницаИзмерения_Key&$filter=' + q("Description eq '" + STUB + "' and DeletionMark eq false")))[0];
      if (s) return (stubNom = s);
      stubNom = await newNom(STUB, 'шт', false, 'Заглушка робота ESEP для счетов поставщиков: настоящие наименования — в комментарии счёта и в доверенности'); made.push('заглушка «' + STUB + '» создана'); return stubNom;
    };
    let invKey = guid(p.inv_key), invNo = '', lines: any[] = [];
    try {
      for (const it of rows) {
        const name = String(it.name).trim(), qty = Number(it.qty), sum = r2(it.sum || qty * Number(it.price)), price = r2(it.price || (qty ? sum / qty : 0));
        let n: any;
        if (it.key === 'stub') n = await getStub();
        else if (guid(it.key)) n = await nomInfo(it.key);
        if (!n || !n.Ref_Key) return fail('Позиция «' + name.slice(0, 60) + '»: выберите номенклатуру, создайте её по анкете или поставьте заглушку «' + STUB + '»');
        lines.push({ n, name, qty, price, sum, unit: String(it.unit || ''), stub: it.key === 'stub', service: !!n['Услуга'] || (it.key === 'stub' && !!it.service) });
      }
    } catch (e) { return fail(String((e as Error).message || e)); }
    const total = r2(lines.reduce((a, l) => a + l.sum, 0)) || r2(inv.total), vatSum = r2(lines.reduce((a, l) => a + vatOf(l.sum), 0));
    const stubNames = lines.filter((l) => l.stub).map((l) => l.name);
    const brief = (lines.length ? lines : [{ name: String(inv.purpose || 'товары') }]).map((l: any) => l.name).slice(0, 3).join(', ').slice(0, 160) + (lines.length > 3 ? ' и др.' : '');

    // 4) счёт на оплату поставщика
    if (!invKey) {
      const doc: any = stamp({ Date: today() + 'T12:00:00', Posted: false, DeletionMark: false, 'Организация_Key': org, 'Контрагент_Key': cp.Ref_Key, 'ДоговорКонтрагента_Key': contract,
        'ВалютаДокумента_Key': cur, 'КурсВзаиморасчетов': 1, 'КратностьВзаиморасчетов': '1', 'СуммаВключаетНДС': incl, 'УчитыватьНДС': tpl ? tpl['УчитыватьНДС'] !== false : !!vr,
        'НомерВходящегоДокумента': number, 'ДатаВходящегоДокумента': idate + 'T00:00:00', 'СтруктурнаяЕдиница': acc.Ref_Key, 'СтруктурнаяЕдиница_Type': 'StandardODATA.Catalog_БанковскиеСчета',
        'КодНазначенияПлатежа': String(inv.knp || tpl?.['КодНазначенияПлатежа'] || '710'), 'СуммаДокумента': total,
        'Комментарий': (MADE + ' №' + number + ' от ' + dShort(idate) + (stubNames.length ? '; «' + STUB + '» вместо: ' + stubNames.join('; ') : '')).slice(0, 1000), 'Товары': [], 'Услуги': [] });
      if (tpl?.['Склад_Key'] && tpl['Склад_Key'] !== ZERO) doc['Склад_Key'] = tpl['Склад_Key'];
      lines.forEach((l) => {
        const vk = rate ? rate.Ref_Key : l.n['СтавкаНДС_Key'];
        if (l.service) doc['Услуги'].push({ LineNumber: String(doc['Услуги'].length + 1), 'Номенклатура_Key': l.n.Ref_Key, 'Содержание': l.name.slice(0, 1000), 'Количество': l.qty, 'Цена': l.price, 'Сумма': l.sum, 'СтавкаНДС_Key': vk, 'СуммаНДС': vatOf(l.sum) });
        else doc['Товары'].push({ LineNumber: String(doc['Товары'].length + 1), 'Номенклатура_Key': l.n.Ref_Key, 'ЕдиницаИзмерения_Key': l.n['БазоваяЕдиницаИзмерения_Key'] || unitKey(l.unit), 'Коэффициент': 1, 'Количество': l.qty, 'Цена': l.price, 'Сумма': l.sum, 'СтавкаНДС_Key': vk, 'СуммаНДС': vatOf(l.sum) });
      });
      const w = await call(base, 'Document_СчетНаОплатуПоставщика?$format=json', 'POST', doc);
      if (!okW(w)) return fail('1С не записала счёт на оплату поставщика: ' + (w.err || 'ошибка ' + w.status));
      invKey = w.js.Ref_Key; invNo = String(w.js.Number || '').replace(/^0+/, ''); made.push('счёт на оплату поставщика №' + invNo + ' создан');
    } else { const r = await call(base, "Document_СчетНаОплатуПоставщика(guid'" + invKey + "')?$format=json&$select=Number"); invNo = String(r.js?.Number || '').replace(/^0+/, ''); }
    const basis = 'счёт на оплату поставщика № ' + number + ' от ' + dShort(idate) + (ctrName && !/^без договора$/i.test(ctrName) ? ', ' + ctrName : '');
    const res: any = { ok: true, made, inv: { key: invKey, number: invNo }, by: who };

    // 5) платёжное поручение исходящее
    let cpAcc: any = null; const iik = String(p.iik || '').toUpperCase().replace(/\s/g, ''), bik = String(p.bik || '').toUpperCase().replace(/\s/g, '');
    if (make.pp) {
      if (/^KZ[0-9A-Z]{18}$/.test(iik)) {
        cpAcc = (await list('Catalog_БанковскиеСчета?$format=json&$select=Ref_Key,Owner,Банк_Key,DeletionMark&$filter=' + q("НомерСчета eq '" + iik + "'"))).find((x: any) => x.Owner === cp.Ref_Key && !x.DeletionMark) || null;
        if (!cpAcc && /^[A-Z0-9]{8,11}$/.test(bik)) {
          const b0 = (await list('Catalog_Банки?$format=json&$select=Ref_Key,Description,БИК&$filter=' + q("БИК eq '" + bik + "' and DeletionMark eq false")))[0];
          if (b0) { const w = await call(base, 'Catalog_БанковскиеСчета?$format=json', 'POST', { Owner: cp.Ref_Key, Owner_Type: 'StandardODATA.Catalog_Контрагенты', Description: (iik + ' в ' + String(b0.Description || '')).slice(0, 100), 'НомерСчета': iik, 'Банк_Key': b0.Ref_Key, 'ВидСчета': 'Расчетный', 'ВалютаДенежныхСредств_Key': cur });
            if (okW(w)) { cpAcc = { Ref_Key: w.js.Ref_Key, Банк_Key: b0.Ref_Key }; made.push('счёт поставщика ' + iik + ' заведён'); } }
        }
      }
      if (!cpAcc) res.pp_note = 'счёт поставщика (ИИК) не заполнен — ' + (!/^KZ/.test(iik) ? 'в счёте нет ИИК' : 'банка с таким БИК нет в справочнике «Банки»');
      // образец: прошлая проведённая оплата поставщику (этому, иначе любому) — счета учёта и статья ДДС
      const tq = (cf: string) => 'Document_ПлатежноеПоручениеИсходящее?$format=json&$top=1&$orderby=' + q('Date desc') + '&$filter=' + q("Posted eq true and DeletionMark eq false and ВидОперации eq 'ОплатаПоставщику'" + cf);
      const pt = (await list(tq(" and Контрагент_Key eq guid'" + cp.Ref_Key + "'")))[0] || (await list(tq('')))[0] || null, pl = ((pt || {})['РасшифровкаПлатежа'] || [])[0] || {};
      const chart = async (code: string) => (await list('ChartOfAccounts_Типовой?$format=json&$top=1&$select=Ref_Key,СчетНУ_Key&$filter=' + q("Code eq '" + code + "'")))[0] || null;
      let a1 = pl['СчетУчетаРасчетовСКонтрагентомБУ_Key'], a2 = pl['СчетУчетаРасчетовПоАвансам_Key'], a3 = pl['СчетУчетаРасчетовСКонтрагентомНУ_Key'];
      if (!guid(a1) || a1 === ZERO) { const c1 = await chart('3310'), c2 = await chart('1710'); a1 = c1?.Ref_Key; a3 = c1?.['СчетНУ_Key']; a2 = c2?.Ref_Key; }
      const bank = pt && pt['СчетБанк_Key'] && pt['СчетБанк_Key'] !== ZERO ? pt['СчетБанк_Key'] : (await chart('1030'))?.Ref_Key;
      const purpose = ('Оплата за ' + brief + ' по счету на оплату № ' + number + ' от ' + dShort(idate) + (ctrName && !/^без договора$/i.test(ctrName) ? ', ' + ctrName : '') + '. Сумма ' + total.toFixed(2) + ' тенге' + (vr ? ', в т.ч. НДС ' + vr + '% ' + vatSum.toFixed(2) + ' тенге' : ', без НДС')).slice(0, 420);
      const pp: any = stamp({ Date: today() + 'T12:00:00', Posted: false, DeletionMark: false, 'ВидОперации': 'ОплатаПоставщику', 'Организация_Key': org, 'Контрагент_Key': cp.Ref_Key, 'ВалютаДокумента_Key': cur,
        'СчетОрганизации_Key': acc.Ref_Key, 'СчетКонтрагента_Key': cpAcc ? cpAcc.Ref_Key : ZERO, 'СуммаДокумента': total, 'НазначениеПлатежа': purpose, 'КодНазначенияПлатежа': String(inv.knp || pt?.['КодНазначенияПлатежа'] || '710'),
        'РННПлательщика': String(f.bin || ''), 'ТекстПлательщика': String(pt?.['ТекстПлательщика'] || f.name || '').slice(0, 200), 'РННПолучателя': bin, 'ТекстПолучателя': String(cp.Description || '').slice(0, 200),
        'ДатаВалютирования': today() + 'T00:00:00', 'Оплачено': false, 'УчитыватьКПН': pt ? pt['УчитыватьКПН'] !== false : true,
        'ДокументОснование': invKey, 'ДокументОснование_Type': 'StandardODATA.Document_СчетНаОплатуПоставщика',
        'Комментарий': ('За что: ' + brief + '; на основании: ' + basis + '; ' + MADE).slice(0, 1000),
        'РасшифровкаПлатежа': [{ LineNumber: '1', 'ДоговорКонтрагента_Key': contract, 'СуммаПлатежа': total, 'СуммаВзаиморасчетов': total, 'КурсВзаиморасчетов': 1, 'КратностьВзаиморасчетов': '1',
          'СтавкаНДС_Key': rate ? rate.Ref_Key : pl['СтавкаНДС_Key'] || ZERO, 'СуммаНДС': vatSum, 'СтатьяДвиженияДенежныхСредств_Key': pl['СтатьяДвиженияДенежныхСредств_Key'] || ZERO,
          'СчетУчетаРасчетовСКонтрагентомБУ_Key': a1 || ZERO, 'СчетУчетаРасчетовПоАвансам_Key': a2 || ZERO, 'СчетУчетаРасчетовСКонтрагентомНУ_Key': a3 || ZERO, 'СчетНаОплату_Key': invKey }] });
      if (pt?.['ВидУчетаНУ_Key']) pp['ВидУчетаНУ_Key'] = pt['ВидУчетаНУ_Key']; if (bank) pp['СчетБанк_Key'] = bank;
      const w = await call(base, 'Document_ПлатежноеПоручениеИсходящее?$format=json', 'POST', pp);
      if (!okW(w)) res.pp_error = '1С не записала платёжное поручение: ' + (w.err || 'ошибка ' + w.status);
      else { res.pp = { key: w.js.Ref_Key, number: String(w.js.Number || '').replace(/^0+/, ''), date: today(), purpose, knp: pp['КодНазначенияПлатежа'], sum: total, vat: vatSum, vat_rate: vr, no_tpl: !pt }; made.push('платёжное поручение №' + res.pp.number + ' создано'); }
    }

    // 6) доверенность — только на товары; вместо заглушки пишем настоящее наименование из счёта
    if (make.poa) {
      const goods = lines.filter((l) => !l.service), person = guid(p.person_key);
      if (!goods.length) res.poa_error = 'Доверенность не нужна: в счёте только работы и услуги';
      else if (!person) res.poa_error = 'Для доверенности не выбран человек';
      else {
        const days = Math.min(Math.max(Number(p.days) || 10, 1), 30), until = addDays(today(), days);
        const pd: any = stamp({ Date: today() + 'T12:00:00', Posted: false, DeletionMark: false, 'Организация_Key': org, 'Контрагент_Key': cp.Ref_Key, 'ДоговорКонтрагента_Key': contract, 'ДатаДействия': until + 'T00:00:00',
          'НаПолучениеОт': String(cp['НаименованиеПолное'] || cp.Description || '').slice(0, 300), 'ПоДокументу': ('Счет на оплату от поставщика №' + number + ' от ' + dLong(idate)).slice(0, 200), 'ДокументОснование_Key': invKey,
          'ФизЛицо_Key': person, 'СтруктурнаяЕдиница_Key': acc.Ref_Key, 'Комментарий': (MADE + (stubNames.length ? '; наименования — из счёта поставщика' : '')).slice(0, 1000),
          'Товары': goods.map((l, i) => ({ LineNumber: String(i + 1), ...(l.stub ? { 'НаименованиеТовара': l.name.slice(0, 1000), 'НаименованиеТовара_Type': 'Edm.String' } : { 'НаименованиеТовара': l.n.Ref_Key, 'НаименованиеТовара_Type': 'StandardODATA.Catalog_Номенклатура' }), 'ЕдиницаПоКлассификатору_Key': l.n['БазоваяЕдиницаИзмерения_Key'] || unitKey(l.unit) || ZERO, 'Количество': l.qty })) });
        const w = await call(base, 'Document_Доверенность?$format=json', 'POST', pd);
        if (!okW(w)) res.poa_error = '1С не записала доверенность: ' + (w.err || 'ошибка ' + w.status);
        else {
          const pn = await call(base, "Catalog_ФизическиеЛица(guid'" + person + "')?$format=json&$select=Description");
          res.poa = { key: w.js.Ref_Key, number: String(w.js.Number || '').replace(/^0+/, ''), date: today(), until, person: pn.js?.Description || '', by_doc: pd['ПоДокументу'], from: pd['НаПолучениеОт'], items: goods.map((l) => ({ name: l.name, unit: l.unit, qty: l.qty })) };
          made.push('доверенность №' + res.poa.number + ' создана');
        }
      }
    }
    // 7) реквизиты для печатных форм (в браузер, не в ИИ)
    if (res.pp || res.poa) {
      const bankOf = async (k: string) => k && k !== ZERO ? (await call(base, "Catalog_Банки(guid'" + k + "')?$format=json&$select=Description,БИК")).js || {} : {};
      const fb = await bankOf(acc['Банк_Key']), cb = cpAcc ? await bankOf(cpAcc['Банк_Key']) : {};
      res.print = { firm: { name: f.full_name || f.name, bin: f.bin || '', iik: acc['НомерСчета'], bank: fb.Description || '', bik: fb['БИК'] || '' }, cp: { name: cp['НаименованиеПолное'] || cp.Description, bin, iik: cpAcc ? iik : '', bank: cb.Description || '', bik: cb['БИК'] || (cpAcc ? bik : '') } };
    }
    return j(res);
  } catch (e) { return j({ ok: false, error: String((e as Error).message || e) }); }
});
