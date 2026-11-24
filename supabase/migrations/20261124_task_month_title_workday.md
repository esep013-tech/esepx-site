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
