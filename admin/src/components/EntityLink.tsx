import type { ReactNode } from 'react';
import { FICHA_VIEW_PERMISSION, useFicha } from '../lib/entityLinks';
import type { FichaType } from '../lib/entityLinks';
import { useAuthStore } from '../stores/authStore';

interface EntityLinkProps {
 type: FichaType;
 /** Sin id (dato borrado, campo no poblado) se pinta como texto plano. */
 id?: string | null;
 children: ReactNode;
 className?: string;
 /** Sin permiso o sin id, no pintar nada en vez de texto plano (para textos como"Ver pedido"). */
 hideWhenDenied?: boolean;
}

/**
 * Nombre de un pedido, comercio, cliente o domiciliario que abre su ficha.
 *
 * Hereda el color y el tamaño del texto que lo rodea: solo se subraya al
 * apuntarlo. Si quien mira no tiene el permiso de vista de ese tipo, o no hay
 * id al que ir, es texto plano: un enlace que termina en un 403 es peor que
 * no tener enlace.
 */
export default function EntityLink({ type, id, children, className = '', hideWhenDenied = false }: EntityLinkProps) {
 const { open } = useFicha();
 const allowed = useAuthStore((s) => s.hasPermission(FICHA_VIEW_PERMISSION[type]));

 if (!id || !allowed) {
 return hideWhenDenied ? null : <span className={className}>{children}</span>;
 }

 return (
 <button
 type="button"
 onClick={(e) => {
 // Vive dentro de filas y tarjetas que también son clicables.
 e.stopPropagation();
 open(type, id);
 }}
 className={`cursor-pointer text-left underline-offset-2 hover:text-[var(--color-text-main)] hover:underline ${className}`}
 >
 {children}
 </button>
 );
}
