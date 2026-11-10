// Проверка связи с облачной 1С фирмы через OData.
// Секреты (задаёт Жанна в Supabase → Edge Functions → Secrets): ONEC_USER, ONEC_PASSWORD — один пользователь для всех баз.
// Вызов из кабинета: { company_id } — одна фирма (любой участник фирмы); { all: true } — все фирмы с адресом 1С (только администратор).
// Результат пишется в companies.onec_check = { ok, code, message, detail?, objects?, at }.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '';
const PASS = Deno.env.get('ONEC_PASSWORD') || '';
const TIMEOUT = 20000;

type Check = { ok: boolean; code: string; message: string; detail?: string; objects?: number; at: string };

function basic(u: string, p: string) {
  const bytes = new TextEncoder().encode(u + ':' + p); // 1С понимает логин кириллицей в UTF-8
  let s = ''; bytes.forEach((b) => (s += String.fromCharCode(b)));
  return 'Basic ' + btoa(s);
}

async function get(url: string, auth: boolean) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...(auth ? { Authorization: basic(USER, PASS) } : {}) }, signal: ctl.signal, redirect: 'manual' });
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

function snippet(t: string) {
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function netError(e: unknown): Check {
  const m = String((e as Error)?.message ?? e);
  const at = new Date().toISOString();
  if ((e as Error)?.name === 'AbortError') return { ok: false, code: 'timeout', message: '1С недоступна на сервере: сервер не ответил за 20 секунд', detail: m, at };
  if (/certificate|tls|ssl/i.test(m)) return { ok: false, code: 'tls', message: 'Сервер 1С отвечает, но его сертификат безопасности не принимается', detail: m, at };
  if (/dns|lookup|resolve|name or service/i.test(m)) return { ok: false, code: 'no_host', message: '1С недоступна: адрес сервера не найден — проверьте адрес 1С', detail: m, at };
  return { ok: false, code: 'unreachable', message: '1С недоступна на сервере: сервер не отвечает', detail: m, at };
}

async function check(base: string): Promise<Check> {
  const at = new Date().toISOString();
  if (!USER || !PASS) return { ok: false, code: 'no_secret', message: 'Логин и пароль 1С не заданы в секретах кабинета', at };
  const root = base.replace(/\/+$/, '');
  let r;
  try { r = await get(root + '/odata/standard.odata/?$format=json', true); } catch (e) { return netError(e); }
  const s = r.status;
  if (s === 200) {
    let n = -1;
    try { const b = JSON.parse(r.text); n = Array.isArray(b.value) ? b.value.length : -1; } catch { /* не JSON */ }
    if (n === 0) return { ok: false, code: 'no_objects', message: 'OData включена, но в ней не выбран состав объектов («Настройка стандартного интерфейса OData»)', at };
    if (n < 0) return { ok: false, code: 'bad_answer', message: 'По адресу OData отвечает не 1С — проверьте адрес 1С', detail: snippet(r.text), at };
    return { ok: true, code: 'ok', message: 'Связь с 1С есть', objects: n, at };
  }
  if (s === 401) return { ok: false, code: 'auth', message: 'Нет такого пользователя в 1С или неверный пароль', at };
  if (s === 403) return { ok: false, code: 'forbidden', message: 'У пользователя 1С нет прав на OData', detail: snippet(r.text), at };
  if (s >= 300 && s < 400) return { ok: false, code: 'redirect', message: 'Сервер перенаправляет запрос — проверьте адрес 1С (http/https, порт)', at };
  if (s === 502 || s === 503 || s === 504) return { ok: false, code: 'down', message: '1С недоступна на сервере: база выключена или на обслуживании', detail: 'HTTP ' + s, at };
  const txt = snippet(r.text);
  if (s === 500 && /лиценз|licen/i.test(r.text)) return { ok: false, code: 'license', message: 'В 1С закончились свободные лицензии', detail: txt, at };
  if (s === 500 && /(информационн\S* баз\S*|infobase).{0,40}(не найден|not found)/i.test(r.text)) return { ok: false, code: 'no_base', message: 'На сервере нет базы с таким адресом', detail: txt, at };
  if (s === 404 || s === 400 || s === 500) {
    // OData не отвечает — смотрим, есть ли сама база по этому адресу
    let b;
    try { b = await get(root + '/ru_RU/', false); } catch (e) { return netError(e); }
    if (b.status === 404) return { ok: false, code: 'no_base', message: 'На сервере нет базы с таким адресом — проверьте адрес 1С', detail: 'OData: HTTP ' + s, at };
    return { ok: false, code: 'odata_off', message: 'База есть, но OData не включена в публикации 1С', detail: 'OData: HTTP ' + s + (txt ? ' · ' + txt : ''), at };
  }
  return { ok: false, code: 'http_' + s, message: '1С ответила ошибкой ' + s, detail: txt, at };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sbUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const sbSrv = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any));
    let firms: { id: string; name: string; onec_url: string | null }[] = [];
    if (p.all) {
      const { data: adm } = await sbUser.rpc('am_i_admin');
      if (!adm) return j({ ok: false, error: 'Только для администратора ESEP' }, 403);
      const { data } = await sbSrv.from('companies').select('id,name,onec_url').not('onec_url', 'is', null).order('name');
      firms = data || [];
    } else {
      const id = String(p.company_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return j({ ok: false, error: 'Не указана фирма' }, 400);
      // RLS: фирму видит только её участник или администратор
      const { data } = await sbUser.from('companies').select('id,name,onec_url').eq('id', id).maybeSingle();
      if (!data) return j({ ok: false, error: 'Фирма не найдена или нет доступа' }, 403);
      if (!data.onec_url) return j({ ok: false, error: 'В профиле фирмы не указан адрес 1С' });
      firms = [data];
    }
    const results: any[] = [];
    for (let i = 0; i < firms.length; i += 5) {
      const part = firms.slice(i, i + 5);
      const res = await Promise.all(part.map(async (f) => {
        const c = await check(f.onec_url!);
        await sbSrv.from('companies').update({ onec_check: c }).eq('id', f.id);
        return { id: f.id, name: f.name, ...c };
      }));
      results.push(...res);
    }
    return j({ ok: true, results });
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) }, 200);
  }
});
