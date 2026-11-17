// ИИ-помощник кабинета ESEP. Отвечает на вопросы о работе с кабинетом и по данным, которые видит сам пользователь (RLS).
// Секреты: OPENAI_API_KEY (обязательно), OPENAI_MODEL (необязательно, по умолчанию gpt-4o-mini).
// Доступ и дневной лимит — таблица ai_access (ai_take занимает одно обращение). Вызов: { messages: [{role:'user'|'assistant', content}] }.
// В модель НЕ передаются: логины порталов, телефоны и e-mail, номера счетов (ИИК), адрес 1С, Chat ID. Паролей в кабинете нет вообще.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const KEY = Deno.env.get('OPENAI_API_KEY') || '';
const MODEL = Deno.env.get('OPENAI_MODEL') || 'gpt-4o-mini';
const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const kzToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const REGIME: Record<string, string> = { general: 'общеустановленный', simplified: 'упрощённая декларация', retail: 'розничный налог', self_employed: 'самозанятый', farm: 'для крестьянских (фермерских) хозяйств', other: 'другой' };

const GUIDE = `Кабинет ESEP (esepx.kz/cabinet) — кабинет бухгалтера: фирмы, роботы и их отчёты, задачи, реквизиты.
Страницы и ссылки (ссылка — это часть адреса после #):
- #firms — «Мои фирмы»: список фирм, группы фирм, блок «Что осталось сделать», порог НДС, кнопки «+ Добавить фирму» и «Загрузить списком».
- #runall — «Запуск и отчёты»: запустить робота сразу по нескольким фирмам (отметить фирмы или группу → «Запустить по отмеченным фирмам»), распечатать отчёты по всем фирмам.
- #people — «Люди моих фирм»: кто имеет доступ к каким фирмам, приглашения.
- #req — «Реквизиты»: все фирмы одной таблицей; кнопки тем («Банк», «ЭЦП», «Енбек»…) показывают нужные столбцы, поиск по всему содержимому, сортировка по заголовку, нажатие на строку открывает карточку реквизитов. Там же кнопка «Скачать шаблон для паролей».
- #history — «История»: журнал действий.
- #profile — «Профиль»: имя, пароль, уведомления в Telegram (Chat ID), помощник для открытия документов в программе 1С.
- #f-<id фирмы> — фирма, вкладка «Роботы и отчёты»: карточки роботов, последний отчёт, кнопка запуска.
- #f-<id фирмы>/feed — «Сообщения» фирмы: все отчёты роботов, галочки «отработано».
- #f-<id фирмы>/team — «Настройки фирмы»: профиль (наименование, БИН, режим, НДС, работники, адрес облачной 1С, приостановка отчётности, Telegram-чат), реквизиты, налоговая отчётность.
- #f-<id фирмы>/team/robots — подключение и отключение роботов фирмы. #f-<id фирмы>/team/people — люди фирмы и приглашения.
Задачи: кнопка «Задачи» в верхнем меню (или панель справа на широком экране). «+ Задача» — название, исполнитель, срок, фирмы, повтор, шаблоны. Задача по нескольким фирмам закрывается галочками по фирмам. В задаче «Разноска выписок банка» у фирмы с несколькими счетами пункты — по счетам.
Роботы: «Счета на оплату», «Доверенности», «Расчёты с контрагентами (Дт/Кт)», «Диагностика поступлений и реализаций» (сначала синхронизация 1С с ИС ЭСФ на ноутбуке, потом отчёт), «Мониторинг кабинета налогоплательщика» (лицевые счета, уведомления, сдача отчётности), «Статистика». Отметки «отработано» сбрасываются при каждой новой проверке.
Пароли в кабинете не хранятся — только логины; для паролей есть шаблон Excel, который хранится на компьютере пользователя.
Права: менять профиль фирмы может владелец; реквизиты — владелец, главный бухгалтер, сопровождение; оператор 1С и руководитель смотрят.`;

const SYSTEM = (today: string) => `Ты — помощник в кабинете ESEP для бухгалтера. Сегодня ${today} (Казахстан). Отвечай по-русски, коротко и по делу, без вступлений.
Правила:
1. Отвечай только по справке о кабинете и по данным пользователя ниже. Если нужных данных нет — так и скажи и подскажи, где их посмотреть или заполнить. Ничего не выдумывай: ни цифр, ни дат, ни названий.
2. Когда советуешь что-то сделать или посмотреть, давай ссылку на нужную страницу в виде [название](#ссылка), например [Реквизиты](#req) или [ИП Пример — сообщения](#f-<id>/feed). Используй только ссылки из справки; id фирмы бери из данных.
3. Перечисления — списком, по одной фирме в строке. Даты — в виде ДД.ММ.ГГГГ.
4. По налогам и законам давай только то, что следует из данных кабинета; на общие вопросы о законодательстве отвечай осторожно и советуй проверить по первоисточнику.
5. Паролей, логинов, телефонов и номеров счетов у тебя нет — если спрашивают, скажи, что они смотрятся в карточке реквизитов или в личном шаблоне.`;

