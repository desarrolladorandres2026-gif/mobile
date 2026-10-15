// Registro de cobertura: qué se inventarió, qué se indexó automáticamente y qué se auditó leyendo el código.
//
// Tres niveles, que NUNCA se mezclan:
//   inventariado   — el archivo existe en el inventario con hash y número de líneas.
//   indexado       — un analizador automático (AST o escaneo de texto) lo procesó; no implica comprensión.
//   auditado       — una persona/agente leyó esos rangos (manual/revisiones.json) y el hash sigue coincidiendo.
import { mergeRanges, rangesLineCount, readJson } from './util.mjs';
import path from 'node:path';
import { MANUAL_DIR } from './util.mjs';

export function loadReviews() {
  return readJson(path.join(MANUAL_DIR, 'revisiones.json'), { version: 1, revisiones: [] });
}

const subtract = (total, covered) => {
  // rangos de [1,total] no cubiertos por `covered` (ya fusionados)
  const out = [];
  let cur = 1;
  for (const [a, b] of covered) {
    if (a > cur) out.push([cur, a - 1]);
    cur = Math.max(cur, b + 1);
  }
  if (cur <= total) out.push([cur, total]);
  return out;
};

export function buildCoverage(inventory, factsMap, reviewsFile) {
  const revs = reviewsFile?.revisiones ?? [];
  const revByFile = new Map();
  for (const r of revs) {
    if (!revByFile.has(r.archivo)) revByFile.set(r.archivo, []);
    revByFile.get(r.archivo).push(r);
  }
  const archivos = [];
  for (const e of inventory) {
    const total = e.lineas ?? 0;
    const fx = factsMap.get(e.ruta);
    const rec = {
      ruta: e.ruta, paquete: e.paquete, clase: e.clase, modo: e.modo, lineas: total, hash: e.hash,
      nivel: 'inventariado', indexado: null, auditado: null, limitaciones: [],
    };
    if (e.modo === 'ast') {
      if (fx) {
        // `rangosIndexados` = sentencias de nivel superior visitadas por el recorrido AST.
        const rg = mergeRanges(fx.rangosIndexados ?? []);
        rec.indexado = { metodo: 'ast', rangos: rg, lineas: rangesLineCount(rg), simbolos: fx.simbolos.length, aristas: fx.aristas.length, erroresSintaxis: fx.erroresSintaxis };
        rec.nivel = 'indexado';
        if (fx.erroresSintaxis) rec.limitaciones.push(`${fx.erroresSintaxis} errores de sintaxis: el AST puede estar incompleto`);
        if (e.paquete === 'web') rec.limitaciones.push('web/ no tiene node_modules: tipos de terceros sin resolver (los símbolos del propio repo sí)');
        if (e.paquete === 'desktop') rec.limitaciones.push('desktop/ no tiene node_modules: tipos de Electron sin resolver');
      } else {
        rec.limitaciones.push('El analizador no produjo hechos para este archivo');
      }
    } else if (e.modo === 'texto') {
      rec.indexado = { metodo: 'escaneo-texto', rangos: total ? [[1, total]] : [], lineas: total };
      rec.nivel = 'indexado';
      rec.limitaciones.push('Solo escaneo de texto (secretos, variables, marcadores); sin análisis semántico');
    } else {
      rec.motivoExclusion = e.motivo ?? null;
      rec.nivel = 'excluido';
    }
    // Auditoría por lectura
    const rs = revByFile.get(e.ruta) ?? [];
    if (rs.length) {
      const vigentes = rs.filter((r) => r.hash === e.hash);
      const obsoletas = rs.filter((r) => r.hash !== e.hash);
      const rg = mergeRanges(vigentes.flatMap((r) => r.rangos));
      rec.auditado = {
        rangos: rg, lineas: rangesLineCount(rg), por: [...new Set(vigentes.map((r) => r.revisor))],
        pendienteDeRevision: obsoletas.length > 0 && rg.length === 0 ? mergeRanges(obsoletas.flatMap((r) => r.rangos)) : [],
        revisionesObsoletas: obsoletas.length,
        notas: vigentes.map((r) => r.nota).filter(Boolean).slice(0, 5),
      };
      if (rg.length || obsoletas.length) rec.nivel = rec.nivel === 'indexado' ? 'indexado+auditado' : rec.nivel;
      if (!rg.length && obsoletas.length) rec.nivel = 'indexado';
    }
    rec.pendienteAuditoria = e.modo === 'ninguno' || !total ? [] : subtract(total, rec.auditado?.rangos ?? []);
    archivos.push(rec);
  }
  return { archivos, resumen: summarize(archivos) };
}

function summarize(archivos) {
  const mk = () => ({ archivos: 0, lineas: 0, analizables: 0, lineasAnalizables: 0, indexadosArchivos: 0, indexadasLineas: 0, auditadosArchivos: 0, auditadasLineas: 0, excluidos: 0, lineasExcluidas: 0, sinHechos: 0 });
  const total = mk();
  const porPaquete = {};
  const porClase = {};
  const add = (acc, a) => {
    acc.archivos++; acc.lineas += a.lineas;
    if (a.nivel === 'excluido') { acc.excluidos++; acc.lineasExcluidas += a.lineas; return; }
    acc.analizables++; acc.lineasAnalizables += a.lineas;
    if (a.indexado) { acc.indexadosArchivos++; acc.indexadasLineas += a.indexado.lineas; } else acc.sinHechos++;
    if (a.auditado?.lineas) { acc.auditadosArchivos++; acc.auditadasLineas += a.auditado.lineas; }
  };
  for (const a of archivos) {
    add(total, a);
    add((porPaquete[a.paquete] ??= mk()), a);
    add((porClase[a.clase] ??= mk()), a);
  }
  return { total, porPaquete, porClase };
}
