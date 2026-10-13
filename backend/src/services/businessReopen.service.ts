import { businessService } from './business.service';

// Barrido de proceso: devuelve a "abierto" los negocios cuyo cierre temporal
// venció. Mismo patrón que los demás (`setInterval`, PM2 en una instancia).
// Cada minuto basta: el comercio elige tramos de 30 minutos en adelante.
let timer: ReturnType<typeof setInterval> | null = null;

export function startBusinessReopenSweeper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    businessService.reopenDue().catch((error) => console.error('[business-reopen-sweep]', error));
  }, intervalMs);
  timer.unref?.();
}

export function stopBusinessReopenSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
