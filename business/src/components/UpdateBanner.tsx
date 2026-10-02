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
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 px-4 py-2.5 bg-[var(--color-primary)] text-white text-xs font-semibold shadow-lg animate-fade-in">
      <RefreshCw className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
      <span>Hay una nueva actualización disponible.</span>
      <button
        onClick={applyUpdate}
        className="px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 border border-white/30 font-bold uppercase tracking-wide text-[10px] transition-colors cursor-pointer"
      >
        Actualizar ahora
      </button>
    </div>
  );
}
