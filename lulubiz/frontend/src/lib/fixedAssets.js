import { parseAmount } from './money.js';

export const MAX_LIFE_MONTHS = 600;

/** Depreciación acumulada tras `months` meses, en línea recta, con la misma aritmética del servidor (entera, con BigInt). */
export function accumulatedAfter(depreciable, lifeMonths, months) {
  const k = Math.min(Math.max(months, 0), lifeMonths);
  return Number((BigInt(depreciable) * BigInt(k)) / BigInt(lifeMonths));
}

/** Cuota del primer mes (la cuota cambia en un centavo según el redondeo). */
export function firstInstallment(cost, salvage, lifeMonths) {
  return accumulatedAfter(cost - salvage, lifeMonths, 1);
}

/** Valida la ficha de un activo y arma el cuerpo. */
export function validateAsset(form, currency) {
  const errors = {};
  const code = form.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(code)) errors.code = 'Letras, números, punto, guion y guion bajo; hasta 20.';
  if (!form.name.trim()) errors.name = 'Escribe el nombre del activo.';
  if (!form.acquisitionDate) errors.acquisitionDate = 'Elige la fecha de adquisición.';
  const cost = parseAmount(form.cost, currency);
  if (!form.cost.trim() || cost === null || cost <= 0) errors.cost = 'Costo no válido. Ejemplo: 4.500.000,00';
  const salvage = parseAmount(form.salvageValue, currency);
  if (salvage === null) errors.salvageValue = 'Valor residual no válido.';
  else if (cost > 0 && salvage >= cost) errors.salvageValue = 'El residual debe ser menor que el costo.';
  const life = Number(form.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > MAX_LIFE_MONTHS) errors.usefulLifeMonths = `La vida útil va de 1 a ${MAX_LIFE_MONTHS} meses.`;
  if (form.depreciationStart && !/^\d{4}-(0[1-9]|1[0-2])$/.test(form.depreciationStart)) errors.depreciationStart = 'Usa el formato AAAA-MM.';
  else if (form.depreciationStart && form.acquisitionDate && form.depreciationStart < form.acquisitionDate.slice(0, 7)) errors.depreciationStart = 'No puede empezar antes de la adquisición.';
  for (const [key, label] of [['asset', 'la cuenta del activo'], ['accumulated', 'la cuenta de depreciación acumulada'], ['expense', 'la cuenta del gasto']]) {
    if (!/^\d{1,12}$/.test(form[key].trim())) errors[key] = `Indica ${label}.`;
  }
  if (!errors.asset && !errors.accumulated && !errors.expense && new Set([form.asset.trim(), form.accumulated.trim(), form.expense.trim()]).size < 3) errors.expense = 'Las tres cuentas deben ser distintas.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      code,
      name: form.name.trim(),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      acquisitionDate: form.acquisitionDate,
      cost,
      ...(salvage ? { salvageValue: salvage } : {}),
      usefulLifeMonths: life,
      ...(form.depreciationStart ? { depreciationStart: form.depreciationStart } : {}),
      ...(form.costCenter ? { costCenter: form.costCenter } : {}),
      accounts: { asset: form.asset.trim(), accumulated: form.accumulated.trim(), expense: form.expense.trim() },
    },
  };
}

/** Valida la baja de un activo: con precio necesita la cuenta donde entra el dinero. */
export function validateDisposal({ date, proceeds, proceedsAccount, gainAccount, lossAccount }, bookValue, currency) {
  const errors = [];
  if (!date) errors.push('Elige la fecha de la baja.');
  const amount = parseAmount(proceeds, currency);
  if (amount === null) errors.push('Precio de venta no válido.');
  if (amount > 0 && !/^\d{1,12}$/.test(proceedsAccount.trim())) errors.push('Indica la cuenta donde entra el dinero de la venta.');
  const difference = (amount ?? 0) - bookValue;
  if (amount !== null && difference < 0 && !/^\d{1,12}$/.test(lossAccount.trim())) errors.push('La baja deja pérdida: indica la cuenta de la pérdida.');
  if (amount !== null && difference > 0 && !/^\d{1,12}$/.test(gainAccount.trim())) errors.push('La venta deja utilidad: indica la cuenta de la utilidad.');
  if (errors.length) return { ok: false, errors, difference };
  return {
    ok: true,
    difference,
    body: {
      date,
      ...(amount > 0 ? { proceeds: amount, proceedsAccount: proceedsAccount.trim() } : {}),
      ...(difference < 0 ? { lossAccount: lossAccount.trim() } : {}),
      ...(difference > 0 ? { gainAccount: gainAccount.trim() } : {}),
    },
  };
}
