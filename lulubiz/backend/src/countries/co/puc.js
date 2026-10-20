/**
 * Plan Único de Cuentas de Colombia: clases y grupos principales.
 *
 * BORRADOR. Solo clases (1 dígito) y grupos (2 dígitos). Cuentas, subcuentas y auxiliares
 * los define cada empresa. Antes de usarlo en producción lo valida el contador.
 */
const clase = (code, name, type) => ({ code, name, type, postable: false });
const grupo = (code, name, type) => ({ code, name, type, parentCode: code[0], postable: false });

export const PUC_COLOMBIA_BORRADOR = [
  clase('1', 'Activo', 'asset'),
  clase('2', 'Pasivo', 'liability'),
  clase('3', 'Patrimonio', 'equity'),
  clase('4', 'Ingresos', 'income'),
  clase('5', 'Gastos', 'expense'),
  clase('6', 'Costos de ventas', 'cost'),

  grupo('11', 'Disponible', 'asset'),
  grupo('12', 'Inversiones', 'asset'),
  grupo('13', 'Deudores', 'asset'),
  grupo('14', 'Inventarios', 'asset'),
  grupo('15', 'Propiedades, planta y equipo', 'asset'),
  grupo('16', 'Intangibles', 'asset'),
  grupo('17', 'Diferidos', 'asset'),
  grupo('18', 'Otros activos', 'asset'),

  grupo('21', 'Obligaciones financieras', 'liability'),
  grupo('22', 'Proveedores', 'liability'),
  grupo('23', 'Cuentas por pagar', 'liability'),
  grupo('24', 'Impuestos, gravámenes y tasas', 'liability'),
  grupo('25', 'Obligaciones laborales', 'liability'),
  grupo('26', 'Pasivos estimados y provisiones', 'liability'),
  grupo('27', 'Diferidos', 'liability'),
  grupo('28', 'Otros pasivos', 'liability'),

  grupo('31', 'Capital social', 'equity'),
  grupo('33', 'Reservas', 'equity'),
  grupo('36', 'Resultados del ejercicio', 'equity'),
  grupo('37', 'Resultados de ejercicios anteriores', 'equity'),

  grupo('41', 'Operacionales', 'income'),
  grupo('42', 'No operacionales', 'income'),

  grupo('51', 'Operacionales de administración', 'expense'),
  grupo('52', 'Operacionales de ventas', 'expense'),
  grupo('53', 'No operacionales', 'expense'),

  grupo('61', 'Costo de ventas y de prestación de servicios', 'cost'),
];
