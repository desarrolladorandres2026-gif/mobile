/** Nombre en español de cada permiso que se puede dar a una clave de API, agrupado por área. */
export const AREAS = [
  ['accounts', 'Plan de cuentas'],
  ['parties', 'Terceros'],
  ['journals', 'Asientos'],
  ['reports', 'Informes y saldos'],
  ['periods', 'Períodos'],
  ['audit', 'Auditoría'],
  ['invoices', 'Facturación electrónica'],
  ['receipts', 'Recibos de caja'],
  ['purchases', 'Compras'],
  ['payments', 'Pagos a proveedores'],
  ['inventory', 'Inventario'],
  ['pos', 'Punto de venta'],
];

export const SCOPE_LABELS = {
  'accounts:read': 'Consultar el plan de cuentas',
  'accounts:manage': 'Crear y editar cuentas',
  'parties:read': 'Consultar terceros',
  'parties:manage': 'Crear y editar terceros',
  'journals:read': 'Consultar asientos',
  'journals:post': 'Registrar asientos',
  'journals:reverse': 'Revertir asientos',
  'reports:read': 'Consultar informes y saldos',
  'periods:manage': 'Cerrar períodos',
  'audit:read': 'Consultar la auditoría',
  'invoices:read': 'Consultar facturas y notas crédito',
  'invoices:issue': 'Emitir facturas y notas crédito',
  'receipts:create': 'Registrar recibos de caja',
  'receipts:void': 'Anular recibos de caja',
  'purchases:read': 'Consultar compras y cuentas por pagar',
  'purchases:create': 'Registrar compras y notas de proveedor',
  'purchases:void': 'Anular compras',
  'payments:create': 'Registrar pagos a proveedores',
  'payments:void': 'Anular pagos',
  'inventory:read': 'Consultar artículos, existencias y kardex',
  'inventory:manage': 'Crear y editar artículos y bodegas',
  'inventory:adjust': 'Hacer ajustes y traspasos de existencias',
  'pos:read': 'Consultar cajas, turnos y ventas de mostrador',
  'pos:sell': 'Abrir turnos, vender y cerrar turnos',
  'pos:void': 'Anular ventas de mostrador',
  'pos:manage': 'Crear y editar cajas',
};

export const scopeLabel = (scope) => SCOPE_LABELS[scope] ?? scope;

/** Permisos agrupados por área, en el orden de `AREAS`; lo que no tenga área va al final. */
export function groupScopes(scopes) {
  const groups = AREAS.map(([area, title]) => ({ area, title, items: scopes.filter((s) => s.startsWith(`${area}:`)).map((scope) => ({ scope, label: scopeLabel(scope) })) }));
  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.scope)));
  const rest = scopes.filter((s) => !known.has(s));
  return [...groups, ...(rest.length ? [{ area: 'other', title: 'Otros', items: rest.map((scope) => ({ scope, label: scopeLabel(scope) })) }] : [])].filter((g) => g.items.length);
}

export function validateKey({ name, scopes, expiresAt }, today) {
  const errors = {};
  if (!name.trim()) errors.name = 'Escribe un nombre que diga para qué se usa la clave.';
  if (scopes.length === 0) errors.scopes = 'Elige al menos un permiso.';
  if (expiresAt && expiresAt < today) errors.expiresAt = 'La fecha de vencimiento ya pasó.';
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, body: ok ? { name: name.trim(), scopes, ...(expiresAt ? { expiresAt } : {}) } : null };
}
