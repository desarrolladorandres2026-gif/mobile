/** Texto en minúsculas y sin tildes, para buscar por prefijo sin distinguir mayúsculas ni acentos. */
export const toNameKey = (name) =>
  String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
