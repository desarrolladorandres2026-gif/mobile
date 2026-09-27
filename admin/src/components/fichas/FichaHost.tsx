import { lazy, Suspense, useCallback } from 'react';
import { FICHA_CHANGED_EVENT, FICHA_VIEW_PERMISSION, useFicha } from '../../lib/entityLinks';
import { useAuthStore } from '../../stores/authStore';

/**
 * Cada ficha es un archivo aparte: solo se descarga la primera vez que
 * alguien abre una de ese tipo, no al cargar el panel.
 */
const OrderProfile360 = lazy(() => import('./OrderProfile360'));
const BusinessProfile360 = lazy(() => import('./BusinessProfile360'));
const UserProfile360 = lazy(() => import('../UserProfile360'));
const DriverProfile360 = lazy(() => import('../DriverProfile360'));

/**
 * Pinta la ficha que pide `?ficha=<tipo>:<id>`, sobre cualquier pantalla.
 *
 * Se monta una sola vez en `Layout`. Una ficha a la vez: abrir otra
 * sustituye a la actual (y"atrás" vuelve a ella, porque `open` empuja al
 * historial). Sin el permiso de vista de ese tipo no se pinta nada, aunque
 * alguien pegue el enlace a mano.
 */
export default function FichaHost() {
 const { current, close } = useFicha();
 const allowed = useAuthStore((s) =>
 current ? s.hasPermission(FICHA_VIEW_PERMISSION[current.type]) : false,
 );

 // Las páginas que listan lo que la ficha puede cambiar (domiciliarios,
 // pedidos…) escuchan este evento y se recargan.
 const notifyChanged = useCallback(() => {
 window.dispatchEvent(new CustomEvent(FICHA_CHANGED_EVENT));
 }, []);

 if (!current || !allowed) return null;

 const key = `${current.type}:${current.id}`;

 return (
 <Suspense fallback={null}>
 {current.type === 'order' ? (
 <OrderProfile360 key={key} orderId={current.id} onClose={close} />
 ) : current.type === 'business' ? (
 <BusinessProfile360 key={key} businessId={current.id} onClose={close} />
 ) : current.type === 'user' ? (
 <UserProfile360 key={key} userId={current.id} onClose={close} />
 ) : (
 <DriverProfile360 key={key} driverId={current.id} onClose={close} onChanged={notifyChanged} />
 )}
 </Suspense>
 );
}
