# 21.11.2026 — run_progress (шкала выполнения запусков)

`public.run_progress(p_ids uuid[] default null) returns jsonb` (security definer, grant authenticated).
- `p_ids = null` — мои запуски: идущие (`queued`/`running`) и ручные за последние сутки, где я запросил или состою в фирме; максимум 8.
- `p_ids` задан — эти запуски (админ — любые, остальные — свои/своих фирм), до 300.
- Поля: id, robot, code, status, check_date, total (фирм в запуске), done (фирм с отчётом по run_id), errs (ошибки из note), created_at, started_at, finished_at.
Используется в «Запуск и отчёты» (#runall, блок «Запуски за сутки») и в «Управление → Запуски» (шкала у каждого запуска).
