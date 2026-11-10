// Серверные роботы ESEP: данные из облачной 1С через OData, без UiPath и Telegram.
// Вызывает база (триггер на новое задание robot_runs, заголовок x-server-key): { run_id }.
// Сейчас умеет: unpaid_invoices — счета на оплату, powers_of_attorney — доверенности, counterparty_debts — расчёты с контрагентами (Дт/Кт).
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

// ---------- Расчёты с контрагентами (Дт/Кт) ----------
// Перенесено из UiPath «Дт/Кт задолженность» (Invoke Code «с группировкой»), без Telegram и PDF.
// 1) план счетов → счета расчётов по кодам; 2) остатки регистра на конец даты проверки, свёрнутое сальдо Дт−Кт по контрагенту;
// 3) движения за год до даты (помесячно) → раскладка долга по срокам (FIFO: непогашенными остаются самые свежие начисления);
// контрагенты с «банк» в названии — отдельным блоком. Формат таблицы — как у UiPath (sections), кабинет рисует его сам.
const DEBT_CODES = new Set(['1110', '1151', '1210', '1220', '1230', '1240', '1260', '1271', '1272', '1274', '1710', '1730', '1740',
  '2010', '2050', '2110', '2120', '2130', '2140', '2160', '2171', '2172', '2174', '2180', '2210', '2220', '2230', '2910', '2940', '2950', '2960', '2970', '2980',
  '3010', '3040', '3050', '3060', '3310', '3320', '3330', '3340', '3360', '3370', '3381', '3382', '3383', '3387', '3410', '3420',
  '3510', '3530', '3540', '3550', '3560', '4010', '4040', '4050', '4110', '4120', '4130', '4140', '4150',
  '4161', '4162', '4163', '4167', '4210', '4220', '4410', '4430', '4440', 'Я111', 'Я201', 'Я301', 'Я302', 'Я304', 'Я401', 'Я402']);
const BUCKETS = ['До месяца', 'От 1 до 3 месяцев', 'От 3 до 6 месяцев', 'От полугода до года', 'Больше года'];
const BUCKET_COLS = ['До месяца', '1–3 мес.', '3–6 мес.', '6–12 мес.', 'Больше года'];
const BUCKET_ICON = ['⚪', '🔵', '🟡', '🟠', '🔥'];
const bucketOf = (days: number) => days <= 30 ? 0 : days <= 90 ? 1 : days <= 180 ? 2 : days <= 365 ? 3 : 4;
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
const pad = (n: number) => String(n).padStart(2, '0');
const isoLocal = (d: Date) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());

async function debts(base: string, checkDate: string) {
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
  // 4. движения за год до даты проверки — помесячно, по 4 месяца параллельно
  const movDt = new Map<string, [number, number][]>(), movKt = new Map<string, [number, number][]>();
  if (saldo.size) {
    const fields = 'Period,Active,AccountDr_Key,AccountCr_Key,ExtDimensionDr1,ExtDimensionDr1_Type,ExtDimensionDr2,ExtDimensionDr2_Type,ExtDimensionDr3,ExtDimensionDr3_Type,'
      + 'ExtDimensionCr1,ExtDimensionCr1_Type,ExtDimensionCr2,ExtDimensionCr2_Type,ExtDimensionCr3,ExtDimensionCr3_Type,Сумма';
    const end = rep + day - 1000; const wins: [number, number][] = [];
    for (let s = new Date(rep - 365 * day); s.getTime() <= end;) {
      const n = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate())); wins.push([s.getTime(), Math.min(n.getTime() - 1000, end)]); s = n;
    }
    for (let i = 0; i < wins.length; i += 4) {
      const parts = await Promise.all(wins.slice(i, i + 4).map(([a, b]) => odata(base, "AccountingRegister_Типовой/RecordsWithExtDimensions(StartPeriod=datetime'" + isoLocal(new Date(a)) + "',EndPeriod=datetime'" + isoLocal(new Date(b)) + "')?$format=json&$select=" + fields)));
      for (const rows of parts) for (const r of rows) {
        if (r.Active === false) continue;
        const sum = Number(r['Сумма'] || 0); if (sum <= 0) continue;
        const at = Date.parse(String(r.Period).slice(0, 10) + 'T00:00:00Z');
        const kD = kontr(r, 'ExtDimensionDr'), kK = kontr(r, 'ExtDimensionCr');
        const ourD = !!kD && acc.has(r.AccountDr_Key), ourK = !!kK && acc.has(r.AccountCr_Key);
        if (ourD && ourK && kD === kK) continue;      // зачёт аванса / перенос между договорами — сальдо не меняется
        if (ourD && saldo.has(kD)) { if (!movDt.has(kD)) movDt.set(kD, []); movDt.get(kD)!.push([at, sum]); }
        if (ourK && saldo.has(kK)) { if (!movKt.has(kK)) movKt.set(kK, []); movKt.get(kK)!.push([at, sum]); }
      }
    }
  }
  // 5. раскладка по срокам
  const spread = (rest: number, mv: [number, number][] | undefined) => {
    const b = [0, 0, 0, 0, 0];
    for (const [at, s] of (mv || []).slice().sort((p, q) => q[0] - p[0])) { if (rest <= 0) break; const t = Math.min(rest, s); b[bucketOf(Math.round((rep - at) / day))] += t; rest -= t; }
    if (rest > 0) b[4] += rest;
    return b;
  };
  const bDt = new Map<string, number[]>(), bKt = new Map<string, number[]>();
  for (const [k, v] of saldo) {
    if (banks.has(k)) continue;
    const s = r2(v);
    if (s > 0) bDt.set(k, spread(s, movDt.get(k))); else if (s < 0) bKt.set(k, spread(-s, movKt.get(k)));
  }
  for (const k of [...both]) if (!bDt.has(k) && !bKt.has(k)) both.delete(k);
  const oldest = (a: number[]) => { for (let i = 4; i >= 0; i--) if (r2(a[i]) !== 0) return i; return 0; };
  const sumA = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const label = (k: string) => nm(k) + (both.has(k) ? ' ⚠️' : '');
  const section = (title: string, data: Map<string, number[]>) => {
    const rows: any[] = [];
    for (let g = 4; g >= 0; g--) [...data].filter(([, a]) => oldest(a) === g).sort((p, q) => q[1][g] - p[1][g] || sumA(q[1]) - sumA(p[1]))
      .forEach(([k, a]) => rows.push({ name: label(k), group: g, total: r2(sumA(a)), b: a.map(r2) }));
    return { title, total: r2([...data.values()].reduce((x, a) => x + sumA(a), 0)), rows };
  };
  const bankRows = [...banks].filter((k) => r2(saldo.get(k)!) !== 0).sort((p, q) => Math.abs(saldo.get(q)!) - Math.abs(saldo.get(p)!))
    .map((k) => { const s = r2(saldo.get(k)!); return { name: nm(k), dt: s > 0 ? s : 0, kt: s < 0 ? -s : 0 }; });
  const sections: any[] = [];
  if (bDt.size) sections.push(section('Нам должны', bDt));
  if (bKt.size) sections.push(section('Мы должны', bKt));
  if (bankRows.length) sections.push({ title: 'Банки', bank: true, rows: bankRows });
  return { bDt, bKt, bankRows, both: both.size, sections, sumA, dateText: d + ' ' + RU_MONTHS[m - 1] + ' ' + y };
}

