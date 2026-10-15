// Lectura de la instantánea vigente con índices en memoria (símbolos y aristas) para consultas rápidas.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SNAP_DIR, readJson } from './util.mjs';

export class Store {
  constructor() {
    this.id = null;
    this.dir = null;
    this.cache = new Map();
    this.sym = null; // Map id -> símbolo
    this.out = null;
    this.in = null;
    this.byFile = null;
  }

  current() {
    return readJson(path.join(DATA_DIR, 'actual.json'), null);
  }

  /** Recarga si la instantánea vigente cambió. Devuelve true si cambió. */
  refresh() {
    const cur = this.current();
    if (!cur) return false;
    if (cur.id === this.id) return false;
    this.id = cur.id;
    this.dir = path.join(SNAP_DIR, cur.id);
    this.cache.clear();
    this.sym = null; this.out = null; this.in = null; this.byFile = null;
    return true;
  }

  get(name) {
    if (!this.dir) return null;
    if (this.cache.has(name)) return this.cache.get(name);
    const v = readJson(path.join(this.dir, name), null);
    this.cache.set(name, v);
    return v;
  }

  rawPath(name) {
    return this.dir ? path.join(this.dir, name) : null;
  }

  indexGraph() {
    if (this.sym) return;
    const simbolos = this.get('simbolos.json') ?? [];
    this.sym = new Map(simbolos.map((s) => [s.id, s]));
    this.byFile = new Map();
    for (const s of simbolos) {
      if (!this.byFile.has(s.archivo)) this.byFile.set(s.archivo, []);
      this.byFile.get(s.archivo).push(s.id);
    }
    const aristas = this.get('aristas.json');
    this.out = new Map();
    this.in = new Map();
    for (const [de, a, tipo, conf, linea, via, uso] of aristas?.filas ?? []) {
      const e = { de, a, tipo, conf, linea, via, uso };
      if (!this.out.has(de)) this.out.set(de, []);
      this.out.get(de).push(e);
      if (!this.in.has(a)) this.in.set(a, []);
      this.in.get(a).push(e);
    }
  }

