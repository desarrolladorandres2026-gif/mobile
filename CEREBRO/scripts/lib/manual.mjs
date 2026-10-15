// Datos curados a mano (manual/*.json) cuyas referencias al código se verifican en cada construcción.
// Si una referencia ya no coincide con el código, el elemento se marca «revisar» o «obsoleto»: nunca se presenta como vigente.
import fs from 'node:fs';
import path from 'node:path';
import { MANUAL_DIR, abs, readJson } from './util.mjs';

const fileCache = new Map();
function linesOf(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  let lines = null;
  try { lines = fs.readFileSync(abs(rel), 'utf8').split(/\r?\n/); } catch { /* no existe */ }
  fileCache.set(rel, lines);
  return lines;
}
export function clearManualCache() { fileCache.clear(); }

/**
 * Resuelve una referencia {archivo, linea, ancla, simbolo}.
 * Estados: ok | movida | perdida | sin-ancla | archivo-inexistente | simbolo-inexistente
 */
export function resolveRef(ref, graph, inventoryByPath) {
  const out = { ...ref, estadoRef: 'ok' };
  if (ref.simbolo) {
    const s = graph.symbols.get(ref.simbolo);
    if (!s) { out.estadoRef = 'simbolo-inexistente'; return out; }
    out.archivo = s.archivo; out.linea = ref.linea ?? s.linea; out.lineaFin = s.lineaFin; out.simboloLinea = s.linea;
    if (!ref.ancla) return out;
  }
  if (!ref.archivo) { out.estadoRef = 'sin-ancla'; return out; }
  const lines = linesOf(ref.archivo);
  if (!lines) { out.estadoRef = 'archivo-inexistente'; return out; }
  if (ref.hashArchivo && inventoryByPath.get(ref.archivo)?.hash !== ref.hashArchivo) out.archivoCambio = true;
  if (!ref.ancla) { out.estadoRef = 'sin-ancla'; return out; }
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const needle = norm(ref.ancla);
  const approx = ref.linea ?? out.linea ?? 1;
  const find = (from, to) => {
    for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) if (norm(lines[i]).includes(needle)) return i + 1;
    return null;
  };
  let hit = find(approx - 1 - 3, approx - 1 + 12);
  if (hit) { out.linea = hit; out.estadoRef = 'ok'; return out; }
  hit = find(0, lines.length);
  if (hit) { out.linea = hit; out.estadoRef = 'movida'; out.lineaOriginal = approx; return out; }
  out.estadoRef = 'perdida';
  return out;
}

function loadManualFile(name, fallback) {
  return readJson(path.join(MANUAL_DIR, name), fallback);
}

export function buildManualLayer(graph, inventory) {
  clearManualCache();
  const invBy = new Map(inventory.map((e) => [e.ruta, e]));
  const resolveAll = (refs) => (refs ?? []).map((r) => resolveRef(r, graph, invBy));
  const flujosDinero = loadManualFile('flujos-dinero.json', { flujos: [] });
  const flujosNegocio = loadManualFile('flujos-negocio.json', { flujos: [] });
  const hallazgos = loadManualFile('hallazgos.json', { hallazgos: [] });
  const integraciones = loadManualFile('integraciones.json', { integraciones: [] });
  const roles = loadManualFile('roles.json', { notas: [] });

  const resolveFlow = (fl) => {
    let rotos = 0;
    const pasos = (fl.pasos ?? []).map((p) => {
      const refs = resolveAll(p.refs);
      const mal = refs.filter((r) => !['ok', 'sin-ancla'].includes(r.estadoRef));
      rotos += mal.length;
      return { ...p, refs, estadoPaso: mal.length ? (mal.some((r) => r.estadoRef === 'movida') && mal.every((r) => r.estadoRef === 'movida') ? 'revisar' : 'obsoleto') : 'vigente' };
    });
    return { ...fl, pasos, referenciasRotas: rotos, vigencia: rotos ? 'pendiente-de-revision' : 'vigente' };
  };

  const hall = (hallazgos.hallazgos ?? []).map((h) => {
    const ev = resolveAll(h.evidencia);
    const mal = ev.filter((r) => !['ok', 'sin-ancla'].includes(r.estadoRef));
    const cambio = ev.some((r) => r.archivoCambio);
    let estado = h.estado ?? 'abierto';
    let nota = null;
    if (mal.some((r) => r.estadoRef === 'perdida' || r.estadoRef === 'archivo-inexistente' || r.estadoRef === 'simbolo-inexistente')) { estado = 'revisar'; nota = 'La evidencia ya no coincide con el código: ¿se corrigió o se movió?'; }
    else if (mal.length || cambio) { estado = estado === 'resuelto' ? estado : 'revisar'; nota = 'El archivo cambió desde que se redactó el hallazgo; confirmar que sigue vigente.'; }
    return { ...h, origen: 'manual', evidencia: ev, estado, notaVigencia: nota };
  });

  return {
    flujosDinero: (flujosDinero.flujos ?? []).map(resolveFlow),
    flujosNegocio: (flujosNegocio.flujos ?? []).map(resolveFlow),
    hallazgos: hall,
    integraciones: (integraciones.integraciones ?? []).map((i) => ({ ...i, evidencia: resolveAll(i.evidencia) })),
    roles: { ...roles, notas: roles.notas ?? [] },
    resumen: {
      flujosDinero: (flujosDinero.flujos ?? []).length,
      flujosNegocio: (flujosNegocio.flujos ?? []).length,
      hallazgos: hall.length,
      hallazgosARevisar: hall.filter((h) => h.estado === 'revisar').length,
    },
  };
}
