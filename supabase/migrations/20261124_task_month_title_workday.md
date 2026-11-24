# 24.11.2026 — задачи: месяц в названии, перенос срока на рабочий день (миграция task_month_title_workday)
- private.next_workday(date) / public.next_workday(p_date) — ближайший рабочий день с этой даты (private.is_workday: выходные, праздники, рабочие субботы).
- private.task_title_month(title, due) — «за <месяц>» → месяц перед сроком.
- private.tasks_repeat: для repeat_kind='month' срок новой задачи = next_workday(repeat_next), название — task_title_month. Сама дата повтора (repeat_next) не сдвигается.
- Кабинет: стандартный шаблон «Оплата налогов за {месяц}», срок 25-го с переносом на рабочий день (rpc next_workday).
