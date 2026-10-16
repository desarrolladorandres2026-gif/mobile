import { productService } from './product.service';

// Barrido de proceso: devuelve a la carta los productos cuyo «agotado por un
// tiempo» venció. Mismo patrón que `businessReopen.service.ts` (`setInterval`,
// PM2 en una instancia). Cada minuto basta: el comercio elige tramos de 5
// minutos en adelante.
let timer: ReturnType<typeof setInterval> | null = null;

export function startProductAvailabilitySweeper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    productService.reopenDue().catch((error) => console.error('[product-availability-sweep]', error));
  }, intervalMs);
  timer.unref?.();
}

export function stopProductAvailabilitySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
