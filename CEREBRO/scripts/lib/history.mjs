// Historial de cambios: diferencia entre dos instantáneas, con niveles de certeza distintos.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, nowIso } from './util.mjs';

const FINANCE_FILE = /(pricing|payment|payout|refund|coupon|ledger|commission|cashReconciliation|cashIncident|adInvoice|settle|wompi|gatewayFee|money|pro\.service|referral|fiscal|proSimulation)/i;

const J = (dir, name) => readJson(path.join(dir, name), null);

export function diffSnapshots(prevDir, newDir, archivosCambiados, invByPath, hashAnterior, modo) {
  const prevInv = J(prevDir, 'inventario.json');
  const newInv = J(newDir, 'inventario.json');
  if (!prevInv || !newInv) return null;
  const pm = new Map(prevInv.archivos.map((e) => [e.ruta, e]));
  const nm = new Map(newInv.archivos.map((e) => [e.ruta, e]));
  const archivos = [];
  const removed = [];
  const added = [];
  for (const [r, e] of nm) {
    const p = pm.get(r);
    if (!p) added.push(e);
    else if (p.hash !== e.hash) archivos.push({ ruta: r, accion: 'modificado', lineas: [p.lineas, e.lineas], paquete: e.paquete });
  }
  for (const [r, e] of pm) if (!nm.has(r)) removed.push(e);
  // Renombrados: mismo contenido, distinta ruta.
  const removedByHash = new Map(removed.map((e) => [e.hash, e]));
  for (const a of added) {
    const m = removedByHash.get(a.hash);
    if (m) { archivos.push({ ruta: a.ruta, anterior: m.ruta, accion: 'renombrado', lineas: [m.lineas, a.lineas], paquete: a.paquete }); removedByHash.delete(a.hash); }
    else archivos.push({ ruta: a.ruta, accion: 'nuevo', lineas: [null, a.lineas], paquete: a.paquete });
  }
  for (const m of removedByHash.values()) archivos.push({ ruta: m.ruta, accion: 'eliminado', lineas: [m.lineas, null], paquete: m.paquete });

  const prevSym = J(prevDir, 'simbolos.json') ?? [];
  const newSym = J(newDir, 'simbolos.json') ?? [];
  const ps = new Map(prevSym.map((s) => [s.id, s]));
  const ns = new Map(newSym.map((s) => [s.id, s]));
  const sAdd = [];
  const sDel = [];
  const sChanged = [];
  for (const [id, s] of ns) {
    const p = ps.get(id);
    if (!p) sAdd.push(s);
    else if ((p.hashCuerpo ?? null) !== (s.hashCuerpo ?? null) || (p.firma ?? null) !== (s.firma ?? null)) sChanged.push({ id, firmaAntes: p.firma ?? null, firmaDespues: s.firma ?? null });
  }
  for (const [id, s] of ps) if (!ns.has(id)) sDel.push(s);
  // Posibles renombrados de símbolos (mismo archivo y mismo cuerpo).
  const renombrados = [];
  const delByKey = new Map();
  for (const s of sDel) if (s.hashCuerpo) delByKey.set(`${s.archivo}|${s.hashCuerpo}`, s);
  for (const s of sAdd) {
    const d = s.hashCuerpo ? delByKey.get(`${s.archivo}|${s.hashCuerpo}`) : null;
    if (d) renombrados.push({ de: d.id, a: s.id });
  }
  const renDe = new Set(renombrados.map((r) => r.de));
  const renA = new Set(renombrados.map((r) => r.a));

  const pe = J(prevDir, 'endpoints.json')?.endpoints ?? [];
  const ne = J(newDir, 'endpoints.json')?.endpoints ?? [];
  const pem = new Map(pe.map((e) => [e.id, e]));
  const nem = new Map(ne.map((e) => [e.id, e]));
  const epAdd = ne.filter((e) => !pem.has(e.id)).map((e) => e.id);
  const epDel = pe.filter((e) => !nem.has(e.id)).map((e) => e.id);
  const epGuardas = [];
  for (const [id, e] of nem) {
    const p = pem.get(id);
    if (p && JSON.stringify(p.guardas) !== JSON.stringify(e.guardas)) epGuardas.push({ id, antes: p.guardas, despues: e.guardas });
  }

  const pa = J(prevDir, 'acciones.json')?.acciones ?? [];
  const na = J(newDir, 'acciones.json')?.acciones ?? [];
  const pam = new Map(pa.map((a) => [a.id, a.estado]));
  const nam = new Map(na.map((a) => [a.id, a.estado]));
  const accAdd = na.filter((a) => !pam.has(a.id)).length;
  const accDel = pa.filter((a) => !nam.has(a.id)).length;
  const accEstado = na.filter((a) => pam.has(a.id) && pam.get(a.id) !== a.estado).map((a) => ({ id: a.id, antes: pam.get(a.id), despues: a.estado })).slice(0, 80);

  // Finanzas: constantes de configuración y archivos del dominio.
  const pc = new Map((J(prevDir, 'estados.json')?.constantes ?? []).map((c) => [c.id, c.texto]));
  const nc = new Map((J(newDir, 'estados.json')?.constantes ?? []).map((c) => [c.id, c.texto]));
  const constCambiadas = [];
  for (const [id, t] of nc) if (pc.has(id) && pc.get(id) !== t) constCambiadas.push({ id, antes: pc.get(id), despues: t });
  const financeFiles = archivos.filter((a) => FINANCE_FILE.test(a.ruta) && !/__tests__|\.test\./.test(a.ruta)).map((a) => a.ruta);

  // Módulos impactados: paquetes tocados + importadores directos.
  const gr = J(newDir, 'archivos-grafo.json');
  const changedPaths = new Set(archivos.filter((a) => a.accion !== 'eliminado').map((a) => a.ruta));
  const impactados = new Set();
  if (gr) for (const [de, a] of gr.filas) if (changedPaths.has(a) && !changedPaths.has(de)) impactados.add(de);
  const impactoEndpoints = [];
  if (changedPaths.size) for (const e of ne) if ((e.cierre?.archivos ?? []).some((f) => changedPaths.has(f))) impactoEndpoints.push(e.id);

  return {
    ts: nowIso(),
    tipo: modo,
    archivos,
    paquetes: [...new Set(archivos.map((a) => a.paquete))],
    simbolos: {
      agregados: sAdd.filter((s) => !renA.has(s.id)).map((s) => ({ id: s.id, tipo: s.tipo })).slice(0, 300),
      eliminados: sDel.filter((s) => !renDe.has(s.id)).map((s) => ({ id: s.id, tipo: s.tipo })).slice(0, 300),
      renombradosProbables: renombrados.slice(0, 100),
      firmasCambiadas: sChanged.filter((c) => c.firmaAntes !== c.firmaDespues).slice(0, 100),
      cuerpoCambiado: sChanged.length,
    },
    endpoints: { agregados: epAdd, eliminados: epDel, guardasCambiadas: epGuardas.slice(0, 50), contratoCambiado: epGuardas.length > 0 },
    acciones: { agregadas: accAdd, eliminadas: accDel, cambiosDeEstado: accEstado },
    finanzas: { constantesCambiadas: constCambiadas, archivosDelDominio: financeFiles, reglaFinancieraCambio: constCambiadas.length > 0 || financeFiles.length > 0 },
    impacto: { importadoresDirectos: [...impactados].slice(0, 100), endpointsAfectados: impactoEndpoints.slice(0, 100) },
    // Cuatro niveles distintos; el cambio solo sube de nivel con evidencia propia.
    niveles: { detectado: true, analizado: true, probado: false, verificadoEnEjecucion: false },
  };
}

export function readHistory(file, limit = 200) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}
