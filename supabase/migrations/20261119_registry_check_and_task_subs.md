# registry_check_and_task_subs (19.11.2026, применено через Supabase)
- companies.registry (jsonb), companies.registry_at — данные и дата последней сверки с госпорталами (пишет функция registry).
- user_task_firms.subs (jsonb [{key,name}]) — свои пункты фирмы в задаче; private.task_subs() = банковские счета + свои пункты; my_tasks и task_sub_mark переведены на неё.
- public.registry_apply(p_company, p_fields) — принять изменения (full_name, reg_date, addr_legal, dir_name, oked_name, vat_payer, vat_date); владелец, главбух, сопровождение.
- public.registry_task(p_rows, p_assignee) — одна задача «Реквизиты: внести или сверить в 1С» с фирмами и пунктами.
