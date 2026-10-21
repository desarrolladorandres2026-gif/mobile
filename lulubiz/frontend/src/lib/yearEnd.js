const ACCOUNT = /^\d{1,12}$/;

/** Años que se pueden cerrar: del actual hacia atrás. El actual aparece, pero el servidor lo rechaza hasta el 31 de diciembre. */
export function yearOptions(today, count = 8) {
  const current = Number(today.slice(0, 4));
  return Array.from({ length: count }, (_, i) => current - i);
}

export const resultLabel = (result) => (result > 0 ? 'Utilidad' : result < 0 ? 'Pérdida' : 'Sin resultado');

/** Validación del formulario de cierre: la cuenta de la utilidad es obligatoria; la de la pérdida, si falta, es la misma. */
export function validateYearClose({ year, currency, profitAccount, lossAccount }) {
  const errors = {};
  if (!Number.isInteger(year)) errors.year = 'Elige el año.';
  if (!/^[A-Za-z]{3}$/.test(currency.trim())) errors.currency = 'La moneda es un código de tres letras, por ejemplo COP.';
  if (!ACCOUNT.test(profitAccount.trim())) errors.profitAccount = 'Indica la cuenta de patrimonio donde queda la utilidad.';
  if (lossAccount.trim() && !ACCOUNT.test(lossAccount.trim())) errors.lossAccount = 'Código de cuenta numérico.';
  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    body: ok ? { year, currency: currency.trim().toUpperCase(), profitAccount: profitAccount.trim(), ...(lossAccount.trim() ? { lossAccount: lossAccount.trim() } : {}) } : null,
  };
}
