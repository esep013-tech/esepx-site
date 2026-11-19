// ИИ-помощник кабинета ESEP. Отвечает на вопросы о работе с кабинетом и по данным, которые видит сам пользователь (RLS).
// Секреты: OPENAI_API_KEY (обязательно), OPENAI_MODEL (необязательно; иначе по порядку gpt-4.1 → gpt-4o → gpt-4o-mini, какая доступна ключу).
// Доступ и дневной лимит — таблица ai_access (ai_take занимает одно обращение). Вызов: { messages: [{role:'user'|'assistant', content}] }.
// В модель НЕ передаются: логины порталов, телефоны и e-mail, номера счетов (ИИК), адрес 1С, Chat ID. Паролей в кабинете нет вообще.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const KEY = Deno.env.get('OPENAI_API_KEY') || '';
const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const kzToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const REGIME: Record<string, string> = { general: 'общеустановленный', simplified: 'упрощённая декларация', retail: 'розничный налог', self_employed: 'самозанятый', farm: 'для крестьянских (фермерских) хозяйств', other: 'другой' };

const GUIDE = `Кабинет ESEP (esepx.kz/cabinet) — кабинет бухгалтера: фирмы, роботы и их отчёты, задачи, реквизиты.
Страницы и ссылки (ссылка — это часть адреса после #):
- #firms — «Мои фирмы»: список фирм, группы фирм, блок «Что осталось сделать», порог НДС, кнопки «+ Добавить фирму» и «Загрузить списком».
- #runall — «Запуск и отчёты»: запустить робота сразу по нескольким фирмам (отметить фирмы или группу → «Запустить по отмеченным фирмам»), распечатать отчёты по всем фирмам.
- #people — «Люди моих фирм»: кто имеет доступ к каким фирмам, приглашения.
- #req — «Реквизиты»: все фирмы одной таблицей; сверху выбор группы фирм (те же группы, что на «Моих фирмах»); кнопки тем («Банк», «ЭЦП», «Енбек»…) показывают нужные столбцы, поиск по всему содержимому, сортировка по заголовку, нажатие на строку открывает карточку реквизитов. Там же кнопка «Скачать шаблон для паролей» (Excel: одна строка на фирму, у каждого портала столбцы «логин» и «пароль»).
- #history — «История»: журнал действий.
- #news — «Что нового»: история изменений кабинета по датам — что появилось и где это найти. На вопрос «что изменилось в кабинете» давай эту ссылку.
- #profile — «Профиль»: имя, пароль, «Уведомления в Telegram» (мой Chat ID с подсказкой, как его узнать, бот кабинета — @buh_esep_bot; список «Получатели уведомлений»: в какой чат, по каким фирмам — все, группа или отмеченные — и как присылать: каждое сообщение сразу, только важные, утренняя сводка «что требует внимания» и вечерняя «что сделано за день», время каждый задаёт сам; кнопки «Проверить чат», «Утренняя сейчас», «Вечерняя сейчас»), помощник для открытия документов в программе 1С.
- #f-<id фирмы> — фирма, вкладка «Роботы и отчёты»: карточки роботов, последний отчёт, кнопка запуска.
- #f-<id фирмы>/feed — «Сообщения» фирмы: все отчёты роботов, галочки «отработано»; рядом со счётчиком кнопка «Скрыть отмеченные» (действует во всех отчётах). Кнопка «В Telegram» у отчёта присылает его в мой Telegram.
- #f-<id фирмы>/team — «Настройки фирмы»: профиль (наименование, БИН, режим, НДС, работники, адрес облачной 1С, приостановка отчётности), реквизиты, налоговая отчётность.
- #f-<id фирмы>/team/robots — подключение и отключение роботов фирмы. #f-<id фирмы>/team/people — люди фирмы и приглашения.
Задачи: панель «Задачи» справа (на узком экране — кнопка «Задачи» в верхнем меню). «+ Задача» — название, исполнитель, срок, время на задачу, время срока, фирмы, повтор, шаблон; внизу формы «Сохранить как шаблон» (можно поделиться с людьми своих фирм). Вкладки панели: «Мне», «Я поставил(а)», «Повторы и шаблоны» — там все повторяющиеся задачи со сроками (изменить, остановить повтор), свои шаблоны и скрытие ненужных стандартных. Задача по нескольким фирмам закрывается галочками по фирмам. В задаче «Разноска выписок банка» у фирмы с несколькими счетами пункты — по счетам.
Роботы: «Счета на оплату», «Доверенности», «Расчёты с контрагентами (Дт/Кт)», «Диагностика поступлений и реализаций» (сначала синхронизация 1С с ИС ЭСФ на ноутбуке, потом отчёт), «Мониторинг кабинета налогоплательщика» (лицевые счета, уведомления, сдача отчётности), «Статистика». Отметки «отработано» сбрасываются при каждой новой проверке.
Пароли в кабинете не хранятся — только логины; для паролей есть шаблон Excel, который хранится на компьютере пользователя.
Права: менять профиль фирмы может владелец; отметку «Плательщик НДС» и дату постановки на учёт — владелец и главный бухгалтер; реквизиты — владелец, главный бухгалтер, сопровождение; оператор 1С и руководитель смотрят.`;

