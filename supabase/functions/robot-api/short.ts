// Длинные формы собственности из 1С -> ТОО, ИП, АО и т.д.
const FORMS: [RegExp, string][] = [
  [/товарищество\s+с\s+ограниченной\s+ответственностью/giu, 'ТОО'],
  [/товарищество\s+с\s+дополнительной\s+ответственностью/giu, 'ТДО'],
  [/индивидуальный\s+предприниматель/giu, 'ИП'],
  [/некоммерческое\s+акционерное\s+общество/giu, 'НАО'],
  [/публичное\s+акционерное\s+общество/giu, 'ПАО'],
  [/акционерное\s+общество/giu, 'АО'],
  [/крестьянское\s*\(?\s*фермерское\s*\)?\s*хозяйство/giu, 'КФХ'],
  [/крестьянское\s+хозяйство/giu, 'КХ'],
  [/фермерское\s+хозяйство/giu, 'ФХ'],
  [/производственный\s+кооператив/giu, 'ПК'],
  [/общественное\s+объединение/giu, 'ОО'],
  [/государственное\s+коммунальное\s+казённое\s+предприятие|государственное\s+коммунальное\s+казенное\s+предприятие/giu, 'ГККП'],
  [/республиканское\s+государственное\s+предприятие/giu, 'РГП'],
  [/государственное\s+учреждение/giu, 'ГУ'],
  [/жауапкершілігі\s+шектеулі\s+серіктестігі/giu, 'ЖШС'],
  [/жеке\s+кәсіпкер/giu, 'ЖК'],
  [/limited\s+liability\s+partnership/giu, 'LLP'],
];
export function shortForms(s: string): string {
  let t = s;
  for (const [re, abbr] of FORMS) t = t.replace(re, abbr);
  return t.replace(/[ \t]{2,}/g, ' ');
}
export function shortDeep(v: unknown): unknown {
  if (typeof v === 'string') return shortForms(v);
  if (Array.isArray(v)) return v.map(shortDeep);
  if (v && typeof v === 'object') { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) o[k] = shortDeep(x); return o; }
  return v;
}