async function runDebts(robot: any, run: any) {
  const { data: firms } = await db.from('companies').select('id,name,onec_url').in('id', run.company_ids);
  const { data: links } = await db.from('company_robots').select('company_id,status,enabled').eq('robot_id', robot.id).in('company_id', run.company_ids);
  const okLink = new Set((links || []).filter((l: any) => l.status === 'active' && l.enabled).map((l: any) => l.company_id));
  const errs: string[] = []; let done = 0;
  const list = (firms || []).filter((f: any) => okLink.has(f.id));
  const cd = /^\d{4}-\d{2}-\d{2}$/.test(String(run.check_date || '')) ? String(run.check_date) : kzToday();
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (f: any) => {
      try {
        if (!f.onec_url) throw new Error('в профиле фирмы не указан адрес 1С');
        const r = await debts(f.onec_url, cd);
        const tot = (mp: Map<string, number[]>) => r2([...mp.values()].reduce((x, a) => x + r.sumA(a), 0));
        const lines = ['🏢 ' + shortName(f.name) + ': задолженность на ' + r.dateText + ' года'];
        const brief = (t: string, mp: Map<string, number[]>) => {
          if (!mp.size) return;
          lines.push('', t + ' — ' + money(tot(mp)) + ' (контрагентов: ' + mp.size + ')');
          for (let g = 4; g >= 0; g--) { const s = r2([...mp.values()].reduce((x, a) => x + a[g], 0)); if (s) lines.push('   ' + BUCKET_ICON[g] + ' ' + BUCKETS[g] + ' — ' + money(s)); }
        };
        brief('🟢 Нам должны', r.bDt); brief('🔴 Мы должны', r.bKt);
        if (r.bankRows.length) lines.push('', '🏦 Есть расчёты с банками — см. таблицу');
        if (r.both) lines.push('', '⚠️ У ' + r.both + ' контрагентов в 1С висят и аванс, и долг — сальдо свёрнуто, проверьте зачёт авансов');
        const none = !r.sections.length;
        if (none) lines.push('', '✅ Задолженности по счетам расчётов нет');
        const { error } = await db.from('events').insert({
          company_id: f.id, robot_id: robot.id, run_id: run.id,
          title: 'Расчёты с контрагентами на ' + dmy(cd),
          body: lines.join('\n'),
          severity: none ? 'info' : 'warning', status: none ? 'done' : 'new', ...(none ? { done_at: new Date().toISOString() } : {}),
          details: none ? null : { title: lines[0], groups: BUCKETS, columns: ['Контрагент', 'Всего', ...BUCKET_COLS], sections: r.sections,
            dt: tot(r.bDt), kt: tot(r.bKt), date: cd },
        });
        if (error) throw new Error(error.message);
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

const HANDLERS: Record<string, (robot: any, run: any) => Promise<void>> = { unpaid_invoices: runInvoices, powers_of_attorney: runPowers, counterparty_debts: runDebts };

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
    EdgeRuntime.waitUntil(handleRun(runId));
    return json({ ok: true, accepted: runId });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
