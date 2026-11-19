# 19.11.2026 (применено через Supabase)
- registry_task_append_and_ls_control: registry_task(p_rows, p_assignee) → jsonb {id, appended, added}; открытая задача «Реквизиты: внести или сверить в 1С» того же автора дополняется (новые фирмы и пункты, без дублей; фирма с новыми пунктами снова «не выполнена»). my_ls_control() — последняя проверка ЛС по моим фирмам и долги (сумма отрицательных tax/pen/pct/fine).
- kn_daily_ls: kn_cycle.ls_only; прежний план недели → private.kn_plan_cycle; public.kn_plan — когда недельная проверка сделана, в будни возвращает ежедневный запрос и обработку ЛС (строка kn_cycle с ls_only, днём проверки не считается); kn_step пишет шаги в строку дня «только ЛС».
- oked_reference: таблица public.oked (1112 кодов, НК РК 03-2019 изм. 4), чтение — всем вошедшим; загрузка — функция registry {oked_load} по ключу сервера.
- registry_apply_kgd_oked_code: registry_apply принимает kgd и oked_code.
