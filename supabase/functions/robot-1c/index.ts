// Серверные роботы ESEP: данные из облачной 1С через OData, без UiPath и Telegram.
// Вызывает база (триггер на новое задание robot_runs, заголовок x-server-key): { run_id }.
// Сейчас умеет: unpaid_invoices — счета на оплату, powers_of_attorney — доверенности, counterparty_debts — расчёты с контрагентами (Дт/Кт),
// esf_diagnostics — диагностика поступлений и реализаций (СНТ, ЭАВР, ЭСФ, непроведённые реализации, сроки выписки ЭСФ).
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
  // счета с даты из настроек фирмы (по умолчанию 01.01 текущего года), без помеченных на удаление и без «отмена» в комментарии и без статуса «Отменен»
  const from = (/^\d{4}-\d{2}-\d{2}$/.test(fromDate || '') ? fromDate : kzToday().slice(0, 4) + '-01-01') + 'T00:00:00';
  const docs = await odata(base, "Document_СчетНаОплатуПокупателю?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Комментарий,DeletionMark,Контрагент_Key,Контрагент/Description&$expand=Контрагент"
    + "&$filter=" + encodeURIComponent("Date ge datetime'" + from + "' and DeletionMark eq false and substringof('отмена',Комментарий) eq false"));
  const sts = await odata(base, "InformationRegister_СтатусыДокументов?$format=json&$select=Документ,Статус,ДополнительныйСтатус&$filter="
    + encodeURIComponent("Документ_Type eq 'StandardODATA.Document_СчетНаОплатуПокупателю'"));
  const st: Record<string, any> = {}; sts.forEach((s: any) => { st[String(s['Документ'])] = s; });
  const items: any[] = [];
  for (const d of docs) {
    const s = st[d.Ref_Key] || {};
    // отменённые счета не показываем: статус «Отменен» в 1С или слово «отмена» в комментарии (в любом регистре)
    if (/^отмен/i.test(String(s['Статус'] || '')) || /отмен/i.test(String(d['Комментарий'] || ''))) continue;
    const pay = PAY[s['Статус']] || (s['Статус'] ? String(s['Статус']) : 'Не оплачен');
    const ship = SHIP[s['ДополнительныйСтатус']] || (s['ДополнительныйСтатус'] ? String(s['ДополнительныйСтатус']) : 'Не отгружен');
    if (pay === 'Оплачен' && ship === 'Отгружен') continue; // полностью выполнен — не показываем
    items.push({
      key: d.Ref_Key, contractor: (d['Контрагент'] && d['Контрагент'].Description || 'Без контрагента').trim(),
      number: String(d.Number || '').replace(/^0+/, '') || String(d.Number || ''), date: String(d.Date || '').slice(0, 10),
      sum: Number(d['СуммаДокумента'] || 0), pay, ship, comment: (d['Комментарий'] || '').trim() || undefined, _ck: d['Контрагент_Key'],
    });
  }
  try { await payHints(base, items); } catch (_) { /* подсказки — не обязательны, отчёт уходит без них */ }
  try { await shipHints(base, items); } catch (_) { /* то же */ }
  items.forEach((x) => { delete x._ck; });
  items.sort((a, b) => a.contractor.localeCompare(b.contractor, 'ru') || a.date.localeCompare(b.date));
  return { from: from.slice(0, 10), items };
}

