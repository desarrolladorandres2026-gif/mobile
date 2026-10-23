import { parseAmount } from './money.js';

export const DOC_TYPES = [
  { value: 'CC', label: 'Cédula de ciudadanía' },
  { value: 'CE', label: 'Cédula de extranjería' },
  { value: 'TI', label: 'Tarjeta de identidad' },
  { value: 'PASSPORT', label: 'Pasaporte' },
  { value: 'PEP', label: 'Permiso especial de permanencia' },
  { value: 'PPT', label: 'Permiso por protección temporal' },
];
export const CONTRACTS = [
  { value: 'indefinite', label: 'Término indefinido' },
  { value: 'fixed', label: 'Término fijo' },
  { value: 'service', label: 'Obra o labor' },
];
export const SALARY_TYPES = [
  { value: 'ordinary', label: 'Ordinario' },
  { value: 'integral', label: 'Integral' },
];
export const ARL_LEVELS = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `Riesgo ${['I', 'II', 'III', 'IV', 'V'][n - 1]}` }));

/** Cuentas que usa la nómina, agrupadas, con el código del plan único colombiano que se sugiere (se puede cambiar). */
export const ACCOUNT_GROUPS = [
  {
    title: 'Gastos',
    fields: [
      ['salaryExpense', 'Sueldos', '510506'],
      ['nonSalaryExpense', 'Pagos no salariales', '510548'],
      ['transportExpense', 'Auxilio de transporte', '510527'],
      ['employerHealthExpense', 'Aportes patronales a salud', '510569'],
      ['employerPensionExpense', 'Aportes patronales a pensión', '510570'],
      ['arlExpense', 'Aportes a ARL', '510568'],
      ['cajaExpense', 'Aportes a la caja de compensación', '510572'],
      ['senaExpense', 'Aportes al SENA', '510578'],
      ['icbfExpense', 'Aportes al ICBF', '510575'],
      ['cesantiasExpense', 'Cesantías', '510530'],
      ['cesantiasInterestExpense', 'Intereses sobre cesantías', '510533'],
      ['primaExpense', 'Prima de servicios', '510536'],
      ['vacationsExpense', 'Vacaciones', '510539'],
    ],
  },
  {
    title: 'Pasivos',
    fields: [
      ['payrollPayable', 'Salarios por pagar', '250505'],
      ['healthPayable', 'Aportes a salud por pagar', '237005'],
      ['pensionPayable', 'Aportes a pensión por pagar', '238030'],
      ['arlPayable', 'Aportes a ARL por pagar', '237006'],
      ['cajaPayable', 'Caja de compensación por pagar', '237010'],
      ['senaPayable', 'SENA por pagar', '237015'],
      ['icbfPayable', 'ICBF por pagar', '237020'],
      ['withholdingPayable', 'Retención en la fuente por salarios', '236505'],
      ['deductionsPayable', 'Otras deducciones de nómina', '237095'],
      ['cesantiasPayable', 'Cesantías consolidadas', '261005'],
      ['cesantiasInterestPayable', 'Intereses sobre cesantías', '261010'],
      ['primaPayable', 'Prima de servicios por pagar', '261020'],
      ['vacationsPayable', 'Vacaciones consolidadas', '261015'],
    ],
  },
];
export const ALL_ACCOUNT_KEYS = ACCOUNT_GROUPS.flatMap((g) => g.fields.map((f) => f[0]));

export const blankEmployee = () => ({ documentType: 'CC', documentNumber: '', name: '', hireDate: '', baseSalary: '', salaryType: 'ordinary', contractType: 'indefinite', transportAid: true, arlRiskLevel: 1, costCenter: '', position: '', email: '' });

/** Valida la ficha de un empleado y arma el cuerpo. */
export function validateEmployee(form, currency) {
  const errors = {};
  if (!form.documentNumber.trim()) errors.documentNumber = 'Escribe el número de documento.';
  if (!form.name.trim()) errors.name = 'Escribe el nombre.';
  if (!form.hireDate) errors.hireDate = 'Elige la fecha de ingreso.';
  const salary = parseAmount(form.baseSalary, currency);
  if (!form.baseSalary.trim() || salary === null || salary <= 0) errors.baseSalary = 'Salario no válido. Ejemplo: 2.500.000,00';
  if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) errors.email = 'Correo no válido.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      documentType: form.documentType,
      documentNumber: form.documentNumber.trim(),
      name: form.name.trim(),
      hireDate: form.hireDate,
      baseSalary: salary,
      salaryType: form.salaryType,
      contractType: form.contractType,
      transportAid: form.transportAid,
      arlRiskLevel: Number(form.arlRiskLevel),
      ...(form.costCenter ? { costCenter: form.costCenter } : {}),
      ...(form.position.trim() ? { position: form.position.trim() } : {}),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
    },
  };
}

