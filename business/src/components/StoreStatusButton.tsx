import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Power, X } from 'lucide-react';

/**
 * Interruptor Abierto / Cerrado del local, con el mismo formato que los demás
 * items de la barra: icono grande y el estado debajo.
 *
 * El estado no es solo `isActive`. Un local abierto pero suspendido por ZIPP
 * o sin aprobar no recibe pedidos, y antes eso solo lo decía un texto oculto
 * para lectores de pantalla: el comercio veía "Abierto" en verde sin pedidos.
 *
 * Abrir es un toque. Cerrar pide elegir por cuánto tiempo: un cierre "por un
 * rato" que nadie reabre son ventas perdidas, y el servidor lo reabre solo.
 */

export interface StoreStatusBusiness {
  isActive?: boolean;
  isSuspended?: boolean;
  suspensionReason?: string;
  isApproved?: boolean;
  reopenAt?: string | null;
}

interface Props {
  business: StoreStatusBusiness | null;
  busy: boolean;
  /** Sin `store:toggle` el botón se queda como indicador de estado. */
  canToggle: boolean;
  /** Media celda del pie: solo el icono, coloreado. El estado va en el tooltip y el lector de pantalla. */
  compact?: boolean;
  onSetOpen: (next: boolean, closeMinutes?: number) => void;
}

const CLOSE_OPTIONS: Array<{ label: string; minutes?: number }> = [
  { label: '30 minutos', minutes: 30 },
  { label: '1 hora', minutes: 60 },
  { label: '2 horas', minutes: 120 },
  { label: 'Hasta que yo lo abra' },
];

const time = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true });

type Tone = 'success' | 'danger' | 'warning';

function describe(business: StoreStatusBusiness | null): { label: string; detail?: string; hint: string; tone: Tone } {
  if (business?.isSuspended) {
    return {
      label: 'Suspendido',
      hint: `ZIPP suspendió este local${business.suspensionReason ? `: ${business.suspensionReason}` : ''}. No recibe pedidos hasta que soporte levante la suspensión.`,
      tone: 'warning',
    };
  }
  if (business && business.isApproved === false) {
    return {
      label: 'Sin aprobar',
      hint: 'Tu local aún no está aprobado: los clientes no lo ven hasta que ZIPP revise tus documentos.',
      tone: 'warning',
    };
  }
  if (business?.isActive === false) {
    const at = business.reopenAt ? new Date(business.reopenAt) : null;
    const valid = at && !Number.isNaN(at.getTime());
    return {
      label: 'Cerrado',
      detail: valid ? `abre ${time.format(at)}` : undefined,
      hint: valid
        ? `Tu local no recibe pedidos y se abrirá solo a las ${time.format(at)}. Púlsalo para abrir ya.`
        : 'Tu local no recibe pedidos. Púlsalo para volver a abrir.',
      tone: 'danger',
    };
  }
  return {
    label: 'Abierto',
    hint: 'Tu local está recibiendo pedidos. Púlsalo para dejar de recibirlos.',
    tone: 'success',
  };
}

const toneClass: Record<Tone, string> = {
  success: 'text-[var(--color-success)]',
  danger: 'text-[var(--color-danger)]',
  warning: 'text-[var(--color-warning)]',
};

export default function StoreStatusButton({ business, busy, canToggle, compact = false, onSetOpen }: Props) {
  const [choosing, setChoosing] = useState(false);
  // La hora de referencia de las opciones se fija al abrir el diálogo: leer el reloj en el render no es puro.
  const [openedAt, setOpenedAt] = useState(0);
  // Índice de CLOSE_OPTIONS. Arranca en el cierre más corto: si nadie toca nada, el local vuelve solo.
  const [picked, setPicked] = useState(0);
  const status = describe(business);
  const isOpen = business?.isActive !== false;

  const press = () => {
    if (busy || !business) return;
    if (isOpen) {
      setOpenedAt(Date.now());
      setPicked(0);
      setChoosing(true);
    }
    else onSetOpen(true);
  };

  const confirm = () => {
    setChoosing(false);
    onSetOpen(false, CLOSE_OPTIONS[picked].minutes);
  };

  return (
    <>
      <button
        type="button"
        onClick={press}
        disabled={!canToggle || !business}
        aria-busy={busy}
        title={status.hint}
        aria-label={`${status.label}${status.detail ? `, ${status.detail}` : ''}. ${status.hint}`}
        className={`${
          compact
            ? 'grid h-14 flex-1 place-items-center'
            : 'flex w-full items-center min-h-12 lg:min-h-[84px] px-3 lg:px-0'
        } rounded-xl cursor-pointer enabled:hover:bg-white/10 disabled:cursor-default ${toneClass[status.tone]} ${busy ? 'opacity-60' : ''}`}
      >
        {compact ? (
          <Power className="w-5 h-5" strokeWidth={1.8} />
        ) : (
        <span className="flex min-w-0 items-center gap-3 lg:w-20 lg:shrink-0 lg:flex-col lg:justify-center lg:gap-1 lg:text-center">
          <Power className="w-[30px] h-[30px] shrink-0" strokeWidth={1.8} />
          <span className="flex min-w-0 flex-col lg:w-full lg:px-0.5 lg:text-xs lg:font-medium lg:leading-tight">
            <span className="truncate text-[13px] lg:text-xs">{busy ? 'Guardando…' : status.label}</span>
            {status.detail && !busy && (
              <span className="truncate text-[11px] font-normal lg:text-[10px]">{status.detail}</span>
            )}
          </span>
        </span>
        )}
      </button>

      {/* En el body, no dentro de la barra: la barra tiene `transform` y `overflow-hidden`,
          y un `fixed` dentro de ella se encoge al ancho del riel en vez de usar la pantalla. */}
      {choosing && createPortal(
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cancelar"
            onClick={() => setChoosing(false)}
            className="absolute inset-0 bg-black/50 cursor-default"
          />
          <div role="dialog" aria-label="Dejar de recibir pedidos" className="relative w-full max-w-sm zipp-modal">
            <div className="p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Dejar de recibir pedidos</h3>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                    ¿Por cuánto tiempo? Los pedidos que ya tienes en marcha siguen su curso.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setChoosing(false)}
                  aria-label="Cerrar"
                  className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <ul role="radiogroup" aria-label="Duración del cierre" className="divide-y divide-[var(--color-border)]">
                {CLOSE_OPTIONS.map((option, index) => {
                  const selected = picked === index;
                  return (
                    <li key={option.label}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setPicked(index)}
                        className="flex w-full items-center gap-3 h-11 px-1 text-sm text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
                      >
                        <span
                          aria-hidden
                          className={`grid w-4 h-4 shrink-0 place-items-center rounded-full border ${selected ? 'border-[var(--color-primary)]' : 'border-[var(--color-border-strong)]'}`}
                        >
                          {selected && <span className="w-2 h-2 rounded-full bg-[var(--color-primary)]" />}
                        </span>
                        <span className={selected ? 'font-semibold' : ''}>{option.label}</span>
                        {option.minutes && (
                          <span className="ml-auto text-xs text-[var(--color-text-secondary)] tabular-nums">
                            abre {time.format(new Date(openedAt + option.minutes * 60_000))}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setChoosing(false)}
                  className="h-8 px-4 rounded-md text-xs font-medium text-[var(--color-text-main)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={confirm}
                  className="h-8 px-4 rounded-md text-xs font-semibold bg-[var(--color-danger)] text-white hover:opacity-90 cursor-pointer"
                >
                  Cerrar el local
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
