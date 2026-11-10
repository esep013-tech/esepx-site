// Управление пользователями (только администратор ESEP):
// invite {email, name?} — пригласить по почте (письмо со ссылкой: кабинет открывает «Завершите регистрацию» с именем и почтой);
// block {user_id, reason?} / unblock {user_id} — чёрный список (вход запрещён);
// archive {user_id} / restore {user_id} — убрать в архив и восстановить (фирмы, роли и настройки не трогаются);
// delete_preview / delete {user_id} — удалить навсегда (только из архива);
// cancel_invite / reinvite {user_id} — отменить или отправить заново приглашение, по которому ещё не зарегистрировались.
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
      if (ex) { const { data: eu } = await adm.auth.admin.getUserById(ex.id); const eU = eu?.user as any; if (eU && eU.invited_at && !eU.user_metadata?.has_password) return j({ ok: false, error: 'Этому человеку уже отправлено приглашение — он ещё не зарегистрировался. В списке ниже можно «Отправить ещё раз» или «Отменить приглашение».' }); }
      if (ex) return j({ ok: false, error: ex.archived_at ? 'Этот человек в архиве — восстановите его.' : ex.blocked_at ? 'Этот человек в чёрном списке.' : 'Этот человек уже зарегистрирован.' });
      const { error } = await adm.auth.admin.inviteUserByEmail(email, { redirectTo: 'https://esepx.kz/cabinet/?invite=1&e=' + encodeURIComponent(email), data: p.name ? { full_name: String(p.name).slice(0, 100) } : undefined });
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
    // приглашение, по которому ещё не зарегистрировались: отменить или отправить заново (старая ссылка перестаёт работать)
    if (act === 'cancel_invite' || act === 'reinvite') {
      const { data: au } = await adm.auth.admin.getUserById(id);
      const u = au?.user as any;
      if (!u || !u.invited_at || u.user_metadata?.has_password) return j({ ok: false, error: 'Человек уже зарегистрировался — приглашение не отменить' });
      const email = u.email, name = u.user_metadata?.full_name;
      const { error } = await adm.auth.admin.deleteUser(id);
      if (error) return j({ ok: false, error: error.message });
      if (act === 'reinvite') {
        const { error: e2 } = await adm.auth.admin.inviteUserByEmail(email, { redirectTo: 'https://esepx.kz/cabinet/?invite=1&e=' + encodeURIComponent(email), data: name ? { full_name: name } : undefined });
        if (e2) return j({ ok: false, error: 'Не удалось отправить приглашение: ' + e2.message });
      }
      return j({ ok: true });
    }
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
    // удалить навсегда — только из архива. Фирмы, где человек единственный, удаляются вместе с отчётами;
    // фирмы, где есть другие люди, остаются им (владельцем становится следующий по роли).
    if (act === 'delete_preview' || act === 'delete') {
      if (!prof.archived_at) return j({ ok: false, error: 'Удалить навсегда можно только из архива' });
      const { data: own } = await adm.from('companies').select('id,name').eq('owner_id', id);
      const { data: mem } = await adm.from('memberships').select('company_id,user_id,role,created_at').in('company_id', (own || []).map((c: any) => c.id).concat(['00000000-0000-0000-0000-000000000000']));
      const RANK: Record<string, number> = { owner: 0, chief_accountant: 1, manager: 2, operator_1c: 3 };
      const gone: any[] = [], keep: any[] = [];
      for (const c of own || []) {
        const others = (mem || []).filter((m: any) => m.company_id === c.id && m.user_id !== id)
          .sort((x: any, y: any) => (RANK[x.role] ?? 9) - (RANK[y.role] ?? 9) || String(x.created_at).localeCompare(String(y.created_at)));
        if (others.length) keep.push({ ...c, heir: others[0].user_id }); else gone.push(c);
      }
      if (act === 'delete_preview') return j({ ok: true, gone: gone.map((c) => c.name), keep: keep.map((c) => c.name) });
      for (const c of keep) {
        const { error } = await adm.from('companies').update({ owner_id: c.heir }).eq('id', c.id);
        if (error) return j({ ok: false, error: 'Не удалось передать фирму «' + c.name + '»: ' + error.message });
        await adm.from('memberships').update({ role: 'owner' }).eq('company_id', c.id).eq('user_id', c.heir);
      }
      if (gone.length) { const { error } = await adm.from('companies').delete().in('id', gone.map((c) => c.id)); if (error) return j({ ok: false, error: 'Не удалось удалить фирмы: ' + error.message }); }
      const { error } = await adm.auth.admin.deleteUser(id);
      if (error) return j({ ok: false, error: 'Не удалось удалить: ' + error.message });
      return j({ ok: true, gone: gone.length, keep: keep.length });
    }
    return j({ ok: false, error: 'action: invite, block, unblock, archive, restore, delete_preview, delete, cancel_invite, reinvite' }, 400);
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) });
  }
});