const SYSTEM = (today: string) => `Ты — помощник в кабинете ESEP для бухгалтера. Сегодня ${today} (Казахстан). Отвечай по-русски, коротко и по делу, без вступлений.
Правила:
1. Отвечай только по справке о кабинете и по данным пользователя ниже. Если нужных данных нет — так и скажи и подскажи, где их посмотреть или заполнить. Ничего не выдумывай: ни цифр, ни дат, ни названий.
1а. На вопросы «сколько», «у каких фирм», «кто» сначала смотри раздел СВОДКА: там готовые числа и полные списки — приводи их целиком и не пересчитывай сам. Если данные есть только по части фирм, скажи и то, что известно, и по скольким фирмам данных нет.
1б. Слова пользователя: «сдать отчёт», «отчётность» — это налоговые формы (ФНО) и статистика из раздела «Отчётность к сдаче»; «отчёты роботов», «не отработано» — результаты проверок роботов. Не путай их; если непонятно, что имеется в виду, ответь коротко по обоим.
2. Когда советуешь что-то сделать или посмотреть, давай ссылку на нужную страницу в виде [название](#ссылка), например [Реквизиты](#req) или [ИП Пример — сообщения](#f-<id>/feed). Используй только ссылки из справки; id фирмы бери из данных.
3. Перечисления — списком, по одной фирме в строке. Даты — в виде ДД.ММ.ГГГГ.
4. По налогам и законам давай только то, что следует из данных кабинета; на общие вопросы о законодательстве отвечай осторожно и советуй проверить по первоисточнику.
5. Паролей, логинов, телефонов и номеров счетов у тебя нет — если спрашивают, скажи, что они смотрятся в карточке реквизитов или в личном шаблоне.`;

