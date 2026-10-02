import { RefreshCw } from 'lucide-react';
import { useUpdateAvailable } from '../lib/checkForUpdates';
import { isDesktop } from '../lib/desktop';

/**
 * Aviso de deploy nuevo, fijo arriba de toda la pantalla.
 *
 * Se queda en pantalla hasta que alguien pulsa "Actualizar ahora": en un
 * panel de comercio, recargar sin avisar puede tirar un formulario a medio
 * llenar, así que aquí la persona decide el momento.
 */
export default function UpdateBanner() {
  const { updateAvailable, applyUpdate } = useUpdateAvailable();

  // En escritorio, `useUpdateAvailable` ya recarga sola en un momento
  // tranquilo: el banner (y su botón, que nadie va a pulsar en el
  // mostrador) no aporta nada y solo parpadearía un instante antes de la
  // recarga automática.
  if (!updateAvailable || isDesktop()) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 px-4 py-2 bg-[var(--color-surface)] border-b border-[var(--color-border)] text-[var(--color-text-main)] text-xs">
      <RefreshCw className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-secondary)]" strokeWidth={2} />
      <span>Hay una nueva actualización disponible.</span>
      <button
        onClick={applyUpdate}
        className="px-3 py-1 rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] text-[var(--zipp-obsidian)] font-semibold cursor-pointer"
      >
        Actualizar ahora
      </button>
    </div>
  );
}
