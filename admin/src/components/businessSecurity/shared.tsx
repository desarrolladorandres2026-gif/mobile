import { Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import { deviceLabel, PLATFORM_LABELS, ROLE_LABELS } from './labels';
import type { MemberRef } from './types';

/**
 * Piezas comunes de las tres pestañas. Sin cajas: tipografía, color de texto
 * y líneas finas. Solo componentes (las clases y formatos viven en
 * `labels.ts`), para que Fast Refresh siga funcionando en este archivo.
 */

export function PlatformIcon({ platform, className = 'h-4 w-4' }: { platform?: string; className?: string }) {
  const Icon = platform === 'mobile' ? Smartphone : platform === 'tablet' ? Tablet : Monitor;
  return <Icon className={`${className} shrink-0 text-[var(--color-text-muted)]`} strokeWidth={1.75} aria-label={PLATFORM_LABELS[platform ?? 'unknown']} />;
}

export function UserCell({ user }: { user: MemberRef }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold">{user.name}</p>
      <p className="truncate text-[11px] text-[var(--color-text-secondary)]">
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
    <div className="flex min-w-0 items-start gap-2">
      <PlatformIcon platform={device.platform} className="mt-0.5 h-4 w-4" />
      <div className="min-w-0">
        <p className="truncate font-semibold">{deviceLabel(device)}</p>
        <p className="flex flex-wrap gap-x-2 text-[11px] text-[var(--color-text-secondary)]">
          <span>{PLATFORM_LABELS[device.platform] ?? PLATFORM_LABELS.unknown}</span>
          {device.shortId && <span className="tabular">{device.shortId}</span>}
          {!device.identified && <span className="font-bold text-[var(--color-text-main)]">Sin identificar</span>}
          {device.identified && device.isNew && <span className="font-bold text-[var(--color-text-main)]">Nuevo</span>}
        </p>
      </div>
    </div>
  );
}

export function MfaMark() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-success)]" title="La sesión se abrió pasando la verificación en dos pasos">
      <ShieldCheck className="h-3.5 w-3.5" /> 2FA
    </span>
  );
}

export function StateLine({ loading, error, empty, children }: { loading: boolean; error: string; empty: boolean; children: React.ReactNode }) {
  if (loading) return <p className="py-6 text-xs text-[var(--color-text-secondary)]">Cargando…</p>;
  if (error) return <p className="py-6 text-xs font-semibold text-[var(--color-danger)]">{error}</p>;
  if (empty) return <p className="py-6 text-xs text-[var(--color-text-secondary)]">Nada que coincida con estos filtros.</p>;
  return <>{children}</>;
}
