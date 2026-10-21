import { useUpdateAvailable } from '../lib/checkForUpdates';

/**
 * Aviso de deploy nuevo, fijo arriba de toda la pantalla.
 *
 * Se queda en pantalla hasta que alguien pulsa"Actualizar ahora": en un
 * panel de administración, recargar sin avisar puede tirar un formulario a
 * medio llenar, así que aquí la persona decide el momento.
 */
export default function UpdateBanner() {
 const { updateAvailable, applyUpdate } = useUpdateAvailable();

 if (!updateAvailable) return null;

 return (
 <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 border-b border-[var(--color-border)] bg-[var(--toast-bg)] px-4 py-1 text-sm text-[var(--color-text-main)]">
 <span>Hay una nueva actualización disponible.</span>
 <button onClick={applyUpdate} className="btn btn-primary">
 Actualizar ahora
 </button>
 </div>
 );
}