// что видит пользователь (его правами) — текстом, без логинов, контактов и номеров счетов.
// Сначала СВОДКА: списки и числа посчитаны здесь, а не моделью — чтобы ответы «сколько» и «у каких фирм» были точными.
const dmy = (v: any) => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(8, 10) + '.' + String(v).slice(5, 7) + '.' + String(v).slice(0, 4) : String(v || '');
async function context(sb: any) {
  const [{ data: firms }, { data: tasks }, { data: auto }, { data: todo }, { data: evs }] = await Promise.all([
    sb.from('companies').select('id,name,full_name,bin,tax_regime,vat_payer,has_employees,eds_valid_until,reports_suspended,reports_suspended_until,onec_url,requisites,company_tax_forms(form_code,off),company_robots(status,enabled,robots(name))').is('archived_at', null).order('name'),
    sb.rpc('my_tasks'), sb.rpc('my_auto_tasks'), sb.rpc('my_todo'),
    sb.from('events').select('company_id,title,body,severity,created_at').eq('status', 'new').is('superseded_at', null).order('created_at', { ascending: false }).limit(60),
  ]);
  const F: any[] = firms || [], today = kzToday(), L: string[] = [], name: Record<string, string> = {};
  F.forEach((f) => { name[f.id] = f.name; });
  const list = (title: string, arr: any[], fmt = (f: any) => f.name) => L.push('- ' + title + ' (' + arr.length + ')' + (arr.length ? ': ' + arr.map(fmt).join('; ') : ''));
  const days = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 864e5);
  L.push('СВОДКА (посчитано кабинетом — этим числам и спискам верь, сам не пересчитывай):', '- Фирм всего: ' + F.length);
  list('Плательщики НДС', F.filter((f) => f.vat_payer === true));
  list('Не плательщики НДС', F.filter((f) => f.vat_payer === false));
  list('НДС в профиле не указан', F.filter((f) => f.vat_payer == null));
  const regs = new Map<string, any[]>(); F.forEach((f) => { const k = f.tax_regime ? (REGIME[f.tax_regime] || f.tax_regime) : 'режим не указан'; if (!regs.has(k)) regs.set(k, []); regs.get(k)!.push(f); });
  regs.forEach((arr, k) => list('Налоговый режим «' + k + '»', arr));
  list('Есть работники', F.filter((f) => f.has_employees === true)); list('Без работников', F.filter((f) => f.has_employees === false));
  const eds = F.filter((f) => f.eds_valid_until).sort((a, b) => String(a.eds_valid_until).localeCompare(String(b.eds_valid_until)));
  list('Срок ЭЦП известен', eds, (f) => f.name + ' — до ' + dmy(f.eds_valid_until) + (days(f.eds_valid_until) < 0 ? ' (ИСТЁК ' + (-days(f.eds_valid_until)) + ' дн. назад)' : ' (осталось ' + days(f.eds_valid_until) + ' дн.)'));
  L.push('- Срок ЭЦП НЕ заполнен: у ' + (F.length - eds.length) + ' фирм из ' + F.length + ' (срок записывает робот, когда входит в кабинет налогоплательщика этой фирмы; про эти фирмы сказать, когда кончается ЭЦП, нельзя)');
  list('ЭЦП кончается в ближайшие 30 дней или уже истекла', eds.filter((f) => days(f.eds_valid_until) <= 30));
  list('Сдача налоговой отчётности приостановлена', F.filter((f) => f.reports_suspended), (f) => f.name + (f.reports_suspended_until ? ' — до ' + dmy(f.reports_suspended_until) : ''));
  list('Адрес облачной 1С не указан', F.filter((f) => !f.onec_url));
  L.push('', 'ФИРМЫ (одна строка — одна фирма):');
  F.forEach((f) => {
    const q = f.requisites || {}, v = q.f || {}, p: string[] = [f.name, 'id ' + f.id];
    if (f.full_name && f.full_name !== f.name) p.push('полное: ' + f.full_name);
    if (f.bin) p.push('БИН/ИИН ' + f.bin);
    p.push('режим: ' + (f.tax_regime ? (REGIME[f.tax_regime] || f.tax_regime) : 'не указан'), 'НДС: ' + (f.vat_payer == null ? 'не указано' : f.vat_payer ? 'плательщик' : 'нет'));
    if (f.has_employees != null) p.push('работники: ' + (f.has_employees ? 'есть' : 'нет'));
    p.push('ЭЦП до: ' + (f.eds_valid_until ? dmy(f.eds_valid_until) : 'не заполнено'));
    const forms = (f.company_tax_forms || []).filter((x: any) => !x.off).map((x: any) => x.form_code); if (forms.length) p.push('налоговые формы: ' + forms.join(', '));
    const rb = (f.company_robots || []).filter((x: any) => x.status === 'active' && x.enabled && x.robots).map((x: any) => x.robots.name); if (rb.length) p.push('роботы: ' + rb.join(', '));
    const RQ: [string, string][] = [['kgd', 'УГД'], ['kgd2', 'УГД по месту жительства'], ['reg_date', 'дата регистрации'], ['kbe', 'КБе'], ['addr_legal', 'юр. адрес'], ['addr_fact', 'факт. адрес'], ['vat_date', 'на учёте по НДС с'], ['dir_name', 'руководитель'], ['dir_pos', 'должность'], ['acc_name', 'контактное лицо'], ['notes', 'примечания']];
    RQ.forEach(([k, t]) => { if (v[k]) p.push(t + ': ' + (/date/.test(k) ? dmy(v[k]) : v[k])); });
    if ((q.oked || []).length) p.push('ОКЭД: ' + q.oked.map((x: any) => (x || []).filter(Boolean).join(' ')).join(', '));
    if ((q.banks || []).length) p.push('банки: ' + q.banks.map((x: any) => [x[0], x[5], x[3] ? '(основной)' : ''].filter(Boolean).join(' ')).join(', '));
    if ((q.kkm || []).length) p.push('ККМ: ' + q.kkm.map((x: any) => (x || []).filter(Boolean).join(' ')).join('; '));
    const ports = [...Object.keys(q.portals || {}), ...(q.portals_x || []).map((x: any) => x[0])].filter(Boolean); if (ports.length) p.push('есть доступ к порталам: ' + ports.join(', '));
    (q.extra || []).forEach((x: any) => { if (x[0]) p.push(x[0] + ': ' + (x[1] || '')); });
    L.push('• ' + p.join(' | '));
  });
  L.push('', 'ОТЧЁТНОСТЬ К СДАЧЕ И ДРУГИЕ ЗАДАЧИ ОТ КАБИНЕТА (налоговые формы ФНО, статистика, продление ЭЦП). Вопросы «какие отчёты сдать», «что осталось сдать» — отвечай по этому разделу:');
  const A: any[] = auto || [];
  if (!A.length) L.push('(сейчас таких задач нет)');
  A.forEach((a) => { const it = a.items || [], left = it.filter((i: any) => !i.done);
    L.push('• ' + a.title + ' — не сделано ' + left.length + ' из ' + it.length + (left.length ? ': ' + left.map((i: any) => [i.name, i.label, i.due ? 'срок ' + dmy(i.due) + (i.due < today ? ' (ПРОСРОЧЕНО)' : '') : ''].filter(Boolean).join(', ')).join('; ') : '')); });
  L.push('', 'МОИ ЗАДАЧИ (поставленные людьми):');
  const T = (tasks || []).filter((t: any) => t.status !== 'done');
  if (!T.length) L.push('(нет незавершённых)');
  const ST: Record<string, string> = { new: 'новая', work: 'в работе', review: 'ждёт проверки' };
  T.forEach((t: any) => L.push('• ' + t.title + ' | срок: ' + (t.due ? dmy(t.due) + (t.due_time ? ' ' + t.due_time : '') + (t.due < today ? ' (ПРОСРОЧЕНА)' : '') : 'без срока') + ' | ' + (ST[t.status] || t.status) + ' | исполнитель: ' + t.assignee + ' | поставил: ' + t.creator
    + ((t.firms || []).length ? ' | фирмы: ' + t.firms.map((x: any) => x.name + (x.done ? ' ✓' : '')).join(', ') : '')));
  L.push('', 'НЕОТРАБОТАННОЕ В ОТЧЁТАХ РОБОТОВ (это результаты проверок роботов: счета, доверенности, долги, диагностика — НЕ налоговая отчётность):');
  const D: any[] = todo || [];
  if (!D.length) L.push('(всё отработано)');
  D.forEach((r) => L.push('• ' + r.robot + ' — не отработано ' + r.open + (r.amount ? ' на сумму ' + Math.round(r.amount).toLocaleString('ru-RU') + ' ₸' : '') + ((r.firms || []).length ? '; по фирмам: ' + r.firms.map((x: any) => x.name + ' (' + x.open + ')').join(', ') : '')));
  L.push('', 'НОВЫЕ ОТЧЁТЫ РОБОТОВ (ещё не отработаны):');
  const E: any[] = evs || [];
  if (!E.length) L.push('(нет)');
  E.forEach((e) => L.push('• ' + dmy(String(e.created_at).slice(0, 10)) + ' | ' + (name[e.company_id] || '') + ' (id ' + e.company_id + ') | ' + e.title + (e.body ? ' | ' + String(e.body).replace(/\s+/g, ' ').slice(0, 260) : '')));
  return L.join('\n').slice(0, 70000);
}

