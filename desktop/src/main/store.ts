import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';

/**
 * Ajustes del contenedor entre arranques: `launchAtLogin`, el nombre de la
 * impresora, el ancho de papel, y un par de banderas internas (si ya vio el
 * aviso de "sigo en la bandeja", el último Abierto/Cerrado conocido para el
 * aviso de Salir). Un JSON en la carpeta de datos de la app — no hace falta
 * una base de datos para esto, y así no se añade otra dependencia nativa.
 */

type StoreData = Record<string, unknown>;

let cache: StoreData | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load(): StoreData {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache!;
}

function persist(): void {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    log.error('[store] no se pudo guardar settings.json', err);
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const data = load();
  return key in data ? (data[key] as T) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  const data = load();
  data[key] = value;
  persist();
}
