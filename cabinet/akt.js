// «Акты сверки»: акт от контрагента читается на компьютере пользователя.
//   PDF из программы — текст со страницы (pdf.js); скан или фото — распознавание в браузере (Tesseract), файл никуда не уходит.
//   Excel — ячейки таблицы.
// Разбор: две половины акта («По данным …» слева и справа), в каждой — строки: дата, документ, дебет, кредит; сальдо на начало, обороты, сальдо на конец.
// Сверка: данные контрагента «зеркально» с нашими из 1С (их дебет = наш кредит): по номеру документа, затем по сумме и дате.
(function () {
  'use strict';
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const MON = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  const yy = (y) => (String(y).length === 2 ? '20' + y : String(y));
  const iso = (d, m, y) => { const D = Number(d), M = Number(m); if (!(D >= 1 && D <= 31 && M >= 1 && M <= 12)) return ''; return yy(y) + '-' + String(M).padStart(2, '0') + '-' + String(D).padStart(2, '0'); };
  const DATE = /^[(\[|]?(\d{1,2})[.,](\d{1,2})[.,]?(\d{4}|\d{2})[)\]|.,]?$/;
  // сумма: «58 790,00», «10 000/00», «10.000:00», «10,000.00», «27 570,001» (хвост от рамки таблицы)
  function amount(t) {
    let s = String(t || '').replace(/[|\]\[)(!'"“”«»]/g, '').replace(/[оОoO]/g, '0').replace(/\s/g, '');
    let m = s.match(/^(\d{1,3}(?:[.,]?\d{3})*)[.,:\/](\d{2})\d?$/);
    if (m) return r2(Number(m[1].replace(/[.,]/g, '')) + Number(m[2]) / 100);
    return null;
  }
  const isNumTok = (t) => /^[\d\s.,:\/|\]oO]+$/.test(t) && /\d/.test(t);

  // ---------- чтение файла → страницы со словами {t, x0, y0, x1, y1} ----------
  async function readFile(name, buf, libs, prog) {
    const low = name.toLowerCase(), b = new Uint8Array(buf.slice(0, 4));
    const say = (t, p) => { if (prog) prog(t, p); };
    if (b[0] === 0x25 && b[1] === 0x50) {
      const pdf = await libs.pdfjs.getDocument({ data: new Uint8Array(buf) }).promise, pages = [];
      let chars = 0;
      for (let i = 1; i <= Math.min(pdf.numPages, 8); i++) {
        const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent(), words = [];
        for (const it of tc.items) {
          const s = String(it.str || ''); if (!s.trim()) continue; chars += s.trim().length;
          const x = it.transform[4], y = vp.height - it.transform[5], h = Math.abs(it.transform[3]) || 8, w = it.width || s.length * h * 0.5;
          // ячейка может быть «Реализация 0418 от 10.07.2026» — делим на слова, x — по доле символов
          let pos = 0; for (const part of s.split(/(\s+)/)) { if (part.trim()) { const a = x + w * pos / s.length, z = x + w * (pos + part.length) / s.length; words.push({ t: part, x0: a, x1: z, y0: y - h, y1: y }); } pos += part.length; }
        }
        pages.push({ w: vp.width, h: vp.height, words });
      }
      if (chars > 200) { mergeAmounts(pages); return { ok: true, pages, how: 'text' }; }
      // скан в PDF — рисуем страницы и распознаём
      const imgs = [];
      for (let i = 1; i <= Math.min(pdf.numPages, 6); i++) {
        const pg = await pdf.getPage(i), vp0 = pg.getViewport({ scale: 1 }), sc = Math.min(4, 2400 / vp0.width), vp = pg.getViewport({ scale: sc });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise; imgs.push(cv);
      }
      return ocr(imgs, libs, say);
    }
    if (/\.(jpe?g|png|webp|bmp|heic)$/i.test(low) || (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50)) {
      const img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('Не удалось открыть картинку')); im.src = URL.createObjectURL(new Blob([buf])); });
      const sc = Math.min(1, 2600 / img.naturalWidth) || 1, cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return ocr([cv], libs, say);
    }
    if (libs.XLSX) {
      const wb = libs.XLSX.read(buf, { type: 'array' }), pages = [];
      for (const sn of wb.SheetNames.slice(0, 3)) {
        const rows = libs.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' }), words = [];
        rows.forEach((r, y) => r.forEach((c, x) => { const s = clean(c); if (s) words.push({ t: s, x0: x * 100, x1: x * 100 + 90, y0: y * 20, y1: y * 20 + 14, cell: true }); }));
        pages.push({ w: Math.max(...rows.map((r) => r.length), 1) * 100, h: rows.length * 20, words });
      }
      return { ok: true, pages, how: 'xlsx' };
    }
    return { ok: false, error: 'Такой файл не читается: нужен PDF, фото (JPG, PNG) или Excel.' };
  }
  async function ocr(canvases, libs, say) {
    const T = libs.Tesseract; if (!T) return { ok: false, error: 'Распознавание не загрузилось' };
    say('Загружаю распознавание (первый раз — около 10 МБ)…', 0);
    const w = await T.createWorker(['rus', 'eng'], 1, { logger: (m) => { if (m.status === 'recognizing text') say('Распознаю страницу…', m.progress); } });
    await w.setParameters({ preserve_interword_spaces: '1' });
    const pages = [];
    try {
      for (let i = 0; i < canvases.length; i++) {
        say('Распознаю страницу ' + (i + 1) + ' из ' + canvases.length + '…', 0);
        const { data } = await w.recognize(canvases[i]);
        pages.push({ w: canvases[i].width, h: canvases[i].height, img: canvases[i].toDataURL('image/jpeg', 0.7), words: (data.words || []).filter((x) => x.text.trim()).map((x) => ({ t: x.text.trim(), x0: x.bbox.x0, x1: x.bbox.x1, y0: x.bbox.y0, y1: x.bbox.y1, c: x.confidence })) });
      }
    } finally { await w.terminate(); }
    mergeAmounts(pages);
    return { ok: true, pages, how: 'ocr' };
  }
  // «58» «790,00» → «58 790,00»; «02.09» «2026» → «02.09.2026»
  function mergeAmounts(pages) {
    for (const p of pages) {
      const L = lines(p.words), out = [];
      for (const ln of L) {
        for (let i = 0; i < ln.length; i++) {
          let a = Object.assign({}, ln[i]); const h = a.y1 - a.y0 || 10;
          while (i + 1 < ln.length) {
            const n = ln[i + 1], gap = n.x0 - a.x1;
            if (gap > h * 1.2) break;
            if (/^\d{1,3}([ .,]\d{3})*$/.test(a.t) && /^\d{3}([.,:\/]\d{2}\d?)?[|\]]?$/.test(n.t)) { a = { t: a.t + ' ' + n.t, x0: a.x0, x1: n.x1, y0: Math.min(a.y0, n.y0), y1: Math.max(a.y1, n.y1) }; i++; continue; }
            if (/^\d{1,2}[.,]\d{1,2}[.,]?$/.test(a.t) && /^\d{2,4}$/.test(n.t)) { a = { t: a.t.replace(/[.,]?$/, '.') + n.t, x0: a.x0, x1: n.x1, y0: a.y0, y1: a.y1 }; i++; continue; }
            break;
          }
          out.push(a);
        }
      }
      p.words = out;
    }
  }
  function lines(words) {
    const ws = words.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1)), L = [];
    const hs = ws.map((w) => w.y1 - w.y0).sort((a, b) => a - b), mh = hs[Math.floor(hs.length / 2)] || 10;
    for (const w of ws) { const c = (w.y0 + w.y1) / 2, ln = L.find((l) => Math.abs(l.c - c) < mh * 0.55); if (ln) { ln.ws.push(w); ln.c = (ln.c * (ln.ws.length - 1) + c) / ln.ws.length; } else L.push({ c, ws: [w] }); }
    return L.sort((a, b) => a.c - b.c).map((l) => l.ws.sort((a, b) => a.x0 - b.x0));
  }

  // ---------- разбор акта ----------
  function parse(pages) {
    const all = pages.flatMap((p) => p.words.map((w) => w.t)).join(' ');
    const o = { sides: [], bins: [...new Set((all.match(/(?<!\d)\d{12}(?!\d)/g) || []))] };
    const per = all.match(/период\s+с\s*(\d{1,2}[.,]\d{1,2}[.,]\d{2,4})\s*(?:г\.?)?\s*по\s*(\d{1,2}[.,]\d{1,2}[.,]\d{2,4})/i);
    const dd = (s) => { const m = String(s).match(/(\d{1,2})[.,](\d{1,2})[.,](\d{2,4})/); return m ? iso(m[1], m[2], m[3]) : ''; };
    if (per) { o.from = dd(per[1]); o.to = dd(per[2]); }
    const nm = all.match(/Акт\s+сверки\s*№\s*([^\s]+)\s+от\s+(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
    if (nm) { o.number = nm[1]; const mi = MON.findIndex((m) => nm[3].toLowerCase().startsWith(m)); if (mi >= 0) o.date = iso(nm[2], mi + 1, nm[4]); }
    // стороны: заголовки «По данным …»
    const heads = [];
    pages.forEach((p, pi) => lines(p.words).forEach((ln) => { const s = ln.map((w) => w.t).join(' '); for (let i = 0; i < ln.length; i++) if (/^данн/i.test(ln[i].t) && i > 0 && /^[{(]?[пП1][оo0]$/i.test(ln[i - 1].t.replace(/[{(]/g, '') || 'по')) heads.push({ pi, x: ln[i - 1].x0, y: ln[i].y0, s }); }));
    // где правая половина: строки с двумя датами (левая и правая колонка «Дата»), иначе — второй заголовок «По данным»
    const splits = [];
    // дата правой колонки идёт сразу после сумм левой половины
    pages.forEach((p, pi) => lines(p.words).forEach((ln) => { for (let i = 1; i < ln.length; i++) if (DATE.test(ln[i].t) && ln[i].x0 > p.w * 0.3 && ln[i].x0 < p.w * 0.75 && amount(ln[i - 1].t) != null) splits.push({ pi, x: ln[i].x0 }); }));
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const splitOf = (pi) => { const s = splits.filter((x) => x.pi === pi).map((x) => x.x); if (s.length) return med(s) - 4; const h = heads.filter((x) => x.pi === pi).map((x) => x.x).sort((a, b) => a - b); if (h.length >= 2) return h[h.length - 1] - 4; const all2 = splits.map((x) => x.x); return all2.length ? med(all2) - 4 : pages[pi].w / 2; };
    // заголовки сторон — текст после «По данным» до таблицы
    const titleOf = (side) => { const hs = heads.filter((h) => (side === 0 ? h.x < splitOf(h.pi) : h.x >= splitOf(h.pi))); if (!hs.length) return ''; const h = hs[0], p = pages[h.pi], sp = splitOf(h.pi);
      const ws = lines(p.words.filter((w) => w.y0 >= h.y - 4 && w.y0 < h.y + (w.y1 - w.y0) * 3.2 && (side === 0 ? w.x0 < sp : w.x0 >= sp))).flat();
      return clean(ws.map((w) => w.t).join(' ').replace(/^.*?данн\S*\s*/i, '').replace(/\s*(Дата|Документ)\b.*$/i, '')); };
    for (const side of [0, 1]) {
      const S = { title: titleOf(side), entries: [], open: null, turn: null, close: null };
      // колонки сумм: заголовки «Дебет»/«Кредит» этой половины, иначе — две группы по правому краю сумм
      const amts = [], items = [];
      pages.forEach((p, pi) => { const sp = splitOf(pi), lo = side === 0 ? 0 : sp, hi = side === 0 ? sp : p.w;
        lines(p.words).forEach((ln, li) => { const ws = ln.filter((w) => w.x0 >= lo - 2 && w.x0 < hi); if (!ws.length) return; const y = pi * 1e6 + ws[0].y0;
          items.push({ pi, y, ws, lo, hi, s: ws.map((w) => w.t).join(' ') }); ws.forEach((w) => { const a = amount(w.t); if (a != null && w.x0 > lo + (hi - lo) * 0.35) amts.push({ x: w.x1, a }); }); }); });
      let hd = null, hk = null; items.forEach((it) => it.ws.forEach((w) => { if (/^(дебет|двбет|дебег|дебе)/i.test(w.t)) hd = hd || (w.x0 + w.x1) / 2; if (/^(кредит|кред|фредит)/i.test(w.t)) hk = hk || (w.x0 + w.x1) / 2; }));
      let cut;
      if (hd && hk && hk > hd) cut = (hd + hk) / 2;
      else { const xs = amts.map((a) => a.x).sort((a, b) => a - b); if (xs.length) { let c1 = xs[0], c2 = xs[xs.length - 1]; for (let k = 0; k < 8; k++) { const g1 = xs.filter((x) => Math.abs(x - c1) <= Math.abs(x - c2)), g2 = xs.filter((x) => Math.abs(x - c1) > Math.abs(x - c2)); if (g1.length) c1 = g1.reduce((a, b) => a + b) / g1.length; if (g2.length) c2 = g2.reduce((a, b) => a + b) / g2.length; } cut = (c1 + c2) / 2; } }
      const col = (w) => { if (hd && hk && hk > hd) { const c = (w.x0 + w.x1) / 2; return Math.abs(c - hd) <= Math.abs(c - hk) ? 'd' : 'k'; } if (cut == null) return 'd'; return w.x1 < cut ? 'd' : 'k'; };
      const docEnd = (it) => it.lo + (it.hi - it.lo) * 0.55;
      // колонка «Дата» — самые левые даты этой половины (даты внутри текста документа правее)
      const dxs = items.flatMap((it) => it.ws.filter((w) => DATE.test(w.t) && w.x0 < it.lo + (it.hi - it.lo) * 0.3).map((w) => w.x0)).sort((a, b) => a - b);
      const dateX = dxs.length ? dxs[Math.floor(dxs.length * 0.1)] : null;
      let cur = null, stop = false;
      const push = () => { if (cur && (cur.debit || cur.credit)) { cur.doc = clean(cur.doc.join(' ')); S.entries.push(cur); } };
      for (const it of items) {
        const low = it.s.toLowerCase();
        const sums = it.ws.filter((w) => w.x0 > docEnd(it) - (it.hi - it.lo) * 0.05).map((w) => ({ w, a: amount(w.t) })).filter((x) => x.a != null);
        if (stop) continue;
        // после «Обороты за период» в таблице идёт только «Сальдо на конец»
        if (S.turn && !S.close && sums.length) { const v = { d: 0, k: 0 }; sums.forEach((x) => { v[col(x.w)] += x.a; }); S.close = v; stop = true; continue; }
        const sal = /сальд|альд|бальд|дона\s*(нач|кон)/.test(low);
        const spec = sal && /нач/.test(low) ? 'open' : /об[оo0]р[оo0]т|ogopo|оборо/i.test(low) ? 'turn' : sal && /кон[еe]ц|конеп|кон\b/.test(low) ? 'close' : '';
        if (spec) { push(); cur = null; const v = { d: 0, k: 0 }; sums.forEach((x) => { v[col(x.w)] += x.a; }); S[spec] = v; if (spec !== 'open') stop = spec === 'close'; continue; }
        // подвал акта («По данным … на … задолженность») — строки кончились
        if (S.entries.length + (cur ? 1 : 0) > 0 && (/задолженн|нижеподпис/.test(low) || (/данн/.test(low) && /^(по|п0)\b/.test(low)))) { push(); cur = null; stop = true; continue; }
        if (/^(итого|всего)/.test(low)) { push(); cur = null; continue; }
        const first = it.ws[0], dm = first && dateX != null && Math.abs(first.x0 - dateX) < (it.hi - it.lo) * 0.05 ? first.t.match(DATE) : null;
        if (dm) { push(); cur = { date: iso(dm[1], dm[2], dm[3]), doc: [], debit: 0, credit: 0, y: it.y, pi: it.pi }; }
        if (!cur) { if (sums.length) { cur = { date: '', doc: [], debit: 0, credit: 0, y: it.y, pi: it.pi }; } else continue; }
        it.ws.forEach((w) => { if (sums.some((x) => x.w === w)) return; if (dm && w === first) return; if (w.x0 < docEnd(it)) cur.doc.push(w.t); });
        // одна строка документа — суммы на одной линии; сумма на другой линии — это уже следующий документ (дата не прочиталась)
        for (const x of sums) { const c = col(x.w), busy = (c === 'd' && cur.debit) || (c === 'k' && cur.credit), other = (cur.debit || cur.credit) && cur.ly != null && Math.abs(cur.ly - it.y) > 2;
          if (busy || other) { push(); cur = { date: '', doc: [], debit: 0, credit: 0, y: it.y, pi: it.pi, split: true }; }
          if (c === 'd') cur.debit = x.a; else cur.credit = x.a; cur.ly = it.y; }
      }
      push();
      S.entries.forEach((e) => { e.no = docNo(e.doc); if (!e.date) { const m = e.doc.match(/(?:от|or|oT|ot|om)\s*\W?(\d{1,2})[.,](\d{1,2})[.,](\d{2,4})/); if (m) { e.date = iso(m[1], m[2], m[3]); e.dateDoc = true; } } });
      o.sides.push(S);
    }
    return o;
  }
  // номер документа: «Реализация 04180019400 от 10.07.2026», «Платежный ордер … 69 от 29.04.2025», «… услуг 92 от 25.04.2025»
  function docNo(t) {
    const m = String(t || '').match(/([A-Za-zА-Яа-я0-9\-\/]*\d[A-Za-zА-Яа-я0-9\-\/]*)\s*(?:от|оТ|ot|oT|or|om)\s*\d{1,2}[.,]\d{1,2}/);
    return m ? m[1].replace(/^[^0-9A-Za-zА-Яа-я]+/, '') : '';
  }
  const nn = (s) => String(s || '').toUpperCase().replace(/[^0-9A-ZА-Я]/g, '').replace(/^[A-ZА-Я]*0*/, '').replace(/^0+/, '');
  const days = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 864e5 : 99);

  // ---------- сверка: их строки (зеркально) ↔ наши из 1С ----------
  // their: [{date, doc, no, debit, credit}], ours: [{date, doc, no, in_no, debit, credit}]
  function compare(their, ours) {
    const T = their.map((e, i) => ({ e, i, used: false })), O = ours.map((e, i) => ({ e, i, used: false })), pairs = [];
    const mirrorEq = (t, o) => Math.abs(t.debit - o.credit) < 0.01 && Math.abs(t.credit - o.debit) < 0.01;
    const nums = (o) => [nn(o.no), nn(o.in_no)].filter(Boolean);
    // 1) по номеру документа
    for (const t of T) { const k = nn(t.e.no); if (!k) continue; const o = O.find((x) => !x.used && nums(x.e).includes(k) && (mirrorEq(t.e, x.e) || days(t.e.date, x.e.date) < 45)); if (o) { t.used = o.used = true; pairs.push({ t: t.e, o: o.e, by: 'no' }); } }
    // 2) по сумме и дате (та же дата, потом до 7 дней)
    for (const lim of [0.5, 7]) for (const t of T) { if (t.used) continue; const o = O.find((x) => !x.used && mirrorEq(t.e, x.e) && days(t.e.date, x.e.date) <= lim); if (o) { t.used = o.used = true; pairs.push({ t: t.e, o: o.e, by: 'sum' }); } }
    // 3) похоже на ошибку распознавания: та же дата и документ того же вида, суммы отличаются на 1–2 цифры
    for (const t of T) { if (t.used) continue; const o = O.find((x) => !x.used && days(t.e.date, x.e.date) < 0.5 && digitsDiff(String(r2(t.e.debit || t.e.credit)), String(r2(x.e.credit || x.e.debit))) <= 2); if (o) { t.used = o.used = true; pairs.push({ t: t.e, o: o.e, by: 'near' }); } }
    T.filter((x) => !x.used).forEach((x) => pairs.push({ t: x.e, o: null }));
    O.filter((x) => !x.used).forEach((x) => pairs.push({ t: null, o: x.e }));
    pairs.forEach((p) => {
      p.bad = []; const t = p.t, o = p.o;
      if (!t) { p.bad.push('nothere'); return; } if (!o) { p.bad.push('nothem'); return; }
      if (Math.abs(t.debit - o.credit) >= 0.01) p.bad.push('sum_d'); if (Math.abs(t.credit - o.debit) >= 0.01) p.bad.push('sum_k');
      if (days(t.date, o.date) >= 0.5) p.bad.push('date');
    });
    pairs.sort((a, b) => String((a.o || a.t).date).localeCompare(String((b.o || b.t).date)));
    return pairs;
  }
  function digitsDiff(a, b) { if (Math.abs(a.length - b.length) > 1) return 9; let d = Math.abs(a.length - b.length); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++; return d; }
  const looksAkt = (text) => /акт\w*\s+сверк|сверк\w*\s+взаим|взаимных\s+расч/i.test(text);
  window.EsepAkt = { readFile, parse, compare, amount, docNo, looksAkt, lines, nn, _merge: mergeAmounts };
})();
