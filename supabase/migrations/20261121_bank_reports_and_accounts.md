# 21.11.2026 — выписки банка: итог разноски, счёт в реквизиты

- `public.bank_reports(id, company_id, created_at, by_user, account, bank, period_from, period_to, head jsonb, rows jsonb)`, RLS: читают участники фирмы.
  `public.bank_report_save(p_company, p_account, p_bank, p_from, p_to, p_head, p_rows)` — любой участник; по фирме остаются 3 последних.
  Кабинет сохраняет итог после «Записать отмеченные в 1С» (если записано хоть что-то); строки: date, n, dir, sum, name, bin, purpose (160), doc, by, st, bad.
  Печать — `bankPrint(head, rows, at)`, кнопка «🖨 Распечатать разноску» над таблицей и «Последние разноски» (`#bank-reps`).
- `public.firm_bank_account_add(p_company, p_iik, p_bank, p_bik, p_cur)` — добавить ИИК из выписки в requisites.banks ([банк, БИК, ИИК, основной, '', валюта]); любой участник фирмы (решение Жанны: «добавлять могут все, кто грузит выписку»).
- bank-1c: `pdocs` (открытые счета на оплату и реализации/поступления контрагентов за год с остатком), у docs — `basis` (к чему прикреплена оплата). bank-write: `fill.doc_key/doc_type` → «Счёт на оплату» или «Документ расчётов» (Сделка); автор и ответственный — пользователь «Робот» базы.
