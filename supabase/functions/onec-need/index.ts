// «Нужен доступ к 1С»: перед работой автоматизация проверяет, открыты ли в OData базы фирмы нужные ей объекты 1С.
// Нет — пользователь видит «администратор получил сообщение», администраторам ESEP уходит сообщение в Telegram,
// в «Управлении» появляется строка; после «✓ Отработано» (с повторной проверкой базы) фирме приходит сообщение «Готово».
// verify_jwt выключен: доступ проверяется внутри.
//   check  { company_id, feature }          — участник фирмы (или администратор): { ok, missing: [{set, label}], issue_id? }
//   robots { company_id, codes: [] }        — проверка при подключении роботов (участник фирмы)
//   done   { issue_id, force? }              — администратор: повторная проверка и «Готово»
// Сервер (x-server-key): check / robots — так же, без «кто ждёт»; dry: true — только проверить, без заявки и сообщений.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-server-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const USER = Deno.env.get('ONEC_USER') || '', PASS = Deno.env.get('ONEC_PASSWORD') || '', TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const SITE = 'https://esepx.kz/cabinet/';
function basic() { const b = new TextEncoder().encode(USER + ':' + PASS); let s = ''; b.forEach((x) => (s += String.fromCharCode(x))); return 'Basic ' + btoa(s); }

