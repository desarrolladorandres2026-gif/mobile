/** Fecha de un instante ISO como día/mes/año (el formato habitual en Colombia), sin pasar por zonas horarias. */
export function formatDay(iso) {
  const match = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}
