// Счета на оплату от поставщиков: чтение файла в браузере (PDF из программы, Excel, Word) и разбор стандартного счёта 1С.
// Сканы и фото не принимаются: их пришлось бы отдавать ИИ целиком, с реквизитами.
// Нестандартный счёт — текст уходит ИИ, но сначала кабинет сам заменяет БИН/ИИН, ИИК, БИК, телефоны и почту метками (mask) и потом возвращает их (unmask).
// window.EsepInv = { readFile(name, buf, libs) → {ok, text, grid, kind} | {ok:false, error}, parseStd(text, grid) → inv | null, mask(text) → {text, map}, unmask(inv, map) }
(function () {
  const MON = { январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12 };
  const clean = (s) => String(s == null ? '' : s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  const num = (s) => { let t = clean(s).replace(/\s/g, ''); if (/,\d{3}\./.test(t) || /,\d{3}$/.test(t) && /\./.test(t)) t = t.replace(/,/g, ''); else t = t.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, ''); const v = Number(t); return t && isFinite(v) ? v : null; };
  // «14 шт» в одной ячейке: число и единица
  const qtyUnit = (s) => { const m = clean(s).match(/^(\d[\d\s\u00a0]*(?:[.,]\d+)?)\s*([^\d\s].*)?$/); return m ? { q: num(m[1]), u: clean(m[2] || '') } : { q: num(s), u: '' }; };
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const isoD = (d, m, y) => { let mm = /^\d+$/.test(m) ? Number(m) : 0; if (!mm) { const k = Object.keys(MON).find((x) => String(m).toLowerCase().startsWith(x)); mm = k ? MON[k] : 0; }
    if (String(y).length === 2) y = '20' + y; return mm && Number(d) ? y + '-' + String(mm).padStart(2, '0') + '-' + String(d).padStart(2, '0') : ''; };

  // ---------- файл → текст и таблица (grid — строки из ячеек) ----------
  async function pdfLines(pdfjs, data) {
    const doc = await pdfjs.getDocument({ data }).promise, lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent(), its = [];
      for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const t = pdfjs.Util.transform(vp.transform, it.transform); its.push({ s: it.str, x: t[4], y: t[5], w: it.width || 0 }); }
      its.sort((a, b) => a.y - b.y || a.x - b.x);
      for (const it of its) { const l = lines.length && lines[lines.length - 1]; if (l && l.p === p && Math.abs(l.y - it.y) <= 3) l.c.push(it); else lines.push({ p, y: it.y, c: [it] }); }
    }
    lines.forEach((l) => l.c.sort((a, b) => a.x - b.x));
    return lines;
  }
  async function readFile(name, buf, libs) {
    const b = new Uint8Array(buf.slice(0, 4)), low = String(name || '').toLowerCase();
    if (/\.(jpe?g|png|gif|bmp|heic|webp|tiff?)$/.test(low) || (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)) return { ok: false, scan: true, error: 'Это фото или скан. Пришлите счёт PDF из программы, Excel или Word — на снимке ИИ увидел бы реквизиты.' };
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
      const lines = await pdfLines(libs.pdfjs, buf), text = lines.map((l) => l.c.map((c) => c.s).join(' ')).join('\n');
      if (text.replace(/\s/g, '').length < 60) return { ok: false, scan: true, error: 'В PDF нет текста — это скан. Пришлите счёт PDF из программы, Excel или Word.' };
      return { ok: true, kind: 'pdf', text, lines };
    }
    if (/\.docx$/.test(low) || (b[0] === 0x50 && b[1] === 0x4B && libs.mammoth && !/\.xlsx?$/.test(low))) {
      const html = (await libs.mammoth.convertToHtml({ arrayBuffer: buf })).value, dom = new DOMParser().parseFromString(html, 'text/html');
      const grid = []; dom.querySelectorAll('tr').forEach((tr) => grid.push([...tr.children].map((td) => clean(td.textContent))));
      const text = [...dom.body.querySelectorAll('p,tr')].filter((n) => n.tagName === 'TR' || !n.closest('tr')).map((n) => n.tagName === 'TR' ? [...n.children].map((td) => clean(td.textContent)).filter(Boolean).join('  ') : clean(n.textContent)).filter(Boolean).join('\n');
      return { ok: true, kind: 'docx', text, grid };
    }
    if (/\.xlsx?$/.test(low) || (b[0] === 0x50 && b[1] === 0x4B) || (b[0] === 0xD0 && b[1] === 0xCF)) {
      const wb = libs.XLSX.read(buf, { type: 'array' }), sh = wb.Sheets[wb.SheetNames[0]];
      const grid = libs.XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' }).map((r) => r.map(clean));
      const text = grid.map((r) => r.filter(Boolean).join('  ')).filter(Boolean).join('\n');
      return { ok: true, kind: 'xlsx', text, grid };
    }
    return { ok: false, error: 'Такой файл не прочитать. Нужен счёт PDF из программы, Excel (.xlsx, .xls) или Word (.docx).' };
  }

  // ---------- таблица товаров ----------
  const COLS = [['n', /^(№|n|п\/п|№\s*п\/п)$/i], ['code', /^(код|артикул)/i], ['vat', /ндс/i], ['name', /(наименован|товар|работ|услуг)/i], ['qty', /^кол/i], ['unit', /^(ед|ед\.|единиц)/i], ['price', /^цена/i], ['sum', /^сумма/i]];
  const colOf = (h) => { const t = clean(h).toLowerCase(); const c = COLS.find(([, re]) => re.test(t)); return c ? c[0] : ''; };
  const STOP = /^(итого|всего|в том числе|в т\.\s?ч|сумма ндс|без ндс)/i;
  // из сетки (Excel, Word): строка-шапка, затем строки до «Итого»
  function itemsFromGrid(grid) {
    for (let i = 0; i < grid.length; i++) {
      const map = {}; grid[i].forEach((c, k) => { const t = colOf(c); if (t && map[t] == null) map[t] = k; });
      if (map.name == null || map.qty == null || map.sum == null) continue;
      const items = [];
      for (let r = i + 1; r < grid.length; r++) {
        const row = grid[r], first = clean(row.filter(Boolean)[0] || '');
        if (STOP.test(first) || row.some((c) => STOP.test(clean(c)))) break;
        const name = clean(row[map.name]), qu = qtyUnit(row[map.qty]), qty = qu.q, sum = num(row[map.sum]);
        let unit = map.unit != null ? clean(row[map.unit]) : qu.u;
        if (!unit) for (let k = map.qty + 1; k < row.length && k < (map.price != null ? map.price : map.sum); k++) { const c = clean(row[k]); if (c && num(c) == null) { unit = c; break; } }
        if (!name && !qty) continue;
        if (name && qty == null && items.length) { items[items.length - 1].name += ' ' + name; continue; }
        if (!name || !(qty > 0)) continue;
        const price = map.price != null ? num(row[map.price]) : null;
        items.push({ name, unit, qty, price: price != null ? price : sum && qty ? r2(sum / qty) : 0, sum: sum != null ? sum : r2(qty * (price || 0)) });
      }
      if (items.length) return items;
    }
    return [];
  }
  // из PDF: шапка таблицы по координатам. Заголовки часто по центру, а наименование прижато влево —
  // поэтому числа относим к ближайшей по центру числовой колонке, текст — к наименованию, короткое слово («шт», «кг») — к единице
  function itemsFromLines(lines) {
    const mid = (c) => c.x + (c.w || 0) / 2;
    for (let i = 0; i < lines.length; i++) {
      const hs = lines[i].c.map((c) => ({ t: colOf(c.s), m: mid(c), x: c.x })).filter((h) => h.t);
      if (!hs.some((h) => h.t === 'name') || !hs.some((h) => h.t === 'qty') || !hs.some((h) => h.t === 'sum')) continue;
      const nameX = hs.find((h) => h.t === 'name').x, numCols = hs.filter((h) => ['qty', 'price', 'sum', 'vat', 'code'].includes(h.t)), hasUnitCol = hs.some((h) => h.t === 'unit');
      const nearest = (m) => numCols.reduce((b, h) => !b || Math.abs(h.m - m) < Math.abs(b.m - m) ? h : b, null).t;
      const items = []; let p0 = lines[i].p;
      for (let r = i + 1; r < lines.length; r++) {
        const l = lines[r], txt = clean(l.c.map((c) => c.s).join(' '));
        if (STOP.test(txt)) break;
        if (l.p !== p0 && /(наименован|товар|кол-?во|количество)/i.test(txt)) { p0 = l.p; continue; }   // шапка на следующей странице
        const cell = { name: [] };
        l.c.forEach((c, k) => {
          const t = clean(c.s);
          if (k === 0 && /^\d{1,4}$/.test(t) && c.x < nameX) { cell.n = t; return; }
          if (/^\d{1,2}\s*%$/.test(t)) return;                                       // ставка НДС
          if (num(t) != null && /\d/.test(t)) { const col = nearest(mid(c)); if (col !== 'vat' && col !== 'code' && cell[col] == null) cell[col] = t; return; }
          const uh = hs.find((h) => h.t === 'unit'), nh = hs.find((h) => h.t === 'name');
          if (uh && !cell.unit && t.length <= 8 && Math.abs(mid(c) - uh.m) < Math.abs(mid(c) - nh.m) && cell.name.length) { cell.unit = t; return; }
          if (!hasUnitCol && !cell.unit && t.length <= 6 && /^[a-zа-яё.²³0-9\s]+$/i.test(t) && cell.name.length && mid(c) > nameX) { cell.unit = t; return; }
          cell.name.push(t);
        });
        const name = clean(cell.name.join(' ')), qu = qtyUnit(cell.qty || ''), qty = qu.q, sum = num(cell.sum), price = num(cell.price);
        if (name && qty == null && sum == null && items.length) { items[items.length - 1].name += ' ' + name; continue; }
        if (!name || !(qty > 0)) continue;
        items.push({ name, unit: clean(cell.unit) || qu.u, qty, price: price != null ? price : sum && qty ? r2(sum / qty) : 0, sum: sum != null ? sum : r2(qty * (price || 0)) });
      }
      if (items.length) return items;
    }
    return [];
  }

  // ---------- реквизиты из текста стандартного счёта 1С ----------
  // ИИК (IBAN Казахстана, 20 знаков): в тексте бывают пробелы, русские буквы вместо латинских, O вместо 0 (распознанные сканы) — чиним и проверяем контрольную сумму
  const LAT = { А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X', У: 'Y', З: 'Z' };
  const lat = (t) => String(t || '').toUpperCase().replace(/[АВСЕНКМОРТХУЗ]/g, (c) => LAT[c]);
  function ibanOk(s) {
    s = String(s || '').toUpperCase().replace(/\s/g, ''); if (!/^KZ\d{2}[0-9A-Z]{16}$/.test(s)) return false;
    let m = 0; for (const ch of s.slice(4) + s.slice(0, 4)) { const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const d of v) m = (m * 10 + Number(d)) % 97; } return m === 1;
  }
  function iiks(text) {
    const t = lat(text), ok = [], raw = [];
    for (const x of t.matchAll(/K\s?Z\s?(?:[0-9OIL]\s?){2}(?:[0-9A-Z]\s?){16}/g)) {
      let v = x[0].replace(/\s/g, ''); v = 'KZ' + v.slice(2, 4).replace(/O/g, '0').replace(/[IL]/g, '1') + v.slice(4);
      if (ibanOk(v)) { if (!ok.includes(v)) ok.push(v); continue; }
      const v2 = v.slice(0, 4) + v.slice(4).replace(/O/g, '0'); if (ibanOk(v2)) { if (!ok.includes(v2)) ok.push(v2); continue; }
      if (!raw.includes(v)) raw.push(v);
    }
    return ok.concat(raw);
  }
  const BIN_RE = /(?:БИН|ИИН)[^\d\n]{0,12}(\d{12})/i;
  function reqs(text) {
    const T = String(text || ''), o = {};
    const m = T.match(/Сч[её]т\s+на\s+оплату\s*№\s*([0-9A-Za-zА-Яа-я\-\/.]+)\s*от\s*(\d{1,2})[\s.]+(\d{1,2}|[а-яё]+)[\s.]+(\d{2,4})/i);
    if (m) { o.number = m[1].replace(/[.\-\/]+$/, ''); o.date = isoD(m[2], m[3], m[4]); }
    const sl = (T.match(/Поставщик[^:\n]*:\s*([^\n]+(?:\n[^\n:]{0,120})?)/i) || [])[1] || '', bl = (T.match(/Покупатель[^:\n]*:\s*([^\n]+)/i) || [])[1] || '';
    const ben = (T.match(/Бенефициар[^:\n]*:?\s*([\s\S]{0,300})/i) || [])[1] || '';
    o.supplier_bin = ((sl.match(BIN_RE) || ben.match(BIN_RE) || [])[1]) || '';
    o.buyer_bin = (bl.match(BIN_RE) || [])[1] || '';
    let nm = sl.replace(/(?:БИН|ИИН)\s*\/?\s*(?:ИИН|БИН)?[^\d\n]{0,6}\d{12}\s*,?/i, '').split(/,|\n|\|/).map(clean).find((x) => /[A-Za-zА-Яа-я]{2}/.test(x) && !/^(Республика|г\.|город|ул|РК\b)/i.test(x)) || '';
    if (!nm) nm = clean((ben.split('\n').find((x) => /(ТОО|ИП|АО|LLP|ЖШС|"|«)/.test(x)) || '').replace(BIN_RE, ''));
    o.supplier = nm.slice(0, 200);
    // ИИК поставщика всегда есть в шапке счёта («Образец платёжного поручения» / «Бенефициар»). Покупательский счёт не берём
    const buy = iiks(bl), mine = (x) => !buy.includes(x);
    o.supplier_iik = iiks(ben).find(mine) || iiks(sl).find(mine) || iiks(T).find(mine) || '';
    const bk = (t) => (lat(t).match(/\b[A-Z]{4}KZ[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/) || [''])[0];
    o.supplier_bik = bk(ben) || bk(T);
    const cl = (T.match(/Договор[^:\n]*:\s*([^\n]+)/i) || [])[1] || '';
    if (cl && !/без договора/i.test(cl)) { o.contract_no = ((cl.match(/№\s*([^\s,]+)/) || cl.match(/([^\s,№]*\d[^\s,]*)\s+от(?=\s|$)/i) || [])[1] || '').replace(/[.,]+$/, ''); const cd = cl.match(/от\s*(\d{1,2})[.\s]+(\d{1,2}|[а-яё]+)[.\s]+(\d{2,4})/i); o.contract_date = cd ? isoD(cd[1], cd[2], cd[3]) : ''; }
    o.knp = ((T.match(/(?:КНП|Код\s+назначения\s+платежа)[^\d\n]{0,10}(\d{3})/i) || [])[1]) || '';
    const tot = T.match(/(?:Всего\s+к\s+оплате|Итого)[^\d\n]{0,20}(\d{1,3}(?:[\s\u00a0,]\d{3})*[.,]\d{2})/i); o.total = tot ? num(tot[1]) : null;
    const vat = T.match(/(?:в\s+том\s+числе|в\s+т\.\s?ч\.?)\s*НДС[^\d\n]{0,8}(?:(\d{1,2})\s*%)?[^\d\n]{0,10}(\d{1,3}(?:[\s\u00a0,]\d{3})*[.,]\d{2})?/i);
    if (vat) { o.vat_included = true; o.vat_sum = vat[2] ? num(vat[2]) : null; o.vat_rate = vat[1] ? Number(vat[1]) : null; }
    else if (/без\s+ндс/i.test(T)) { o.vat_rate = null; o.vat_sum = null; o.vat_included = true; }
    else { const v2 = T.match(/(?:Сумма\s+)?НДС[^\d\n]{0,8}(\d{1,2})\s*%/i); o.vat_rate = v2 ? Number(v2[1]) : null; o.vat_included = true; }
    if (o.vat_sum && !o.vat_rate && o.total) o.vat_rate = Math.abs(o.total * 16 / 116 - o.vat_sum) < Math.abs(o.total * 12 / 112 - o.vat_sum) ? 16 : 12;
    return o;
  }
  // стандартный счёт: есть номер, дата и таблица, сумма строк сходится с итогом
  // проверка количества по сумме: «3 260,00» иногда читается как 326000, «1,000» — как 1000.
  // Если количество × цена не сходится с суммой строки, а количество /10, /100 или /1000 сходится — берём его.
  function fixItems(items) {
    (items || []).forEach((i) => {
      const q = Number(i.qty), p = Number(i.price), s = Number(i.sum); if (!(q > 0 && p > 0 && s > 0)) return;
      const ok = (x) => Math.abs(x * p - s) <= Math.max(1, s * 0.0005);
      if (ok(q)) return;
      for (const d of [10, 100, 1000, 10000]) if (ok(q / d)) { i.qty = r2(q / d * 1000) / 1000; i.qtyFixed = q; return; }
      for (const d of [10, 100, 1000]) if (ok(q * d)) { i.qty = q * d; i.qtyFixed = q; return; }
    });
    return items;
  }
  function parseStd(text, src) {
    const o = reqs(text), items = fixItems(src.lines ? itemsFromLines(src.lines) : itemsFromGrid(src.grid || []));
    const s = r2(items.reduce((a, i) => a + (i.sum || 0), 0));
    if (!o.number || !o.date || !items.length) return null;
    if (o.total != null && Math.abs(s - o.total) > 1) return null;
    items.forEach((i) => { i.service = /(услуг|работ|монтаж|установк|доставк|ремонт|обслуживан|аренд|консультац)/i.test(i.name) && !/(шт|кг|м2|м3|м\b|л\b|упак|рул|лист)/i.test(i.unit); });
    return Object.assign({ total: s, items }, o, { total: o.total != null ? o.total : s, how: 'std' });
  }
  // ---------- метки вместо реквизитов (для ИИ) ----------
  function mask(text) {
    const map = {}, cnt = {}, rev = {};
    const put = (kind, v) => { const k = kind + ':' + v; if (rev[k]) return rev[k]; cnt[kind] = (cnt[kind] || 0) + 1; const t = '[' + kind + cnt[kind] + ']'; rev[k] = t; map[t] = v; return t; };
    const t = String(text || '')
      .replace(/KZ\s?\d{2}(?:\s?[0-9A-Z]){16}/gi, (x) => put('ИИК', x.replace(/\s/g, '').toUpperCase()))
      .replace(/\b[A-Z]{4}KZ[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g, (x) => put('БИК', x))
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[ПОЧТА]').replace(/(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[ТЕЛ]')
      .replace(/(?<!\d)\d{12}(?!\d)/g, (x) => put('БИН', x));
    return { text: t, map };
  }
  function unmask(inv, map) {
    const back = (v) => { const s = String(v || '').trim(); return map[s] || (/^\[/.test(s) ? '' : s); };
    ['supplier_bin', 'supplier_iik', 'supplier_bik', 'buyer_bin'].forEach((k) => { inv[k] = back(inv[k]); });
    return inv;
  }
  // похоже ли на счёт на оплату (а не на выписку)
  const looksInvoice = (text) => /сч[её]т\s+на\s+оплату|счет-фактур|invoice/i.test(text) && !/выписка\s+по\s+(лицевому\s+)?сч[её]ту|входящий\s+остаток/i.test(text);
  window.EsepInv = { readFile, parseStd, mask, unmask, reqs, looksInvoice, ibanOk, iiks, fixItems };
})();