// ---------- Подсказки к неоплаченным счетам: где может быть оплата ----------
// Ищем среди поступлений (банк и касса) с даты счёта: 1) номер счёта в назначении платежа или комментарии;
// 2) тот же контрагент и та же сумма; 3) тот же контрагент частями; 4) та же сумма, но платил другой контрагент.
// Один платёж — к одному счёту. Платёж, где уже выбран «Счёт на оплату», не предлагаем (тот счёт закрыт в 1С).
// p — вероятность совпадения в процентах (для бухгалтера: сколько усилий нужно на сверку).
const normNo = (v: any) => String(v ?? '').replace(/[^0-9A-Za-zА-Яа-я]/g, '').replace(/^0+/, '').toLowerCase();
const money2 = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// документ позже счёта больше чем на 60 дней — совпадение менее вероятно
const far = (x: any, d: string) => Date.parse(d) - Date.parse(x.date) > 60 * 864e5;
const regNo = (reg: any, n: any) => { const r = String(reg || '').trim(), k = String(n || '').trim().replace(/^0+/, '') || String(n || '').trim(); return r ? (k && k !== r ? r + ' (' + k + ')' : r) : k; };
const dm = (iso: string) => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
async function payHints(base: string, items: any[]) {
  const open = items.filter((x) => x.pay !== 'Оплачен' && x.date);
  if (!open.length) return;
  const from = open.reduce((m, x) => (x.date < m ? x.date : m), open[0].date) + 'T00:00:00';
  const flt = encodeURIComponent("Posted eq true and Date ge datetime'" + from + "'");
  const pp = await odataTry(base, 'Document_ПлатежноеПоручениеВходящее?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,НазначениеПлатежа,Комментарий,РасшифровкаПлатежа&$filter=' + flt,
    'Document_ПлатежноеПоручениеВходящее?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,НазначениеПлатежа,Комментарий&$filter=' + flt);
  // основной документ поступления на счёт в Бухгалтерии для Казахстана — «Платёжный ордер на поступление денежных средств»
  let po: any[] = [];
  try { po = await odataTry(base, 'Document_ПлатежныйОрдерПоступлениеДенежныхСредств?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,НазначениеПлатежа,Комментарий,РасшифровкаПлатежа&$filter=' + flt,
    'Document_ПлатежныйОрдерПоступлениеДенежныхСредств?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,НазначениеПлатежа,Комментарий&$filter=' + flt); } catch (_) { po = []; }
  let pko: any[] = [];
  try { pko = await odata(base, 'Document_ПриходныйКассовыйОрдер?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент,Комментарий,Основание&$filter=' + flt); } catch (_) { pko = []; }
  type Pay = { key: string; kind: string; no: string; date: string; sum: number; ck: string; text: string; used: boolean };
  const pays: Pay[] = [];
  for (const r of [...pp.map((x: any) => ({ ...x, _k: 'ПП' })), ...po.map((x: any) => ({ ...x, _k: 'ПО' }))]) {
    if ((r['РасшифровкаПлатежа'] || []).some((l: any) => !isEmptyKey(l['СчетНаОплату_Key']))) continue;
    pays.push({ key: r.Ref_Key, kind: r._k, no: String(r.Number || '').replace(/^0+/, ''), date: String(r.Date).slice(0, 10), sum: Number(r['СуммаДокумента'] || 0),
      ck: String(r['Контрагент_Key'] || ''), text: (String(r['НазначениеПлатежа'] || '') + ' ' + String(r['Комментарий'] || '')).toLowerCase(), used: false });
  }
  for (const r of pko) pays.push({ key: r.Ref_Key, kind: 'ПКО', no: String(r.Number || '').replace(/^0+/, ''), date: String(r.Date).slice(0, 10), sum: Number(r['СуммаДокумента'] || 0),
    ck: String(r['Контрагент'] || ''), text: (String(r['Комментарий'] || '') + ' ' + String(r['Основание'] || '')).toLowerCase(), used: false });
  pays.sort((a, b) => a.date.localeCompare(b.date));
  const after = (x: any) => pays.filter((p) => !p.used && p.date >= x.date && p.sum > 0);
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const ref = (p: Pay) => p.kind + ' № ' + p.no + ' от ' + dm(p.date) + ' — ' + money2(p.sum);
  // 1) номер счёта в назначении / комментарии: «сч», «счет», «счёт», «счету» … № 59
  for (const x of open) {
    const n = normNo(x.number); if (!n) continue;
    const re = new RegExp('сч[её]?т?[а-я]*[^0-9a-zа-я]{0,30}(на\\s*оплату[^0-9]{0,10})?№?\\s*0*' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
    const hit = after(x).filter((p) => re.test(p.text));
    if (hit.length) { hit.forEach((p) => (p.used = true)); x.hints = { ...(x.hints || {}), pay: { k: 'text', p: 95, t: 'По назначению платежа: ' + hit.map(ref).join('; ') } }; }
  }
  // 2) тот же контрагент и та же сумма
  for (const x of open) {
    if (x.hints?.pay) continue;
    const p = after(x).find((p) => p.ck === x._ck && eq(p.sum, x.sum));
    if (p) { p.used = true; x.hints = { ...(x.hints || {}), pay: { k: 'same', p: far(x, p.date) ? 65 : 80, t: 'Контрагент и сумма: ' + ref(p) } }; }
  }
  // 3) тот же контрагент частями (сумма платежей не больше счёта)
  for (const x of open) {
    if (x.hints?.pay) continue;
    let tot = 0; const got: Pay[] = [];
    for (const p of after(x)) { if (p.ck !== x._ck) continue; if (tot + p.sum > x.sum + 0.01) continue; tot += p.sum; got.push(p); }
    if (got.length) { got.forEach((p) => (p.used = true)); x.hints = { ...(x.hints || {}), pay: { k: 'part', p: Math.round(40 + 30 * tot / (x.sum || tot)) - (far(x, got[got.length - 1].date) ? 15 : 0), t: 'Частями: ' + money2(tot) + ' из ' + money2(x.sum) + ' (' + got.map(ref).join('; ') + ')' } }; }
  }
  // 4) та же сумма, но другой контрагент
  const other: [any, Pay][] = [];
  for (const x of open) {
    if (x.hints?.pay) continue;
    const p = after(x).find((p) => eq(p.sum, x.sum) && p.ck !== x._ck);
    if (p) { p.used = true; other.push([x, p]); }
  }
  if (other.length) {
    const nm = new Map<string, string>();
    for (const c of await odata(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description')) nm.set(c.Ref_Key, shortName(String(c.Description || '')));
    for (const [x, p] of other) x.hints = { ...(x.hints || {}), pay: { k: 'other', p: 35, t: 'Сумма та же, платил другой: ' + (nm.get(p.ck) || 'без контрагента') + ' — ' + ref(p) } };
  }
}

// ---------- Подсказки к неотгруженным счетам: реализации после даты счёта ----------
// 1) номер счёта в комментарии реализации; 2) тот же контрагент и та же сумма; 3) тот же контрагент частями. Одна реализация — к одному счёту.
async function shipHints(base: string, items: any[]) {
  const open = items.filter((x) => x.ship !== 'Отгружен' && x.date);
  if (!open.length) return;
  const from = open.reduce((m, x) => (x.date < m ? x.date : m), open[0].date) + 'T00:00:00';
  const rs = await odata(base, 'Document_РеализацияТоваровУслуг?$format=json&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,Комментарий&$filter='
    + encodeURIComponent("Posted eq true and Date ge datetime'" + from + "'"));
  const docs = rs.map((r: any) => ({ no: String(r.Number || '').replace(/^0+/, ''), date: String(r.Date).slice(0, 10), sum: Number(r['СуммаДокумента'] || 0), ck: String(r['Контрагент_Key'] || ''),
    text: String(r['Комментарий'] || '').toLowerCase(), used: false })).sort((a: any, b: any) => a.date.localeCompare(b.date));
  const after = (x: any) => docs.filter((d: any) => !d.used && d.date >= x.date && d.sum > 0);
  const ref = (d: any) => 'Реализация № ' + d.no + ' от ' + dm(d.date) + ' — ' + money2(d.sum);
  for (const x of open) {
    const n = normNo(x.number); if (!n) continue;
    const re = new RegExp('сч[её]?т?[а-я]*[^0-9a-zа-я]{0,30}(на\\s*оплату[^0-9]{0,10})?№?\\s*0*' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
    const hit = after(x).filter((d: any) => re.test(d.text));
    if (hit.length) { hit.forEach((d: any) => (d.used = true)); x.hints = { ...(x.hints || {}), ship: { k: 'text', p: 95, t: 'По комментарию: ' + hit.map(ref).join('; ') } }; }
  }
  for (const x of open) {
    if (x.hints?.ship) continue;
    const d = after(x).find((d: any) => d.ck === x._ck && Math.abs(d.sum - x.sum) < 0.01);
    if (d) { d.used = true; x.hints = { ...(x.hints || {}), ship: { k: 'same', p: far(x, d.date) ? 60 : 75, t: 'Контрагент и сумма: ' + ref(d) } }; }
  }
  for (const x of open) {
    if (x.hints?.ship) continue;
    let tot = 0; const got: any[] = [];
    for (const d of after(x)) { if (d.ck !== x._ck) continue; if (tot + d.sum > x.sum + 0.01) continue; tot += d.sum; got.push(d); }
    if (got.length) { got.forEach((d) => (d.used = true)); x.hints = { ...(x.hints || {}), ship: { k: 'part', p: Math.round(35 + 30 * tot / (x.sum || tot)) - (far(x, got[got.length - 1].date) ? 15 : 0), t: 'Частями: ' + money2(tot) + ' из ' + money2(x.sum) + ' (' + got.map(ref).join('; ') + ')' } }; }
  }
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
          body: n ? n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'счёт' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'счёта' : 'счетов') + ' на ' + money(sum) + ' ₸ по ' + cnt + ' контрагентам: не оплачены и/или не отгружены. Счета с ' + dmy(r.from) + ', кроме отменённых (статус «Отменен» или «отмена» в комментарии).' : null,
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
  const docs = await odata(base, "Document_Доверенность?$format=json&$select=Ref_Key,Number,Date,ДатаДействия,Комментарий,DeletionMark,ПоДокументу,НаПолучениеОт,ДокументОснование_Key,Контрагент_Key,Контрагент/Description&$expand=Контрагент"
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
      comment: (d['Комментарий'] || '').trim() || undefined, _ck: d['Контрагент_Key'], _inv: isEmptyKey(basisKey) ? '' : String(basisKey),
    });
  }
  // подсказка: ЭСФ полученный, где указан номер этой доверенности → по ней уже пришёл товар
  if (items.length) {
    try {
      const es = await odata(base, 'Document_ЭСФ?$format=json&$select=Ref_Key,Number,РегистрационныйНомер,Date,ДатаОборота,ДоверенностьНаПоставкуНомер,ДоверенностьНаПоставкуДата,Контрагент_Key,СуммаДокумента&$filter='
        + encodeURIComponent("Направление eq 'Входящий' and ДоверенностьНаПоставкуНомер ne '' and Date ge datetime'" + from + "'"));
      const byNo = new Map<string, any[]>();
      es.forEach((e: any) => { const k = normNo(e['ДоверенностьНаПоставкуНомер']); if (!k) return; if (!byNo.has(k)) byNo.set(k, []); byNo.get(k)!.push(e); });
      for (const x of items) {
        const c = byNo.get(normNo(x.number)) || []; if (!c.length) continue;
        const score = (e: any) => (String(e['ДоверенностьНаПоставкуДата'] || '').slice(0, 10) === x.date ? 2 : 0) + (e['Контрагент_Key'] === x._ck ? 1 : 0);
        const best = c.slice().sort((a, b) => score(b) - score(a))[0];
        const no = regNo(best['РегистрационныйНомер'], best.Number);
        x.hints = { status: { k: score(best) ? 'same' : 'other', p: [40, 70, 85, 95][score(best)], t: 'ЭСФ ' + no + ' от ' + dm(String(best['ДатаОборота'] || best.Date).slice(0, 10)) + ' на ' + money2(Number(best['СуммаДокумента'] || 0))
          + ' — в нём указана доверенность № ' + String(best['ДоверенностьНаПоставкуНомер']).trim() + (score(best) ? '' : ' (дата или поставщик другие — проверьте)') } };
      }
    } catch (_) { /* подсказки не обязательны */ }
    try { await poaReceiptHints(base, items, docs); } catch (_) { /* подсказки не обязательны */ }
  }
  items.forEach((x) => { delete x._ck; delete x._inv; });
  items.sort((a, b) => a.contractor.localeCompare(b.contractor, 'ru') || a.date.localeCompare(b.date));
  return { from: from.slice(0, 10), items };
}

// подсказка к доверенности: поступление ТМЗ не раньше даты доверенности, к которому её не привязали.
// Сравниваем по порядку: контрагент → сумма (поступления и счёта поставщика из «По документу») → товары доверенности.
// m — что совпало: c контрагент, s сумма, g все товары, h часть товаров. Одно поступление — к одной доверенности.
async function poaReceiptHints(base: string, items: any[], docs: any[]) {
  const from = items.reduce((m, x) => (x.date < m ? x.date : m), items[0].date);
  const flt = encodeURIComponent("Posted eq true and Date ge datetime'" + from + "T00:00:00'");
  const rs = await odata(base, 'Document_ПоступлениеТоваровУслуг?$format=json&$select=Ref_Key,Number,Date,Контрагент_Key,СуммаДокумента,ДокументОснование,ДокументОснование_Type,СчетНаОплатуПоставщика_Key,Товары&$filter=' + flt);
  // поступления, которые уже закрыли какую-то доверенность (через неё или через её счёт), не предлагаем
  const poaInv = new Set(docs.map((d: any) => String(d['ДокументОснование_Key'] || '')).filter((k) => !isEmptyKey(k)));
  const recs = rs.filter((r: any) => r['ДокументОснование_Type'] !== 'StandardODATA.Document_Доверенность' && !poaInv.has(String(r['СчетНаОплатуПоставщика_Key'] || '')))
    .map((r: any) => ({ no: String(r.Number || '').replace(/^0+/, ''), date: String(r.Date).slice(0, 10), sum: Number(r['СуммаДокумента'] || 0), ck: String(r['Контрагент_Key'] || ''),
      goods: new Set<string>((r['Товары'] || []).map((g: any) => String(g['Номенклатура_Key'] || '')).filter((k: string) => !isEmptyKey(k))), used: false }))
    .sort((a: any, b: any) => a.date.localeCompare(b.date));
  if (!recs.length) return;
  // товары доверенностей и суммы счетов поставщиков
  const goodsOf = new Map<string, Set<string>>();
  try {
    for (const d of await odata(base, 'Document_Доверенность?$format=json&$select=Ref_Key,Товары&$filter=' + encodeURIComponent("Date ge datetime'" + from + "T00:00:00' and DeletionMark eq false")))
      goodsOf.set(d.Ref_Key, new Set((d['Товары'] || []).map((g: any) => String(g['НаименованиеТовара'] || '')).filter((k: string) => !isEmptyKey(k))));
  } catch (_) { /* без товаров */ }
  const invSum = new Map<string, number>();
  const invKeys = [...new Set(items.map((x) => x._inv).filter(Boolean))];
  if (invKeys.length) {
    try {
      for (const v of await odata(base, 'Document_СчетНаОплатуПоставщика?$format=json&$select=Ref_Key,СуммаДокумента&$filter=' + encodeURIComponent("Date ge datetime'" + addDays(from, -120) + "T00:00:00'")))
        if (invKeys.includes(v.Ref_Key)) invSum.set(v.Ref_Key, Number(v['СуммаДокумента'] || 0));
    } catch (_) { /* без сумм */ }
  }
  const P: Record<string, number> = { csg: 95, cs: 85, csh: 85, cg: 75, ch: 60, sg: 55, c: 40 };
  // все пары «доверенность — поступление», лучшие совпадения разбираем первыми (чтобы слабое не забрало чужое сильное)
  const pairs: { x: any; r: any; m: string; p: number }[] = [];
  for (const x of items) {
    const want = goodsOf.get(x.key) || new Set<string>(), sum = x._inv ? invSum.get(x._inv) : undefined;
    for (const r of recs) {
      if (r.date < x.date) continue;
      const c = r.ck === x._ck, s = sum != null && sum > 0 && Math.abs(r.sum - sum) < 1;
      const hit = [...want].filter((g) => r.goods.has(g)).length;
      const g = want.size > 0 && hit === want.size, h = !g && hit > 0;
      const m = (c ? 'c' : '') + (s ? 's' : '') + (g ? 'g' : h ? 'h' : '');
      if (P[m]) pairs.push({ x, r, m, p: P[m] });
    }
  }
  pairs.sort((a, b) => b.p - a.p || a.r.date.localeCompare(b.r.date));
  const done = new Set<any>();
  for (const { x, r: best, m: bestM, p: bestP } of pairs) {
    if (done.has(x) || best.used) continue;
    done.add(x); best.used = true;
    const what = [bestM.includes('c') ? 'поставщик' : '', bestM.includes('s') ? 'сумма счёта' : '', bestM.includes('g') ? 'все товары' : bestM.includes('h') ? 'часть товаров' : ''].filter(Boolean).join(', ');
    x.hints = { ...(x.hints || {}), basis: { k: bestM.includes('c') ? 'same' : 'other', p: bestP, m: bestM,
      t: 'Поступление ТМЗ № ' + best.no + ' от ' + dm(best.date) + ' на ' + money2(best.sum) + ' — совпали: ' + what + '. Если это оно, укажите доверенность в поступлении' } };
  }
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

// ---------- Расчёты с контрагентами (Дт/Кт) ----------
// Перенесено из UiPath «Дт/Кт задолженность» (Invoke Code «с группировкой»), без Telegram и PDF.
// 1) план счетов → счета расчётов по кодам; 2) остатки регистра на конец даты проверки, свёрнутое сальдо Дт−Кт по контрагенту;
// 3) движения за 3 года до даты (помесячно) → раскладка долга по срокам (FIFO) и анализ по документам (сошедшиеся пары, счета на оплату, позиции);
// контрагенты с «банк» в названии — отдельным блоком. Формат таблицы — как у UiPath (sections), кабинет рисует его сам.
const DEBT_CODES = new Set(['1110', '1151', '1210', '1220', '1230', '1240', '1260', '1271', '1272', '1274', '1710', '1730', '1740',
  '2010', '2050', '2110', '2120', '2130', '2140', '2160', '2171', '2172', '2174', '2180', '2210', '2220', '2230', '2910', '2940', '2950', '2960', '2970', '2980',
  '3010', '3040', '3050', '3060', '3310', '3320', '3330', '3340', '3360', '3370', '3381', '3382', '3383', '3387', '3410', '3420',
  '3510', '3530', '3540', '3550', '3560', '4010', '4040', '4050', '4110', '4120', '4130', '4140', '4150',
  '4161', '4162', '4163', '4167', '4210', '4220', '4410', '4430', '4440', 'Я111', 'Я201', 'Я301', 'Я302', 'Я304', 'Я401', 'Я402']);
// сроки: 0 до месяца … 4 от 1 до 3 лет, 5 — больше 3 лет (общий срок исковой давности прошёл — к списанию)
const BUCKETS = ['До месяца', 'От 1 до 3 месяцев', 'От 3 до 6 месяцев', 'От полугода до года', 'От 1 до 3 лет', 'Больше 3 лет — к списанию'];
const BUCKET_COLS = ['До месяца', '1–3 мес.', '3–6 мес.', '6–12 мес.', '1–3 года', 'Больше 3 лет'];
const BUCKET_ICON = ['⚪', '🔵', '🟡', '🟠', '🔥', '⛔'];
const NB = BUCKETS.length;
const bucketOf = (days: number) => days <= 30 ? 0 : days <= 90 ? 1 : days <= 180 ? 2 : days <= 365 ? 3 : days <= 1095 ? 4 : 5;
const r2 = (v: number) => Math.round(v * 100) / 100;
const money = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const SHORT_FORMS: [RegExp, string][] = [
  [/товарищество\s+с\s+ограниченной\s+ответственностью/giu, 'ТОО'], [/индивидуальный\s+предприниматель/giu, 'ИП'],
  [/акционерное\s+общество/giu, 'АО'], [/жауапкершілігі\s+шектеулі\s+серіктестігі/giu, 'ЖШС'],
];
const shortName = (s: string) => SHORT_FORMS.reduce((t, [re, a]) => t.replace(re, a), s).replace(/[ \t]{2,}/g, ' ').trim();
const kontr = (o: any, prefix: string) => {
  for (let n = 1; n <= 3; n++) { const t = o[prefix + n + '_Type']; if (t && String(t).endsWith('Catalog_Контрагенты')) return String(o[prefix + n] || ''); }
  return '';
};
const dogovor = (o: any, prefix: string) => {
  for (let n = 1; n <= 3; n++) { const t = o[prefix + n + '_Type']; if (t && String(t).endsWith('Catalog_ДоговорыКонтрагентов')) return String(o[prefix + n] || ''); }
  return '';
};
const pad = (n: number) => String(n).padStart(2, '0');
const isoLocal = (d: Date) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
const ZG = '00000000-0000-0000-0000-000000000000';

// ---- анализ: как бухгалтер с актом сверки — убираем сошедшиеся пары, по остатку смотрим счета на оплату и позиции ----
const DOC_RU: Record<string, string> = {
  РеализацияТоваровУслуг: 'Реализация', ПоступлениеТоваровУслуг: 'Поступление', ПлатежноеПоручениеВходящее: 'ПП входящее', ПлатежноеПоручениеИсходящее: 'ПП исходящее',
  ПлатежныйОрдерПоступлениеДенежныхСредств: 'Платёжный ордер (поступление)', ПлатежныйОрдерСписаниеДенежныхСредств: 'Платёжный ордер (списание)',
  ПриходныйКассовыйОрдер: 'ПКО', РасходныйКассовыйОрдер: 'РКО', ОперацияБух: 'Операция', КорректировкаДолга: 'Корректировка долга', АвансовыйОтчет: 'Авансовый отчёт',
  ВозвратТоваровОтПокупателя: 'Возврат от покупателя', ВозвратТоваровПоставщику: 'Возврат поставщику', ВводНачальныхОстатков: 'Ввод начальных остатков',
  ОплатаОтПокупателяПлатежнойКартой: 'Оплата картой', ПоступлениеДопРасходов: 'Доп. расходы', ОказаниеПроизводственныхУслуг: 'Оказание услуг',
  ПоступлениеНМА: 'Поступление НМА', ПоступлениеОС: 'Поступление ОС', РеализацияОС: 'Реализация ОС', СчетФактураВыданный: 'Счёт-фактура выданный',
};
const docRu = (t: string) => DOC_RU[t] || t.replace(/([а-яё])([А-ЯЁ])/g, '$1 $2');
const isPayType = (t: string) => /Платежн|КассовыйОрдер|ОплатаОтПокупателя/.test(t);
const isShipType = (t: string) => /^(Реализация|Поступление|Оказание|ВозвратТоваров)/.test(t);
type Mv = { at: number; amt: number; rec: string; rt: string; ctr: string };
type Doc = { rec: string; rt: string; at: number; amt: number; ctr: string; used?: boolean };
type Part = string | { d: string; k: string; t: string };

async function byKeys(base: string, set: string, keys: string[], select = '') {
  const out = new Map<string, any>(); const ks = [...new Set(keys.filter((k) => k && k !== ZG))];
  const chunks: string[][] = []; for (let i = 0; i < ks.length; i += 15) chunks.push(ks.slice(i, i + 15));
  for (let i = 0; i < chunks.length; i += 6) {
    const res = await Promise.all(chunks.slice(i, i + 6).map((c) => odata(base, set + '?$format=json' + (select ? '&$select=' + select : '') + '&$filter=' + encodeURIComponent(c.map((k) => "Ref_Key eq guid'" + k + "'").join(' or '))).catch(() => [])));
    res.forEach((rows) => rows.forEach((x: any) => out.set(x.Ref_Key, x)));
  }
  return out;
}
const lines = (d: any) => [...(d?.['Товары'] || []), ...(d?.['Услуги'] || [])].map((l: any) => ({ n: String(l['Номенклатура_Key'] || ''), q: Number(l['Количество'] || 0), s: Number(l['Сумма'] || 0) + (d?.['СуммаВключаетНДС'] === false ? Number(l['СуммаНДС'] || 0) : 0), t: String(l['Содержание'] || '') }));
const qty = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString('ru-RU');

async function analyze(base: string, list: { k: string; S: number }[], mov: Map<string, Mv[]>, rep: number) {
  const day = 86400e3, out = new Map<string, { L: Part[][]; open: { at: number; rest: number }[] }>();
  type W = { k: string; S: number; docs: Doc[]; opening: number; from: number; zero: boolean; pairs: number; left: Doc[] };
  const ws: W[] = [];
  for (const { k, S } of list) {
    const agg = new Map<string, Doc>();
    for (const m of mov.get(k) || []) { const d = agg.get(m.rec) || { rec: m.rec, rt: m.rt, at: m.at, amt: 0, ctr: m.ctr }; d.amt += m.amt; d.at = Math.min(d.at, m.at); agg.set(m.rec, d); }
    const all = [...agg.values()].filter((d) => Math.abs(d.amt) >= 0.005).sort((a, b) => a.at - b.at || (a.rec < b.rec ? -1 : 1));
    // последняя точка, где расчёты были закрыты в ноль: всё, что после неё, и составляет нынешний долг
    let bal = S, start = -1;
    for (let i = all.length - 1; i >= 0; i--) { bal -= all[i].amt; if (Math.abs(bal) < 0.01) { start = i; break; } }
    let docs = start >= 0 ? all.slice(start) : all, opening = start >= 0 ? 0 : bal;
    if (docs.length > 80) { opening += docs.slice(0, docs.length - 80).reduce((a, d) => a + d.amt, 0); docs = docs.slice(-80); }
    const sg = S > 0 ? 1 : -1, ch = docs.filter((d) => d.amt * sg > 0), pay = docs.filter((d) => d.amt * sg < 0);
    let pairs = 0;
    // 1) пары на одинаковую сумму (то, что обводят кружочками в акте сверки) — ближайшие по дате
    for (const c of ch) {
      let best: Doc | null = null;
      for (const p of pay) if (!p.used && Math.abs(Math.abs(p.amt) - Math.abs(c.amt)) < 0.01 && (!best || Math.abs(p.at - c.at) < Math.abs(best.at - c.at))) best = p;
      if (best) { best.used = true; c.used = true; pairs++; }
    }
    // 2) одна оплата = 2–4 идущих подряд документа (и наоборот)
    const grp = (one: Doc[], many: Doc[]) => {
      for (const o of one) {
        if (o.used) continue; const fr = many.filter((x) => !x.used);
        found: for (let i = 0; i < fr.length; i++) { let s = 0; for (let j = i; j < Math.min(fr.length, i + 4); j++) { s += Math.abs(fr[j].amt); if (j > i && Math.abs(s - Math.abs(o.amt)) < 0.01) { o.used = true; fr.slice(i, j + 1).forEach((x) => (x.used = true)); pairs++; break found; } if (s > Math.abs(o.amt) + 0.01) break; } }
      }
    };
    grp(pay, ch); grp(ch, pay);
    ws.push({ k, S, docs, opening: r2(opening), from: docs.length ? docs[0].at : rep, zero: start >= 0, pairs, left: docs.filter((d) => !d.used) });
  }
  // документы, которые нужно прочитать: всё окно у тех, у кого есть остаток (для связи со счетами на оплату и номеров)
  const need = new Map<string, string[]>(); let cnt = 0;
  for (const w of ws) { if (!w.left.length) continue; for (const d of w.docs) { if (cnt > 700) break; (need.get(d.rt) || need.set(d.rt, []).get(d.rt)!).push(d.rec); cnt++; } }
  const got = new Map<string, any>();
  for (const [rt, keys] of need) (await byKeys(base, 'Document_' + rt, keys)).forEach((v, k) => got.set(k, v));
  // счета на оплату: у реализации/поступления — «основание», у оплаты — счёт в расшифровке платежа
  const invOf = (d: Doc): { inv: string; type: string; sum: number }[] => {
    const x = got.get(d.rec); if (!x) return [];
    if (isShipType(d.rt)) { const t = String(x['ДокументОснование_Type'] || ''); return /СчетНаОплату/.test(t) && x['ДокументОснование'] && x['ДокументОснование'] !== ZG ? [{ inv: x['ДокументОснование'], type: t.replace('StandardODATA.Document_', ''), sum: Math.abs(d.amt) }] : []; }
    if (isPayType(d.rt)) return (x['РасшифровкаПлатежа'] || []).filter((l: any) => l['СчетНаОплату_Key'] && l['СчетНаОплату_Key'] !== ZG).map((l: any) => ({ inv: l['СчетНаОплату_Key'], type: '', sum: Number(l['СуммаПлатежа'] || 0) }));
    return [];
  };
  const invKeys = new Map<string, string>(); // счёт → объект 1С
  for (const w of ws) for (const d of w.docs) for (const i of invOf(d)) invKeys.set(i.inv, i.type || (w.S > 0 ? 'СчетНаОплатуПокупателю' : 'СчетНаОплатуПоставщика'));
  const invs = new Map<string, any>();
  for (const t of ['СчетНаОплатуПокупателю', 'СчетНаОплатуПоставщика']) {
    const ks = [...invKeys].filter(([k, tt]) => tt === t && !invs.has(k)).map(([k]) => k);
    if (ks.length) (await byKeys(base, 'Document_' + t, ks)).forEach((v, k) => invs.set(k, { ...v, _t: t }));
  }
  const miss = [...invKeys.keys()].filter((k) => !invs.has(k)); // у оплаты тип счёта не указан — пробуем второй вид
  for (const t of ['СчетНаОплатуПоставщика', 'СчетНаОплатуПокупателю']) if (miss.length) (await byKeys(base, 'Document_' + t, miss.filter((k) => !invs.has(k)))).forEach((v, k) => invs.set(k, { ...v, _t: t }));
  // названия номенклатуры — для позиций, которые разошлись
  const nomKeys = new Set<string>();
  invs.forEach((v) => lines(v).forEach((l) => nomKeys.add(l.n)));
  for (const w of ws) for (const d of w.docs) if (isShipType(d.rt)) lines(got.get(d.rec)).forEach((l) => nomKeys.add(l.n));
  const noms = await byKeys(base, 'Catalog_Номенклатура', [...nomKeys], 'Ref_Key,Description');
  const nomName = (k: string, t = '') => String(noms.get(k)?.Description || t || 'позиция без названия').trim();
  // договоры — для пометки «по разным договорам»
  const ctrKeys = new Set<string>(); for (const w of ws) for (const d of w.docs) if (d.ctr && d.ctr !== ZG) ctrKeys.add(d.ctr);
  const ctrs = ctrKeys.size ? await byKeys(base, 'Catalog_ДоговорыКонтрагентов', [...ctrKeys], 'Ref_Key,Description') : new Map();

  const num = (x: any) => { const n = String(x?.Number || '').trim(); return /^\d+$/.test(n) ? n.replace(/^0+(?=\d)/, '') : n; };
  const ref = (d: Doc): Part => { const x = got.get(d.rec); const t = docRu(d.rt) + (x ? ' №' + num(x) : '') + ' от ' + dmy(new Date(d.at).toISOString().slice(0, 10)); return { d: 'Документ.' + d.rt, k: d.rec, t }; };
  const iref = (k: string, w0 = 'счёту'): Part => { const x = invs.get(k); return x ? { d: 'Документ.' + x._t, k, t: w0 + ' на оплату №' + num(x) + ' от ' + dmy(String(x.Date || '').slice(0, 10)) } : 'счёт на оплату (не найден в 1С)'; };
  // за что документ: у реализации/поступления — позиции (самые крупные, до трёх), у оплаты — назначение платежа
  const za = (d: Doc) => {
    const x = got.get(d.rec); if (!x) return '';
    if (isShipType(d.rt)) {
      const ls = lines(x).sort((a, b) => b.s - a.s); if (!ls.length) return '';
      const names = ls.slice(0, 3).map((l) => nomName(l.n, l.t) + (l.q && ls.length > 1 ? ' ' + qty(l.q) : ''));
      return ' — за: ' + names.join(', ') + (ls.length > 3 ? ' и ещё ' + (ls.length - 3) : '');
    }
    const t = String(x['НазначениеПлатежа'] || x['Основание'] || x['Комментарий'] || '').replace(/\s+/g, ' ').trim();
    return t ? ' — «' + (t.length > 90 ? t.slice(0, 88) + '…' : t) + '»' : '';
  };
  for (const w of ws) {
    const L: Part[][] = [], sg = w.S > 0 ? 1 : -1;
    // остаток после пар: оплаты (в обратную сторону) закрывают самые ранние документы — открытыми остаются свежие
    type O = { d: Doc | null; rest: number; full: number };
    const open: O[] = [];
    if (w.opening * sg > 0.005) open.push({ d: null, rest: Math.abs(w.opening), full: Math.abs(w.opening) });
    let pool = w.opening * sg < -0.005 ? Math.abs(w.opening) : 0, closers = 0;
    for (const d of w.left) if (d.amt * sg > 0) open.push({ d, rest: Math.abs(d.amt), full: Math.abs(d.amt) }); else { pool += Math.abs(d.amt); closers++; }
    for (const o of open) { if (pool <= 0.005) break; const t = Math.min(pool, o.rest); o.rest = r2(o.rest - t); pool -= t; }
    const still = open.filter((o) => o.rest > 0.005);
    const head = [w.zero ? 'Расчёты были закрыты в ноль до ' + dmy(new Date(w.from).toISOString().slice(0, 10)) : 'За 3 года расчёты в ноль не закрывались',
      w.pairs ? 'сошлись по суммам и убраны: ' + w.pairs : '', closers ? 'оплаты частями (' + closers + ') закрыли более ранние документы' : ''].filter(Boolean).join('; ');
    L.push([head + '. Открыто:']);
    const shown = still.slice(-15), hidden = still.slice(0, still.length - shown.length);
    if (hidden.length) L.push(['   …более ранние документы: ' + hidden.length + ' на ' + money(r2(hidden.reduce((a, o) => a + o.rest, 0)))]);
    const invDone = new Set<string>();
    // все счета на оплату этого периода: что по ним заказано, реализовано (поступило) и оплачено
    type IVx = { inv: any; buy: boolean; want: Map<string, { q: number; s: number; t: string }>; have: Map<string, { q: number; s: number; t: string }>; shipped: number; paid: number; total: number };
    const IV = new Map<string, IVx>();
    for (const k of new Set(w.docs.flatMap((x) => invOf(x).map((y) => y.inv)))) {
      const inv = invs.get(k); if (!inv) continue;
      const grp = w.docs.filter((x) => invOf(x).some((y) => y.inv === k)), ships = grp.filter((x) => isShipType(x.rt)), pays = grp.filter((x) => isPayType(x.rt));
      const want = new Map<string, { q: number; s: number; t: string }>(), have = new Map<string, { q: number; s: number; t: string }>();
      lines(inv).forEach((l) => { const x = want.get(l.n) || { q: 0, s: 0, t: l.t }; x.q += l.q; x.s += l.s; want.set(l.n, x); });
      ships.forEach((x) => lines(got.get(x.rec)).forEach((l) => { const y = have.get(l.n) || { q: 0, s: 0, t: l.t }; y.q += l.q; y.s += l.s; have.set(l.n, y); }));
      IV.set(k, { inv, buy: inv._t === 'СчетНаОплатуПокупателю', want, have, total: Number(inv['СуммаДокумента'] || 0),
        shipped: r2(ships.reduce((a, x) => a + Math.abs(x.amt), 0)), paid: r2(pays.reduce((a, x) => a + invOf(x).filter((y) => y.inv === k).reduce((b, y) => b + y.sum, 0), 0)) });
    }
    const invLines = (k: string, lead: string): Part[][] => {
      const v = IV.get(k); if (!v) return [];
      const shipW = v.buy ? 'реализовано' : 'поступило', gotW = v.buy ? 'отгружено ' : 'получено ', docW = v.buy ? 'реализация' : 'поступление';
      const note: string[] = [];
      if (v.paid > v.total + 0.01) note.push('переплата ' + money(r2(v.paid - v.total))); else if (v.paid > 0.005 && v.paid + 0.01 < v.total) note.push('недоплата ' + money(r2(v.total - v.paid)));
      if (v.shipped > v.total + 0.01) note.push(shipW + ' больше счёта на ' + money(r2(v.shipped - v.total))); else if (v.shipped + 0.01 < v.total) note.push((v.buy ? 'не реализовано' : 'не поступило') + ' на ' + money(r2(v.total - v.shipped)));
      const pos: Part[][] = [];
      for (const [n, a] of v.want) {
        const b = v.have.get(n) || { q: 0, s: 0, t: '' };
        if (b.q + 0.0005 < a.q) pos.push(['        – ' + nomName(n, a.t) + ': по счёту ' + qty(a.q) + ', ' + gotW + qty(b.q) + ' — не хватает ' + qty(a.q - b.q) + ' на ' + money(r2(a.s - b.s))]);
        else if (b.q > a.q + 0.0005) pos.push(['        – ' + nomName(n, a.t) + ': по счёту ' + qty(a.q) + ', ' + gotW + qty(b.q) + ' — больше на ' + qty(b.q - a.q)]);
        else if (Math.abs(a.s - b.s) >= 0.01) pos.push(['        – ' + nomName(n, a.t) + ': количество совпадает, сумма по счёту ' + money(a.s) + ', в документах ' + money(b.s)]);
      }
      for (const [n, b] of v.have) {
        if (v.want.has(n)) continue;
        // позиция есть в другом счёте, где её ещё не хватает — похоже, документ выписан не по тому счёту
        const other = [...IV].find(([k2, o]) => k2 !== k && o.want.has(n) && (o.have.get(n)?.q || 0) + 0.0005 < o.want.get(n)!.q);
        pos.push(other ? ['        – ' + nomName(n, b.t) + ': нет в этом счёте, ' + gotW + qty(b.q) + ' на ' + money(b.s) + ' — эта позиция есть в ', iref(other[0], 'счёте'), ', где её не хватает: похоже, ' + docW + ' выписана не по тому счёту']
          : ['        – ' + nomName(n, b.t) + ': нет в счёте, ' + gotW + qty(b.q) + ' на ' + money(b.s)]);
      }
      if (!note.length && !pos.length) return [];
      const out2: Part[][] = [[lead, iref(k), ' на ' + money(v.total) + ': ' + shipW + ' ' + money(v.shipped) + ', оплачено ' + money(v.paid) + (note.length ? ' — ' + note.join(', ') : '')], ...pos.slice(0, 12)];
      if (pos.length > 12) out2.push(['        – и ещё позиций: ' + (pos.length - 12)]);
      return out2;
    };
    for (const o of shown) {
      const part = o.rest < o.full - 0.005 ? money(o.rest) + ' из ' + money(o.full) : money(o.rest);
      if (!o.d) { L.push([w.zero ? '   • более ранние документы (не разобраны): ' + money(o.rest) : '   • остаток старше 3 лет (или введён остатками): ' + money(o.rest) + ' — проверьте, к списанию']); continue; }
      const d = o.d, t = d.rt, old = rep - d.at > 1095 * day ? ' — старше 3 лет, к списанию' : '';
      const what = /^Реализация|^Оказание/.test(t) ? ' — не оплачено ' + part
        : /^Поступление/.test(t) ? ' — не оплачено поставщику ' + part
        : /^ВозвратТоваровОтПокупателя/.test(t) ? ' — возврат от покупателя ' + part + ', деньги не возвращены'
        : /^ВозвратТоваровПоставщику/.test(t) ? ' — возврат поставщику ' + part + ', деньги не вернули'
        : isPayType(t) && /Входящ|Поступление|Приходный|ОплатаОтПокупателя/.test(t) ? ' — получено ' + part + ', реализации на эту сумму нет (аванс покупателя)'
        : isPayType(t) ? ' — оплачено ' + part + ', поступления на эту сумму нет (аванс поставщику)'
        : ' — ' + part;
      L.push(['   • ', ref(d), what + old + za(d)]);
      // счёт на оплату этого документа: сколько по нему реализовано (поступило) и оплачено, какие позиции разошлись
      for (const i of invOf(d)) { if (invDone.has(i.inv)) continue; invDone.add(i.inv); L.push(...invLines(i.inv, '      по ')); }
    }
    // остальные счета этого периода: суммы сошлись, но внутри есть ошибки (другие позиции, не тот счёт, переплата)
    const rest = [...IV.keys()].filter((k) => !invDone.has(k)).map((k) => invLines(k, '   • по ')).filter((x) => x.length);
    if (rest.length) { L.push(['Другие счета на оплату с расхождениями:']); rest.slice(0, 10).forEach((x) => L.push(...x)); if (rest.length > 10) L.push(['   …и ещё счетов: ' + (rest.length - 10)]); }
    // разные договоры: долг по одному и аванс по другому
    const byC = new Map<string, number>(); w.docs.forEach((d) => byC.set(d.ctr || '', (byC.get(d.ctr || '') || 0) + d.amt));
    const plus = [...byC].filter(([, v]) => v > 0.01), minus = [...byC].filter(([, v]) => v < -0.01);
    if (plus.length && minus.length) L.push(['По договорам: ' + [...plus, ...minus].map(([c, v]) => '«' + (ctrs.get(c)?.Description || 'без договора') + '» ' + (v > 0 ? 'нам должны ' : 'мы должны ') + money(Math.abs(v))).join('; ') + ' — проверьте зачёт']);
    // открытые документы — по ним и считаются сроки долга (остаток без даты — к самому старому сроку)
    out.set(w.k, { L, open: still.map((o) => ({ at: o.d ? o.d.at : (w.zero ? w.from : 0), rest: o.rest })) });
  }
  return out;
}

async function debts(base: string, checkDate: string, opt: { noan?: boolean; years?: number; prof?: Record<string, number> } = {}) {
  const T0 = Date.now(), mark = (k: string) => { if (opt.prof) opt.prof[k] = Date.now() - T0; };
  const [y, m, d] = checkDate.split('-').map(Number);
  const rep = Date.UTC(y, m - 1, d);                 // дата проверки, 00:00 (время 1С — «как написано», без поясов)
  const day = 86400e3;
  // 1. счета расчётов
  const acc = new Set<string>();
  for (const a of await odata(base, 'ChartOfAccounts_Типовой?$format=json&$select=Ref_Key,Code')) if (DEBT_CODES.has(String(a.Code || '').trim().toUpperCase())) acc.add(a.Ref_Key);
  if (!acc.size) throw new Error('в плане счетов 1С не найден ни один счёт расчётов');
  // 2. сальдо на конец дня проверки
  const bal = await odata(base, "AccountingRegister_Типовой/Balance(Period=datetime'" + isoLocal(new Date(rep + day)) + "')?$format=json");
  const saldo = new Map<string, number>(); const hasDt = new Set<string>(), hasKt = new Set<string>();
  for (const s of bal) {
    if (!acc.has(s.Account_Key)) continue;
    const k = kontr(s, 'ExtDimension'); if (!k) continue;
    const dt = Number(s['СуммаSplittedBalanceDr'] || 0), kt = Number(s['СуммаSplittedBalanceCr'] || 0);
    saldo.set(k, (saldo.get(k) || 0) + dt - kt); if (dt > 0) hasDt.add(k); if (kt > 0) hasKt.add(k);
  }
  const both = new Set([...hasDt].filter((k) => hasKt.has(k)));
  // 3. имена, банки
  const names = new Map<string, string>();
  if (saldo.size) for (const c of await odata(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description')) names.set(c.Ref_Key, shortName(String(c.Description || '')));
  const nm = (k: string) => names.get(k) || '(контрагент без названия)';
  const banks = new Set([...saldo.keys()].filter((k) => /банк|bank/i.test(nm(k))));
  // 4. движения за 3 года до даты проверки — помесячно, по 4 месяца параллельно
  const mov = new Map<string, Mv[]>();
  if (saldo.size) {
    const fields = 'Period,Active,Recorder,Recorder_Type,LineNumber,AccountDr_Key,AccountCr_Key,ExtDimensionDr1,ExtDimensionDr1_Type,ExtDimensionDr2,ExtDimensionDr2_Type,ExtDimensionDr3,ExtDimensionDr3_Type,'
      + 'ExtDimensionCr1,ExtDimensionCr1_Type,ExtDimensionCr2,ExtDimensionCr2_Type,ExtDimensionCr3,ExtDimensionCr3_Type,Сумма';
    const end = rep + day - 1000, from = Date.UTC(y - (opt.years || 3), m - 1, d); const wins: [number, number][] = [];
    for (let s = new Date(from); s.getTime() <= end;) {
      const n = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate())); wins.push([s.getTime(), Math.min(n.getTime() - 1000, end)]); s = n;
    }
    // только счета расчётов, по которым были обороты за период: 1С фильтрует сама — в ответе в разы меньше строк
    // (все проводки базы за 3 года не помещаются в лимит процессорного времени функции)
    let used = [...acc];
    try {
      const t = await odata(base, "AccountingRegister_Типовой/Turnovers(StartPeriod=datetime'" + isoLocal(new Date(from)) + "',EndPeriod=datetime'" + isoLocal(new Date(end)) + "')?$format=json&$select=Account_Key");
      const s2 = new Set(t.map((x: any) => String(x.Account_Key)).filter((k: string) => acc.has(k))); if (s2.size) used = [...s2];
    } catch (_) { /* без отбора по оборотам — берём все счета расчётов */ }
    const flts: string[] = [];
    for (let i = 0; i < used.length; i += 10) flts.push(used.slice(i, i + 10).map((k) => "AccountDr_Key eq guid'" + k + "' or AccountCr_Key eq guid'" + k + "'").join(' or '));
    const jobs: string[] = [];
    for (const [a, b] of wins) for (const f of flts) jobs.push("AccountingRegister_Типовой/RecordsWithExtDimensions(StartPeriod=datetime'" + isoLocal(new Date(a)) + "',EndPeriod=datetime'" + isoLocal(new Date(b)) + "')?$format=json&$select=" + fields + '&$filter=' + encodeURIComponent(f));
    const seen = new Set<string>();
    for (let i = 0; i < jobs.length; i += 6) {
      const parts = await Promise.all(jobs.slice(i, i + 6).map((q) => odata(base, q)));
      if (opt.prof) opt.prof.raw = (opt.prof.raw || 0) + parts.reduce((x, rows) => x + rows.length, 0);
      for (const rows of parts) for (const r of rows) {
        if (r.Active === false) continue;
        const sum = Number(r['Сумма'] || 0); if (sum <= 0) continue;
        const rec = String(r.Recorder || ''), id = rec + '|' + r.LineNumber; if (seen.has(id)) continue; seen.add(id);
        const at = Date.parse(String(r.Period).slice(0, 10) + 'T00:00:00Z');
        const kD = kontr(r, 'ExtDimensionDr'), kK = kontr(r, 'ExtDimensionCr');
        const ourD = !!kD && acc.has(r.AccountDr_Key), ourK = !!kK && acc.has(r.AccountCr_Key);
        if (ourD && ourK && kD === kK) continue;      // зачёт аванса / перенос между договорами — сальдо не меняется
        const rt = String(r.Recorder_Type || '').replace('StandardODATA.Document_', '');
        if (ourD && saldo.has(kD)) { if (!mov.has(kD)) mov.set(kD, []); mov.get(kD)!.push({ at, amt: sum, rec, rt, ctr: dogovor(r, 'ExtDimensionDr') }); }
        if (ourK && saldo.has(kK)) { if (!mov.has(kK)) mov.set(kK, []); mov.get(kK)!.push({ at, amt: -sum, rec, rt, ctr: dogovor(r, 'ExtDimensionCr') }); }
      }
    }
    if (opt.prof) { opt.prof.accs = used.length; opt.prof.reqs = jobs.length; }
  }
  mark('mov'); if (opt.prof) opt.prof.rows = [...mov.values()].reduce((a, v) => a + v.length, 0);
  // 5. раскладка по срокам (FIFO: непогашенными остаются самые свежие начисления)
  const spread = (rest: number, mv: [number, number][]) => {
    const b = new Array(NB).fill(0);
    for (const [at, s] of mv.slice().sort((p, q) => q[0] - p[0])) { if (rest <= 0) break; const t = Math.min(rest, s); b[bucketOf(Math.round((rep - at) / day))] += t; rest -= t; }
    if (rest > 0) b[NB - 1] += rest;
    return b;
  };
  const bDt = new Map<string, number[]>(), bKt = new Map<string, number[]>();
  for (const [k, v] of saldo) {
    if (banks.has(k)) continue;
    const s = r2(v), mv = mov.get(k) || [];
    if (s > 0) bDt.set(k, spread(s, mv.filter((x) => x.amt > 0).map((x) => [x.at, x.amt])));
    else if (s < 0) bKt.set(k, spread(-s, mv.filter((x) => x.amt < 0).map((x) => [x.at, -x.amt])));
  }
  for (const k of [...both]) if (!bDt.has(k) && !bKt.has(k)) both.delete(k);
  const sumA0 = (a: number[]) => a.reduce((x, y) => x + y, 0);
  // 6. анализ по документам (не обязателен: если 1С не отдала документы — таблица уходит без него)
  let an = new Map<string, { L: Part[][]; open: { at: number; rest: number }[] }>(), anErr = '';
  mark('pre_an');
  if (!opt.noan) try { an = await analyze(base, [...bDt.keys(), ...bKt.keys()].map((k) => ({ k, S: r2(saldo.get(k)!) })), mov, rep); } catch (e) { anErr = String((e as Error).message); }
  // сроки — по документам, оставшимся открытыми после сверки (если анализ сошёлся с сальдо), иначе — как раньше
  for (const mp of [bDt, bKt]) for (const [k, a] of mp) {
    const o = an.get(k)?.open; if (!o || !o.length || Math.abs(o.reduce((x, y) => x + y.rest, 0) - sumA0(a)) > 0.05) continue;
    const b = new Array(NB).fill(0); o.forEach((x) => { b[x.at ? bucketOf(Math.round((rep - x.at) / day)) : NB - 1] += x.rest; }); mp.set(k, b);
  }
  mark('an');
  const oldest = (a: number[]) => { for (let i = NB - 1; i >= 0; i--) if (r2(a[i]) !== 0) return i; return 0; };
  const sumA = sumA0;
  const label = (k: string) => nm(k) + (both.has(k) ? ' ⚠️' : '');
  const section = (title: string, data: Map<string, number[]>) => {
    const rows: any[] = [];
    for (let g = NB - 1; g >= 0; g--) [...data].filter(([, a]) => oldest(a) === g).sort((p, q) => q[1][g] - p[1][g] || sumA(q[1]) - sumA(p[1]))
      .forEach(([k, a]) => rows.push({ name: label(k), group: g, total: r2(sumA(a)), b: a.map(r2), ...(an.get(k)?.L.length ? { an: an.get(k)!.L } : {}) }));
    return { title, total: r2([...data.values()].reduce((x, a) => x + sumA(a), 0)), rows };
  };
  const bankRows = [...banks].filter((k) => r2(saldo.get(k)!) !== 0).sort((p, q) => Math.abs(saldo.get(q)!) - Math.abs(saldo.get(p)!))
    .map((k) => { const s = r2(saldo.get(k)!); return { name: nm(k), dt: s > 0 ? s : 0, kt: s < 0 ? -s : 0 }; });
  const sections: any[] = [];
  if (bDt.size) sections.push(section('Нам должны', bDt));
  if (bKt.size) sections.push(section('Мы должны', bKt));
  if (bankRows.length) sections.push({ title: 'Банки', bank: true, rows: bankRows });
  return { bDt, bKt, bankRows, both: both.size, sections, sumA, anErr, dateText: d + ' ' + RU_MONTHS[m - 1] + ' ' + y };
}

// Дт/Кт: тяжёлые фирмы (3 года движений + анализ по документам) упираются в лимит процессорного времени функции,
// поэтому одна фирма — один вызов: после фирмы функция вызывает себя же для следующей (resume).
// Готовые фирмы — те, у кого есть отчёт по run_id; ошибки копятся в note; «сейчас в работе» — now_firms, пульс — beat;
// tries — сколько раз брались за фирму: функция оборвалась на ней дважды (сторож продолжил) — фирма уходит в ошибки, робот идёт дальше.
const FIRM_LIMIT = 100000;
async function runDebts(robot: any, run: any, ctx: { key?: string; t0?: number; tok?: string } = {}) {
  const tok = ctx.tok || crypto.randomUUID();
  const { data: firms } = await db.from('companies').select('id,name,onec_url').in('id', run.company_ids);
  const { data: links } = await db.from('company_robots').select('company_id,status,enabled').eq('robot_id', robot.id).in('company_id', run.company_ids);
  const okLink = new Set((links || []).filter((l: any) => l.status === 'active' && l.enabled).map((l: any) => l.company_id));
  const list = (firms || []).filter((f: any) => okLink.has(f.id));
  const cd = /^\d{4}-\d{2}-\d{2}$/.test(String(run.check_date || '')) ? String(run.check_date) : kzToday();
  const errs: string[] = String(run.note || '').split('; ').filter((x) => x && list.some((f: any) => x.startsWith(f.name + ': ')));
  const one = async (f: any) => {
    if (!f.onec_url) throw new Error('в профиле фирмы не указан адрес 1С');
    const r = await debts(f.onec_url, cd);
    const tot = (mp: Map<string, number[]>) => r2([...mp.values()].reduce((x, a) => x + r.sumA(a), 0));
    const lines = ['🏢 ' + shortName(f.name) + ': задолженность на ' + r.dateText + ' года'];
    const brief = (t: string, mp: Map<string, number[]>) => {
      if (!mp.size) return;
      lines.push('', t + ' — ' + money(tot(mp)) + ' (контрагентов: ' + mp.size + ')');
      for (let g = NB - 1; g >= 0; g--) { const s = r2([...mp.values()].reduce((x, a) => x + a[g], 0)); if (s) lines.push('   ' + BUCKET_ICON[g] + ' ' + BUCKETS[g] + ' — ' + money(s)); }
    };
    brief('🟢 Нам должны', r.bDt); brief('🔴 Мы должны', r.bKt);
    if (r.bankRows.length) lines.push('', '🏦 Есть расчёты с банками — см. таблицу');
    if (r.both) lines.push('', '⚠️ У ' + r.both + ' контрагентов в 1С висят и аванс, и долг — сальдо свёрнуто, проверьте зачёт авансов');
    const none = !r.sections.length;
    if (none) lines.push('', '✅ Задолженности по счетам расчётов нет');
    const { data: dup } = await db.from('events').select('id').eq('run_id', run.id).eq('company_id', f.id).limit(1);
    if (dup && dup.length) return;   // отчёт по фирме уже записан
    const { error } = await db.from('events').insert({
      company_id: f.id, robot_id: robot.id, run_id: run.id,
      title: 'Расчёты с контрагентами на ' + dmy(cd),
      body: lines.join('\n'),
      severity: none ? 'info' : 'warning', status: none ? 'done' : 'new', ...(none ? { done_at: new Date().toISOString() } : {}),
      details: none ? null : { title: lines[0], groups: BUCKETS, columns: ['Контрагент', 'Всего', ...BUCKET_COLS], sections: r.sections,
        dt: tot(r.bDt), kt: tot(r.bKt), date: cd },
    });
    if (error) throw new Error(error.message);
  };
  for (;;) {
    // занять запуск: работает только один вызов (свой токен, переданный по цепочке, или прежний замолчал больше 90 с)
    const { data: got } = await db.from('robot_runs').update({ lk: tok, beat: new Date().toISOString() }).eq('id', run.id).eq('status', 'running')
      .or('lk.is.null,lk.eq.' + tok + ',beat.lt.' + new Date(Date.now() - 90000).toISOString()).select('status,tries');
    const cur = got && got[0];
    if (!cur) return;   // остановлено пользователем или уже работает другой вызов
    const { data: evs } = await db.from('events').select('company_id').eq('run_id', run.id);
    const doneIds = new Set((evs || []).map((e: any) => e.company_id));
    const left = list.filter((f: any) => !doneIds.has(f.id) && !errs.some((x) => x.startsWith(f.name + ': ')));
    if (!left.length) {
      const skipped = run.company_ids.length - list.length;
      const note = [doneIds.size ? 'проверено фирм: ' + doneIds.size : '', skipped ? 'пропущено (робот не готов к работе): ' + skipped : '', ...errs].filter(Boolean).join('; ');
      await db.from('robot_runs').update({ status: errs.length ? 'error' : 'done', finished_at: new Date().toISOString(), now_firms: null, beat: new Date().toISOString(), note: note.slice(0, 2000) || null }).eq('id', run.id).eq('status', 'running');
      return;
    }
    const f = left[0], tries: Record<string, number> = { ...(cur.tries || {}) };
    if ((tries[f.id] || 0) >= 2) {
      errs.push(f.name + ': робот дважды прервался на этой фирме — слишком много документов в 1С за 3 года, сообщите в ESEP');
      await db.from('robot_runs').update({ note: errs.join('; ').slice(0, 2000) }).eq('id', run.id).eq('status', 'running');
      continue;
    }
    tries[f.id] = (tries[f.id] || 0) + 1;
    await db.from('robot_runs').update({ now_firms: f.name, beat: new Date().toISOString(), tries }).eq('id', run.id);
    try {
      await Promise.race([one(f), new Promise((_, rej) => setTimeout(() => rej(new Error('1С не успела отдать данные за ' + FIRM_LIMIT / 1000 + ' с — попробуйте позже')), FIRM_LIMIT))]);
    } catch (e) {
      errs.push(f.name + ': ' + (e as Error).message);
      await db.from('robot_runs').update({ note: errs.join('; ').slice(0, 2000) }).eq('id', run.id).eq('status', 'running');
    }
    // следующая фирма — в новом вызове (свой запас процессорного времени)
    if (ctx.key) {
      await db.from('robot_runs').update({ beat: new Date().toISOString() }).eq('id', run.id);
      const r = await fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/robot-1c', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-server-key': ctx.key }, body: JSON.stringify({ run_id: run.id, resume: true, tok }) }).catch(() => null);
      if (r && r.ok) return;
    }
  }
}

