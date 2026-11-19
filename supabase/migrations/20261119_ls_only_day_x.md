# 19.11.2026 — лицевой счёт роботом только в день X

`private.kn_plan_cycle`: было `need_ls := c.ls_done_at is null` (ЛС в каждый проход, в т.ч. в обычный понедельник).
Стало: `need_ls := c.ls_done_at is null and (p_force or cd = any(kn_pay_days(wk)) or cd = any(kn_firm_pay_days(p_company, wk)))`.
По понедельникам без дня X ЛС не запрашивается; в остальные дни — платежи из КГД (`ls_kgd`, cron 'ls-kgd-morning').
Ручной запуск (p_force) — как раньше, всё.
