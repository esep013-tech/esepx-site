// Реквизиты и проверка по БИН из государственных источников: КГД (X-Portal-Token) и портал «Открытые данные» data.egov.kz (apiKey).
// Секреты (кладёт Жанна): KGD_TOKEN, EGOV_KEY. Ключи никому не передаются и в ответ не попадают.
// Этап 1 (19.11.2026): только пробный опрос источников по ключу сервера — { probe: true, bin, kind: 'UL'|'IP' }.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (...names: string[]) => { for (const n of names) { const v = Deno.env.get(n); if (v) return { name: n, v }; } return null; };
const KGD = () => env('KGD_TOKEN', 'KGD_PORTAL_TOKEN', 'X_PORTAL_TOKEN', 'KGD_KEY');
const EGOV = () => env('EGOV_KEY', 'EGOV_API_KEY', 'DATA_EGOV_KEY');

// запрос с ограничением по времени; в ответ — статус и начало тела
async function call(url: string, init: RequestInit = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const txt = await r.text(); let body: unknown = txt.slice(0, 3000);
    try { body = JSON.parse(txt); } catch (_) { /* не JSON */ }
    return { status: r.status, body };
  } catch (e) { return { status: 0, error: String((e as Error).message ?? e) }; } finally { clearTimeout(t); }
}
const cut = (v: unknown) => { const s = JSON.stringify(v); return s && s.length > 2500 ? s.slice(0, 2500) : v; };

async function probe(bin: string, kind: string) {
  const out: Record<string, unknown> = {}, k = KGD(), e = EGOV();
  out.secrets = { kgd: k ? k.name : null, egov: e ? e.name : null };
  if (k) {
    const h = { 'X-Portal-Token': k.v, Accept: 'application/json' };
    for (const host of ['https://kgd.gov.kz', 'https://portal.kgd.gov.kz']) {
      const tp = await call(host + '/services/isnaportalsync/public/taxpayer-data?taxpayerCode=' + bin + '&taxpayerType=' + kind, { headers: h });
      out['kgd_taxpayer ' + host] = { status: tp.status, body: cut(tp.body), error: tp.error };
      if (tp.status && tp.status !== 404 && tp.status < 500 && tp.status !== 0) {
        const nds = await call(host + '/services/isnaportalsync/public/search-payer-data?taxpayerCode=' + bin, { headers: h });
        out['kgd_nds ' + host] = { status: nds.status, body: cut(nds.body), error: nds.error };
        const liq = await call(host + '/services/isnaportalsync/public/find-liquidated-taxpayer?taxpayerCode=' + bin + '&page=0&pageSize=5', { headers: h });
        out['kgd_liquidation ' + host] = { status: liq.status, body: cut(liq.body), error: liq.error };
        break;
      }
    }
  }
  if (e) {
    const base = 'https://data.egov.kz/api/v4';
    const src = encodeURIComponent(JSON.stringify({ size: 2, query: { bool: { must: [{ match: { bin } }] } } }));
    for (const ds of ['gbd_ul/v1', 'gbd_ul/v2', 'gbd_ul', 'dara_kasipkerler_boiynsha_dere/v1']) {
      const m = await call(base + '/' + ds + '?apiKey=' + encodeURIComponent(e.v) + '&source=' + src);
      out['egov ' + ds] = { status: m.status, body: cut(m.body), error: m.error };
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const key = req.headers.get('x-server-key') || '';
    const { data: ok } = key ? await adm.rpc('server_robot_key_ok', { p_key: key }) : { data: false };
    if (!ok) return j({ ok: false, error: 'Нет доступа' }, 403);
    const p = await req.json().catch(() => ({} as any));
    const bin = String(p.bin || '').replace(/\D/g, '');
    if (!/^\d{12}$/.test(bin)) return j({ ok: false, error: 'БИН/ИИН — 12 цифр' }, 400);
    if (p.probe) return j({ ok: true, probe: await probe(bin, p.kind === 'IP' ? 'IP' : 'UL') });
    return j({ ok: false, error: 'Неизвестное действие' }, 400);
  } catch (err) {
    return j({ ok: false, error: String((err as Error).message ?? err) });
  }
});