// ---------- Порог НДС: оборот с 1 января по 6010 (минус возвраты 6020), только чтение 1С ----------
async function vatTurnover(base: string) {
  const year = kzToday().slice(0, 4);
  const acc = await odata(base, "ChartOfAccounts_Типовой?$format=json&$select=Ref_Key,Code&$filter=Code eq '6010' or Code eq '6020'");
  const k6010 = acc.find((a: any) => String(a.Code).trim() === '6010')?.Ref_Key;
  const k6020 = acc.find((a: any) => String(a.Code).trim() === '6020')?.Ref_Key;
  if (!k6010) throw new Error('в плане счетов 1С нет счёта 6010');
  const per = "Turnovers(StartPeriod=datetime'" + year + "-01-01T00:00:00',EndPeriod=datetime'" + kzToday() + "T23:59:59')";
  const sum = async (key: string, f: string) => (await odata(base, 'AccountingRegister_Типовой/' + per + "?$format=json&$select=" + f + "&$filter=Account_Key eq guid'" + key + "'"))
    .reduce((t: number, r: any) => t + Number(r[f] || 0), 0);
  const rev = await sum(k6010, 'СуммаTurnoverCr');
  const ret = k6020 ? await sum(k6020, 'СуммаTurnoverDr') : 0;
  return { turnover: r2(rev - ret), year: Number(year) };
}
async function vatCheck(companyId?: string) {
  let q = db.from('companies').select('id,name,onec_url').eq('tax_regime', 'general').eq('vat_payer', false).is('archived_at', null).not('onec_url', 'is', null);
  if (companyId) q = q.eq('id', companyId);
  const { data: firms } = await q;
  const list = firms || [];
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (f: any) => {
      try {
        const v = await vatTurnover(f.onec_url);
        await db.from('companies').update({ vat_turnover: v.turnover, vat_turnover_year: v.year, vat_turnover_at: new Date().toISOString(), vat_turnover_err: null }).eq('id', f.id);
      } catch (e) {
        await db.from('companies').update({ vat_turnover_err: String((e as Error).message).slice(0, 300), vat_turnover_at: new Date().toISOString() }).eq('id', f.id);
      }
    }));
  }
}

