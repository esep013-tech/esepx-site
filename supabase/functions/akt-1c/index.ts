// Робот «Акты сверки»: данные взаиморасчётов с контрагентом из 1С за период — для сверки с присланным актом.
// verify_jwt выключен: доступ проверяется внутри (вошедший администратор ESEP; служебный ключ сервера — только для проверки).
// Действия (только чтение, 1С не меняется):
//   data { company_id, bin, name, from, to } — контрагент по БИН (не нашёлся — похожие по БИН и названию), сальдо на начало,
//        все проводки по контрагенту за период из регистра бухгалтерии (счета расчётов с субконто «Контрагент»), сгруппированные по документам,
//        обороты и сальдо на конец; виден ли в 1С документ «Акт сверки взаиморасчётов».
//   Сам акт кабинет в базе не хранит.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '', PASS = Deno.env.get('ONEC_PASSWORD') || '';
const ZERO = '00000000-0000-0000-0000-000000000000';
function basic() { const b = new TextEncoder().encode(USER + ':' + PASS); let s = ''; b.forEach((x) => (s += String.fromCharCode(x))); return 'Basic ' + btoa(s); }
async function call(base: string, path: string) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 50000);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/odata/standard.odata/' + path, { headers: { Accept: 'application/json', Authorization: basic() }, signal: ctl.signal });
    const txt = await r.text(); let js: any = null; try { js = JSON.parse(txt); } catch { /* не JSON */ }
    const err = js && js['odata.error'] ? String(js['odata.error'].message?.value || '') : '';
    return { status: r.status, js, err: err || (r.ok ? '' : txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)) };
  } finally { clearTimeout(t); }
}
const q = (s: string) => encodeURIComponent(s);
const guid = (x: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || '')) ? String(x) : '';
const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const isoD = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : '';
const norm = (s: string) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/товарищество с ограниченной ответственностью|тоо|ип|индивидуальный предприниматель/g, ' ').replace(/[^a-zа-я0-9]+/g, ' ').trim();
// как документы называются в акте сверки 1С
const KIND: Record<string, string> = {
  РеализацияТоваровУслуг: 'Реализация ТМЗ и услуг', ПоступлениеТоваровУслуг: 'Поступление ТМЗ и услуг', ПлатежноеПоручениеВходящее: 'Платежное поручение входящее',
  ПлатежноеПоручениеИсходящее: 'Платежное поручение исходящее', ПлатежныйОрдерПоступлениеДенежныхСредств: 'Платежный ордер (поступление денежных средств)',
  ПлатежныйОрдерСписаниеДенежныхСредств: 'Платежный ордер (списание денежных средств)', ПриходныйКассовыйОрдер: 'Приходный кассовый ордер', РасходныйКассовыйОрдер: 'Расходный кассовый ордер',
  ВозвратТоваровОтПокупателя: 'Возврат ТМЗ от покупателя', ВозвратТоваровПоставщику: 'Возврат ТМЗ поставщику', КорректировкаДолга: 'Корректировка долга', ОперацияБух: 'Операция (бухгалтерский учет)',
  ВводНачальныхОстатков: 'Ввод начальных остатков', ПоступлениеДопРасходов: 'Поступление доп. расходов', АвансовыйОтчет: 'Авансовый отчет', ОказаниеУслуг: 'Оказание услуг',
};
const kindOf = (t: string) => { const n = String(t || '').replace(/^.*Document_/, ''); return KIND[n] || n.replace(/([а-я])([А-Я])/g, '$1 $2'); };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!, sbSrv = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const sbUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any)), act = String(p.action || '');
    const skey = req.headers.get('x-server-key') || ''; let srv = false;
    if (skey) { const { data: ok } = await sbSrv.rpc('server_robot_key_ok', { p_key: skey }); if (!ok) return j({ ok: false, error: 'Нет доступа' }, 401); srv = true; }
    if (!srv) { const { data: u } = await sbUser.auth.getUser(); if (!u || !u.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
      const { data: adm } = await sbUser.rpc('am_i_admin'); if (!adm) return j({ ok: false, error: 'Раздел пока в настройке' }, 403); }
    const id = String(p.company_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return j({ ok: false, error: 'Не указана фирма' }, 400);
    const { data: f } = await sbSrv.from('companies').select('id,name,full_name,bin,onec_url').eq('id', id).maybeSingle();
    if (!f || !f.onec_url) return j({ ok: false, error: 'У фирмы не указан адрес 1С' });
    if (!USER || !PASS) return j({ ok: false, error: 'Логин и пароль 1С не заданы в секретах кабинета' });
    const base = f.onec_url as string;
    const get = async (path: string) => { const r = await call(base, path); if (r.status !== 200) throw new Error('1С: ' + (r.err || 'ошибка ' + r.status)); return r.js; };
    const list = async (path: string) => ((await get(path)).value || []) as any[];

    if (act === 'data') {
      const from = isoD(p.from), to = isoD(p.to); if (!from || !to || from > to) return j({ ok: false, error: 'Укажите период акта: с какого и по какое число' });
      const bin = String(p.bin || '').replace(/\D/g, '');
      // контрагент: точно по БИН; иначе — похожие (БИН отличается 1–2 цифрами — так бывает при распознавании скана — или похожее название)
      let cp: any = null, cands: any[] = [];
      if (guid(p.cp_key)) cp = (await call(base, "Catalog_Контрагенты(guid'" + p.cp_key + "')?$format=json&$select=Ref_Key,Description,НаименованиеПолное,ИдентификационныйКодЛичности")).js;
      if (!cp?.Ref_Key && bin.length === 12) cp = (await list('Catalog_Контрагенты?$format=json&$select=Ref_Key,Description,НаименованиеПолное,ИдентификационныйКодЛичности&$filter=' + q("ИдентификационныйКодЛичности eq '" + bin + "' and DeletionMark eq false")))[0] || null;
      if (!cp?.Ref_Key) {
        cp = null;
        const all = await list('Catalog_Контрагенты?$format=json&$select=Ref_Key,Description,ИдентификационныйКодЛичности&$filter=' + q('DeletionMark eq false and IsFolder eq false'));
        const nm = norm(p.name || ''), words = nm.split(' ').filter((w) => w.length > 2);
        cands = all.map((c: any) => { const b = String(c['ИдентификационныйКодЛичности'] || ''); let d = 99; if (bin.length === 12 && b.length === 12) { d = 0; for (let i = 0; i < 12; i++) if (b[i] !== bin[i]) d++; }
          const cn = norm(c.Description), hit = words.filter((w) => cn.includes(w)).length; return { key: c.Ref_Key, name: c.Description, bin: b, d, hit }; })
          .filter((c: any) => c.d <= 2 || (words.length && c.hit >= Math.min(2, words.length))).sort((a: any, b: any) => a.d - b.d || b.hit - a.hit).slice(0, 6);
        return j({ ok: true, cp: null, cands, need_cp: true });
      }
      const cpKey = cp.Ref_Key, C = "cast(guid'" + cpKey + "', 'Catalog_Контрагенты')";
      // сальдо на начало: остатки по всем счетам с субконто «Контрагент» = этот контрагент (дебет — нам должны, кредит — мы должны)
      const bal = async (d: string) => { const xs = await list("AccountingRegister_Типовой/Balance(Period=datetime'" + d + "T00:00:00',Condition='" + "ExtDimension1 eq " + C.replace(/'/g, "''") + "')?$format=json");
        let s = 0; xs.forEach((x: any) => { s += Number(x['СуммаBalance']) || 0; }); return r2(s); };
      const opening = await bal(from);
      // проводки за период; обороты между счетами одного и того же контрагента (зачёт аванса) в акт не попадают
      const recs = await list("AccountingRegister_Типовой/RecordsWithExtDimensions(StartPeriod=datetime'" + from + "T00:00:00',EndPeriod=datetime'" + to + "T23:59:59')?$format=json&$select=Period,Recorder,Recorder_Type,AccountDr_Key,AccountCr_Key,ExtDimensionDr1,ExtDimensionCr1,Сумма,Active&$filter=" + q('ExtDimensionDr1 eq ' + C + ' or ExtDimensionCr1 eq ' + C));
      const docs = new Map<string, any>();
      for (const x of recs) {
        if (x.Active === false) continue;
        const dr = x.ExtDimensionDr1 === cpKey, cr = x.ExtDimensionCr1 === cpKey; if (dr && cr) continue;
        const k = x.Recorder; if (!docs.has(k)) docs.set(k, { key: k, type: String(x.Recorder_Type || '').replace('StandardODATA.', ''), date: String(x.Period).slice(0, 10), debit: 0, credit: 0 });
        const d = docs.get(k); if (dr) d.debit = r2(d.debit + Number(x['Сумма'])); if (cr) d.credit = r2(d.credit + Number(x['Сумма']));
      }
      // номера, даты и входящие номера документов
      const byType = new Map<string, any[]>(); docs.forEach((d) => { if (!byType.has(d.type)) byType.set(d.type, []); byType.get(d.type)!.push(d); });
      for (const [type, ds] of byType) {
        for (let i = 0; i < ds.length; i += 15) {
          const part = ds.slice(i, i + 15), flt = part.map((d) => "Ref_Key eq guid'" + d.key + "'").join(' or ');
          let r = await call(base, type + '?$format=json&$select=Ref_Key,Number,Date,НомерВходящегоДокумента,ДатаВходящегоДокумента&$filter=' + q(flt));
          if (r.status !== 200) r = await call(base, type + '?$format=json&$select=Ref_Key,Number,Date&$filter=' + q(flt));
          for (const x of (r.js?.value || [])) { const d = part.find((y) => y.key === x.Ref_Key); if (!d) continue;
            d.number = String(x.Number || '').replace(/^0+/, ''); d.doc_date = String(x.Date || '').slice(0, 10);
            const inNo = String(x['НомерВходящегоДокумента'] || '').trim(); if (inNo) { d.in_no = inNo; d.in_date = String(x['ДатаВходящегоДокумента'] || '').slice(0, 10).replace(/^0001.*/, ''); } }
        }
      }
      const rows = [...docs.values()].filter((d) => d.debit || d.credit).map((d) => ({ key: d.key, type: d.type, kind: kindOf(d.type), date: d.date, no: d.number || '', in_no: d.in_no || '', in_date: d.in_date || '', doc_date: d.doc_date || d.date,
        doc: kindOf(d.type) + ' ' + (d.in_no || d.number || '') + ' от ' + (d.in_date || d.doc_date || d.date).split('-').reverse().join('.'), debit: d.debit, credit: d.credit }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
      const debit = r2(rows.reduce((a, x) => a + x.debit, 0)), credit = r2(rows.reduce((a, x) => a + x.credit, 0));
      const pub = (await call(base, 'Document_АктСверкиВзаиморасчетов?$format=json&$top=1&$select=Ref_Key')).status === 200;
      const org = (await call(base, 'Catalog_Организации?$format=json&$top=1&$select=Description,НаименованиеПолное&$filter=' + q('DeletionMark eq false'))).js?.value?.[0] || {};
      return j({ ok: true, cp: { key: cpKey, name: cp.Description, full: cp['НаименованиеПолное'] || cp.Description, bin: cp['ИдентификационныйКодЛичности'] || '' },
        firm: { name: org.Description || f.name, full: org['НаименованиеПолное'] || f.full_name || f.name, bin: f.bin || '' },
        from, to, opening, rows, debit, credit, closing: r2(opening + debit - credit), act_doc: pub });
    }
    return j({ ok: false, error: 'Неизвестное действие' }, 400);
  } catch (e) { return j({ ok: false, error: (e as Error).message || 'Ошибка' }); }
});