// что видит пользователь (его правами) — сжато, без логинов, контактов и номеров счетов
async function context(sb: any) {
  const [{ data: firms }, { data: tasks }, { data: auto }, { data: todo }, { data: evs }] = await Promise.all([
    sb.from('companies').select('id,name,full_name,bin,tax_regime,vat_payer,has_employees,eds_valid_until,reports_suspended,reports_suspended_until,onec_url,requisites,company_tax_forms(form_code,off),company_robots(status,enabled,robots(name))').is('archived_at', null).order('name'),
    sb.rpc('my_tasks'), sb.rpc('my_auto_tasks'), sb.rpc('my_todo'),
    sb.from('events').select('company_id,title,body,severity,created_at').eq('status', 'new').is('superseded_at', null).order('created_at', { ascending: false }).limit(60),
  ]);
  const name: Record<string, string> = {};
  const F = (firms || []).map((f: any) => {
    name[f.id] = f.name; const q = f.requisites || {}, v = q.f || {};
    const o: any = { id: f.id, фирма: f.name };
    if (f.full_name && f.full_name !== f.name) o.полное = f.full_name;
    if (f.bin) o.бин = f.bin;
    if (f.tax_regime) o.режим = REGIME[f.tax_regime] || f.tax_regime;
    if (f.vat_payer != null) o.ндс = f.vat_payer ? 'плательщик' : 'нет';
    if (f.has_employees != null) o.работники = f.has_employees ? 'есть' : 'нет';
    if (f.eds_valid_until) o.эцп_до = f.eds_valid_until;
    if (f.reports_suspended) o.отчётность = 'приостановлена' + (f.reports_suspended_until ? ' до ' + f.reports_suspended_until : '');
    o['1с'] = f.onec_url ? 'облачная, адрес указан' : 'адрес не указан';
    const forms = (f.company_tax_forms || []).filter((x: any) => !x.off).map((x: any) => x.form_code); if (forms.length) o.формы = forms.join(', ');
    const rb = (f.company_robots || []).filter((x: any) => x.status === 'active' && x.enabled && x.robots).map((x: any) => x.robots.name); if (rb.length) o.роботы = rb;
    const r: any = {};
    for (const k of ['kgd', 'kgd2', 'reg_date', 'kbe', 'addr_legal', 'addr_fact', 'vat_date', 'dir_name', 'dir_pos', 'acc_name', 'notes']) if (v[k]) r[k] = v[k];
    if ((q.oked || []).length) r.окэд = q.oked.map((x: any) => (x || []).filter(Boolean).join(' '));
    if ((q.banks || []).length) r.банки = q.banks.map((x: any) => [x[0], x[5], x[3] ? 'основной' : ''].filter(Boolean).join(' '));
    if ((q.kkm || []).length) r.ккм = q.kkm.map((x: any) => (x || []).filter(Boolean).join(', '));
    const ports = [...Object.keys(q.portals || {}), ...(q.portals_x || []).map((x: any) => x[0])].filter(Boolean); if (ports.length) r.порталы_есть_доступ = ports;
    if ((q.extra || []).length) r.свои_поля = q.extra.map((x: any) => (x[0] || '') + ': ' + (x[1] || ''));
    if (Object.keys(r).length) o.реквизиты = r;
    return o;
  });
  const T = (tasks || []).filter((t: any) => t.status !== 'done').map((t: any) => ({ задача: t.title, срок: t.due || null, время: t.due_time || undefined, статус: t.status, исполнитель: t.assignee, поставил: t.creator,
    фирмы: (t.firms || []).map((x: any) => x.name + (x.done ? ' ✓' : '')) }));
  const A = (auto || []).map((a: any) => ({ задача_от_кабинета: a.title, пункты: (a.items || []).map((i: any) => [i.name, i.label, i.due ? 'до ' + i.due : '', i.done ? '✓' : 'не сделано'].filter(Boolean).join(' · ')) }));
  const E = (evs || []).map((e: any) => ({ фирма: name[e.company_id] || '', id: e.company_id, дата: String(e.created_at).slice(0, 10), отчёт: e.title, текст: String(e.body || '').slice(0, 300) }));
  let s = JSON.stringify({ фирмы: F, мои_задачи: T, задачи_от_кабинета: A, осталось_сделать_по_роботам: todo || [], новые_отчёты_роботов: E });
  if (s.length > 60000) s = JSON.stringify({ фирмы: F, мои_задачи: T, задачи_от_кабинета: A, осталось_сделать_по_роботам: todo || [], новые_отчёты_роботов: E.slice(0, 15) }).slice(0, 60000);
  return s;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const { data: me } = await sb.auth.getUser();
    if (!me?.user) return j({ ok: false, error: 'Войдите в кабинет' }, 401);
    const p = await req.json().catch(() => ({} as any));
    const msgs = (Array.isArray(p.messages) ? p.messages : []).filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-10).map((m: any) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return j({ ok: false, error: 'Напишите вопрос' }, 400);
    if (!KEY) return j({ ok: false, need_setup: true, error: 'Помощник ещё не подключён: в секретах сервера нет ключа OPENAI_API_KEY.' });
    const { data: take, error: te } = await adm.rpc('ai_take', { p_user: me.user.id });
    if (te) return j({ ok: false, error: te.message });
    if (!take?.ok) return j({ ok: false, error: take?.error || 'Нет доступа', used: take?.used, limit: take?.limit });
    const ctx = await context(sb);
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM(kzToday()) + '\n\nСПРАВКА О КАБИНЕТЕ:\n' + GUIDE + '\n\nДАННЫЕ ПОЛЬЗОВАТЕЛЯ (JSON):\n' + ctx }, ...msgs] }) });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) return j({ ok: false, error: 'Модель ответила ошибкой: ' + String(d?.error?.message || r.status).slice(0, 300), used: take.used, limit: take.limit });
    const answer = String(d?.choices?.[0]?.message?.content || '').trim();
    return j({ ok: true, answer: answer || 'Модель не дала ответа — попробуйте переформулировать вопрос.', used: take.used, limit: take.limit });
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) });
  }
});
