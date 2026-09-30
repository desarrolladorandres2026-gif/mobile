import { useRealtime, type ConnectionStatus as Status } from '../hooks/realtimeContext';

const LABEL: Record<Status, string> = {
  online: 'En línea',
  connecting: 'Conectando…',
  offline: 'Sin conexión',
};

const DOT: Record<Status, string> = {
  online: 'bg-[var(--color-success)]',
  connecting: 'bg-[var(--color-warning)] animate-pulse',
  offline: 'bg-[var(--color-danger)]',
};

/**
 * ¿Le están llegando los pedidos a este panel? Es lo primero que el comercio
 * necesita saber para fiarse del timbre: un panel sordo se ve igual que uno
 * sin pedidos. Discreto mientras todo va bien.
 */
export default function ConnectionStatus() {
  const { status } = useRealtime();
  return (
    <span
      role="status"
      title="Conexión con ZIPP para recibir pedidos"
      className="hidden sm:flex items-center gap-2 text-xs font-semibold text-[var(--color-text-secondary)]"
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[status]}`} />
      {LABEL[status]}
    </span>
  );
}