/** Parámetros del año: salario mínimo, auxilio de transporte y UVT son obligatorios; el resto usa las tarifas de ley. */
export function validateYearParams(form, currency) {
  const errors = {};
  const read = (key, label) => {
    const value = parseAmount(form[key], currency);
    if (!String(form[key]).trim() || value === null || value <= 0) errors[key] = `${label} no válido.`;
    return value;
  };
  const smmlv = read('smmlv', 'Salario mínimo');
  const transportAid = read('transportAid', 'Auxilio de transporte');
  const uvt = read('uvt', 'UVT');
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { params: { smmlv, transportAid, uvt, exonerated: form.exonerated, withholding: form.withholding } } };
}

/** Convierte las novedades escritas (por empleado) en el cuerpo que espera el servidor. Una fila sin nada se omite. */
export function parseNovelties(rows, currency) {
  const errors = [];
  const novelties = [];
  for (const row of rows) {
    const novelty = { employeeId: row.employeeId };
    const label = row.name;
    if (String(row.daysWorked).trim() !== '') {
      const days = Number(row.daysWorked);
      if (!Number.isInteger(days) || days < 0 || days > 30) errors.push(`${label}: los días trabajados van de 0 a 30.`);
      else novelty.daysWorked = days;
    }
    for (const [key, text] of [['salaryExtras', 'extras salariales'], ['nonSalaryExtras', 'extras no salariales'], ['otherDeductions', 'otras deducciones'], ['withholding', 'retención']]) {
      if (!String(row[key]).trim()) continue;
      const value = parseAmount(row[key], currency);
      if (value === null || value < 0) errors.push(`${label}: ${text} no válido.`);
      else novelty[key] = value;
    }
    if (Object.keys(novelty).length > 1) novelties.push(novelty);
  }
  return errors.length ? { ok: false, errors } : { ok: true, novelties };
}

export const blankNovelty = (employee) => ({ employeeId: employee._id, name: employee.name, daysWorked: '', salaryExtras: '', nonSalaryExtras: '', otherDeductions: '', withholding: '' });

/** Lo que se paga por cada obligación de una corrida, para mostrarlo como renglones. */
export function obligationsOf(totals) {
  return [
    { key: 'net', label: 'Salarios netos por pagar', amount: totals.net },
    { key: 'health', label: 'Salud (empleado y empleador)', amount: totals.health + totals.employer.health },
    { key: 'pension', label: 'Pensión y fondo de solidaridad', amount: totals.pension + totals.solidarity + totals.employer.pension },
    { key: 'arl', label: 'ARL', amount: totals.employer.arl },
    { key: 'caja', label: 'Caja de compensación', amount: totals.employer.caja },
    { key: 'sena', label: 'SENA', amount: totals.employer.sena },
    { key: 'icbf', label: 'ICBF', amount: totals.employer.icbf },
    { key: 'withholding', label: 'Retención en la fuente', amount: totals.withholding },
    { key: 'deductions', label: 'Otras deducciones', amount: totals.otherDeductions },
  ].filter((o) => o.amount > 0);
}

/** Mes anterior al de `today` (AAAA-MM-DD) como `AAAA-MM`: el que normalmente se liquida. */
export function previousMonth(today) {
  const [y, m] = today.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export const BENEFIT_KINDS = [
  { value: 'prima', label: 'Prima de servicios (semestral)' },
  { value: 'cesantias', label: 'Cesantías e intereses (anual)' },
];

/** Período sugerido de una prestación: el último semestre cerrado para la prima, el año anterior para las cesantías. */
export function defaultBenefitLabel(kind, today) {
  const [y, m] = today.split('-').map(Number);
  if (kind === 'cesantias') return String(y - 1);
  return m >= 7 ? `${y}-1` : `${y - 1}-2`;
}

/** Valida el período de una prestación: `AAAA-1` o `AAAA-2` para la prima, `AAAA` para las cesantías. */
export function validateBenefitLabel(kind, label) {
  const text = label.trim();
  if (kind === 'prima') return /^\d{4}-[12]$/.test(text) ? null : 'La prima va por semestre: AAAA-1 (enero a junio) o AAAA-2 (julio a diciembre).';
  return /^\d{4}$/.test(text) ? null : 'Las cesantías van por año: AAAA.';
}

export const PROVISION_LABELS = { cesantias: 'Cesantías', cesantiasInterest: 'Intereses sobre cesantías', prima: 'Prima de servicios', vacations: 'Vacaciones' };
