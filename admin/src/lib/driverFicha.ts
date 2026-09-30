import type { DocumentIndicator, AccountStatus } from './dossier';

/** Espejo de `DriverFicha` del backend (`driverFicha.service.ts`). */

export interface FichaDocument {
  type: string;
  label: string;
  group: 'personal' | 'vehicle';
  indicator: DocumentIndicator;
  message: string;
  documentId?: string;
  status?: string;
  reference?: string;
  uploadedAt?: string;
  issuedAt?: string;
  expiresAt?: string;
  reviewedAt?: string;
  reviewedByName?: string;
  rejectionReason?: string;
  hasFile: boolean;
}

export interface FichaHistoryItem {
  at: string;
  kind: 'registro' | 'documento' | 'vehiculo' | 'cuenta' | 'suspension' | 'sos' | 'pago' | 'liquidacion' | 'contrato';
  action: string;
  by?: string;
  detail?: string;
}

export interface DriverFicha {
  summary: {
    docsUpToDate: boolean;
    issues: string[];
    quick: Record<'identity' | 'license' | 'soat' | 'technical_review', DocumentIndicator>;
  };
  identity: {
    avatar?: string;
    birthDate?: string;
    registeredAt?: string;
    verification: 'verified' | 'in_review' | 'none';
    lastVerificationAt?: string;
  };
  vehicle: {
    type: string;
    plate?: string;
    brand?: string;
    model?: string;
    year?: number;
    color?: string;
    engineCc?: number;
    ownerName?: string;
    registrationNumber?: string;
  };
  driving: {
    licenseNumber?: string;
    category?: string;
    issuedAt?: string;
    expiresAt?: string;
    indicator: DocumentIndicator;
    message: string;
    lastValidatedAt?: string;
    validatedBy?: string;
  };
  documents: FichaDocument[];
  operation: {
    status: string;
    account: AccountStatus;
    lastConnectionAt?: string;
    connectedSeconds7d: number | null;
    connectedSeconds30d: number | null;
    activeOrders: number;
    completed: number;
    cancelled: number;
    acceptanceRate: number | null;
    cancellationRate: number | null;
    distanceKm: { last7d: number | null; last30d: number | null; coveredDays: number; truncated: boolean };
    lastLocation?: { lat: number; lng: number; at: string };
  };
  performance: {
    avgDeliveryMinutes: number | null;
    delivered7d: number;
    delivered30d: number;
    previous7d: number;
    trend: 'up' | 'down' | 'flat';
  };
  security: {
    emergencyContact?: { name: string; phone: string; relationship?: string; updatedAt?: string };
    suspensions: Array<{ action: 'suspended' | 'reactivated'; at: string; by?: string; reason?: string }>;
  };
  account: {
    createdAt?: string;
    lastLoginAt?: string;
    twoFactorEnabled: boolean;
    isBlocked: boolean;
    isActive: boolean;
    device?: { platform: string; updatedAt: string };
    trustedDevices: number;
    blocks: Array<{ action: 'blocked' | 'unblocked'; at: string; by?: string; reason?: string }>;
  };
  financeExtra: {
    totalEarned: number;
    totalPaid: number;
    totalPending: number;
    lastPayment?: { amount: number; at: string };
  } | null;
  history: FichaHistoryItem[];
}

/** "12 h 30 min"; `null` cuando aún no hay dato (no es lo mismo que cero). */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return 'Sin registro aún';
  if (seconds < 60) return '0 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** Estado operativo que lee el administrador: la suspensión manda sobre la disponibilidad. */
export function operationalLabel(account: AccountStatus, status: string): { label: string; tone: 'ok' | 'busy' | 'off' | 'danger' } {
  if (account === 'suspended') return { label: 'Suspendido', tone: 'danger' };
  if (status === 'available') return { label: 'Disponible', tone: 'ok' };
  if (status === 'busy') return { label: 'En pedido', tone: 'busy' };
  return { label: 'Desconectado', tone: 'off' };
}

export const verificationLabels = { verified: 'Verificada', in_review: 'En revisión', none: 'Sin verificar' } as const;

export const trendLabels = { up: 'Al alza', down: 'A la baja', flat: 'Estable' } as const;

export const historyKindLabels: Record<FichaHistoryItem['kind'], string> = {
  registro: 'Registro',
  documento: 'Documento',
  vehiculo: 'Vehículo',
  cuenta: 'Cuenta',
  suspension: 'Suspensión',
  sos: 'SOS',
  pago: 'Pago',
  liquidacion: 'Liquidación',
  contrato: 'Contrato',
};
