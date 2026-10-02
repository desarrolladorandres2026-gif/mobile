import { powerSaveBlocker } from 'electron';
import log from 'electron-log';

/**
 * Evita que Windows suspenda el equipo mientras la app corre.
 *
 * `prevent-app-suspension` (y no `prevent-display-sleep`): la pantalla sí
 * puede apagarse —el comercio no necesita verla encendida toda la noche—,
 * pero el proceso no puede quedarse congelado o el timbre no suena cuando
 * entra un pedido a las 2 a.m.
 */

let blockerId: number | null = null;

export function startPowerSaveBlocker(): void {
  if (blockerId !== null) return;
  blockerId = powerSaveBlocker.start('prevent-app-suspension');
  log.info(`[power] bloqueo de suspensión activo (id ${blockerId})`);
}

export function stopPowerSaveBlocker(): void {
  if (blockerId === null) return;
  powerSaveBlocker.stop(blockerId);
  blockerId = null;
}
