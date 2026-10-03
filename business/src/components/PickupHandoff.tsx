import { useEffect, useState } from 'react';
import { Lock, Bike, Camera, ShieldAlert } from 'lucide-react';
import api from '../services/api';
import { clock, type BusinessOrder, type FlowState } from '../lib/orderFlow';

/**
 * Lo que el comercio necesita ver sin abrir nada, mientras el
 * domiciliario viene o ya está en el mostrador: quién es, si llegó, y el
 * código que debe pedirle antes de entregarle el pedido.
 *
 * El código se trae de `/orders/:id/flow` y no del listado: es un dato
 * aparte, guardado por separado, y el servidor solo se lo entrega a la
 * parte que le toca en el momento que le toca —aquí, mientras el pedido
 * está "listo" y su código sigue sin usarse. El panel no decide qué
 * ocultar; recibe ya solo lo que puede ver.
 */
export default function PickupHandoff({
  order,
  refreshKey = 0,
}: {
  order: BusinessOrder;
  /** Sube con cada evento en vivo del pedido y fuerza una relectura. */
  refreshKey?: number;
}) {
  const [flow, setFlow] = useState<FlowState | null>(null);
  const driver = order.driverId;
  const driverId = driver?._id;

  useEffect(() => {
    if (!driverId) { setFlow(null); return; }
    let alive = true;
    api
      .get(`/orders/${order._id}/flow`)
      .then(({ data }) => { if (alive) setFlow(data.data); })
      .catch(() => { if (alive) setFlow(null); });
    return () => { alive = false; };
  }, [order._id, order.status, driverId, refreshKey]);

  if (!driver) {
    return (
      <span className="text-xs text-[var(--color-text-secondary)]">
        Esperando domiciliario…
      </span>
    );
  }

  const driverName = driver.userId?.name || 'Domiciliario';
  const arrived = flow?.pickup?.arrivedAt;
  const code = flow?.pickup?.code;
  const hasEvidence = !!flow?.pickup?.evidence;
  const locked = flow?.pickup?.lockedUntil;

  return (
    <div className="flex flex-col items-start md:items-end gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-main)]">
        <Bike className="w-3.5 h-3.5 text-[var(--color-primary)]" />
        {driverName}
      </span>

      {!arrived ? (
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">
          En camino al local…
        </span>
      ) : (
        <>
          <span className="text-[10px] font-semibold text-[var(--color-text-muted)]">
            Llegó a las {clock(arrived)}
          </span>

          <span
            className={`flex items-center gap-1 text-[10px] font-semibold ${
              hasEvidence ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'
            }`}
          >
            <Camera className="w-3 h-3" />
            {hasEvidence ? 'Evidencia registrada' : 'Falta la foto de recogida'}
          </span>

          {/*
            Un código bloqueado no es un detalle técnico: significa que
            quien está en el mostrador ha fallado el código cinco veces, y
            el comercio tiene que saber que no debe entregarle nada.
          */}
          {locked ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--color-danger-bg)] border border-[var(--color-danger)]/40 text-[10px] font-semibold text-[var(--color-danger)]">
              <ShieldAlert className="w-3.5 h-3.5" />
              Código bloqueado — no entregues el pedido
            </span>
          ) : code ? (
            <span
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[var(--color-primary-bg)] border border-[var(--color-primary)]/40"
              title="Dicta este código al domiciliario antes de entregarle el pedido"
            >
              <Lock className="w-3.5 h-3.5 text-[var(--color-primary-dark)]" />
              <span className="font-mono font-semibold text-sm tracking-[0.2em] text-[var(--color-primary-dark)]">
                {code}
              </span>
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
