// ESEP — чтение банковских выписок (робот «Выписки банка»).
// Файл читается в браузере пользователя и на сервер не отправляется: в кабинет уходят только разобранные строки.
// Понимает: формат 1С (txt, 1CClientBankExchange — любой банк), Excel Kaspi Pay, PDF Kaspi Pay / Народный банк / Банк ЦентрКредит.
// Каждая строка выписки: { n, date:'гггг-мм-дд', time, dir:'in'|'out', sum, name, bin, iik, bik, knp, purpose, ref, kind }.
// Проверки сальдо и оборотов — check(): расхождение не запрещает работу, а даёт предупреждение.
(function (root) {
  'use strict';

  // ---------- общее
  const BANKS = { '722': 'Kaspi Bank', '601': 'Народный банк', '856': 'Банк ЦентрКредит', '965': 'ForteBank', '998': 'Jusan Bank', '948': 'Евразийский банк', '551': 'Freedom Bank', '821': 'Bank RBK', '849': 'Нурбанк', '914': 'Bereke Bank', '949': 'Altyn Bank', '886': 'Home Credit Bank', '913': 'Банк Китая в Казахстане' };
  const bankByIik = (iik) => BANKS[String(iik || '').slice(4, 7)] || '';
  const clean = (s) => String(s == null ? '' : s).replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  // число из «1 081,13», «1,588,929.98», «547723.17», «10 980»
  function num(v) {
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    let s = String(v == null ? '' : v).replace(/[\s   ]/g, '').replace(/[^\d.,-]/g, '');
    if (!s || !/\d/.test(s)) return null;
    const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
    if (c >= 0 && d >= 0) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (c >= 0) s = /,\d{1,2}$/.test(s) && s.indexOf(',') === c ? s.replace(',', '.') : s.replace(/,/g, '');
    else if (d >= 0 && !(/\.\d{1,2}$/.test(s) && s.indexOf('.') === d)) s = s.replace(/\./g, '');
    const n = Number(s); return isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  // дата из «05.11.2026», «05-11-2026», «05.11.26», «2026-11-05»
  function iso(v) {
    const s = String(v == null ? '' : v).trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4}|\d{2})/.exec(s); if (!m) return '';
    return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const fmtMoney = (n) => (n == null ? '—' : Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtDate = (d) => (d ? d.split('-').reverse().join('.') : '');
  // «Референс 4172498726 …», «Внешний референс: 5826Q…» (Народный банк) — номер операции банка отдельно от назначения
  function splitRef(p) {
    let ref = '', s = clean(p);
    s = s.replace(/\s*Внешний референс:\s*\S+\s*$/i, '');
    const m = /^Референс\s+(\d+)\s*/i.exec(s); if (m) { ref = m[1]; s = s.slice(m[0].length); }
    return { ref, purpose: clean(s) };
  }

  // ---------- кодировка текстового файла: UTF-8 (с меткой и без), UTF-16, иначе Windows-1251
  function decodeText(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return new TextDecoder('windows-1251').decode(b); }
  }

  // ---------- формат 1С (1CClientBankExchange): названия полей без учёта регистра; остатки — общие или по каждому дню
  function parse1C(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    if (!/^1CClientBankExchange/i.test((lines[0] || '').trim())) return null;
    const head = {}, blocks = [], docs = []; let cur = null, mode = '';
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\s+$/, ''); if (!line) continue;
      const eq = line.indexOf('='), k = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase(), v = eq < 0 ? '' : line.slice(eq + 1).trim();
      if (k === 'секциярасчсчет') { cur = {}; mode = 'acc'; continue; }
      if (k === 'конецрасчсчет') { if (cur) blocks.push(cur); cur = null; mode = ''; continue; }
      if (k === 'секциядокумент') { cur = { 'вид': v }; mode = 'doc'; continue; }
      if (k === 'конецдокумента') { if (cur) docs.push(cur); cur = null; mode = ''; continue; }
      if (k === 'конецфайла') break;
      if (mode) cur[k] = v; else if (!(k in head)) head[k] = v;
    }
    const account = clean(head['расчсчет'] || (blocks[0] && blocks[0]['расчсчет']) || '').toUpperCase();
    const days = blocks.map((b) => ({ from: iso(b['датаначала']), to: iso(b['датаконца']), opening: num(b['начальныйостаток']), totalIn: num(b['всегопоступило']), totalOut: num(b['всегосписано']), closing: num(b['конечныйостаток']) }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    const st = { format: '1c', formatName: 'формат 1С', bank: bankByIik(account), account, ownerBin: '', ownerName: '', from: iso(head['датаначала']) || (days[0] && days[0].from) || '', to: iso(head['датаконца']) || (days.length ? days[days.length - 1].to : ''),
      opening: days.length ? days[0].opening : null, closing: days.length ? days[days.length - 1].closing : null,
      totalIn: days.length && days.every((d) => d.totalIn != null) ? r2(days.reduce((a, d) => a + d.totalIn, 0)) : null,
      totalOut: days.length && days.every((d) => d.totalOut != null) ? r2(days.reduce((a, d) => a + d.totalOut, 0)) : null,
      days: days.length > 1 ? days : [], rows: [], has: { knp: false, iik: false } };
    const pick = (d, side, names) => { for (const n of names) { const v = d[side + n]; if (v) return clean(v); } return ''; };
    for (const d of docs) {
      const sin = num(d['суммаприход']), sout = num(d['суммарасход']); let dir = sin ? 'in' : sout ? 'out' : '', sum = sin || sout || num(d['сумма']) || 0;
      const payIik = pick(d, 'плательщик', ['иик', 'счет', 'расчсчет']).toUpperCase(), recIik = pick(d, 'получатель', ['иик', 'счет', 'расчсчет']).toUpperCase();
      if (!dir) dir = recIik === account ? 'in' : payIik === account ? 'out' : '';
      const me = dir === 'in' ? 'получатель' : 'плательщик', cp = dir === 'in' ? 'плательщик' : 'получатель';
      if (!st.ownerBin) st.ownerBin = digits(pick(d, me, ['бин_иин', 'бин', 'иин', 'рнн', 'инн']));
      if (!st.ownerName) st.ownerName = pick(d, me, ['наименование', '1', '']);
      const sp = splitRef(d['назначениеплатежа'] || '');
      const row = { n: clean(d['номердокумента'] || d['номер']), date: iso(d['датаоперации'] || d['датадокумента'] || d['дата']), time: '', dir, sum,
        name: pick(d, cp, ['наименование', '1', '']), bin: digits(pick(d, cp, ['бин_иин', 'бин', 'иин', 'рнн', 'инн'])), iik: dir === 'in' ? payIik : recIik,
        bik: pick(d, cp, ['банкбик', 'бик']).toUpperCase(), knp: clean(d['кодназначенияплатежа'] || d['кнп']), kbk: clean(d['кодбюджетнойклассификации'] || d['кбк']), kbe: pick(d, cp, ['кбе']),
        purpose: sp.purpose, ref: sp.ref, kind: clean(d['виддокумента']).replace(/([а-яё])([А-ЯЁ])/g, '$1 $2').toLowerCase() };
      if (row.bin.length !== 12) row.bin = row.bin.length > 12 ? row.bin.slice(0, 12) : row.bin;
      if (row.knp) st.has.knp = true; if (row.iik) st.has.iik = true;
      st.rows.push(row);
    }
    return st;
  }

  // ---------- Excel Kaspi Pay: строки листа массивом массивов (SheetJS: sheet_to_json(ws, { header: 1, raw: true }))
  function parseXlsxRows(aoa) {
    const rows = (aoa || []).map((r) => (r || []).map((c) => (c == null ? '' : c)));
    const txt = (r) => r.map((c) => clean(c)).filter(Boolean);
    const hi = rows.findIndex((r) => { const t = txt(r).join('|'); return /Дебет/i.test(t) && /Кредит/i.test(t) && /Назначение/i.test(t); });
    if (hi < 0) return null;
    const hdr = rows[hi].map((c) => clean(c).toLowerCase());
    const col = (re) => hdr.findIndex((h) => re.test(h));
    const C = { n: col(/^№|номер/), date: col(/дата/), deb: col(/дебет/), cred: col(/кредит/), name: col(/наименование/), iik: col(/иик/), bik: col(/бик/), knp: col(/кнп/), purpose: col(/назначение/) };
    if (C.date < 0 || C.deb < 0 || C.cred < 0) return null;
    const val = (re) => { for (const r of rows.slice(0, hi)) { const t = txt(r); const i = t.findIndex((x) => re.test(x)); if (i >= 0 && t[i + 1] != null) return t[i + 1]; } return ''; };
    const per = val(/^Период/i).split(/\s+-\s+/), account = clean(val(/счет:/i)).toUpperCase();
    const st = { format: 'xlsx', formatName: 'Excel', bank: bankByIik(account) || 'Kaspi Bank', account, ownerBin: digits(val(/ИИН\/БИН/i)), ownerName: val(/^Наименование/i), from: iso(per[0]), to: iso(per[1]),
      opening: num(val(/Входящий остаток/i)), closing: num(val(/Исходящий остаток/i)), totalIn: null, totalOut: null, countIn: null, countOut: null, days: [], rows: [], has: { knp: false, iik: false } };
    for (const r of rows.slice(hi + 1)) {
      const first = txt(r)[0] || '';
      if (/^Итого обороты/i.test(first)) { st.totalOut = num(r[C.deb]); st.totalIn = num(r[C.cred]); continue; }
      if (/^Итого операций/i.test(first)) { st.countOut = num(r[C.deb]); st.countIn = num(r[C.cred]); continue; }
      const date = iso(r[C.date]); if (!date) continue;
      const deb = num(r[C.deb]) || 0, cred = num(r[C.cred]) || 0; if (!deb && !cred) continue;
      const nm = String(r[C.name] == null ? '' : r[C.name]).split(/\r?\n/), bl = nm.findIndex((x) => /ИИН\/БИН|БИН\/ИИН/i.test(x));
      const row = { n: clean(r[C.n]), date, time: (/\d{1,2}:\d{2}(:\d{2})?/.exec(String(r[C.date])) || [''])[0], dir: cred ? 'in' : 'out', sum: cred || deb,
        name: clean((bl >= 0 ? nm.slice(0, bl) : nm).join(' ')), bin: bl >= 0 ? digits(nm[bl]).slice(0, 12) : '', iik: clean(r[C.iik]).toUpperCase(), bik: clean(r[C.bik]).toUpperCase(),
        knp: clean(r[C.knp]), kbk: '', kbe: '', purpose: clean(r[C.purpose]), ref: '', kind: '' };
      if (row.knp) st.has.knp = true; if (row.iik) st.has.iik = true;
      st.rows.push(row);
    }
    return st;
  }

  // ---------- PDF: куски текста с местом на странице [{ p, x, y, w, h, s }] (pdf.js), где h — высота страницы
  const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/, AMT_RE = /^\d[\d\s., ]*\d$|^\d$/;
  const sortItems = (a) => a.slice().sort((u, v) => u.p - v.p || u.y - v.y || u.x - v.x);
  const mid = (it) => it.x + it.w / 2;
  const sameLine = (items, re, tol) => { const l = items.find((i) => re.test(i.s)); if (!l) return [];
    return items.filter((i) => i !== l && i.p === l.p && Math.abs(i.y - l.y) <= (tol || 3) && i.x > l.x).sort((a, b) => a.x - b.x); };
  const after = (items, re) => clean(sameLine(items, re).map((i) => i.s).join(' '));
  // строки таблицы: начало строки — дата в колонке дат; текст, перенесённый на следующую страницу, остаётся в своей строке
  function tableRows(items, isAnchor, isEnd) {
    const out = []; let cur = null, ended = false;
    const list = sortItems(items).filter((i) => !(i.h && i.y > i.h - 34 && /^\d+(\s*-\s*\d+)?$/.test(i.s.trim())));   // номера страниц
    const anchors = list.filter(isAnchor);
    for (const it of list) {
      if (ended) break;
      if (isEnd(it) && (cur || out.length)) { ended = true; break; }
      const a = anchors.find((x) => x.p === it.p && Math.abs(x.y - it.y) <= 2);
      if (a && (!cur || cur.a !== a)) {
        // первая линия новой строки: всё, что на одной высоте с датой
        cur = out.find((r) => r.a === a); if (!cur) { cur = { a, items: [] }; out.push(cur); }
      }
      if (cur) cur.items.push(it);
    }
    return { rows: out.map((r) => r.items), ended };
  }
  // склейка перенесённого текста колонки. В PDF слово может быть разорвано посреди; уверенно склеиваем только перенос по дефису
  // и «хвостик» в 1–2 буквы («Алматински» + «й», «противопожарн» + «ой»). Остальное — через пробел: при сравнении текстов пробелы не учитываются.
  const SMALL = /^(по|за|от|на|из|до|в|и|с|к|о|у|а|я|г|тг|ул|д|кв|шт|ед|не|ИП|АО)$/i;
  function joinWrapped(list) {
    const a = list.slice().sort((u, v) => u.p - v.p || u.y - v.y || u.x - v.x); let s = '';
    a.forEach((it, i) => {
      const t = it.s.trim(); if (!t) return;
      if (!s) { s = t; return; }
      const prev = a[i - 1], pt = prev.s.trim(), sameY = prev.p === it.p && Math.abs(prev.y - it.y) <= 2;
      const first = t.split(/[\s.,;:"»)]+/)[0];
      const glue = !sameY && (/\S-$/.test(pt) || (/[а-яё]{4,}$/.test(pt) && !/\s/.test(pt.slice(-6)) && /^[а-яё]{1,2}$/.test(first) && !SMALL.test(first)));
      s += (glue ? '' : ' ') + t;
    });
    return clean(s);
  }
  const joinTight = (list) => sortItems(list).map((i) => i.s.trim()).join('');
  const bucket = (items, colOf) => { const o = {}; for (const it of items) { const k = colOf(it); if (k) (o[k] = o[k] || []).push(it); } return o; };

  function pdfKaspi(items) {
    const account = (after(items, /^Лицевой счет/i).match(/KZ[0-9A-Z]{18}/i) || [''])[0].toUpperCase();
    const per = after(items, /^Период:/i).split(/\s+-\s+/);
    const st = { format: 'pdf', formatName: 'PDF', bank: 'Kaspi Bank', account, ownerBin: digits(after(items, /^ИИН\/БИН:/i)).slice(0, 12), ownerName: after(items, /^Наименование клиента/i), from: iso(per[0]), to: iso(per[1]),
      opening: num(after(items, /^Входящий остаток/i)), closing: num(after(items, /^Исходящий остаток/i)), totalIn: null, totalOut: null, countIn: null, countOut: null, days: [], rows: [], has: { knp: false, iik: false } };
    // центры колонок — по строке с номерами колонок «1 … 9» под шапкой таблицы
    const hd = items.find((i) => /^Назначение платежа$/i.test(i.s.trim()));
    const nums = hd ? items.filter((i) => i.p === hd.p && /^[1-9]$/.test(i.s.trim()) && i.y > hd.y && i.y < hd.y + 60).sort((a, b) => a.x - b.x) : [];
    const line = nums.length >= 9 ? nums.filter((i) => Math.abs(i.y - nums[0].y) <= 2 || true).slice(0, 9) : null;
    if (!line || line.length < 9) return Object.assign(st, { broken: 'не найдена шапка таблицы' });
    const cen = line.map(mid), keys = ['n', 'date', 'deb', 'cred', 'name', 'iik', 'bik', 'knp', 'purpose'];
    const colOf = (it) => { const m = mid(it); let b = 0; for (let i = 1; i < cen.length; i++) if (Math.abs(cen[i] - m) < Math.abs(cen[b] - m)) b = i; return keys[b]; };
    const top = line[0].y, body = items.filter((i) => i.p > line[0].p || i.y > top + 3);
    const tr = tableRows(body, (i) => DATE_RE.test(i.s.trim()) && colOf(i) === 'date', (i) => /^Итого обороты/i.test(i.s.trim()));
    const cells = tr.rows.map((r) => bucket(r, colOf));
    for (const c of cells) {
      const deb = num(joinTight(c.deb || [])) || 0, cred = num(joinTight(c.cred || [])) || 0;
      const nmAll = clean(sortItems(c.name || []).map((i) => i.s).join(' ')), nb = /\s*(?:БИН\/ИИН|ИИН\/БИН)\s*([\d\s]*)$/i.exec(nmAll);
      const dt = sortItems(c.date || []).map((i) => i.s.trim());
      const row = { n: joinTight(c.n || []), date: iso(dt[0]), time: dt[1] || '', dir: cred ? 'in' : 'out', sum: cred || deb,
        name: nb ? clean(nmAll.slice(0, nb.index)) : nmAll, bin: nb ? digits(nb[1]).slice(0, 12) : '',
        iik: joinTight(c.iik || []).toUpperCase(), bik: joinTight(c.bik || []).toUpperCase(), knp: joinTight(c.knp || []), kbk: '', kbe: '', purpose: joinWrapped(c.purpose || []), ref: '', kind: '' };
      if (row.knp) st.has.knp = true; if (row.iik) st.has.iik = true;
      st.rows.push(row);
    }
    const tot = sameLine(items, /^Итого обороты/i).filter((i) => AMT_RE.test(i.s.trim()));
    tot.forEach((i) => { const k = colOf(i); if (k === 'deb') st.totalOut = num(i.s); if (k === 'cred') st.totalIn = num(i.s); });
    const cnt = sameLine(items, /^Итого операций/i).filter((i) => /^\d+$/.test(i.s.trim()));
    cnt.forEach((i) => { const k = colOf(i); if (k === 'deb') st.countOut = num(i.s); if (k === 'cred') st.countIn = num(i.s); });
    return st;
  }

  function pdfHalyk(items) {
    const amt = (re) => { const a = sameLine(items, re).find((i) => /^\d[\d\s,.]*\.\d{2}$/.test(i.s.trim())); return a ? num(a.s) : null; };
    const dat = (re) => { const a = sameLine(items, re).find((i) => /^\d{2}-\d{2}-\d{4}$/.test(i.s.trim())); return a ? iso(a.s) : ''; };
    const acc = items.find((i) => /^KZ[0-9A-Z]{18}$/i.test(i.s.trim()));
    const st = { format: 'pdf', formatName: 'PDF', bank: 'Народный банк', account: acc ? acc.s.trim().toUpperCase() : '', ownerBin: digits(after(items, /^ИИН\/БИН$/i)).slice(0, 12), ownerName: after(items, /^Клиент$/i),
      from: dat(/^Входящий остаток/i), to: dat(/^Исходящий остаток/i), opening: amt(/^Входящий остаток/i), closing: amt(/^Исходящий остаток/i), totalIn: null, totalOut: null, days: [], rows: [], has: { knp: false, iik: false } };
    const hD = items.find((i) => /^Дебет$/i.test(i.s.trim())), hC = items.find((i) => hD && i.p === hD.p && Math.abs(i.y - hD.y) <= 3 && /^Кредит$/i.test(i.s.trim()));
    const hK = items.find((i) => hD && i.p === hD.p && /^Контрагент$/i.test(i.s.trim())), hP = items.find((i) => hD && i.p === hD.p && /^Детали платежа$/i.test(i.s.trim()));
    const hN = items.find((i) => hD && i.p === hD.p && /^Номер документа$/i.test(i.s.trim())), hV = items.find((i) => hD && i.p === hD.p && /^комиссии$/i.test(i.s.trim()));
    if (!hD || !hC || !hK || !hP || !hN) return Object.assign(st, { broken: 'не найдена шапка таблицы' });
    const xName = hK.x - 30, xDet = hP.x - 30, xVat = hV ? hV.x - 12 : 1e9, split = (mid(hD) + mid(hC)) / 2, xNum = hN.x - 6, xAmt = hD.x - 30;
    const colOf = (it) => { if (it.x >= xVat) return 'vat'; if (it.x >= xDet) return 'purpose'; if (it.x >= xName) return 'name';
      if (it.x >= xAmt && /^\d[\d,]*\.\d{2}$/.test(it.s.trim())) return mid(it) < split ? 'deb' : 'cred'; if (it.x >= xNum) return 'n'; return 'date'; };
    const body = items.filter((i) => i.p > hD.p || i.y > hD.y + 12);
    const tr = tableRows(body, (i) => DATE_RE.test(i.s.trim()) && i.x < xNum, (i) => /^(Обороты:|Исходящий остаток)/i.test(i.s.trim()) || /^(Дебет|Кредит)$/i.test(i.s.trim()));
    for (const r of tr.rows) {
      const c = bucket(r, colOf), deb = num(joinTight(c.deb || [])) || 0, cred = num(joinTight(c.cred || [])) || 0;
      const nm = sortItems(c.name || []), bi = nm.findIndex((x) => /^(БИН|ИИН)\s*\d/i.test(x.s.trim()));
      const sp = splitRef(joinWrapped(c.purpose || []));
      st.rows.push({ n: joinTight(c.n || []), date: iso(joinTight(c.date || [])), time: '', dir: cred ? 'in' : 'out', sum: cred || deb,
        name: clean((bi >= 0 ? nm.slice(0, bi) : nm).map((i) => i.s).join(' ')), bin: bi >= 0 ? digits(nm[bi].s).slice(0, 12) : '', iik: '', bik: '', knp: '', kbk: '', kbe: '',
        purpose: sp.purpose, ref: sp.ref, kind: '', bankVat: num(joinTight(c.vat || [])) || 0 });
    }
    const ob = items.find((i) => /^Обороты:/i.test(i.s.trim()));
    if (ob) { const a = items.filter((i) => i.p === ob.p && i.y > ob.y && i.y < ob.y + 16 && /^\d[\d\s,.]*\.\d{2}$/.test(i.s.trim())).sort((u, v) => u.x - v.x);
      if (a.length >= 2) { st.totalOut = num(a[0].s); st.totalIn = num(a[1].s); } }
    return st;
  }

  function pdfBcc(items) {
    const one = (re) => { const a = sameLine(items, re); return a.length ? a[0].s.trim() : ''; };
    const per = items.map((i) => /с\s+(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})/.exec(i.s)).find(Boolean);
    const st = { format: 'pdf', formatName: 'PDF', bank: 'Банк ЦентрКредит', account: (one(/ИИК:\s*$/i).match(/KZ[0-9A-Z]{18}/i) || [''])[0].toUpperCase(), ownerBin: digits(one(/ИИН\s*\/\s*БИН:\s*$/i)).slice(0, 12), ownerName: one(/Клиент:\s*$/i),
      from: per ? iso(per[1]) : '', to: per ? iso(per[2]) : '', opening: num(one(/Входящее сальдо:\s*$/i)), closing: num(one(/Исходящее сальдо:\s*$/i)), totalIn: null, totalOut: null, days: [], rows: [], has: { knp: false, iik: false } };
    // центры колонок — по первой строке шапки таблицы
    const H = [['n', /^Реттік/], ['date', /Дата$/], ['bik', /^Корр-т/], ['iik', /^Корр-т/], ['sbin', /^Жіберуш/], ['name', /^Корреспонд/], ['rbin', /^Алушы/], ['deb', /^Дебет/], ['cred', /^Кредит/], ['knp', /^ТМК/], ['bank', /^Банк$/], ['purpose', /^Төлемнің/]];
    const h0 = items.find((i) => /^Реттік/.test(i.s.trim())); if (!h0) return Object.assign(st, { broken: 'не найдена шапка таблицы' });
    const hl = items.filter((i) => i.p === h0.p && Math.abs(i.y - h0.y) <= 2).sort((a, b) => a.x - b.x);
    if (hl.length !== H.length || !hl.every((i, k) => H[k][1].test(i.s.trim()))) return Object.assign(st, { broken: 'шапка таблицы изменилась' });
    const cen = hl.map(mid), keys = H.map((x) => x[0]);
    const edge = cen.slice(1).map((c, i) => (c + cen[i]) / 2);
    const colOf = (it) => { const m = mid(it); let k = 0; while (k < edge.length && m >= edge[k]) k++; const key = keys[k];
      if ((key === 'rbin' || key === 'deb' || key === 'cred' || key === 'knp') && /^\d[\d ]*,\d{2}$/.test(it.s.trim())) return it.x + it.w < (cen[7] + cen[8]) / 2 + 4 ? 'deb' : 'cred'; return key; };
    const hdrBottom = Math.max(...items.filter((i) => i.p === h0.p && i.y >= h0.y && i.y < h0.y + 45 && /^(дент|ля|платежа|ент|получателя)$/.test(i.s.trim())).map((i) => i.y), h0.y + 30);
    const body = items.filter((i) => i.p > h0.p || i.y > hdrBottom + 3);
    const tr = tableRows(body, (i) => DATE_RE.test(i.s.trim()) && colOf(i) === 'date', (i) => /Итого:\s*$/i.test(i.s.trim()) || /Исходящее сальдо/i.test(i.s));
    const cells = tr.rows.map((r) => bucket(r, colOf));
    for (const c of cells) {
      const deb = num(joinTight(c.deb || [])) || 0, cred = num(joinTight(c.cred || [])) || 0, dt = sortItems(c.date || []).map((i) => i.s.trim());
      const dir = cred ? 'in' : 'out';
      const row = { n: joinTight(c.n || []), date: iso(dt[0]), time: dt[1] || '', dir, sum: cred || deb, name: joinWrapped(c.name || []),
        bin: digits(joinTight((dir === 'in' ? c.sbin : c.rbin) || [])).slice(0, 12), iik: joinTight(c.iik || []).toUpperCase(), bik: joinTight(c.bik || []).toUpperCase(),
        knp: joinTight(c.knp || []), kbk: '', kbe: '', purpose: joinWrapped(c.purpose || []), ref: '', kind: '', bankName: joinWrapped(c.bank || []) };
      if (row.knp) st.has.knp = true; if (row.iik) st.has.iik = true;
      st.rows.push(row);
    }
    const it = items.find((i) => /Итого:\s*$/i.test(i.s.trim()));
    if (it) { const a = items.filter((i) => i.p === it.p && i.y >= it.y - 2 && i.y < it.y + 14 && i.x > it.x && /^[\d ,]+$/.test(i.s.trim()));
      const b = bucket(a, (i) => (i.x + i.w < (cen[7] + cen[8]) / 2 + 4 ? 'deb' : 'cred')); st.totalOut = num(joinTight(b.deb || [])); st.totalIn = num(joinTight(b.cred || [])); }
    return st;
  }

  function parsePdfItems(items) {
    const all = items.map((i) => i.s).join(' ');
    if (/KASPI BANK/i.test(all) && /Лицевой счет/i.test(all)) return pdfKaspi(items);
    if (/Народный Банк Казахстана/i.test(all) && /ВЫПИСКА ПО СЧЕТУ/i.test(all)) return pdfHalyk(items);
    if (/Банк ЦентрКредит/i.test(all) && /Обороты по счетам/i.test(all)) return pdfBcc(items);
    return null;
  }

  // ---------- проверки: сальдо, обороты, количество, пропуски. Ничего не запрещают — только предупреждают.
  // warns: [{ level: 'red' | 'yellow' | 'info', text }]
  function check(st) {
    const w = [], rows = st.rows, sin = r2(rows.filter((r) => r.dir === 'in').reduce((a, r) => a + r.sum, 0)), sout = r2(rows.filter((r) => r.dir === 'out').reduce((a, r) => a + r.sum, 0));
    st.sumIn = sin; st.sumOut = sout; st.nIn = rows.filter((r) => r.dir === 'in').length; st.nOut = rows.filter((r) => r.dir === 'out').length;
    if (st.broken) w.push({ level: 'red', text: 'Таблица платежей прочитана не полностью: ' + st.broken + '. Загрузите выписку в формате 1С.' });
    if (!rows.length && !st.broken) w.push({ level: 'yellow', text: 'В выписке нет ни одного платежа за период.' });
    if (st.totalIn != null && Math.abs(st.totalIn - sin) > 0.005) w.push({ level: 'red', text: 'Поступления: в выписке итог ' + fmtMoney(st.totalIn) + ', а по строкам получилось ' + fmtMoney(sin) + ' (разница ' + fmtMoney(r2(st.totalIn - sin)) + '). Возможно, файл прочитан не полностью — проверьте строки.' });
    if (st.totalOut != null && Math.abs(st.totalOut - sout) > 0.005) w.push({ level: 'red', text: 'Списания: в выписке итог ' + fmtMoney(st.totalOut) + ', а по строкам получилось ' + fmtMoney(sout) + ' (разница ' + fmtMoney(r2(st.totalOut - sout)) + '). Возможно, файл прочитан не полностью — проверьте строки.' });
    if (st.countIn != null && st.countIn !== st.nIn) w.push({ level: 'red', text: 'Поступлений в выписке ' + st.countIn + ', прочитано ' + st.nIn + '.' });
    if (st.countOut != null && st.countOut !== st.nOut) w.push({ level: 'red', text: 'Списаний в выписке ' + st.countOut + ', прочитано ' + st.nOut + '.' });
    if (st.opening != null && st.closing != null) {
      const calc = r2(st.opening + sin - sout);
      st.saldoOk = Math.abs(calc - st.closing) <= 0.005;
      if (!st.saldoOk) w.push({ level: 'red', text: 'Сальдо не сходится: на начало ' + fmtMoney(st.opening) + ' + поступило ' + fmtMoney(sin) + ' − списано ' + fmtMoney(sout) + ' = ' + fmtMoney(calc) + ', а в выписке на конец ' + fmtMoney(st.closing) + '.' });
    } else { st.saldoOk = null; w.push({ level: 'yellow', text: 'В выписке нет сальдо на начало или на конец — сверить остаток нельзя.' }); }
    // остатки по дням (Народный банк, формат 1С): на какой день расхождение
    if (st.days && st.days.length) {
      const bad = [];
      for (const d of st.days) { if (d.opening == null || d.closing == null) continue;
        const di = r2(rows.filter((r) => r.dir === 'in' && r.date >= d.from && r.date <= d.to).reduce((a, r) => a + r.sum, 0)), dout = r2(rows.filter((r) => r.dir === 'out' && r.date >= d.from && r.date <= d.to).reduce((a, r) => a + r.sum, 0));
        if (Math.abs(r2(d.opening + di - dout) - d.closing) > 0.005) bad.push(fmtDate(d.from)); }
      if (bad.length) w.push({ level: 'red', text: 'Остаток по дням не сходится: ' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' и ещё ' + (bad.length - 5) : '') + '.' });
    }
    const noDate = rows.filter((r) => !r.date).length, noSum = rows.filter((r) => !r.sum).length, noDir = rows.filter((r) => !r.dir).length;
    if (noDate) w.push({ level: 'red', text: 'Строк без даты: ' + noDate + '.' });
    if (noSum) w.push({ level: 'red', text: 'Строк без суммы: ' + noSum + '.' });
    if (noDir) w.push({ level: 'red', text: 'Не понятно, приход или расход: ' + noDir + ' строк.' });
    if (st.from && st.to) { const out = rows.filter((r) => r.date && (r.date < st.from || r.date > st.to)).length; if (out) w.push({ level: 'yellow', text: 'Платежей вне периода выписки: ' + out + '.' }); }
    const miss = [];
    if (rows.length && !rows.some((r) => r.knp)) miss.push('кода назначения платежа (КНП)');
    if (rows.length && !rows.some((r) => r.iik)) miss.push('счёта контрагента');
    if (miss.length) w.push({ level: 'info', text: 'В этой выписке нет ' + miss.join(' и ') + (st.format === '1c' ? ' — банк их не выгружает.' : '. В формате 1С сведений больше — лучше загружать его.') + ' Такие строки робот разбирает по контрагенту и тексту назначения, а где не уверен — оставит решение вам.' });
    else if (st.format !== '1c') w.push({ level: 'info', text: 'Совет: загружайте выписку в формате 1С (txt) — в нём самые подробные сведения, и он читается точнее, чем ' + st.formatName + '.' });
    st.warns = w; return st;
  }

  // ---------- чтение файла в браузере. libs: { pdfjs, XLSX } — подгружаются кабинетом только когда нужны
  async function pdfItems(pdfjs, data) {
    const doc = await pdfjs.getDocument({ data }).promise, out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
      for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const t = pdfjs.Util.transform(vp.transform, it.transform);
        out.push({ p, x: Math.round(t[4] * 10) / 10, y: Math.round(t[5] * 10) / 10, w: Math.round(it.width * 10) / 10, h: vp.height, s: it.str }); }
    }
    return out;
  }
  // { ok, st } или { ok: false, error }
  async function readFile(name, buf, libs) {
    const b = new Uint8Array(buf), ext = (/\.([a-z0-9]+)$/i.exec(name || '') || ['', ''])[1].toLowerCase();
    const isPdf = b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46, isZip = b[0] === 0x50 && b[1] === 0x4B, isOle = b[0] === 0xD0 && b[1] === 0xCF;
    let st = null;
    if (isPdf) {
      const items = await pdfItems(libs.pdfjs, b);
      if (!items.length) return { ok: false, error: 'В этом PDF нет текста — похоже, это скан или фото. Скачайте выписку из банк-клиента в формате 1С.' };
      st = parsePdfItems(items);
      if (!st) return { ok: false, error: 'PDF этого банка кабинет пока не читает. Загрузите выписку в формате 1С (txt) — он подходит для любого банка. А этот файл пришлите в ESEP: научим кабинет его читать.' };
    } else if (isZip || isOle || ext === 'xlsx' || ext === 'xls') {
      const wb = libs.XLSX.read(b, { type: 'array' });
      for (const sn of wb.SheetNames) { st = parseXlsxRows(libs.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' })); if (st) break; }
      if (!st) return { ok: false, error: 'Excel этого банка кабинет пока не читает. Загрузите выписку в формате 1С (txt) — он подходит для любого банка. А этот файл пришлите в ESEP: научим кабинет его читать.' };
    } else {
      st = parse1C(decodeText(b));
      if (!st) return { ok: false, error: 'Это не выписка в формате 1С: файл должен начинаться со строки «1CClientBankExchange». В банк-клиенте выберите выгрузку «для 1С» (txt).' };
    }
    if (!st.account) return { ok: false, error: 'В файле не найден номер счёта — выписка прочитана неверно. Пришлите файл в ESEP.' };
    return { ok: true, st: check(st) };
  }

  const api = { readFile, parse1C, parseXlsxRows, parsePdfItems, check, decodeText, num, iso, bankByIik, fmtMoney, fmtDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EsepBank = api;
})(typeof self !== 'undefined' ? self : this);