// ---------- Диагностика поступлений и реализаций (esf_diagnostics) ----------
// Перенесено из UiPath: внешний отчёт Жанны «ПоступленияИРеализации.erf» (проверки 1–10) и типовой
// «Отчёт по наличию счетов-фактур выданных» (по первичным документам) → крайний срок выписки ЭСФ = дата оборота + 15 дней.
// Синхронизацию с ИС ЭСФ (загрузка ЭСФ/СНТ/ЭАВР с портала, ЭЦП) по-прежнему делает UiPath — здесь только чтение 1С.
const isUndef = (t: any) => !t || /Undefined$/.test(String(t));
const isEmptyKey = (k: any) => !k || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(String(k));
const ENUM_RU: Record<string, string> = { ВБумажномВиде: 'В бумажном виде', НаПорталеИСЭСФ: 'На портале ИС ЭСФ', НаПорталеГосзакупок: 'На портале госзакупок',
  ВОжиданииПодтвержденияПолучателя: 'Ждёт подтверждения получателя', ВОжиданииПодтвержденияОтзываПолучателя: 'Ждёт подтверждения отзыва' };
const enumRu = (s: any) => { const v = String(s || ''); if (!v) return 'Способ не указан'; if (ENUM_RU[v]) return ENUM_RU[v];
  const w = v.replace(/([а-яё])([А-ЯЁ])/g, '$1 $2').split(' '); return w.map((x, i) => i && x !== x.toUpperCase() ? x.toLowerCase() : x).join(' '); };