// что нужно каждой автоматизации (имена объектов OData). any — достаточно одного из списка.
type Need = { name: string; sets: string[]; any?: string[][] };
const NEEDS: Record<string, Need> = {
  inv: { name: 'Счета от поставщиков', sets: ['Catalog_Контрагенты', 'Catalog_ДоговорыКонтрагентов', 'Catalog_Номенклатура', 'Catalog_НоменклатурныеГруппы', 'Catalog_ВидыНоменклатуры', 'Catalog_КлассификаторЕдиницИзмерения', 'Catalog_СтавкиНДС', 'Catalog_БанковскиеСчета', 'Catalog_Банки', 'Catalog_Организации', 'Catalog_Пользователи', 'ChartOfAccounts_Типовой', 'Document_СчетНаОплатуПоставщика'] },
  inv_pp: { name: 'Счета от поставщиков — платёжное поручение', sets: ['Document_ПлатежноеПоручениеИсходящее'] },
  inv_poa: { name: 'Счета от поставщиков — доверенность', sets: ['Document_Доверенность', 'Catalog_ФизическиеЛица', 'Catalog_СотрудникиОрганизаций', 'InformationRegister_КонтактнаяИнформация', 'Catalog_ВидыКонтактнойИнформации'],
    any: [['InformationRegister_ДокументыФизическихЛиц', 'InformationRegister_ПаспортныеДанныеФизЛиц', 'InformationRegister_ПаспортныеДанныеФизическихЛиц', 'InformationRegister_УдостоверенияЛичностиФизЛиц']] },
  akt: { name: 'Акты сверки', sets: ['AccountingRegister_Типовой', 'Catalog_Контрагенты', 'Catalog_Организации'] },
  akt_make: { name: 'Акты сверки — создание акта в 1С', sets: ['Document_АктСверкиВзаиморасчетов'] },
  bank: { name: 'Выписки банка', sets: ['Catalog_Контрагенты', 'Catalog_ДоговорыКонтрагентов', 'Catalog_БанковскиеСчета', 'Catalog_Банки', 'Catalog_Пользователи', 'Catalog_СтатьиДвиженияДенежныхСредств', 'AccountingRegister_Типовой', 'ChartOfAccounts_Типовой',
    'Document_ПлатежныйОрдерСписаниеДенежныхСредств', 'Document_ПлатежныйОрдерПоступлениеДенежныхСредств', 'Document_ПлатежноеПоручениеИсходящее', 'Document_ПлатежноеПоручениеВходящее'] },
  // роботы по расписанию (сервер), проверка при подключении
  unpaid_invoices: { name: 'Неоплаченные счета на оплату', sets: ['Document_СчетНаОплатуПокупателю', 'InformationRegister_СтатусыДокументов', 'Catalog_Контрагенты', 'Document_ПлатежноеПоручениеВходящее', 'Document_ПлатежныйОрдерПоступлениеДенежныхСредств', 'Document_ПриходныйКассовыйОрдер', 'Document_РеализацияТоваровУслуг'] },
  powers_of_attorney: { name: 'Доверенности под контролем', sets: ['Document_Доверенность', 'Document_ПоступлениеТоваровУслуг', 'Document_ЭСФ', 'Document_СчетНаОплатуПоставщика', 'Catalog_ДоговорыКонтрагентов', 'Catalog_Контрагенты', 'Catalog_Номенклатура'] },
  counterparty_debts: { name: 'Расчёты с контрагентами', sets: ['AccountingRegister_Типовой', 'ChartOfAccounts_Типовой', 'Catalog_Контрагенты'] },
  esf_diagnostics: { name: 'Диагностика поступлений и реализаций', sets: ['Catalog_Контрагенты', 'Document_ПоступлениеТоваровУслуг', 'Document_РеализацияТоваровУслуг', 'Document_СНТ', 'Document_Сторнирование', 'Document_СчетФактураВыданный', 'Document_ЭСФ', 'Document_ЭлектронныйАктВыполненныхРабот', 'InformationRegister_СчетаФактурыПрекратившиеДействие', 'AccountingRegister_Типовой', 'ChartOfAccounts_Типовой'] },
};
// как объект называется в «Настройке стандартного интерфейса OData»
const KIND: Record<string, string> = { Catalog: 'Справочники', Document: 'Документы', InformationRegister: 'Регистры сведений', AccumulationRegister: 'Регистры накопления', AccountingRegister: 'Регистры бухгалтерии', ChartOfAccounts: 'Планы счетов' };
const label = (s: string) => { const [k, ...n] = s.split('_'); const nm = n.join('_').replace(/([а-яё])([А-ЯЁ])/g, '$1 $2').replace(/([А-ЯЁ])([А-ЯЁ][а-яё])/g, '$1 $2'); return (KIND[k] || k) + ' → ' + nm.charAt(0) + nm.slice(1).toLowerCase(); };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!, db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const sbUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const p = await req.json().catch(() => ({} as any)), act = String(p.action || '');
    let srv = false, uid: string | null = null, adm = false;
    const skey = req.headers.get('x-server-key') || '';
    if (skey) { const { data: ok } = await db.rpc('server_robot_key_ok', { p_key: skey }); if (!ok) return j({ ok: false, error: 'Нет доступа' }, 401); srv = true; }
    else { const { data: u } = await sbUser.auth.getUser(); if (!u || !u.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401); uid = u.user.id; const { data: a } = await sbUser.rpc('am_i_admin'); adm = !!a; }

    // список объектов OData базы (кэш 6 часов; fresh — заново)
    const metaOf = async (f: any, fresh = false): Promise<string[] | null> => {
      if (!fresh) { const { data: c } = await db.from('onec_meta').select('sets,at').eq('company_id', f.id).maybeSingle(); if (c && Date.now() - Date.parse(c.at) < 6 * 3600e3 && c.sets.length) return c.sets; }
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
      try {
        const r = await fetch(String(f.onec_url).replace(/\/+$/, '') + '/odata/standard.odata/$metadata', { headers: { Authorization: basic() }, signal: ctl.signal });
        if (r.status !== 200) return null;
        const sets = [...new Set([...(await r.text()).matchAll(/EntitySet Name="([^"]+)"/g)].map((x) => x[1]))];
        await db.from('onec_meta').upsert({ company_id: f.id, sets, at: new Date().toISOString() });
        return sets;
      } catch { return null; } finally { clearTimeout(t); }
    };
    const missingOf = (sets: string[], need: Need) => { const S = new Set(sets), m = need.sets.filter((x) => !S.has(x)); (need.any || []).forEach((g) => { if (!g.some((x) => S.has(x))) m.push(g[0]); }); return m; };
    const tgAdmins = async (text: string) => {
      if (!TOKEN) return;
      const { data: ads } = await db.from('platform_admins').select('user_id'); const ids = (ads || []).map((a: any) => a.user_id); if (!ids.length) return;
      const { data: ps } = await db.from('profiles').select('telegram_chat_id').in('id', ids).not('telegram_chat_id', 'is', null);
      for (const pr of ps || []) { const c = String(pr.telegram_chat_id || '').trim(); if (!c) continue;
        await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c, text: text.slice(0, 3900) + '\n\n' + SITE + '#admin', disable_web_page_preview: true }) }).catch(() => null); }
    };
    // заявка администратору: одна открытая на фирму и автоматизацию; ждущие пользователи добавляются
    const report = async (f: any, feature: string, missing: string[]) => {
      const need = NEEDS[feature];
      const { data: ex } = await db.from('onec_issues').select('id,missing,waiting').eq('company_id', f.id).eq('feature', feature).eq('status', 'open').maybeSingle();
      if (ex) {
        const waiting = uid && !ex.waiting.includes(uid) ? [...ex.waiting, uid] : ex.waiting, changed = missing.join('|') !== (ex.missing || []).join('|');
        await db.from('onec_issues').update({ missing, waiting, updated_at: new Date().toISOString() }).eq('id', ex.id);
        if (changed) await tgAdmins('🔑 Нужен доступ к 1С (обновлено)\nФирма: ' + f.name + '\nАвтоматизация: ' + need.name + '\nОткрыть в «Настройке стандартного интерфейса OData»:\n' + missing.map((x) => '• ' + label(x)).join('\n'));
        return ex.id;
      }
      const { data: ins } = await db.from('onec_issues').insert({ company_id: f.id, feature, feature_name: need.name, missing, waiting: uid ? [uid] : [] }).select('id').single();
      let who = ''; if (uid) { const { data: pr } = await db.from('profiles').select('full_name').eq('id', uid).maybeSingle(); who = pr?.full_name || ''; }
      await tgAdmins('🔑 Нужен доступ к 1С\nФирма: ' + f.name + '\nАвтоматизация: ' + need.name + (who ? '\nЖдёт: ' + who : '') + '\nОткрыть в 1С: Администрирование → Настройка стандартного интерфейса OData:\n' + missing.map((x) => '• ' + label(x)).join('\n') + '\nКогда откроете — отметьте «Отработано» в «Управлении».');
      return ins?.id || null;
    };
    const firmOf = async (id: string) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      if (!srv && !adm) { const { data: mine } = await sbUser.from('companies').select('id').eq('id', id).maybeSingle(); if (!mine) return null; }   // участник фирмы (RLS)
      const { data: f } = await db.from('companies').select('id,name,onec_url').eq('id', id).maybeSingle(); return f;
    };

    if (act === 'check' || act === 'robots') {
      const f = await firmOf(String(p.company_id || '')); if (!f) return j({ ok: false, error: 'Нет доступа к фирме' }, 403);
      if (!f.onec_url) return j({ ok: true, skip: true, missing: [] });
      const feats = act === 'check' ? [String(p.feature || '')] : (Array.isArray(p.codes) ? p.codes.map(String) : []).filter((c: string) => NEEDS[c]);
      if (act === 'check' && !NEEDS[feats[0]]) return j({ ok: false, error: 'Неизвестная автоматизация' }, 400);
      const sets = await metaOf(f); if (!sets) return j({ ok: true, skip: true, missing: [], note: '1С не ответила — проверка пропущена' });
      const out: any[] = [];
      for (const ft of feats) {
        let miss = missingOf(sets, NEEDS[ft]);
        if (miss.length) { const fresh = await metaOf(f, true); if (fresh) miss = missingOf(fresh, NEEDS[ft]); }   // кэш мог устареть — проверить заново
        if (miss.length) out.push({ feature: ft, name: NEEDS[ft].name, missing: miss.map((x) => ({ set: x, label: label(x) })), issue_id: p.dry && srv ? null : await report(f, ft, miss) });
      }
      if (act === 'check') return j({ ok: true, missing: out[0]?.missing || [], issue_id: out[0]?.issue_id || null });
      return j({ ok: true, robots: out });
    }

    if (act === 'done') {
      if (!adm) return j({ ok: false, error: 'Только для администратора ESEP' }, 403);
      const { data: is } = await db.from('onec_issues').select('*').eq('id', String(p.issue_id || '')).maybeSingle(); if (!is) return j({ ok: false, error: 'Заявка не найдена' });
      if (is.status === 'done') return j({ ok: true, already: true });
      const { data: f } = await db.from('companies').select('id,name,onec_url').eq('id', is.company_id).maybeSingle();
      const sets = f ? await metaOf(f, true) : null, miss = sets ? missingOf(sets, NEEDS[is.feature] || { name: '', sets: is.missing }) : is.missing;
      if (!p.force && sets && miss.length) return j({ ok: false, still: miss.map((x: string) => ({ set: x, label: label(x) })), error: 'В 1С ещё закрыто: ' + miss.map(label).join('; ') });
      await db.from('onec_issues').update({ status: 'done', done_at: new Date().toISOString(), done_by: uid, missing: miss, updated_at: new Date().toISOString() }).eq('id', is.id);
      // сообщение фирме: «Готово» (уходит и в Telegram получателям, как другие сообщения)
      await db.from('events').insert({ company_id: is.company_id, title: 'Доступ к 1С открыт — «' + is.feature_name + '» снова работает', body: 'Администратор ESEP открыл в 1С всё, что нужно для «' + is.feature_name + '». Можно продолжать работу.', severity: 'info', status: 'new' });
      return j({ ok: true });
    }
    return j({ ok: false, error: 'Неизвестное действие' }, 400);
  } catch (e) { return j({ ok: false, error: (e as Error).message || 'Ошибка' }); }
});
