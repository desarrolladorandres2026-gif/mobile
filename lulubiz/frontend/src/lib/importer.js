import { mapColumns } from './csv.js';
import { validateItem } from './inventory.js';
import { parsePercent } from './invoicing.js';
import { nitCheckDigit } from './nit.js';

/** Columnas de cada archivo, con los nombres alternativos que se aceptan (en español o en inglés). */
export const ITEM_COLUMNS = {
  codigo: ['sku', 'referencia', 'code'],
  nombre: ['name', 'descripcion', 'articulo'],
  tipo: ['type'],
  unidad: ['unit', 'unidad_de_medida'],
  cuenta_inventario: ['cuenta_de_inventario', 'inventory_account'],
  cuenta_costo: ['cuenta_de_costo', 'cuenta_costo_de_ventas', 'cogs_account'],
  cuenta_ingreso: ['cuenta_de_ingreso', 'cuenta_de_ingresos', 'income_account'],
  precio: ['precio_de_venta', 'price'],
  iva: ['iva_porcentaje', 'vat'],
  minimo: ['minimo_de_existencias', 'stock_minimo', 'min_stock'],
};
export const ITEM_REQUIRED = ['codigo', 'nombre'];

export const PARTY_COLUMNS = {
  nombre: ['razon_social', 'nombre_o_razon_social', 'name'],
  tipo_documento: ['tipo_de_documento', 'tipo_doc', 'tax_id_type'],
  documento: ['nit', 'numero_de_documento', 'identificacion', 'tax_id'],
  digito: ['dv', 'digito_de_verificacion', 'check_digit'],
  rol: ['roles', 'es', 'role'],
  correo: ['email', 'correo_electronico'],
  telefono: ['phone', 'celular'],
  direccion: ['address'],
  ciudad: ['city', 'municipio'],
  departamento: ['region', 'depto'],
};
export const PARTY_REQUIRED = ['nombre', 'documento'];

const TYPES = { bien: 'goods', bienes: 'goods', goods: 'goods', servicio: 'service', servicios: 'service', service: 'service' };
const ROLES = { cliente: 'customer', clientes: 'customer', customer: 'customer', proveedor: 'supplier', proveedores: 'supplier', supplier: 'supplier' };

/** Marca como error las filas cuya clave ya apareció antes en el archivo. */
function flagRepeats(results, keyOf, label) {
  const seen = new Map();
  for (const r of results) {
    if (!r.body) continue;
    const key = keyOf(r.body);
    if (seen.has(key)) {
      r.error = `${label} repetido: ya está en la línea ${seen.get(key)} del archivo.`;
      r.body = null;
    } else seen.set(key, r.line);
  }
}

/** Artículos: valida cada fila como lo hace el formulario. Devuelve `{ line, body | error }` por fila. */
export function prepareItems(objects, { currency }) {
  const results = objects.map(({ line, values: v }) => {
    const rawType = (v.tipo ?? '').trim().toLowerCase();
    const type = rawType ? TYPES[rawType] : 'goods';
    if (!type) return { line, error: `El tipo «${v.tipo}» no es válido: usa bien o servicio.` };
    const vat = (v.iva ?? '').trim();
    const vatBps = vat === '' ? '' : parsePercent(vat);
    if (vatBps === null) return { line, error: `El IVA «${vat}» no es un porcentaje válido (por ejemplo 19).` };
    const checked = validateItem({
      sku: v.codigo ?? '',
      name: v.nombre ?? '',
      type,
      unit: (v.unidad ?? '').trim() || 'UND',
      inventoryAccount: v.cuenta_inventario ?? '',
      cogsAccount: v.cuenta_costo ?? '',
      incomeAccount: v.cuenta_ingreso ?? '',
      price: v.precio ?? '',
      vatBps: vatBps === '' ? '' : String(vatBps),
      minStock: v.minimo ?? '',
      currency,
    });
    if (!checked.ok) return { line, error: Object.values(checked.errors).join(' ') };
    return { line, body: checked.body };
  });
  flagRepeats(results, (b) => b.sku.toUpperCase(), 'Código');
  return results;
}

