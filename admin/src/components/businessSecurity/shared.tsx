import { deviceLabel, PLATFORM_LABELS, ROLE_LABELS } from './labels';
import type { MemberRef } from './types';

/**
 * Piezas comunes de las tres pestañas. Sin cajas: tipografía, color de texto
 * y líneas finas. Solo componentes (las clases y formatos viven en
 * `labels.ts`), para que Fast Refresh siga funcionando en este archivo.
 */

export function UserCell({ user }: { user: MemberRef }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold">{user.name}</p>
      <p className="truncate text-xs text-[var(--color-text-secondary)]">
        {user.businessRole ? ROLE_LABELS[user.businessRole] : 'Sin acceso actual'}
        {user.email ? ` · ${user.email}` : ''}
      </p>
    </div>
  );
}

export function DeviceCell({
  device,
}: {
  device: { platform: string; os: string; osVersion: string | null; browser: string; browserVersion: string | null; shortId: string | null; identified: boolean; isNew: boolean };
}) {
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold">{deviceLabel(device)}</p>
      <p className="flex flex-wrap gap-x-2 text-xs text-[var(--color-text-secondary)]">
        <span>{PLATFORM_LABELS[device.platform] ?? PLATFORM_LABELS.unknown}</span>
        {device.shortId && <span className="tabular">{device.shortId}</span>}
        {!device.identified && <span className="font-semibold text-[var(--color-text-main)]">Sin identificar</span>}
        {device.identified && device.isNew && <span className="font-semibold text-[var(--color-text-main)]">Nuevo</span>}
      </p>
    </div>
  );
}

export function MfaMark() {
  return (
    <span className="state-ok text-xs" title="La sesión se abrió pasando la verificación en dos pasos">
      Verificación en dos pasos
    </span>
  );
}

export function StateLine({ loading, error, empty, children }: { loading: boolean; error: string; empty: boolean; children: React.ReactNode }) {
  if (loading) return <p className="state-line">Cargando…</p>;
  if (error) return <p className="state-line state-line-error">{error}</p>;
  if (empty) return <p className="state-line">Nada que coincida con estos filtros.</p>;
  return <>{children}</>;
}
