/** Fecha de un instante ISO como día/mes/año (el formato habitual en Colombia), sin pasar por zonas horarias. */
export function formatDay(iso) {
  const match = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

/** Hoy en la hora local, como día/mes/año. */
export function todayText() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** «01/01/2026 a 31/03/2026» desde dos días ISO; con uno solo, ese día. */
export function rangeText(from, to) {
  if (from && to) return `${formatDay(from)} a ${formatDay(to)}`;
  return formatDay(from || to);
}