/** «890.903.938-8» → { taxId: '890903938', checkDigit: 8 }. Sin guion, el dígito sale de la columna o se calcula. */
function splitDocument(raw, type, digitText) {
  const clean = raw.replace(/[.\s]/g, '');
  if (type !== 'NIT') return { taxId: clean };
  const dash = /^(\d+)-(\d)$/.exec(clean);
  const taxId = dash ? dash[1] : clean;
  let checkDigit;
  if (dash) checkDigit = Number(dash[2]);
  else if (digitText.trim() !== '') checkDigit = /^\d$/.test(digitText.trim()) ? Number(digitText.trim()) : null;
  else checkDigit = nitCheckDigit(taxId);
  return { taxId, checkDigit };
}

/** Terceros: arma el cuerpo que espera el servidor, que es quien valida el documento y su dígito. */
export function prepareParties(objects, { defaultType }) {
  const results = objects.map(({ line, values: v }) => {
    const name = (v.nombre ?? '').trim();
    if (!name) return { line, error: 'Falta el nombre o la razón social.' };
    if (!(v.documento ?? '').trim()) return { line, error: 'Falta el número de documento.' };
    const roleText = (v.rol ?? '').trim().toLowerCase();
    let roles;
    if (!roleText) roles = ['customer'];
    else if (roleText === 'ambos' || roleText === 'both') roles = ['customer', 'supplier'];
    else {
      const parts = roleText.split(/[/,;|]| y /).map((r) => r.trim()).filter(Boolean);
      roles = parts.map((r) => ROLES[r]);
      if (roles.some((r) => !r)) return { line, error: `El rol «${v.rol}» no es válido: usa cliente, proveedor o ambos.` };
      roles = [...new Set(roles)];
    }
    const type = (v.tipo_documento ?? '').trim().toUpperCase() || defaultType;
    const { taxId, checkDigit } = splitDocument(v.documento, type, v.digito ?? '');
    if (type === 'NIT' && (checkDigit === null || checkDigit === undefined)) return { line, error: 'El NIT necesita un dígito de verificación válido.' };
    const address = Object.fromEntries(Object.entries({ line: v.direccion ?? '', city: v.ciudad ?? '', region: v.departamento ?? '' }).filter(([, x]) => x));
    return {
      line,
      body: {
        name,
        roles,
        taxIdType: type,
        taxId,
        ...(type === 'NIT' ? { checkDigit } : {}),
        ...((v.correo ?? '').trim() ? { email: v.correo.trim() } : {}),
        ...((v.telefono ?? '').trim() ? { phone: v.telefono.trim() } : {}),
        ...(Object.keys(address).length ? { address } : {}),
      },
    };
  });
  flagRepeats(results, (b) => `${b.taxIdType}:${b.taxId}`, 'Documento');
  return results;
}

export function prepare(kind, header, rows, options) {
  const columns = kind === 'items' ? ITEM_COLUMNS : PARTY_COLUMNS;
  const required = kind === 'items' ? ITEM_REQUIRED : PARTY_REQUIRED;
  const mapped = mapColumns(header, rows, columns, required);
  if (mapped.missing.length) return { ...mapped, results: [] };
  return { ...mapped, results: kind === 'items' ? prepareItems(mapped.objects, options) : prepareParties(mapped.objects, options) };
}

/**
 * Crea las filas válidas una por una (la API no tiene alta masiva), sin detenerse en un error. Una fila que ya existe
 * (código o documento repetido en la empresa) se cuenta aparte: repetir la importación no duplica nada.
 */
export async function runImport(valid, post, onProgress = () => {}) {
  const outcome = { created: [], existed: [], failed: [] };
  let done = 0;
  for (const row of valid) {
    try {
      await post(row.body);
      outcome.created.push(row.line);
    } catch (error) {
      if (error?.code === 'DUPLICATE') outcome.existed.push({ line: row.line, message: error.message });
      else outcome.failed.push({ line: row.line, message: error?.message ?? 'Error inesperado.' });
    }
    done += 1;
    onProgress(done, valid.length);
  }
  return outcome;
}
