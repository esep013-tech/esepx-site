// Управление пользователями (только администратор ESEP):
// invite {email, name?} — пригласить по почте (письмо со ссылкой входа в кабинет);
// block {user_id, reason?} / unblock {user_id} — чёрный список (вход запрещён);
// archive {user_id} / restore {user_id} — удалить в архив и восстановить (фирмы, роли и настройки не трогаются).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const FOREVER = '876000h';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sbUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: isAdm } = await sbUser.rpc('am_i_admin');
    if (!isAdm) return j({ ok: false, error: 'Только для администратора ESEP' }, 403);
    const { data: me } = await sbUser.auth.getUser();
    const p = await req.json().catch(() => ({} as any));
    const act = String(p.action || '');

    if (act === 'invite') {
      const email = String(p.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j({ ok: false, error: 'Проверьте почту' });
      const { data: ex } = await adm.from('profiles').select('id,archived_at,blocked_at').ilike('email', email).maybeSingle();
      if (ex) return j({ ok: false, error: ex.archived_at ? 'Этот человек в архиве — восстановите его.' : ex.blocked_at ? 'Этот человек в чёрном списке.' : 'Этот человек уже зарегистрирован.' });
      const { error } = await adm.auth.admin.inviteUserByEmail(email, { redirectTo: 'https://esepx.kz/cabinet/', data: p.name ? { full_name: String(p.name).slice(0, 100) } : undefined });
      if (error) return j({ ok: false, error: /already/i.test(error.message) ? 'Этот человек уже зарегистрирован.' : 'Не удалось отправить приглашение: ' + error.message });
      return j({ ok: true });
    }

    const id = String(p.user_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return j({ ok: false, error: 'Не выбран пользователь' }, 400);
    if (me?.user?.id === id) return j({ ok: false, error: 'Себя изменить нельзя' });
    const { data: tAdm } = await adm.from('platform_admins').select('user_id').eq('user_id', id).maybeSingle();
    if (tAdm) return j({ ok: false, error: 'Администратора ESEP изменить нельзя' });
    const { data: prof } = await adm.from('profiles').select('blocked_at,archived_at').eq('id', id).maybeSingle();
    if (!prof) return j({ ok: false, error: 'Пользователь не найден' }, 404);
    const now = new Date().toISOString();
    const ban = (on: boolean) => adm.auth.admin.updateUserById(id, { ban_duration: on ? FOREVER : 'none' } as any);

    if (act === 'block') {
      const { error } = await ban(true); if (error) return j({ ok: false, error: error.message });
      await adm.from('profiles').update({ blocked_at: now, blocked_reason: p.reason ? String(p.reason).slice(0, 300) : null }).eq('id', id);
      return j({ ok: true });
    }
    if (act === 'unblock') {
      if (!prof.archived_at) { const { error } = await ban(false); if (error) return j({ ok: false, error: error.message }); }
      await adm.from('profiles').update({ blocked_at: null, blocked_reason: null }).eq('id', id);
      return j({ ok: true });
    }
    if (act === 'archive') {
      const { error } = await ban(true); if (error) return j({ ok: false, error: error.message });
      await adm.from('profiles').update({ archived_at: now }).eq('id', id);
      return j({ ok: true });
    }
    if (act === 'restore') {
      if (!prof.blocked_at) { const { error } = await ban(false); if (error) return j({ ok: false, error: error.message }); }
      await adm.from('profiles').update({ archived_at: null }).eq('id', id);
      return j({ ok: true });
    }
    return j({ ok: false, error: 'action: invite, block, unblock, archive, restore' }, 400);
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) });
  }
});