// модели по порядку: если первая недоступна ключу, берём следующую (свою можно задать секретом OPENAI_MODEL)
const MODELS = [...new Set([Deno.env.get('OPENAI_MODEL') || '', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'].filter(Boolean))];
async function ask(messages: any[]) {
  let last = '';
  for (const model of MODELS) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ model, messages }) });
    const d = await r.json().catch(() => ({} as any));
    if (r.ok) return { ok: true, answer: String(d?.choices?.[0]?.message?.content || '').trim(), model };
    last = String(d?.error?.message || r.status);
    if (!(r.status === 404 || r.status === 403 || /model/i.test(last))) break;   // ошибка не про модель (баланс, ключ) — перебирать незачем
  }
  return { ok: false, error: last };
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
    const res = await ask([{ role: 'system', content: SYSTEM(kzToday()) + '\n\nСПРАВКА О КАБИНЕТЕ:\n' + GUIDE + '\n\nДАННЫЕ ПОЛЬЗОВАТЕЛЯ:\n' + ctx }, ...msgs]);
    if (!res.ok) return j({ ok: false, error: 'Модель ответила ошибкой: ' + String(res.error).slice(0, 300), used: take.used, limit: take.limit });
    return j({ ok: true, answer: res.answer || 'Модель не дала ответа — попробуйте переформулировать вопрос.', used: take.used, limit: take.limit, model: res.model });
  } catch (e) {
    return j({ ok: false, error: String((e as Error).message ?? e) });
  }
});
