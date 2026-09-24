export interface DriverListItem {
  _id: string;
  userId?: {
    _id: string;
    name: string;
    phone?: string;
    email?: string;
    avatar?: string;
    documentType?: string;
    documentNumber?: string;
    lastLoginAt?: string;
    isBlocked?: boolean;
    createdAt?: string;
  };
  vehicleType: string;
  licensePlate?: string;
  status: string;
  isActive: boolean;
  isApproved: boolean;
  baseFund: number;
  currentFund: number;
  rating: number;
  totalReviews?: number;
  totalDeliveries: number;
  lastLocationAt?: string;
  createdAt: string;
}

export type DriverAccountState = 'pending' | 'active' | 'suspended';

export function driverAccountState(d: Pick<DriverListItem, 'isApproved' | 'isActive'>): DriverAccountState {
  if (!d.isApproved) return 'pending';
  return d.isActive ? 'active' : 'suspended';
}

export const accountStateStyles: Record<DriverAccountState, { label: string; text: string }> = {
  pending: { label: 'Pendiente de aprobación', text: 'text-[var(--color-warning)]' },
  active: { label: 'Activo', text: 'text-[#047857]' },
  suspended: { label: 'Suspendido', text: 'text-[var(--color-danger)]' },
};

export const availabilityStyles: Record<string, { label: string; text: string; dot: string }> = {
  available: { label: 'Disponible', text: 'text-[#047857]', dot: 'bg-[var(--color-success)]' },
  busy: { label: 'Ocupado', text: 'text-[#B45309]', dot: 'bg-[var(--color-warning)]' },
  offline: { label: 'Desconectado', text: 'text-[var(--color-text-muted)]', dot: 'bg-[var(--color-text-muted)]' },
};

export const vehicleLabel = (type?: string) =>
  type === 'motorcycle' ? 'Moto' : type === 'bicycle' ? 'Bicicleta' : '—';

export const money = (value?: number) => `$${(value || 0).toLocaleString('es-CO')}`;

export const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('es-CO') : '—');

export const dateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export function relativeTime(iso?: string): string {
  if (!iso) return 'Sin registro';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'Ahora';
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `Hace ${days} d` : day(iso);
}
