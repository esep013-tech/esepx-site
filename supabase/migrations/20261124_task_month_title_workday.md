# 24.11.2026 — задачи: месяц в названии, перенос срока на рабочий день (миграция task_month_title_workday)
- private.next_workday(date) / public.next_workday(p_date) — ближайший рабочий день с этой даты (private.is_workday: выходные, праздники, рабочие субботы).
- private.task_title_month(title, due) — «за <месяц>» → месяц перед сроком.
- private.tasks_repeat: для repeat_kind='month' срок новой задачи = next_workday(repeat_next), название — task_title_month. Сама дата повтора (repeat_next) не сдвигается.
- Кабинет: стандартный шаблон «Оплата налогов за {месяц}», срок 25-го с переносом на рабочий день (rpc next_workday).

## 24.11.2026 — общая задача на нескольких человек (миграция task_co_executors)
- `user_tasks.co_ids uuid[]` — соисполнители; `assignee_id` остаётся основным исполнителем.
- `task_set_co(p_task, p_co)` — задаёт соисполнителей (только постановщик).
- `my_tasks`: задача видна соисполнителям, поля `co_ids`, `co`; соисполнитель видит только фирмы, где он участник.
- `task_action`, `task_check_mark`, `task_firm_mark`, `task_sub_mark`: отмечать может и соисполнитель. Политики чтения, сводка и повтор (`tasks_repeat` копирует `co_ids`) учитывают соисполнителей.

## 24.11.2026 — комментарии в задачах (миграция task_comments)
- Таблица `user_task_comments` (task_id, author_id, item, body); доступ только через функции.
- `task_comment_add(p_task, p_body, p_item)` — пишут постановщик, исполнитель, соисполнители; `item`: `cl:<ключ пункта>` или `f:<id фирмы>`, пусто — ко всей задаче. `task_comment_del(p_id)` — только автор.
- `my_tasks` отдаёт `comments`; комментарий к фирме видят только те, у кого есть доступ к этой фирме.

## 24.11.2026 — чат задачи (миграция task_chat_system_messages)
- `task_action`, `task_check_mark`, `task_firm_mark` пишут в `user_task_comments` служебную строку (`item = 'sys'`): кто взял в работу, отметил пункт или фирму, завершил.
