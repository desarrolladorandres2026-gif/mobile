import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ShieldAlert, Banknote, MessageSquareWarning, Clock,
  RotateCw, ArrowRight, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';

/**
 * Centro de incidentes.
 *
 * Nada de lo que aparece aquí es nuevo. Las emergencias, las alertas de
 * fraude, los faltantes de efectivo, los reclamos y los pedidos detenidos ya
 * existían — pero cada uno en su pantalla. Nadie mira cinco pantallas a la
 * vez, así que en la práctica se miraba una y las otras cuatro acumulaban.
 *
 * El orden lo decide el servidor: primero por gravedad y, dentro de la misma
 * gravedad, lo más antiguo primero. Es deliberado que las emergencias vayan
 * arriba aunque acaben de entrar: es la única categoría donde lo que está en
 * juego es una persona y no dinero.
 */

type IncidentKind = 'sos' | 'fraud' | 'cash' | 'complaint' | 'stalled_order';
type Severity = 'critical' | 'high' | 'medium';

interface Incident {
  kind: IncidentKind;
  severity: Severity;
  id: string;
  title: string;
  detail: string;
  at: string;
  userId?: string;
  orderId?: string;
}

interface Summary {
  activeSos: number;
  openFraud: number;
  openCash: number;
  openClaims: number;
  blockedUsers: number;
}

const KIND: Record<IncidentKind, { label: string; icon: LucideIcon }> = {
  sos: { label: 'Emergencia', icon: ShieldAlert },
  fraud: { label: 'Fraude', icon: AlertTriangle },
  cash: { label: 'Efectivo', icon: Banknote },
  complaint: { label: 'Reclamo', icon: MessageSquareWarning },
  stalled_order: { label: 'Pedido detenido', icon: Clock },
};

const SEVERITY: Record<Severity, { label: string; bar: string; chip: string }> = {
  critical: {
    label: 'Crítico',
    bar: 'bg-[var(--color-danger)]',
    chip: 'bg-[var(--color-danger)] text-white',
  },
  high: {
    label: 'Alto',
    bar: 'bg-[var(--color-warning)]',
    chip: 'bg-[var(--color-warning)] text-white',
  },
  medium: {
    label: 'Medio',
    bar: 'bg-[var(--color-border)]',
    chip: 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)]',
  },
};

/** Cuánto lleva esperando, que es lo que decide a qué se atiende antes. */
function waitingFor(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </p>
      <p className={`text-2xl font-bold ${tone ?? 'text-[var(--color-text-main)]'}`}>{value}</p>
    </div>
  );
}

export default function Incidents() {
  const navigate = useNavigate();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | IncidentKind>('all');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [list, totals] = await Promise.all([
        api.get('/security/incidents'),
        api.get('/security/incidents/summary'),
      ]);
      setIncidents(list.data.data ?? []);
      setSummary(totals.data.data ?? null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Un centro de incidentes que hay que refrescar a mano deja de ser un
    // centro de incidentes en cuanto alguien se distrae. Medio minuto es
    // suficiente: son consultas de conteo, no de listado pesado.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const shown = filter === 'all' ? incidents : incidents.filter((i) => i.kind === filter);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Centro de incidentes</h1>
          <p className="page-subtitle">
            Todo lo que está abierto ahora mismo, en un solo sitio y por gravedad
          </p>
        </div>
        <button
          onClick={load}
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)] shadow-xs transition-all hover:bg-[var(--color-bg)]"
        >
          <RotateCw className="h-4 w-4 text-[var(--color-primary)]" />
          <span>Actualizar</span>
        </button>
      </div>

      {summary ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="Emergencias" value={summary.activeSos} tone="text-[var(--color-danger)]" />
          <Kpi label="Fraude" value={summary.openFraud} />
          <Kpi label="Efectivo" value={summary.openCash} />
          <Kpi label="Reclamos" value={summary.openClaims} />
          <Kpi label="Cuentas bloqueadas" value={summary.blockedUsers} />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b border-[var(--color-border-light)] pb-4">
        {(['all', ...Object.keys(KIND)] as const).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key as 'all' | IncidentKind)}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filter === key
                ? 'bg-[var(--color-primary)] text-white'
                : 'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
            }`}
          >
            {key === 'all' ? 'Todo' : KIND[key as IncidentKind].label}
          </button>
        ))}
      </div>

      {loading && incidents.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Cargando…</p>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] py-16">
          <ShieldCheck className="h-8 w-8 text-[var(--color-success)]" />
          <p className="font-semibold text-[var(--color-text-main)]">No hay nada abierto</p>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Ni emergencias, ni faltantes, ni pedidos detenidos.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((incident) => {
            const kind = KIND[incident.kind];
            const severity = SEVERITY[incident.severity];
            const Icon = kind.icon;

            return (
              <li
                key={`${incident.kind}:${incident.id}`}
                className="flex items-stretch overflow-hidden rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)]"
              >
                {/* La gravedad se lee antes que el texto: es una barra de
                    color, no una etiqueta que haya que ir a buscar. */}
                <div className={`w-1 shrink-0 ${severity.bar}`} />

                <div className="flex flex-1 flex-wrap items-center gap-3 p-4">
                  <Icon className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]" />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-[var(--color-text-main)]">{incident.title}</p>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${severity.chip}`}
                      >
                        {severity.label}
                      </span>
                    </div>
                    <p className="break-words text-sm text-[var(--color-text-secondary)]">
                      {incident.detail}
                    </p>
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {kind.label} · {waitingFor(incident.at)}
                    </p>
                  </div>

                  {/* Un incidente sin a dónde ir es una notificación. Estos
                      llevan al sitio donde de verdad se resuelven. */}
                  {incident.orderId ? (
                    <button
                      onClick={() => navigate(`/orders?orderId=${incident.orderId}`)}
                      className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
                    >
                      Ver pedido <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {incident.kind === 'sos' ? (
                    <button
                      onClick={() => navigate('/fleet')}
                      className="flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-danger)] px-3 py-1.5 text-xs font-bold text-white"
                    >
                      Ver en el mapa <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {incident.kind === 'complaint' ? (
                    <button
                      onClick={() => navigate('/support')}
                      className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
                    >
                      Abrir en soporte <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