const addDays = (iso: string, n: number) => new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// документы отгрузки из типового отчёта; true — дата оборота может быть датой подписания на портале (электронный акт)
// 4-й флаг — есть реквизит ОтложитьНачислениеНДС (у ПередачаОС/НМА и прочих операций его нет — проверено по всем базам 11.11.2026)
const SHIP_DOCS: [string, string, boolean, boolean][] = [
  ['РеализацияТоваровУслуг', 'Реализация', true, true], ['АктОбОказанииПроизводственныхУслуг', 'Акт производственных услуг', true, true],
  ['РеализацияУслугПоПереработке', 'Реализация услуг по переработке', true, true], ['ВозвратТоваровОтПокупателя', 'Возврат от покупателя', false, true],
  ['ПередачаОС', 'Передача ОС', false, false], ['ПередачаНМА', 'Передача НМА', false, false],
  ['РегистрацияПрочихОперацийПоРеализованнымТоварамВЦеляхНДС', 'Прочие операции по реализации (НДС)', false, false],
];
async function odataTry(base: string, a: string, b: string) { try { return await odata(base, a); } catch (e) { if (/не опубликован|неверный запрос/.test((e as Error).message)) return await odata(base, b); throw e; } }

async function diagnostics(base: string, fromDate?: string) {
  const today = kzToday();
  // по умолчанию — 01.01 три года назад (в 2026 → 01.01.2023, с 2027 → 01.01.2024); дату, выбранную пользователем, не трогаем
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromDate || '') ? String(fromDate) : (Number(today.slice(0, 4)) - 3) + '-01-01';
  const per = (f = 'Date') => f + " ge datetime'" + from + "T00:00:00' and " + f + " le datetime'" + today + "T23:59:59'";
  const q = (o: string, sel: string, flt: string) => o + '?$format=json&$select=' + sel + '&$filter=' + encodeURIComponent(flt);
  const notIn = (v: any, arr: string[]) => !arr.includes(String(v || ''));
  const names = new Map<string, string>();
  const name = (k: any) => names.get(String(k)) || 'Без контрагента';
  // по каждой проверке — расшифровка документов (номер, дата, контрагент, статус); в отчёт не больше 100 строк на проверку
  type Doc = { key: string; number: string; date: string; contractor: any; status?: string; sum?: number; way?: string; hint?: { k: string; p?: number; t: string } };
  const checks: { title: string; count: number; parts?: [string, number][]; items?: Doc[]; skipped?: string }[] = [];
  // регистрационный номер портала + номер самого документа в скобках: «ESF-…-42226234 (31184)»
  const num = (x: any) => regNo(x['РегистрационныйНомер'], x.Number);
  const doc = (x: any, ctr: string): Doc => ({ key: String(x.Ref_Key), number: num(x), date: String(x.Date || '').slice(0, 10), contractor: x[ctr],
    ...(x['Статус'] ? { status: enumRu(x['Статус']) } : {}), ...(x['СуммаДокумента'] != null ? { sum: Number(x['СуммаДокумента']) || 0 } : {}) });
  const add = (title: string, rows: any[], ctr: string, extra?: (x: any, d: Doc) => void) => {
    const items = rows.slice().sort((p, q) => String(p.Date || '').localeCompare(String(q.Date || ''))).slice(0, 100).map((x) => { const d = doc(x, ctr); if (extra) extra(x, d); return d; });
    checks.push({ title, count: rows.length, items });
  };
  const H = 'Ref_Key,Number,Date,Статус';

  // СНТ полученные (1, 2)
  const snt = await odataTry(base, q('Document_СНТ', H + ',ДокументОснование_Type,РегистрационныйНомер,Контрагент_Key', "Направление eq 'Входящий' and " + per()),
    q('Document_СНТ', H + ',ДокументОснование_Type', "Направление eq 'Входящий' and " + per()));
  add('Не подтверждено СНТ полученных', snt.filter((x: any) => notIn(x['Статус'], ['Аннулирован', 'Отозван', 'Подтвержден'])), 'Контрагент_Key');
  add('СНТ полученные без документа-основания', snt.filter((x: any) => notIn(x['Статус'], ['Аннулирован', 'Отозван']) && isUndef(x['ДокументОснование_Type'])), 'Контрагент_Key');
  // ЭАВР (3, 4, 7) — если документ не опубликован в OData, проверка пропускается с пометкой
  let avrIn: any[] | null = null, avrOut: any[] | null = null;
  const AV = H + ',ДокументОснование,ДокументОснование_Type,РегистрационныйНомер,Контрагент';
  try {
    avrIn = await odata(base, q('Document_ЭлектронныйАктВыполненныхРабот', AV, "Направление eq 'Входящий' and " + per()));
    avrOut = await odata(base, q('Document_ЭлектронныйАктВыполненныхРабот', AV, "Направление eq 'Исходящий' and " + per()));
  } catch (e) { if (!/не опубликован/.test((e as Error).message)) throw e; }
  if (avrIn && avrOut) {
    add('Не подтверждено ЭАВР полученных', avrIn.filter((x: any) => notIn(x['Статус'], ['Подтвержденный', 'Отозванный', 'Расторгнут'])), 'Контрагент');
    add('ЭАВР полученных без документа-основания', avrIn.filter((x: any) => notIn(x['Статус'], ['Отозванный', 'Расторгнут']) && isUndef(x['ДокументОснование_Type'])), 'Контрагент');
  } else checks.push({ title: 'ЭАВР полученные', count: 0, skipped: 'ЭАВР не опубликован в OData этой базы' });
  // ЭСФ полученные (5, 6)
  const WAIT = "(Статус eq 'ВОжиданииПодтвержденияПолучателя' or Статус eq 'ВОжиданииПодтвержденияОтзываПолучателя')";
  const EF = H + ',РегистрационныйНомер,Контрагент_Key,СуммаДокумента';
  add('Подтвердить ЭСФ полученные', await odata(base, q('Document_ЭСФ', EF, "Направление eq 'Входящий' and " + WAIT)), 'Контрагент_Key');
  const noSf = (await odata(base, q('Document_ЭСФ', EF + ',СчетФактура_Type,ДатаОборота', "Направление eq 'Входящий' and " + per())))
    .filter((x: any) => notIn(x['Статус'], ['Отозванный', 'Аннулированный']) && isUndef(x['СчетФактура_Type']));
  // подсказка: поступление от этого поставщика на дату оборота ЭСФ (сумма та же — можно оформить ЭСФ на его основании)
  const recBy = new Map<string, any[]>();
  if (noSf.length) {
    const ds = noSf.map((x: any) => String(x['ДатаОборота'] || x.Date).slice(0, 10)).filter((d: string) => d && !d.startsWith('0001')).sort();
    if (ds.length) {
      try {
        const rec = await odata(base, q('Document_ПоступлениеТоваровУслуг', 'Ref_Key,Number,Date,Контрагент_Key,СуммаДокумента', "DeletionMark eq false and Date ge datetime'" + ds[0] + "T00:00:00' and Date le datetime'" + ds[ds.length - 1] + "T23:59:59'"));
        rec.forEach((r: any) => { const k = r['Контрагент_Key'] + '|' + String(r.Date).slice(0, 10); if (!recBy.has(k)) recBy.set(k, []); recBy.get(k)!.push(r); });
      } catch (_) { /* подсказки не обязательны */ }
    }
  }
  add('Не оформлено ЭСФ полученных', noSf, 'Контрагент_Key', (x, d) => {
    const day = String(x['ДатаОборота'] || x.Date).slice(0, 10);
    const c = recBy.get(x['Контрагент_Key'] + '|' + day) || []; if (!c.length) return;
    const sum = Number(x['СуммаДокумента'] || 0);
    const same = c.find((r: any) => Math.abs(Number(r['СуммаДокумента'] || 0) - sum) < 1);
    const r = same || c[0];
    (d as any).hint = { k: same ? 'same' : 'other', p: same ? 85 : 50, t: 'Поступление № ' + String(r.Number || '').replace(/^0+/, '') + ' от ' + dm(day) + ' на ' + money2(Number(r['СуммаДокумента'] || 0))
      + (same ? ' — сумма совпадает, оформите ЭСФ по нему' : ' — дата и поставщик совпадают, сумма другая') };
  });
  // ЭАВР выданные (7)
  const avrWait = avrOut ? avrOut.filter((x: any) => notIn(x['Статус'], ['Расторгнут', 'Аннулирован', 'Подтвержденный', 'Отозванный', 'Отклоненный'])) : [];
  if (avrOut) add('Неподтверждённые ЭАВР выданные', avrWait, 'Контрагент');
  else checks.push({ title: 'ЭАВР выданные', count: 0, skipped: 'ЭАВР не опубликован в OData этой базы' });
  // Непроведённые реализации (8) — со способом выписки
  const unp = await odataTry(base, q('Document_РеализацияТоваровУслуг', 'Ref_Key,Number,Date,Контрагент_Key,СуммаДокумента,СпособВыпискиАктовВыполненныхРабот', 'Posted eq false and DeletionMark eq false and ' + per()),
    q('Document_РеализацияТоваровУслуг', 'Ref_Key,Number,Date,Контрагент_Key,СпособВыпискиАктовВыполненныхРабот', 'Posted eq false and DeletionMark eq false and ' + per()));
  // реализация — основание неподтверждённого ЭАВР выданного: она уже в строке про ЭАВР, второй раз не показываем (решение Жанны 24.11.2026)
  const byAvr = new Set(avrWait.map((x: any) => String(x['ДокументОснование'] || '')).filter((k: string) => k && !isEmptyKey(k)));
  add('Не проведено реализаций', unp.filter((x: any) => !byAvr.has(String(x.Ref_Key))), 'Контрагент_Key', (x, d) => { d.way = enumRu(x['СпособВыпискиАктовВыполненныхРабот']); });
  // ЭСФ выданные ждут подтверждения (10)
  add('Не подтверждены ЭСФ выданные', await odata(base, q('Document_ЭСФ', EF, "Направление eq 'Исходящий' and " + WAIT)), 'Контрагент_Key');
  // имена контрагентов — одним запросом, если есть что расшифровывать
  if (checks.some((c) => c.items && c.items.length)) {
    for (const c of await odata(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description')) names.set(c.Ref_Key, shortName(String(c.Description || '')));
    checks.forEach((c) => (c.items || []).forEach((d) => { d.contractor = isEmptyKey(d.contractor) ? '' : name(d.contractor); }));
  }

  // Сроки выписки ЭСФ по документам отгрузки (типовой отчёт по наличию счетов-фактур выданных)
  const early = addDays(from, -120);
  const ship: any[] = [];
  for (const [obj, title, el, vat] of SHIP_DOCS) {
    const full = 'Ref_Key,Number,Date,Контрагент_Key' + (vat ? ',ОтложитьНачислениеНДС' : '') + (el ? ',СпособВыпискиАктовВыполненныхРабот,ДатаПодписанияГЗ' : '');
    const flt = "Posted eq true and Date ge datetime'" + early + "T00:00:00' and Date le datetime'" + today + "T23:59:59'";
    let rows: any[] = [];
    try { rows = await odataTry(base, q('Document_' + obj, full, flt), q('Document_' + obj, 'Ref_Key,Number,Date', flt)); }
    catch (e) { if (/не опубликован/.test((e as Error).message)) continue; throw e; }
    for (const r of rows) {
      const elec = el && r['СпособВыпискиАктовВыполненныхРабот'] && r['СпособВыпискиАктовВыполненныхРабот'] !== 'ВБумажномВиде';
      const eff = String((elec ? r['ДатаПодписанияГЗ'] : r.Date) || '').slice(0, 10);
      if (eff < from || eff > today || eff.startsWith('0001')) continue;
      if (r['ОтложитьНачислениеНДС'] === true) continue;
      ship.push({ key: r.Ref_Key, obj, type: title, number: String(r.Number || '').replace(/^0+/, '') || String(r.Number || ''), date: String(r.Date || '').slice(0, 10), eff, contractor: r['Контрагент_Key'] });
    }
  }
  const esf: { overdue: number; overdueFrom: string; upcoming: number; nearest: string; items: any[] } = { overdue: 0, overdueFrom: '', upcoming: 0, nearest: '', items: [] };
  if (ship.length) {
    const want = new Set(ship.map((s) => s.key));
    const links = (await odata(base, 'Document_СчетФактураВыданный_ДокументыОснования?$format=json&$select=Ref_Key,ДокументОснование')).filter((l: any) => want.has(String(l['ДокументОснование'])));
    const sfKeys = new Set(links.map((l: any) => String(l.Ref_Key)));
    const sfHead = new Map<string, any>();
    if (sfKeys.size) for (const s of await odata(base, q('Document_СчетФактураВыданный', 'Ref_Key,DeletionMark,ДатаСовершенияОборотаПоРеализации', "Date ge datetime'" + addDays(early, -60) + "T00:00:00'"))) if (sfKeys.has(s.Ref_Key) && !s.DeletionMark) sfHead.set(s.Ref_Key, s);
    // счета-фактуры, прекратившие действие, и сторнированные — не считаются
    const dead = new Set<string>();
    if (sfHead.size) {
      for (const r of await odata(base, 'InformationRegister_СчетаФактурыПрекратившиеДействие?$format=json')) for (const x of (r.RecordSet || [r])) if (x['СчетФактура']) dead.add(String(x['СчетФактура']));
      for (const s of await odata(base, q('Document_Сторнирование', 'ДокументОснование,DeletionMark', 'DeletionMark eq false'))) if (s['ДокументОснование']) dead.add(String(s['ДокументОснование']));
    }
    const sfOf = new Map<string, string[]>();
    links.forEach((l: any) => { const sf = String(l.Ref_Key); if (!sfHead.has(sf) || dead.has(sf)) return; const k = String(l['ДокументОснование']); if (!sfOf.has(k)) sfOf.set(k, []); sfOf.get(k)!.push(sf); });
    // выписанный ЭСФ: есть регистрационный номер и не отклонён / не отозван / не аннулирован
    const issued = new Set<string>();
    if (sfOf.size) {
      const es = await odataTry(base, q('Document_ЭСФ', 'СчетФактура,РегистрационныйНомер,Статус,Состояние', "Направление eq 'Исходящий' and Date ge datetime'" + early + "T00:00:00'"),
        q('Document_ЭСФ', 'СчетФактура,РегистрационныйНомер,Статус', "Направление eq 'Исходящий' and Date ge datetime'" + early + "T00:00:00'"));
      es.forEach((e: any) => { if (String(e['РегистрационныйНомер'] || '').trim() && !/Отклон|Отозван|Аннулир/.test(String(e['Состояние'] || '') + ' ' + String(e['Статус'] || ''))) issued.add(String(e['СчетФактура'])); });
    }
    const needNames = [];
    for (const s of ship) {
      const sfs = sfOf.get(s.key) || [];
      if (sfs.some((sf) => issued.has(sf))) continue;                       // ЭСФ выписан
      const sfDate = sfs.map((sf) => String(sfHead.get(sf)['ДатаСовершенияОборотаПоРеализации'] || '').slice(0, 10)).find((x) => x && !x.startsWith('0001'));
      const turn = sfDate || s.eff;
      const dl = addDays(turn, 15);
      esf.items.push({ key: s.key, obj: s.obj, type: s.type, number: s.number, date: s.date, contractor: s.contractor, turnover: turn, deadline: dl, sf: sfs.length > 0 });
      needNames.push(s.contractor);
    }
    if (esf.items.length && !names.size) for (const c of await odata(base, 'Catalog_Контрагенты?$format=json&$select=Ref_Key,Description')) names.set(c.Ref_Key, shortName(String(c.Description || '')));
    esf.items.forEach((x) => { x.contractor = isEmptyKey(x.contractor) ? 'Без контрагента' : name(x.contractor); });
    esf.items.sort((a, b) => a.deadline.localeCompare(b.deadline));
    const over = esf.items.filter((x) => x.deadline < today), up = esf.items.filter((x) => x.deadline >= today);
    esf.overdue = over.length; esf.overdueFrom = over.length ? over[0].deadline : '';
    esf.upcoming = up.length; esf.nearest = up.length ? up[0].deadline : '';
  }
  return { from, checks, esf };
}

async function runDiagnostics(robot: any, run: any) {
  const { data: firms } = await db.from('companies').select('id,name,onec_url').in('id', run.company_ids);
  const { data: links } = await db.from('company_robots').select('company_id,status,enabled,settings').eq('robot_id', robot.id).in('company_id', run.company_ids);
  const okLink = new Set((links || []).filter((l: any) => l.status === 'active' && l.enabled).map((l: any) => l.company_id));
  const setOf: Record<string, any> = {}; (links || []).forEach((l: any) => { setOf[l.company_id] = l.settings || {}; });
  const errs: string[] = []; let done = 0;
  const list = (firms || []).filter((f: any) => okLink.has(f.id));
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (f: any) => {
      try {
        if (!f.onec_url) throw new Error('в профиле фирмы не указан адрес 1С');
        const r = await diagnostics(f.onec_url, setOf[f.id] && setOf[f.id].from);
        // как в UiPath: только то, что требует внимания; ✍️ — что сделать, 📋 — с разбивкой
        const lines: string[] = [];
        r.checks.filter((c) => c.count > 0).forEach((c) => lines.push('✍️ ' + c.title + ': ' + c.count));
        let esfLine = '';
        if (r.esf.overdue) esfLine = '⏰ Просрочено ЭСФ (' + r.esf.overdue + ') с ' + dmy(r.esf.overdueFrom);
        else if (r.esf.upcoming) esfLine = '📤 Отправить ЭСФ (' + r.esf.upcoming + ') до ' + dmy(r.esf.nearest);
        if (esfLine) lines.push(esfLine);
        const skipped = r.checks.filter((c) => c.skipped);
        const n = r.checks.reduce((a, c) => a + c.count, 0) + r.esf.overdue + r.esf.upcoming;
        const body = (n ? lines.join('\n') : '✅ Всё в порядке: документы подтверждены и оформлены, ЭСФ выписаны.')
          + (skipped.length ? '\n\nℹ️ Не проверено: ' + skipped.map((c) => c.title + ' (' + c.skipped + ')').join('; ') : '')
          + '\n\nПериод: с ' + dmy(r.from) + ' по ' + dmy(kzToday()) + '. Данные 1С — после последней синхронизации с ИС ЭСФ.';
        const title = n ? 'Диагностика поступлений и реализаций: требует внимания' + (r.esf.overdue ? ' · просрочено ЭСФ ' + r.esf.overdue : '') : 'Диагностика поступлений и реализаций: всё в порядке';
        const { error } = await db.from('events').insert({
          company_id: f.id, robot_id: robot.id, run_id: run.id, title, body,
          severity: r.esf.overdue ? 'critical' : n ? 'warning' : 'info', status: n ? 'new' : 'done', ...(n ? {} : { done_at: new Date().toISOString() }),
          details: { kind: 'diag', date: kzToday(), from: r.from, checks: r.checks, esf: r.esf },
        });
        if (error) throw new Error(error.message);
        await db.from('robot_status').upsert({ company_id: f.id, robot_id: robot.id, key: 'diag',
          label: n ? 'Диагностика с ' + dmy(r.from) + ': требует внимания' + (esfLine ? ' · ' + esfLine.replace(/^\S+ /, '') : '') : 'Диагностика с ' + dmy(r.from) + ': всё в порядке',
          at: new Date().toISOString() }, { onConflict: 'company_id,robot_id,key' });
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

const HANDLERS: Record<string, (robot: any, run: any, ctx?: any) => Promise<void>> = { unpaid_invoices: runInvoices, powers_of_attorney: runPowers, counterparty_debts: runDebts, esf_diagnostics: runDiagnostics };

async function handleRun(runId: string, key = '', resume = false, tok = '') {
  const t0 = Date.now();
  const { data: run } = await db.from('robot_runs').select('*').eq('id', runId).maybeSingle();
  if (resume) {   // продолжение запуска Дт/Кт по частям
    if (!run || run.status !== 'running') return;
    const { data: robot } = await db.from('robots').select('id,code,name,executor').eq('id', run.robot_id).maybeSingle();
    if (!robot || robot.code !== 'counterparty_debts') return;
    try { await runDebts(robot, run, { key, t0, tok: tok || undefined }); }
    catch (e) { await db.from('robot_runs').update({ status: 'error', finished_at: new Date().toISOString(), now_firms: null, note: String((e as Error).message).slice(0, 2000) }).eq('id', run.id); }
    return;
  }
  if (!run || run.status !== 'queued') return;
  const { data: robot } = await db.from('robots').select('id,code,name,executor').eq('id', run.robot_id).maybeSingle();
  const h = robot && robot.executor === 'server' ? HANDLERS[robot.code] : null;
  // занять задание (только если всё ещё в очереди — защита от двойного запуска)
  const { data: took } = await db.from('robot_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', run.id).eq('status', 'queued').select('id');
  if (!took || !took.length) return;
  if (!h) { await db.from('robot_runs').update({ status: 'error', finished_at: new Date().toISOString(), note: 'Серверный робот для «' + (robot?.name || '?') + '» не найден' }).eq('id', run.id); return; }
  if (!USER || !PASS) { await db.from('robot_runs').update({ status: 'error', finished_at: new Date().toISOString(), note: 'Логин и пароль 1С не заданы в секретах кабинета' }).eq('id', run.id); return; }
  try { await h(robot, run, { key, t0 }); }
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
    // проверка Дт/Кт без записи в кабинет (только по ключу сервера): ответ — таблица с анализом
    if (p.debts_dry && p.company_id) {
      const { data: f } = await db.from('companies').select('onec_url').eq('id', String(p.company_id)).maybeSingle();
      if (!f || !f.onec_url) return json({ ok: false, error: 'нет адреса 1С' }, 404);
      const t0 = Date.now(), prof: Record<string, number> = {};
      const r = await debts(f.onec_url, /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : kzToday(), { noan: !!p.noan, years: Number(p.years) || 3, prof });
      return json({ ok: true, ms: Date.now() - t0, prof, ...(p.brief ? {} : { sections: r.sections }) });
    }
    // порог НДС: оборот по 6010 (все подходящие фирмы или одна)
    if (p.vat_check) {
      if (!USER || !PASS) return json({ ok: false, error: 'Логин и пароль 1С не заданы' }, 500);
      // @ts-ignore EdgeRuntime есть в Supabase
      EdgeRuntime.waitUntil(vatCheck(p.company_id ? String(p.company_id) : undefined));
      return json({ ok: true, accepted: 'vat_check' });
    }
    const runId = String(p.run_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, error: 'Нужен run_id' }, 400);
    // отвечаем сразу, работа идёт в фоне
    // @ts-ignore EdgeRuntime есть в Supabase
    EdgeRuntime.waitUntil(handleRun(runId, key, !!p.resume, /^[0-9a-f-]{36}$/i.test(String(p.tok || '')) ? String(p.tok) : ''));
    return json({ ok: true, accepted: runId });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
