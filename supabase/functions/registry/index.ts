// Сверка реквизитов фирмы по БИН/ИИН с государственными источниками: КГД (X-Portal-Token) и портал «Открытые данные» data.egov.kz (apiKey).
// Секреты (кладёт Жанна): KGD_TOKEN, EGOV_KEY. Ключи наружу не выдаются.
// Пользователь кабинета: { company_id } — фирма должна быть ему доступна (RLS). Ответ: { ok, data } и запись в companies.registry / registry_at.
// Сервер (x-server-key): { probe: true, bin, pay_kbk? } — сырой ответ источников для проверки.
// Условия data.egov.kz: не больше 40 запросов в минуту, данные не изменять, источник указывать. Всю базу не копируем — только поля своих фирм.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { unzipSync, strFromU8 } from 'npm:fflate@0.8.2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const KGD_TOKEN = Deno.env.get('KGD_TOKEN') || '', EGOV_KEY = Deno.env.get('EGOV_KEY') || '';
const KGD = 'https://kgd.gov.kz/services/isnaportalsync/public', EGOV = 'https://data.egov.kz/api/v4';

async function call(url: string, init: RequestInit = {}, ms = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const txt = await r.text(); let body: any = txt;
    try { body = JSON.parse(txt); } catch (_) { /* не JSON */ }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: null as any, error: String((e as Error).message ?? e) }; } finally { clearTimeout(t); }
}
const kgd = (path: string) => call(KGD + path, { headers: { 'X-Portal-Token': KGD_TOKEN, Accept: 'application/json' } });
// БИН юрлица: пятая цифра 4, 5 или 6; у ИИН на этом месте десятки дня рождения (0–3)
const isUL = (bin: string) => Number(bin[4]) >= 4;
const day = (v: unknown) => { const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; };
const title = (s: string) => s.toLowerCase().replace(/(^|[\s\-«"(])([a-zа-яёәғқңөұүһі])/g, (_m, a, b) => a + b.toUpperCase());
const sentence = (s: string) => { const t = s.trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : t; };

async function check(bin: string) {
  const kind = isUL(bin) ? 'UL' : 'IP';
  const out: any = { bin, kind, at: new Date().toISOString(), errors: [] as string[], sources: [] as string[] };
  if (!KGD_TOKEN) out.errors.push('Не задан токен КГД');
  else {
    const [tp, nds, liq] = await Promise.all([
      kgd('/taxpayer-data?taxpayerCode=' + bin + '&taxpayerType=' + kind),
      kgd('/search-payer-data?taxpayerCode=' + bin),
      kgd('/find-liquidated-taxpayer?taxpayerCode=' + bin + '&page=0&pageSize=5'),
    ]);
    const r = tp.body?.taxpayerPortalSearchResponses?.[0];
    if (tp.status === 200 && r && r.messageResult === 'SUCCESS') {
      const fn = r.name || (r.fullName && typeof r.fullName === 'object' ? [r.fullName.lastName, r.fullName.firstName, r.fullName.middleName].filter(Boolean).join(' ') : r.fullName);
      out.name = fn || null; out.reg_date = day(r.beginDate); out.end_date = day(r.endDate); out.end_reason = r.additionalInfo || r.endReasonCode || null; out.ugd = r.taxOrg || null;
      out.sources.push('КГД');
      // код УГД: в ответе КГД его нет, берём орган, куда чаще всего платились налоги и взносы за последние 2 года (КБК 1… и 9…)
      const pay = tp.body?.paymentAnswer?.payment;
      if (Array.isArray(pay)) {
        const since = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10), cnt: Record<string, { n: number; name: string }> = {};
        pay.filter((x: any) => /^[19]/.test(String(x.kbk)) && /^2/.test(String(x.payStatus)) && String(x.receiptDate) >= since && /^\d{6}$/.test(String(x.taxOrgCode)))
          .forEach((x: any) => { const k = String(x.taxOrgCode); (cnt[k] ||= { n: 0, name: x.nameTaxRu || '' }).n++; });
        const best = Object.entries(cnt).sort((a, b) => b[1].n - a[1].n)[0];
        if (best) { out.ugd_code = best[0].slice(0, 4); out.ugd_name = String(best[1].name).replace(/\s+КГД МФ РК$/, '').trim(); }
      }
    } else out.errors.push('КГД, поиск налогоплательщика: ' + (r?.errorMessage || tp.error || 'ответ ' + tp.status));
    if (nds.status === 200) {
      const b = nds.body;
      if (b && typeof b === 'object' && b.ndsRegistrationDate) {
        const rs = b.ndsDeregistrationReason;
        out.vat = { payer: !b.ndsDeregistrationDate, date: day(b.ndsRegistrationDate), dereg: day(b.ndsDeregistrationDate), reason: rs && typeof rs === 'object' ? rs.ru || rs.code || null : rs || null };
      } else out.vat = { payer: false };
    } else out.errors.push('КГД, плательщик НДС: ' + (nds.error || 'ответ ' + nds.status));
    if (liq.status === 200) { const c = liq.body?.taxpayers?.content; out.liquidation = Array.isArray(c) && c.length ? (day(c[0].beginDate) || 'да') : null; }
    else out.errors.push('КГД, ликвидация: ' + (liq.error || 'ответ ' + liq.status));
  }
  // адрес, вид деятельности и руководитель — только для юрлиц (в реестре Минюста ИП нет)
  if (kind === 'UL') {
    if (!EGOV_KEY) out.errors.push('Не задан ключ портала «Открытые данные»');
    else {
      const src = encodeURIComponent(JSON.stringify({ size: 5, query: { bool: { must: [{ match: { bin } }] } } }));
      // портал бывает медленным: ждём до 45 с и при сбое пробуем ещё раз
      const gu = EGOV + '/gbd_ul/v1?apiKey=' + encodeURIComponent(EGOV_KEY) + '&source=' + src;
      let g = await call(gu, {}, 45000);
      if (g.status === 0 || g.status >= 500) { await new Promise((r) => setTimeout(r, 2000)); g = await call(gu, {}, 45000); }
      const row = Array.isArray(g.body) ? g.body.find((x: any) => String(x.bin) === bin) : null;
      if (g.status === 200 && row) {
        out.addr = String(row.addressru || '').replace(/,?\s*тел\.?\s*[:+\d(].*$/i, '').trim() || null;
        out.oked = row.okedru ? sentence(String(row.okedru)) : null;
        if (out.oked) { const { data: ok } = await adm.from('oked').select('code,name').ilike('name', out.oked.replace(/[%_]/g, '')).limit(1); if (ok && ok[0]) { out.oked_code = ok[0].code; out.oked = ok[0].name; } }
        out.director = row.director ? title(String(row.director)) : null;
        out.status = row.statusru || null; out.name_reg = row.nameru || null;
        if (!out.reg_date) out.reg_date = day(row.datereg);
        out.sources.push('портал «Открытые данные» data.egov.kz');
      } else if (g.status === 200) out.errors.push('В реестре юридических лиц запись не найдена');
      else out.errors.push('Портал «Открытые данные» не ответил' + (g.status ? ' (ответ ' + g.status + ')' : ' вовремя') + ' — попробуйте сверить позже');
    }
  }
  return out;
}

// справочник ОКЭД: официальный файл Бюро национальной статистики (НК РК 03-2019 с изм. 4) → таблица public.oked (код из 5 цифр, название)
const OKED_URL = 'https://stat.gov.kz/upload/iblock/68e/lki56d5rxyenji6uc8ciz8zjv80clauu/' + encodeURIComponent('ОКЭД с Изм 4_rus.docx');
async function okedLoad() {
  const r = await fetch(OKED_URL); if (!r.ok) return { ok: false, error: 'Файл ОКЭД не скачался: ' + r.status };
  const files = unzipSync(new Uint8Array(await r.arrayBuffer()), { filter: (f) => f.name === 'word/document.xml' });
  const xml = strFromU8(files['word/document.xml']);
  const seen = new Set<string>(), rows: { code: string; name: string }[] = [];
  for (const par of xml.split('</w:p>')) {
    const t = [...par.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(\d{2})\.(\d{2})\.(\d)\s+(.+)$/);
    if (m && !seen.has(m[1] + m[2] + m[3])) { seen.add(m[1] + m[2] + m[3]); rows.push({ code: m[1] + m[2] + m[3], name: m[4].slice(0, 400) }); }
  }
  if (rows.length < 900) return { ok: false, error: 'В файле найдено мало кодов: ' + rows.length };
  const { error } = await adm.from('oked').upsert(rows, { onConflict: 'code' });
  return error ? { ok: false, error: error.message } : { ok: true, count: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const p = await req.json().catch(() => ({} as any));
    const key = req.headers.get('x-server-key') || '';
    if (key) {
      const { data: ok } = await adm.rpc('server_robot_key_ok', { p_key: key });
      if (!ok) return j({ ok: false, error: 'Нет доступа' }, 403);
      if (p.oked_load) return j(await okedLoad());
      const bin = String(p.bin || '').replace(/\D/g, '');
      if (!/^\d{12}$/.test(bin)) return j({ ok: false, error: 'БИН/ИИН — 12 цифр' }, 400);
      const res: any = { check: await check(bin) };
      if (p.pay_kbk) {   // последние платежи по одному КБК — для сверки с лицевым счётом
        const tp = await kgd('/taxpayer-data?taxpayerCode=' + bin + '&taxpayerType=' + (isUL(bin) ? 'UL' : 'IP'));
        const pay = tp.body?.paymentAnswer?.payment;
        res.payments = Array.isArray(pay) ? pay.filter((x: any) => String(x.kbk) === String(p.pay_kbk)).sort((a: any, b: any) => String(b.receiptDate).localeCompare(String(a.receiptDate))).slice(0, 8)
          .map((x: any) => ({ date: day(x.receiptDate), writeOff: day(x.writeOffDate), sum: x.summa, payType: x.payType, entryType: x.entryType, status: x.payStatus, ogd: x.taxOrgCode })) : (tp.body?.paymentAnswer || null);
      }
      return j({ ok: true, ...res });
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const { data: me } = await sb.auth.getUser();
    if (!me?.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
    const { data: firm } = await sb.from('companies').select('id,bin').eq('id', String(p.company_id || '')).maybeSingle();
    if (!firm) return j({ ok: false, error: 'Фирма не найдена или нет доступа' }, 404);
    const bin = String(firm.bin || '').replace(/\D/g, '');
    if (!/^\d{12}$/.test(bin)) return j({ ok: false, error: 'В профиле фирмы не указан БИН/ИИН из 12 цифр' });
    const data = await check(bin);
    if (data.sources.length) await adm.from('companies').update({ registry: data, registry_at: data.at }).eq('id', firm.id);
    return j({ ok: true, data });
  } catch (err) {
    return j({ ok: false, error: String((err as Error).message ?? err) });
  }
});
