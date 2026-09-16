import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import {
  AlertTriangle, ShieldAlert, Banknote, MessageSquareWarning, Clock,
  RotateCw, ArrowRight, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';
import SosPanel from '../components/SosPanel';

/**
 * Aviso sonoro de una emergencia nueva.
 *
 * Sin archivo de audio: dos tonos generados con Web Audio son suficientes
 * para que quien está mirando otra pestaña levante la vista, y no dependen
 * de un asset que alguien podría olvidar copiar al desplegar.
 */
function playSosBeep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.28);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.28 + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.28);
      osc.stop(ctx.currentTime + i * 0.28 + 0.26);
    });
  } catch {
    // Sin audio disponible (política de autoplay, navegador sin soporte):
    // el aviso visual del banner y la fila resaltada siguen sirviendo.
  }
}

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
  const [openAlertId, setOpenAlertId] = useState<string | null>(null);
  const [justArrived, setJustArrived] = useState<{ id: string; detail: string } | null>(null);
  const socketRef = useRef<Socket | null>(null);

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

  // Una emergencia no puede depender del refresco de 30 segundos: llega por
  // socket a la sala `admin` (el backend mete ahí a todo administrador al
  // conectar) y refresca la lista al instante, con tono y aviso propios.
  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;

    const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
    const socket: Socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    const onTriggered = (payload: { alertId: string; driverId: string }) => {
      playSosBeep();
      setJustArrived({ id: payload.alertId, detail: 'Nueva emergencia' });
      load();
    };
    const onUpdated = () => load();

    socket.on('sos:triggered', onTriggered);
    socket.on('sos:updated', onUpdated);

    return () => {
      socket.off('sos:triggered', onTriggered);
      socket.off('sos:updated', onUpdated);
      socket.disconnect();
    };
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
          className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)] shadow-xs transition-all hover:bg-[var(--color-bg)]"
        >
          <RotateCw className="h-4 w-4 text-[var(--color-primary)]" />
          <span>Actualizar</span>
        </button>
      </div>

      {justArrived ? (
        <button
          onClick={() => { setOpenAlertId(justArrived.id); setJustArrived(null); }}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger)] px-4 py-3 text-left text-white shadow-lg animate-fade-in"
        >
          <ShieldAlert className="h-5 w-5 shrink-0 animate-pulse" />
          <span className="flex-1 text-sm font-bold">
            {justArrived.detail}: un domiciliario acaba de activar el botón de pánico
          </span>
          <span className="shrink-0 text-xs font-bold underline">Atender ahora</span>
        </button>
      ) : null}

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
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => navigate('/fleet')}
                        className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
                      >
                        Ver en el mapa
                      </button>
                      <button
                        onClick={() => setOpenAlertId(incident.id)}
                        className="flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-danger)] px-3 py-1.5 text-xs font-bold text-white"
                      >
                        Atender <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
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

      {openAlertId ? (
        <SosPanel
          alertId={openAlertId}
          onClose={() => setOpenAlertId(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}
