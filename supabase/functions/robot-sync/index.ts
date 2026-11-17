// Робот UiPath «Диагностика» в начале работы спрашивает кабинет: какие фирмы отмечены для синхронизации с ИС ЭСФ.
// Заголовок x-robot-key (тот же ключ, что у robot-api). Тело: {"action":"sync_take","robot":"esf_diagnostics"}.
// Ответ: {"ok":true,"request_id":"…"|null,"firms":[{"bin","onec_url","name"}]} — пустой список = идти по всем фирмам.
// {"action":"stop_check","robot":"…"} -> {"ok":true,"stop":true|false} — просили ли в кабинете остановиться после текущей фирмы.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  try {
    const key = req.headers.get('x-robot-key') ?? '';
    if (!key.startsWith('esep_')) return json({ ok: false, error: 'Нет ключа x-robot-key' }, 401);
    const { data: valid } = await db.rpc('robot_api_check_key', { p_key: key });
    if (!valid) return json({ ok: false, error: 'Ключ не подходит' }, 401);
    const p = await req.json().catch(() => ({} as any));
    if (p.action !== 'sync_take' && p.action !== 'stop_check') return json({ ok: false, error: 'action: sync_take или stop_check' }, 400);
    const { data, error } = await db.rpc(p.action === 'stop_check' ? 'robot_stop_check' : 'sync_take', { p_robot_code: String(p.robot || 'esf_diagnostics') });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json(data);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
