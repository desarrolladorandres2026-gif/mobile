// Roles y permisos: enums, matrices declaradas en código y guardas reales de cada endpoint.
import { layerOf } from './domain.mjs';

/** Convierte un valor evaluado (tablas.mjs) a texto corto. */
const flat = (v) => {
  if (v == null) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(flat);
  if (v._enum) return `${v._enum}.${v.miembro}`;
  if (v._texto != null) return `⟨${v._texto}⟩`;
  if (v._spread != null) return `…${v._spread}`;
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = flat(x);
  return o;
};

export function buildRoles(factsMap, graph, endpointData, tablas, manual) {
  const enums = {};
  for (const [id, s] of graph.symbols) {
    if (s.tipo === 'enum' && /(^|[a-z])(Role|Permission)s?$|^Business(Role|Permission)|^UserRole$|^Permission$|^StaffRole/.test(s.nombre)) {
      enums[s.nombre] = { id, archivo: s.archivo, linea: s.linea, miembros: s.miembros ?? [] };
    }
  }
  const matrices = tablas.dominio
    .filter((t) => /PERMISSION|ROLE/i.test(t.nombre))
    .map((t) => ({ id: t.id, nombre: t.nombre, archivo: t.archivo, linea: t.linea, valor: flat(t.valor), consumidores: t.consumidores }));

  const guardas = endpointData.endpoints.filter((e) => e.montada).map((e) => ({
    id: e.id, metodo: e.metodo, ruta: e.ruta, archivo: e.archivo, linea: e.linea,
    publica: e.guardas.publica, roles: e.guardas.roles, permisos: e.guardas.permisos, permisosCualquiera: e.guardas.permisosCualquiera,
    soloAdminPermisos: e.guardas.soloAdminPermisos, rolRbac: e.guardas.rolRbac, rechazaMostrador: e.guardas.rechazaMostrador,
    permisosInternos: e.cierre?.permisosInternos ?? [], escribe: !!e.escribe,
  }));

  // Resumen por rol de cuenta: qué rutas admiten (según authorize) y cuántas son del rol sin restricción.
  const porRol = {};
  for (const g of guardas) {
    const roles = g.roles.length ? g.roles : g.publica ? ['(pública)'] : ['(cualquier sesión)'];
    for (const r of roles) {
      porRol[r] ??= { rutas: 0, escritura: 0, conPermiso: 0 };
      porRol[r].rutas++;
      if (g.escribe || g.metodo !== 'GET') porRol[r].escritura++;
      if (g.permisos.length || g.soloAdminPermisos.length || g.permisosCualquiera.length) porRol[r].conPermiso++;
    }
  }

  // Uso de cada permiso en rutas (para detectar permisos huérfanos o sin ruta que los exija).
  const permisoEnRutas = {};
  for (const g of guardas) for (const p of [...g.permisos, ...g.permisosCualquiera, ...g.soloAdminPermisos, ...g.permisosInternos]) {
    (permisoEnRutas[p] ??= new Set()).add(g.id);
  }
  const permisos = (enums.Permission?.miembros ?? []).map((m) => ({ miembro: m, rutas: [...(permisoEnRutas[m] ?? [])].length }));

  // Compuertas de interfaz (RequireAccess / PermissionGate / <Route permission>)
  const compuertasUi = [];
  for (const [file, fx] of factsMap) {
    if (!['admin', 'business'].includes(fx.paquete)) continue;
    for (const r of fx.ui?.rutasPantalla ?? []) {
      for (const t of r.etiquetas) {
        if (Object.keys(t.atributos).some((k) => /permission|roles|anyOf|allOf|module|requires/.test(k))) {
          compuertasUi.push({ paquete: fx.paquete, ruta: r.ruta, archivo: file, linea: r.linea, componente: t.tag, atributos: t.atributos });
        }
      }
    }
  }

  return { enums, matrices, guardas, porRol, permisos, compuertasUi, notas: manual?.roles?.notas ?? [] };
}
