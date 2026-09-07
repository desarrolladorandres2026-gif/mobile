import { useEffect, useState } from 'react';
import {
  ShoppingBag, Check, ChefHat, PackageCheck, Bike, MapPin, Camera,
  ShieldCheck, ShieldAlert, Navigation, CircleCheck, CircleX, Clock,
  type LucideIcon,
} from 'lucide-react';
import api from '../services/api';
import { clock } from '../lib/orderFlow';

/**
 * La historia del pedido, tal como la cuenta el servidor.
 *
 * No se deduce de los campos del pedido: se pide a `/orders/:id/timeline`,
 * que devuelve los hitos con su actor. La diferencia importa cuando hay
 * una reclamación — "salió del local a las 19:42, lo recogió Andrés
 * Buitrago" es una respuesta; "el pedido está entregado" no lo es.
 *
 * Se dibuja como un raíl y no como una lista de tarjetas: son catorce
 * pasos y encerrar cada uno en su caja convierte una secuencia en un
 * inventario.
 */

interface TimelineEntry {
  action: string;
  label: string;
  at: string;
  actor: { id: string | null; name: string | null; role: string } | null;
  derived: boolean;
  incident: boolean;
}

const ICONS: Record<string, LucideIcon> = {
  order_created: ShoppingBag,
  order_accepted: Check,
  order_preparing: ChefHat,
  order_ready: PackageCheck,
  driver_assigned: Bike,
  arrived_pickup: MapPin,
  evidence_pickup_evidence: Camera,
  code_verified_pickup: ShieldCheck,
  code_failed_pickup: ShieldAlert,
  order_picked_up: PackageCheck,
  order_on_way: Navigation,
  arrived_delivery: MapPin,
  evidence_delivery_evidence: Camera,
  code_verified_delivery: ShieldCheck,
  code_failed_delivery: ShieldAlert,
  order_delivered: CircleCheck,
  order_cancelled: CircleX,
};

const ROLE_LABELS: Record<string, string> = {
  client: 'Cliente',
  business: 'Comercio',
  driver: 'Domiciliario',
  admin: 'Soporte ZIPP',
};

export default function OrderTimeline({ orderId }: { orderId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setFailed(false);

    api
      .get(`/orders/${orderId}/timeline`)
      .then(({ data }) => { if (alive) setEntries(data.data ?? []); })
      .catch(() => { if (alive) setFailed(true); });

    return () => { alive = false; };
  }, [orderId]);

  if (failed) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-3">
        No pudimos cargar el historial de este pedido.
      </p>
    );
  }

  if (!entries) {
    return (
      <div className="space-y-3 py-2" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <span className="w-6 h-6 rounded-full bg-[var(--color-bg-alt)] animate-pulse shrink-0" />
            <span className="h-3 flex-1 max-w-40 rounded bg-[var(--color-bg-alt)] animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-3">
        Todavía no hay movimientos registrados.
      </p>
    );
  }

  return (
    <ol className="relative">
      {entries.map((entry, index) => {
        const Icon = ICONS[entry.action] ?? Clock;
        const last = index === entries.length - 1;

        const tint = entry.incident
          ? 'text-[var(--color-danger)] bg-[var(--color-danger-bg)]'
          : 'text-[var(--color-primary)] bg-[var(--color-primary-bg)]';

        return (
          <li key={`${entry.action}-${entry.at}-${index}`} className="flex gap-3 pb-4 last:pb-0">
            {/* Raíl: el punto y la línea que lo une con el siguiente hito. */}
            <div className="flex flex-col items-center shrink-0">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center ${tint}`}>
                <Icon className="w-3.5 h-3.5" />
              </span>
              {!last && <span className="w-px flex-1 mt-1 bg-[var(--color-border)]" />}
            </div>

            <div className="min-w-0 flex-1 -mt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <p
                  className={`text-xs font-semibold ${
                    entry.incident
                      ? 'text-[var(--color-danger)]'
                      : 'text-[var(--color-text-main)]'
                  }`}
                >
                  {entry.label}
                </p>
                <time className="text-[11px] tabular text-[var(--color-text-muted)] shrink-0">
                  {clock(entry.at)}
                </time>
              </div>

              <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                {entry.actor?.name
                  ? `${entry.actor.name} · ${ROLE_LABELS[entry.actor.role] ?? entry.actor.role}`
                  : /*
                     * Un hito derivado se reconstruyó desde la fecha del
                     * pedido y no tiene firma. Decirlo es más útil que
                     * dejar el hueco en blanco: explica por qué a este
                     * paso le falta el nombre y a los demás no.
                     */
                    'Registrado antes de la bitácora actual'}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
