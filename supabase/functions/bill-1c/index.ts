// «Расчёт за услуги» (только администратор ESEP): сколько документов создано в 1С фирмы за месяц — по видам документов.
// verify_jwt выключен: доступ проверяется внутри (am_i_admin). Только чтение 1С.
//   count { company_id, month: 'ГГГГ-ММ' } — все опубликованные в OData виды документов (Document_…), по каждому $count за месяц
//        без помеченных на удаление; результат сохраняется в billing_counts (by_type), считает документы и цену уже кабинет.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '', PASS = Deno.env.get('ONEC_PASSWORD') || '';
function basic() { const b = new TextEncoder().encode(USER + ':' + PASS); let s = ''; b.forEach((x) => (s += String.fromCharCode(x))); return 'Basic ' + btoa(s); }
async function get(base: string, path: string, ms = 50000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(base.replace(/\/+$/, '') + '/odata/standard.odata/' + path, { headers: { Authorization: basic() }, signal: ctl.signal }); return { status: r.status, text: await r.text() }; }
  finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!, sbSrv = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const sbUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const { data: u } = await sbUser.auth.getUser(); if (!u || !u.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
    const { data: adm } = await sbUser.rpc('am_i_admin'); if (!adm) return j({ ok: false, error: 'Только для администратора ESEP' }, 403);
    const p = await req.json().catch(() => ({} as any));
    if (p.action !== 'count') return j({ ok: false, error: 'Неизвестное действие' }, 400);
    const id = String(p.company_id || ''), m = String(p.month || '').match(/^(\d{4})-(\d{2})$/);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !m) return j({ ok: false, error: 'Не указаны фирма или месяц' }, 400);
    const { data: f } = await sbSrv.from('companies').select('id,name,onec_url').eq('id', id).maybeSingle();
    if (!f || !f.onec_url) return j({ ok: false, error: 'У фирмы не указан адрес 1С' });
    if (!USER || !PASS) return j({ ok: false, error: 'Логин и пароль 1С не заданы в секретах кабинета' });
    const base = f.onec_url as string, y = Number(m[1]), mo = Number(m[2]);
    const from = m[1] + '-' + m[2] + '-01T00:00:00', to = (mo === 12 ? y + 1 : y) + '-' + String(mo === 12 ? 1 : mo + 1).padStart(2, '0') + '-01T00:00:00';
    const md = await get(base, '$metadata', 60000); if (md.status !== 200) return j({ ok: false, error: '1С не отдала список документов (ошибка ' + md.status + ')' });
    // виды документов: Document_Имя (табличные части — Document_Имя_Часть — не считаем)
    const types = [...new Set([...md.text.matchAll(/EntitySet Name="(Document_[^"_]+)"/g)].map((x) => x[1]))];
    const flt = encodeURIComponent("Date ge datetime'" + from + "' and Date lt datetime'" + to + "' and DeletionMark eq false");
    const by: Record<string, number> = {}, bad: string[] = [];
    let i = 0;
    const worker = async () => { while (i < types.length) { const t = types[i++];
      try { const r = await get(base, t + '/$count?$filter=' + flt, 30000); const n = Number(r.text.trim()); if (r.status === 200 && isFinite(n)) { if (n > 0) by[t.replace(/^Document_/, '')] = n; } else bad.push(t.replace(/^Document_/, '')); }
      catch { bad.push(t.replace(/^Document_/, '')); } } };
    await Promise.all(Array.from({ length: 8 }, worker));
    const month = m[1] + '-' + m[2] + '-01';
    const { error } = await sbSrv.from('billing_counts').upsert({ company_id: id, month, by_type: by, counted_at: new Date().toISOString() }, { onConflict: 'company_id,month' });
    if (error) return j({ ok: false, error: 'Не сохранилось: ' + error.message });
    return j({ ok: true, by_type: by, types: types.length, failed: bad });
  } catch (e) { return j({ ok: false, error: (e as Error).message || 'Ошибка' }); }
});
