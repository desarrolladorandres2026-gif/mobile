import { COLLECTIONS } from '../data/db.js';

/*
 * Primeros pasos de una empresa: qué falta configurar antes de operar de verdad, calculado de lo que ya hay.
 * Cada paso dice si está hecho, si es obligatorio o solo recomendable, qué falta exactamente y a qué pantalla ir.
 * No guarda nada: es una vista sobre la configuración y los datos, así que nunca se desactualiza.
 *
 * Paso: { key, title, done, required, detail, path }
 *  - Obligatorios: sin ellos no se factura, no se compra o no se contabiliza con sentido.
 *  - Recomendables: lo que casi toda empresa necesita pero que se puede hacer después.
 *  - El proveedor de facturación en modo de pruebas deja ese paso sin hacer: sus documentos no valen ante la DIAN.
 */
export function createOnboardingService({ db, invoicing, purchases }) {
  const count = (collection, tenantId, filter = {}) => db.collection(collection).countDocuments({ tenantId, ...filter });

  return {
    async get(tenantId) {
      const [invoicingStatus, purchasingStatus, accountCount, partyCount, itemCount, registerCount, settingsCount] = await Promise.all([
        invoicing.status(tenantId),
        purchases.status(tenantId),
        count(COLLECTIONS.accounts, tenantId),
        count(COLLECTIONS.parties, tenantId),
        count(COLLECTIONS.items, tenantId),
        count(COLLECTIONS.posRegisters, tenantId),
        count(COLLECTIONS.settings, tenantId),
      ]);
      const resolutionMissing = invoicingStatus.missing.filter((m) => m.startsWith('una resolución'));
      const settingsMissing = invoicingStatus.missing.filter((m) => !m.startsWith('una resolución'));

      const steps = [
        {
          key: 'chart',
          title: 'Plan de cuentas',
          required: true,
          done: accountCount > 0,
          detail: accountCount > 0 ? `${accountCount} cuentas cargadas.` : 'Carga el plan de cuentas de Colombia o crea las tuyas. El plan que trae Lulubiz es un borrador: pide a tu contador que lo revise antes de contabilizar.',
          path: 'cuentas',
        },
        {
          key: 'invoicing-settings',
          title: 'Datos del emisor y cuentas de facturación',
          required: true,
          done: settingsCount > 0 && settingsMissing.length === 0,
          detail: settingsMissing.length === 0 && settingsCount > 0 ? 'Emisor y cuentas configurados.' : `Falta: ${(settingsMissing.length ? settingsMissing : ['los datos del emisor y las cuentas contables']).join(', ')}.`,
          path: 'facturacion',
        },
        {
          key: 'resolutions',
          title: 'Resoluciones de numeración',
          required: true,
          done: settingsCount > 0 && resolutionMissing.length === 0,
          detail: resolutionMissing.length === 0 && settingsCount > 0 ? 'Hay resolución vigente para facturas y notas crédito.' : `Falta: ${resolutionMissing.length ? resolutionMissing.join(', ') : 'una resolución de numeración vigente para facturas y para notas crédito'}.`,
          path: 'facturacion',
        },
        {
          key: 'purchasing',
          title: 'Cuentas de compras',
          required: true,
          done: purchasingStatus.ready,
          detail: purchasingStatus.ready ? 'Proveedores e IVA descontable configurados.' : `Falta: ${purchasingStatus.missing.join(', ')}.`,
          path: 'facturacion',
        },
        {
          key: 'provider',
          title: 'Proveedor de facturación electrónica',
          required: true,
          done: invoicingStatus.configured && invoicingStatus.sandbox === false,
          detail: !invoicingStatus.configured
            ? 'Este servidor no tiene un proveedor de facturación electrónica conectado: no se pueden emitir facturas.'
            : invoicingStatus.sandbox
              ? 'Está en modo de pruebas: los documentos no tienen validez ante la DIAN. Sirve para ensayar, no para facturar de verdad.'
              : `Conectado: ${invoicingStatus.provider}.`,
          path: 'facturas',
        },
        {
          key: 'parties',
          title: 'Clientes y proveedores',
          required: false,
          done: partyCount > 0,
          detail: partyCount > 0 ? `${partyCount} terceros registrados.` : 'Registra tus clientes y proveedores, o impórtalos desde un archivo.',
          path: 'importar',
        },
        {
          key: 'items',
          title: 'Artículos',
          required: false,
          done: itemCount > 0,
          detail: itemCount > 0 ? `${itemCount} artículos registrados.` : 'Si manejas inventario, registra tus artículos o impórtalos desde un archivo.',
          path: 'importar',
        },
        {
          key: 'pos',
          title: 'Cajas del punto de venta',
          required: false,
          done: registerCount > 0,
          detail: registerCount > 0 ? `${registerCount} cajas creadas.` : 'Solo si vendes en mostrador: crea tu primera caja.',
          path: 'cajas',
        },
      ];
      const requiredPending = steps.filter((s) => s.required && !s.done).length;
      return { steps, requiredPending, ready: requiredPending === 0, sandbox: invoicingStatus.sandbox === true };
    },
  };
}
