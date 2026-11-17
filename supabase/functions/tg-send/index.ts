// Telegram из кабинета ESEP через бота (Bot API — бесплатно). Секрет: TELEGRAM_BOT_TOKEN.
// Пользователь (Authorization: его вход в кабинет):
//   test                          — тестовое сообщение себе (проверка Chat ID);
//   event {event_id, pdf?, name?} — отчёт себе: короткое сообщение + PDF (pdf — base64, до 15 МБ).
// Сервер (x-server-key, триггер на новое сообщение робота): notify {event_id} — всем людям фирмы,
//   у кого в профиле включены уведомления и указан Chat ID и кому доступен этот робот (кроме заблокированных и архивных),
//   и в чат фирмы (companies.telegram_chat_id), если в профиле фирмы стоит галочка telegram_notify.
// Сервер: {admin_text} — служебное сообщение администраторам ESEP (у кого в профиле указан Chat ID).
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

// подробности отчёта прямо в сообщении — чтобы не заходить в кабинет: кто именно, какой КБК и ОГД, какое уведомление и от какого числа
const dmy = (iso: string) => /^\d{4}-\d{2}-\d{2}/.test(iso || '') ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : String(iso || '');
const sum2 = (v: number) => Math.abs(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₸';
// длинный регистрационный номер ЭСФ в сообщении не нужен: берём короткий номер из скобок, иначе только дату
const nshort = (n: any) => { const t = String(n || '').trim(); if (t.length <= 20) return t; const m = t.match(/\(([^)]+)\)\s*$/); return m ? m[1] : ''; };
function detailLines(ev: any): string[] {
  const d = ev.details || {}; const L: string[] = [];
  if (d.kind === 'diag') {
    for (const c of d.checks || []) {
      if (!c.count) continue;
      L.push('✍️ <b>' + esc(c.title) + ': ' + c.count + '</b>');
      // по каждому контрагенту — номера и даты документов (старые первыми)
      const by = new Map<string, any[]>();
      (c.items || []).forEach((i: any) => { const n = String(i.contractor || 'Без контрагента'); if (!by.has(n)) by.set(n, []); by.get(n)!.push(i); });
      const arr = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
      arr.slice(0, 10).forEach(([n, docs]) => {
        const ds = docs.slice().sort((a: any, b: any) => String(a.date || '').localeCompare(String(b.date || '')));
        const txt = ds.slice(0, 5).map((x: any) => (nshort(x.number) ? '№ ' + esc(nshort(x.number)) + ' ' : '') + (x.date ? 'от ' + dmy(x.date) : '')).filter((t: string) => t.trim()).join('; ');
        L.push('   • ' + esc(n) + (txt ? ' — ' + txt : '') + (ds.length > 5 ? ' и ещё ' + (ds.length - 5) : (!txt && ds.length > 1 ? ' — ' + ds.length : '')));
      });
      const shown = arr.slice(0, 10).reduce((t, x) => t + x[1].length, 0);
      if (c.count > shown) L.push('   … и ещё ' + (c.count - shown));
    }
    const items = (d.esf && d.esf.items) || [], today = String(d.date || '');
    const grp = (title: string, list: any[], word: string) => {
      if (!list.length) return;
      L.push(title + ': ' + list.length + '</b>');
      list.slice(0, 10).forEach((x: any) => L.push('   • ' + esc(x.contractor || 'Без контрагента') + ' — ' + esc(x.type || 'документ') + ' № ' + esc(x.number || '') + ' от ' + dmy(x.date) + ', ' + word + ' ' + dmy(x.deadline)));
      if (list.length > 10) L.push('   … и ещё ' + (list.length - 10));
    };
    grp('⏰ <b>Просрочено ЭСФ', items.filter((x: any) => String(x.deadline) < today), 'срок был');
    grp('📤 <b>Отправить ЭСФ', items.filter((x: any) => String(x.deadline) >= today), 'срок до');
  } else if (d.kind === 'ls_balances') {
    for (const r of d.rows || []) {
      const parts: string[] = [];
      ([['tax', 'налог'], ['pen', 'пеня'], ['fine', 'штраф'], ['pct', 'проценты']] as [string, string][]).forEach(([k, w]) => { const v = Number(r[k]) || 0; if (v < 0) parts.push(w + ' ' + sum2(v)); });
      if (parts.length) L.push('• <b>КБК ' + esc(r.kbk || '') + '</b> ' + esc(r.name || '') + (r.ogd ? ' · ОГД ' + esc(r.ogd) : '') + ': долг — ' + parts.join('; '));
    }
  } else if (d.kind === 'kn_check') {
    for (const i of d.items || []) {
      const st = String(i.status || ''), due = String(i.due || '');
      L.push('• ' + esc(i.title || '') + (i.delivered ? ' — от ' + esc(i.delivered) : '') + (st && st !== 'новые' ? ' · ' + esc(st) : '') + (due && due !== '—' ? ' · срок ' + esc(due) : ''));
    }
  }
  return L;
}
function notifyText(firm: any, ev: any) {
  const head = '🏢 <b>' + esc(firm?.name || '') + '</b>\n' + esc(ev.title || '');
  const tail = '\n\n<a href="' + SITE + '#f-' + ev.company_id + '">Открыть в кабинете ESEP</a>';
  const det = detailLines(ev);
  if (!det.length) return shortText(firm, ev, 600);
  // у диагностики текст отчёта повторяет подробности — берём подробности; у остальных — короткий итог и расшифровку
  let body = (ev.details && ev.details.kind === 'diag') ? '' : String(ev.body || '').replace(/\r/g, '').trim();
  if (body.length > 400) body = body.slice(0, 400).replace(/\s+\S*$/, '') + '…';
  let out = head + (body ? '\n\n' + esc(body) : '') + '\n';
  for (let k = 0; k < det.length; k++) {
    if (out.length + det[k].length + tail.length > 3800) { out += '\n… полностью — в кабинете'; break; }
    out += '\n' + det[k];
  }
  return out + tail;
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
      // служебное сообщение администраторам ESEP
      if (p.admin_text) {
        const { data: ads } = await adm.from('platform_admins').select('user_id');
        const aids = (ads || []).map((a: any) => a.user_id);
        const achats = new Set<string>();
        if (aids.length) {
          const { data: ps } = await adm.from('profiles').select('telegram_chat_id').in('id', aids).not('telegram_chat_id', 'is', null);
          (ps || []).forEach((pr: any) => { const c = String(pr.telegram_chat_id || '').trim(); if (c) achats.add(c); });
        }
        let text = esc(String(p.admin_text));
        if (text.length > 3900) text = text.slice(0, 3890) + '…';
        let sent = 0; const errs: string[] = [];
        for (const c of achats) { try { await sendText(c, text + '\n\n<a href="' + SITE + '">Кабинет ESEP</a>'); sent++; } catch (e) { errs.push((e as Error).message); } }
        return j({ ok: true, sent, errors: errs });
      }
      const { data: ev } = await adm.from('events').select('id,company_id,robot_id,title,body,status,details').eq('id', String(p.event_id || '')).maybeSingle();
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
      for (const c of chats) { try { await sendText(c, notifyText(firm, ev)); sent++; } catch (e) { errs.push((e as Error).message); } }
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