  search(q, { tipo = null, paquete = null, limite = 40 } = {}) {
    this.indexGraph();
    q = (q ?? '').trim().toLowerCase();
    if (!q) return [];
    const parts = q.split(/\s+/);
    const out = [];
    for (const s of this.sym.values()) {
      if (tipo && s.tipo !== tipo) continue;
      if (paquete && s.paq !== paquete) continue;
      if (s.tipo === 'modulo' && !parts.some((p) => s.archivo.toLowerCase().includes(p))) continue;
      const hay = `${s.ruta} ${s.archivo}`.toLowerCase();
      let score = 0;
      let ok = true;
      for (const p of parts) {
        if (s.nombre.toLowerCase() === p) score += 12;
        else if (s.nombre.toLowerCase().startsWith(p)) score += 8;
        else if (s.nombre.toLowerCase().includes(p)) score += 5;
        else if (hay.includes(p)) score += 2;
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (s.exportado) score += 1;
      if (s.tipo === 'inline') score -= 2;
      score += Math.min(3, Math.log2(1 + (s.entran ?? 0)) / 3);
      out.push({ score, s });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limite).map((x) => x.s);
  }

  /** Vecindad: BFS acotado en las direcciones pedidas. */
  neighborhood(id, { dir = 'both', prof = 1, tipos = null, maxNodos = 90 } = {}) {
    this.indexGraph();
    const nodes = new Map();
    const edges = [];
    const seenEdge = new Set();
    const skip = new Set(['usa-tipo', 'usa-enum']);
    const ok = (e) => !skip.has(e.tipo) && (!tipos || tipos.includes(e.tipo));
    const visit = (start, direction) => {
      let frontier = [start];
      for (let d = 0; d < prof; d++) {
        const next = [];
        for (const cur of frontier) {
          const list = direction === 'out' ? this.out.get(cur) : this.in.get(cur);
          for (const e of list ?? []) {
            if (!ok(e)) continue;
            const other = direction === 'out' ? e.a : e.de;
            if (!this.sym.has(other)) continue;
            const k = `${e.de}>${e.a}>${e.tipo}`;
            if (!seenEdge.has(k)) { seenEdge.add(k); edges.push({ ...e, nivel: d + 1 }); }
            if (!nodes.has(other) && nodes.size < maxNodos) { nodes.set(other, { nivel: d + 1, lado: direction }); next.push(other); }
          }
        }
        frontier = next;
      }
    };
    nodes.set(id, { nivel: 0, lado: 'centro' });
    if (dir === 'out' || dir === 'both') visit(id, 'out');
    if (dir === 'in' || dir === 'both') visit(id, 'in');
    return { nodos: [...nodes.entries()].map(([nid, m]) => ({ ...this.sym.get(nid), ...m })), aristas: edges.filter((e) => nodes.has(e.de) && nodes.has(e.a)) };
  }

  /** Impacto: quién deja de funcionar o debe revisarse si cambia este símbolo/archivo. */
  impact(id, { maxDepth = 6, maxNodes = 1500 } = {}) {
    this.indexGraph();
    const starts = this.sym.has(id) ? [id] : (this.byFile.get(id) ?? []);
    const seen = new Map();
    const q = [];
    for (const s of starts) { seen.set(s, 0); q.push(s); }
    while (q.length && seen.size < maxNodes) {
      const cur = q.shift();
      const d = seen.get(cur);
      if (d >= maxDepth) continue;
      for (const e of this.in.get(cur) ?? []) {
        if (e.tipo === 'usa-tipo' || e.tipo === 'implementa' || e.tipo === 'extiende') {
          // una clase extendida o interfaz impactan a sus hijos
        }
        if (seen.has(e.de)) continue;
        seen.set(e.de, d + 1);
        q.push(e.de);
      }
    }
    const symbols = [...seen.keys()].map((k) => this.sym.get(k)).filter(Boolean);
    const files = new Set(symbols.map((s) => s.archivo));
    const eps = (this.get('endpoints.json')?.endpoints ?? []).filter((e) => (e.cierre?.archivos ?? []).some((f) => files.has(f)) && symbols.some((s) => s.id === e.manejador || (e.cierre?.archivos ?? []).includes(s.archivo)));
    const handlerSet = new Set(symbols.map((s) => s.id));
    const acciones = (this.get('acciones.json')?.acciones ?? []).filter((a) => a.manejadores.some((m) => handlerSet.has(m)));
    const pruebas = (this.get('pruebas.json') ?? []).filter((t) => t.importa.some((f) => files.has(f)));
    return {
      simbolos: symbols.length,
      archivos: [...files].sort(),
      endpoints: eps.slice(0, 300).map((e) => e.id),
      acciones: acciones.slice(0, 300).map((a) => ({ id: a.id, archivo: a.archivo, linea: a.linea, etiqueta: a.etiqueta, estado: a.estado })),
      pruebas: pruebas.slice(0, 120).map((t) => t.archivo),
      muestra: symbols.filter((s) => s.tipo !== 'modulo').slice(0, 120).map((s) => ({ id: s.id, tipo: s.tipo, nivel: seen.get(s.id) })),
    };
  }
}

export function readSourceSlice(root, rel, desde, hasta) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root))) throw new Error('ruta fuera del repo');
  if (/(^|[\\/])\.env(\.|$)/.test(rel) && !/example|sample|template/.test(rel)) throw new Error('archivo de entorno bloqueado');
  const txt = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  const a = Math.max(1, desde || 1);
  const b = Math.min(txt.length, hasta || a + 60);
  return { desde: a, hasta: b, total: txt.length, lineas: txt.slice(a - 1, b) };
}
