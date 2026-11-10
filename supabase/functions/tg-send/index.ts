// Telegram из кабинета ESEP через бота (Bot API — бесплатно). Секрет: TELEGRAM_BOT_TOKEN.
// Пользователь (Authorization: его вход в кабинет):
//   test                          — тестовое сообщение себе (проверка Chat ID);
//   event {event_id, pdf?, name?} — отчёт себе: короткое сообщение + PDF (pdf — base64, до 15 МБ).
// Сервер (x-server-key, триггер на новое сообщение робота): notify {event_id} — всем людям фирмы,
//   у кого в профиле включены уведомления и указан Chat ID и кому доступен этот робот (кроме заблокированных и архивных),
//   и в чат фирмы (companies.telegram_chat_id), если в профиле фирмы стоит галочка telegram_notify.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const esc = (t: string) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SITE = 'https://esepx.kz/cabinet/';

function tgError(d: any) {
  const m = String(d?.description || '');
  if (/chat not found/i.test(m)) return 'Telegram не нашёл этот Chat ID. Проверьте число и нажмите «Старт» у бота ESEP в Telegram.';
  if (/bot was blocked/i.test(m)) return 'Бот ESEP заблокирован в вашем Telegram — разблокируйте его и попробуйте ещё раз.';
  if (/unauthorized/i.test(m)) return 'Токен бота не подходит — проверьте секрет TELEGRAM_BOT_TOKEN.';
  return 'Telegram ответил ошибкой: ' + (m || 'неизвестно');
}
async function sendText(chat: string, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(tgError(d));
}
async function sendDoc(chat: string, bytes: Uint8Array, name: string, caption: string) {
  const fd = new FormData();
  fd.append('chat_id', chat); fd.append('caption', caption); fd.append('parse_mode', 'HTML');
  fd.append('document', new Blob([bytes], { type: 'application/pdf' }), name);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(tgError(d));
}
// короткое сообщение об отчёте: фирма, заголовок, начало текста, ссылка в кабинет
function shortText(firm: any, ev: any, max = 900) {
  let body = String(ev.body || '').replace(/\r/g, '').trim();
  if (body.length > max) body = body.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return '🏢 <b>' + esc(firm?.name || '') + '</b>\n' + esc(ev.title || '') + (body ? '\n\n' + esc(body) : '') + '\n\n<a href="' + SITE + '#f-' + ev.company_id + '">Открыть в кабинете ESEP</a>';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const p = await req.json().catch(() => ({} as any));
    if (!TOKEN) return j({ ok: false, need_setup: true, error: 'Бот Telegram ещё не подключён к кабинету (нет секрета TELEGRAM_BOT_TOKEN).' });

    // ---- сервер: уведомление о новом сообщении робота
    const skey = req.headers.get('x-server-key') || '';
    if (skey) {
      const { data: ok } = await adm.rpc('server_robot_key_ok', { p_key: skey });
      if (!ok) return j({ ok: false, error: 'Нет доступа' }, 401);
      const { data: ev } = await adm.from('events').select('id,company_id,robot_id,title,body,status').eq('id', String(p.event_id || '')).maybeSingle();
      if (!ev || ev.status !== 'new') return j({ ok: true, sent: 0 });
      const { data: firm } = await adm.from('companies').select('name,telegram_chat_id,telegram_notify').eq('id', ev.company_id).maybeSingle();
      const { data: mem } = await adm.from('memberships').select('user_id,role,robot_ids').eq('company_id', ev.company_id);
      // человеку — только отчёты его роботов (владелец и «все роботы» — всё)
      const ids = (mem || []).filter((m: any) => m.role === 'owner' || !m.robot_ids || !ev.robot_id || m.robot_ids.includes(ev.robot_id)).map((m: any) => m.user_id);
      // куда слать: чат фирмы (если включён в профиле фирмы) + личные чаты людей фирмы; один чат — одно сообщение
      const chats = new Set<string>();
      if (firm?.telegram_notify && String(firm.telegram_chat_id || '').trim()) chats.add(String(firm.telegram_chat_id).trim());
      if (ids.length) {
        const { data: ps } = await adm.from('profiles').select('id,telegram_chat_id').in('id', ids).eq('telegram_notify', true).is('blocked_at', null).is('archived_at', null).not('telegram_chat_id', 'is', null);
        (ps || []).forEach((pr: any) => { const c = String(pr.telegram_chat_id || '').trim(); if (c) chats.add(c); });
      }
      let sent = 0; const errs: string[] = [];
      for (const c of chats) { try { await sendText(c, shortText(firm, ev, 600)); sent++; } catch (e) { errs.push((e as Error).message); } }
      return j({ ok: true, sent, errors: errs });
    }

    // ---- пользователь
    const sbUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const { data: me } = await sbUser.auth.getUser();
    if (!me?.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
    const { data: prof } = await adm.from('profiles').select('telegram_chat_id').eq('id', me.user.id).maybeSingle();
    const chat = String(prof?.telegram_chat_id || '').trim();
    if (!chat) return j({ ok: false, need_chat: true, error: 'Укажите свой Chat ID в профиле — раздел «Уведомления в Telegram».' });

    if (p.action === 'test') {
      await sendText(chat, '✅ Telegram подключён к кабинету ESEP. Сюда будут приходить отчёты и уведомления роботов.');
      return j({ ok: true });
    }
    if (p.action === 'event') {
      // доступ к отчёту проверяем правами самого пользователя (RLS)
      const { data: ev } = await sbUser.from('events').select('id,company_id,title,body').eq('id', String(p.event_id || '')).maybeSingle();
      if (!ev) return j({ ok: false, error: 'Отчёт не найден или нет доступа' }, 404);
      const { data: firm } = await adm.from('companies').select('name').eq('id', ev.company_id).maybeSingle();
      const text = shortText(firm, ev);
      if (p.pdf) {
        const b64 = String(p.pdf).replace(/^data:[^,]*,/, '');
        if (b64.length > 20_000_000) return j({ ok: false, error: 'PDF больше 15 МБ — отправьте с отбором поменьше' }, 413);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const name = String(p.name || 'ESEP.pdf').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120);
        if (text.length <= 1000) await sendDoc(chat, bytes, name, text);
        else { await sendText(chat, text); await sendDoc(chat, bytes, name, '📎 ' + esc(ev.title || 'Отчёт')); }
      } else await sendText(chat, text);
      return j({ ok: true });
    }
    return j({ ok: false, error: 'action: test или event' }, 400);
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) });
  }
});
