import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Eye } from 'lucide-react';
import EntityLink from './EntityLink';
import InternalNotes from './InternalNotes';
import DriverDossier from './DriverDossier';
import { Facts, Grid } from './fichas/ui';
import { PermissionGate } from './PermissionGate';
import { Permission } from '../lib/permissions';
import { dateTime, day, money, relativeTime, vehicleLabel } from '../lib/drivers';
import { indicatorStyles, openDossierFile, type DocumentIndicator } from '../lib/dossier';
import {
  formatDuration,
  historyKindLabels,
  operationalLabel,
  trendLabels,
  verificationLabels,
  type DriverFicha,
} from '../lib/driverFicha';
import type { Profile360 } from './DriverProfile360';

/**
 * Cuerpo de la ficha del domiciliario, en pestañas: Resumen, Perfil,
 * Documentos, Operación, Seguridad, Finanzas, Historial, Notas y Expediente.
 *
 * Cada dato sale de `data.ficha` (backend) o del perfil 360 que ya existía;
 * lo que el sistema no registra se rotula ("Sin registro aún"), nunca se
 * rellena. Sin cajas: tablas de datos y espacio.
 */

export type FichaTab =
  | 'summary' | 'profile' | 'documents' | 'operation' | 'security' | 'finance' | 'history' | 'notes' | 'dossier';

const sosStatusLabels: Record<string, string> = {
  active: 'Activa',
  acknowledged: 'Atendida',
  resolved: 'Resuelta',
  false_alarm: 'Falsa alarma',
};

const EMPTY = 'Sin registro';

/** Punto de estado + texto: el color solo no basta. */
function Indicator({ value, label }: { value: DocumentIndicator; label?: string }) {
  const s = indicatorStyles[value];
  return (
    <span className={`inline-flex items-center gap-2 ${s.text}`}>
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      {label ?? s.label}
    </span>
  );
}

const asText = (v: string | number | undefined | null) => (v === undefined || v === null || v === '' ? EMPTY : String(v));

/** Encabezado: estado operativo, vehículo, calificación y los cuatro documentos que habilitan. */
export function FichaHeader({ data }: { data: Profile360 }) {
  const f = data.ficha;
  const d = data.driver;
  const op = operationalLabel(f.operation.account, f.operation.status);
  const opColor =
    op.tone === 'ok' ? 'text-[#047857]' : op.tone === 'danger' ? 'text-[var(--color-danger)]' : op.tone === 'busy' ? 'text-[#B45309]' : 'text-[var(--color-text-main)]';

  const quick: Array<[string, DocumentIndicator]> = [
    ['Identidad', f.summary.quick.identity],
    ['Licencia', f.summary.quick.license],
    ['SOAT', f.summary.quick.soat],
    ['Tecnomecánica', f.summary.quick.technical_review],
  ];

  return (
    <div className="space-y-3 pt-4 text-xs">
      <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[var(--color-text-main)]">
        <span className={`font-bold ${opColor}`}>{op.label}</span>
        <span>{vehicleLabel(d.vehicleType)}{d.licensePlate ? ` · ${d.licensePlate}` : ''}</span>
        <span>{d.rating > 0 ? `${d.rating.toFixed(1)} ★ (${d.totalReviews ?? 0})` : 'Sin calificaciones'}</span>
        <span>{d.totalDeliveries ?? 0} entregas</span>
        <span className={f.summary.docsUpToDate ? '' : 'font-bold text-[var(--color-danger)]'}>
          {f.summary.docsUpToDate ? 'Documentación al día' : 'Documentación con pendientes'}
        </span>
      </p>
      <ul className="flex flex-wrap gap-x-6 gap-y-1">
        {quick.map(([label, ind]) => {
          const ok = ind === 'valid';
          const bad = ind === 'expired' || ind === 'rejected';
          return (
            <li key={label} className={`flex items-center gap-1.5 ${bad ? 'font-bold text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
              {ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />
              ) : (
                <AlertTriangle className={`h-3.5 w-3.5 ${bad ? '' : 'text-[var(--color-warning)]'}`} />
              )}
              {label}: {indicatorStyles[ind].label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const TAB_LABELS: Record<FichaTab, string> = {
  summary: 'Resumen',
  profile: 'Perfil',
  documents: 'Documentos',
  operation: 'Operación',
  security: 'Seguridad',
  finance: 'Finanzas',
  history: 'Historial',
  notes: 'Notas',
  dossier: 'Expediente',
};

export default function DriverFichaTabs({
  data,
  driverId,
  alta,
  canApprove,
  onChanged,
}: {
  data: Profile360;
  driverId: string;
  /** Bloque "Alta" mientras el domiciliario está pendiente de aprobación. */
  alta?: ReactNode;
  canApprove: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<FichaTab>('summary');
  const [fileError, setFileError] = useState('');
  const f: DriverFicha = data.ficha;
  const d = data.driver;

  const tabs: FichaTab[] = [
    'summary', 'profile', 'documents', 'operation', 'security',
    ...(data.finance ? (['finance'] as const) : []),
    'history',
    ...(data.notes !== null ? (['notes'] as const) : []),
    ...(canApprove ? (['dossier'] as const) : []),
  ];

  const view = (doc: DriverFicha['documents'][number]) =>
    doc.hasFile && canApprove ? (
      <button
        type="button"
        onClick={() => {
          setFileError('');
          openDossierFile(`/drivers/${driverId}/documents/${doc.documentId}/file`, 'inline', doc.label).catch((err) =>
            setFileError(err instanceof Error ? err.message : 'No se pudo abrir el documento.')
          );
        }}
        className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]"
      >
        <Eye className="h-3.5 w-3.5" /> Ver documento
      </button>
    ) : (
      ''
    );

  const identityNumber = [d.userId?.documentType, d.userId?.documentNumber ?? (d.userId?.documentNumberLast4 ? `•••• ${d.userId.documentNumberLast4}` : '')]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="pb-8">
      <div role="tablist" className="mb-6 flex flex-wrap gap-x-6 gap-y-1 border-b border-[var(--color-border-light)]">
        {tabs.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px cursor-pointer border-b-2 pb-2 text-xs font-bold uppercase tracking-wider ${
              tab === id
                ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
                : 'border-transparent text-[var(--color-text-secondary)]'
            }`}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>

      {fileError && (
        <p className="mb-4 flex items-center gap-1.5 font-semibold text-[var(--color-danger)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {fileError}
        </p>
      )}

      {tab === 'summary' && (
        <div className="space-y-6">
          {alta}
          {f.summary.issues.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-[var(--color-text-main)]">Qué requiere atención</h3>
              <ul className="space-y-0.5 text-[var(--color-text-main)]">
                {f.summary.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </section>
          )}
          <Facts
            title="Estado operativo"
            items={[
              ['Estado', operationalLabel(f.operation.account, f.operation.status).label],
              ['Pedidos activos', String(f.operation.activeOrders)],
              ['Última conexión', relativeTime(f.operation.lastConnectionAt)],
              ['Entregas', String(d.totalDeliveries ?? 0)],
              ['Tasa de aceptación', f.operation.acceptanceRate != null ? `${f.operation.acceptanceRate}%` : 'Sin ofertas'],
              ['Tendencia', `${trendLabels[f.performance.trend]} (${f.performance.delivered7d} vs ${f.performance.previous7d})`],
            ]}
          />
          <Grid
            title="Últimos pedidos"
            head={['Pedido', 'Estado', 'Fecha', 'Total']}
            empty="Sin pedidos todavía."
            right={[3]}
            rows={data.activity.recentOrders.slice(0, 5).map((o) => [
              <EntityLink type="order" id={o._id}>{o.orderNumber ?? 'Pedido'}</EntityLink>,
              o.status,
              day(o.createdAt),
              money(o.total),
            ])}
          />
        </div>
      )}

      {tab === 'profile' && (
        <div className="space-y-6">
          <Facts
            title="Identidad"
            items={[
              ['Nombre completo', d.userId?.name],
              ['Documento', identityNumber],
              ['Nacimiento', f.identity.birthDate ? day(f.identity.birthDate) : 'Solo en vista completa'],
              ['Teléfono', d.userId?.phone],
              ['Correo', d.userId?.email],
              ['Registro en ZIPP', day(f.identity.registeredAt)],
              ['Verificación de identidad', verificationLabels[f.identity.verification]],
              ['Última verificación', f.identity.lastVerificationAt ? day(f.identity.lastVerificationAt) : EMPTY],
            ]}
          />
          <Facts
            title="Vehículo"
            items={[
              ['Tipo', f.vehicle.type],
              ['Placa', f.vehicle.plate],
              ['Marca', asText(f.vehicle.brand)],
              ['Modelo', asText(f.vehicle.model)],
              ['Año', asText(f.vehicle.year)],
              ['Color', asText(f.vehicle.color)],
              ['Cilindraje', f.vehicle.engineCc ? `${f.vehicle.engineCc} cc` : EMPTY],
              ['Propietario', asText(f.vehicle.ownerName)],
              ['Tarjeta de propiedad', asText(f.vehicle.registrationNumber)],
            ]}
          />
          <Facts
            title="Conducción"
            items={[
              ['Número de licencia', asText(f.driving.licenseNumber)],
              ['Categoría', asText(f.driving.category)],
              ['Expedición', f.driving.issuedAt ? day(f.driving.issuedAt) : EMPTY],
              ['Vencimiento', f.driving.expiresAt ? day(f.driving.expiresAt) : EMPTY],
              ['Estado', <Indicator value={f.driving.indicator} />],
              ['Última validación', f.driving.lastValidatedAt ? `${day(f.driving.lastValidatedAt)}${f.driving.validatedBy ? ` · ${f.driving.validatedBy}` : ''}` : EMPTY],
            ]}
          />
        </div>
      )}

      {tab === 'documents' && (
        <div className="space-y-6">
          <Grid
            title="Documentación"
            head={['Documento', 'Referencia', 'Expedición', 'Vencimiento', 'Estado', 'Cargado', 'Última revisión', 'Revisó', '']}
            empty="Aún no ha subido documentos."
            rows={f.documents.map((doc) => [
              <span className="font-semibold">{doc.label}</span>,
              asText(doc.reference),
              doc.issuedAt ? day(doc.issuedAt) : '—',
              doc.expiresAt ? day(doc.expiresAt) : '—',
              <span>
                <Indicator value={doc.indicator} />
                <br />
                <span className="text-[var(--color-text-secondary)]">{doc.message}</span>
              </span>,
              doc.uploadedAt ? day(doc.uploadedAt) : '—',
              doc.reviewedAt ? day(doc.reviewedAt) : '—',
              doc.reviewedByName ?? '—',
              view(doc),
            ])}
          />
          {canApprove && (
            <p className="text-[var(--color-text-secondary)]">
              Para aprobar, rechazar, pedir una actualización o anotar una observación, usa la pestaña Expediente.
            </p>
          )}
        </div>
      )}

      {tab === 'operation' && (
        <div className="space-y-6">
          <Facts
            title="Operación"
            items={[
              ['Estado', operationalLabel(f.operation.account, f.operation.status).label],
              ['Última conexión', f.operation.lastConnectionAt ? `${relativeTime(f.operation.lastConnectionAt)} · ${dateTime(f.operation.lastConnectionAt)}` : EMPTY],
              ['Tiempo conectado 7 días', formatDuration(f.operation.connectedSeconds7d)],
              ['Tiempo conectado 30 días', formatDuration(f.operation.connectedSeconds30d)],
              ['Pedidos activos', String(f.operation.activeOrders)],
              ['Completados', String(f.operation.completed)],
              ['Cancelados', String(f.operation.cancelled)],
            ]}
          />
          <Facts
            title="Rendimiento"
            items={[
              ['Calificación', `${d.rating > 0 ? d.rating.toFixed(1) : 'S/V'} (${d.totalReviews ?? 0})`],
              ['Aceptación (30 d)', f.operation.acceptanceRate != null ? `${f.operation.acceptanceRate}%` : 'Sin ofertas'],
              ['Cancelación (30 d)', f.operation.cancellationRate != null ? `${f.operation.cancellationRate}%` : 'Sin pedidos'],
              ['Tiempo de entrega (recogida → entrega)', f.performance.avgDeliveryMinutes != null ? `${f.performance.avgDeliveryMinutes} min` : EMPTY],
              ['Pedidos 7 días', `${f.performance.delivered7d} (antes: ${f.performance.previous7d})`],
              ['Pedidos 30 días', String(f.performance.delivered30d)],
              ['Tendencia', trendLabels[f.performance.trend]],
            ]}
          />
          <Facts
            title="Recorrido y ubicación"
            items={[
              [
                'Distancia 7 días',
                f.operation.distanceKm.last7d != null ? `${f.operation.distanceKm.last7d.toLocaleString('es-CO')} km` : EMPTY,
              ],
              [
                'Distancia 30 días',
                f.operation.distanceKm.last30d != null
                  ? `${f.operation.distanceKm.last30d.toLocaleString('es-CO')} km${f.operation.distanceKm.coveredDays < 30 ? ` (${f.operation.distanceKm.coveredDays} d de rastro)` : ''}${f.operation.distanceKm.truncated ? ' · parcial' : ''}`
                  : EMPTY,
              ],
              ['Zona habitual', data.activity.coverageZones[0]?.zone ?? EMPTY],
              [
                'Última ubicación conocida',
                f.operation.lastLocation
                  ? `${f.operation.lastLocation.lat.toFixed(4)}, ${f.operation.lastLocation.lng.toFixed(4)} · ${relativeTime(f.operation.lastLocation.at)}`
                  : 'No disponible',
              ],
              ['Batería', d.batteryLevel != null ? `${d.batteryLevel}%` : EMPTY],
            ]}
          />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Grid
              title="Últimos pedidos"
              head={['Pedido', 'Estado', 'Fecha', 'Total']}
              empty="Sin pedidos todavía."
              right={[3]}
              rows={data.activity.recentOrders.map((o) => [
                <EntityLink type="order" id={o._id}>{o.orderNumber ?? 'Pedido'}</EntityLink>,
                o.status,
                day(o.createdAt),
                money(o.total),
              ])}
            />
            <div className="min-w-0 space-y-6">
              <Grid
                title="Zonas habituales (aproximado)"
                head={['Zona', 'Pedidos']}
                empty="Aún sin suficientes entregas."
                right={[1]}
                rows={data.activity.coverageZones.map((z) => [z.zone, String(z.count)])}
              />
              <Grid
                title="Calificaciones de clientes"
                head={['Fecha', 'Comentario', 'Nota']}
                empty="Sin calificaciones todavía."
                right={[2]}
                rows={data.activity.reviews.map((r) => [day(r.createdAt), r.comment ?? '', `${r.rating}★`])}
              />
            </div>
          </div>
        </div>
      )}

      {tab === 'security' && (
        <div className="space-y-6">
          <Facts
            title="Contacto de emergencia"
            items={
              f.security.emergencyContact
                ? [
                    ['Nombre', f.security.emergencyContact.name],
                    ['Parentesco', asText(f.security.emergencyContact.relationship)],
                    ['Teléfono', f.security.emergencyContact.phone],
                    ['Actualizado', f.security.emergencyContact.updatedAt ? day(f.security.emergencyContact.updatedAt) : 'Sin fecha (anterior al registro de cambios)'],
                  ]
                : [['Contacto', 'No registró contacto']]
            }
          />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Grid
              title="Alertas SOS e incidentes"
              head={['Fecha', 'Nota', 'Estado']}
              empty="Sin alertas SOS."
              rows={data.incidents.sos.map((s) => [dateTime(s.createdAt), s.note ?? '', sosStatusLabels[s.status] ?? s.status])}
            />
            <Grid
              title="Suspensiones y reactivaciones"
              head={['Fecha', 'Acción', 'Responsable', 'Motivo']}
              empty="Sin suspensiones registradas."
              rows={f.security.suspensions.map((s) => [
                dateTime(s.at),
                s.action === 'suspended' ? 'Suspendido' : 'Reactivado',
                s.by ?? '—',
                s.reason ?? 'Sin motivo registrado',
              ])}
            />
          </div>
          <Facts
            title="Cuenta ZIPP"
            items={[
              ['Creada', day(f.account.createdAt)],
              ['Último inicio de sesión', f.account.lastLoginAt ? dateTime(f.account.lastLoginAt) : EMPTY],
              ['Última conexión', f.operation.lastConnectionAt ? relativeTime(f.operation.lastConnectionAt) : EMPTY],
              ['Dispositivo actual', f.account.device ? `${f.account.device.platform} · ${relativeTime(f.account.device.updatedAt)}` : 'Sin registro'],
              ['Dispositivos autorizados', f.account.trustedDevices ? String(f.account.trustedDevices) : 'Sin registro'],
              ['2FA', f.account.twoFactorEnabled ? 'Activado' : 'No activado'],
              ['Cuenta', f.account.isBlocked ? 'Bloqueada' : f.account.isActive ? 'Activa' : 'Suspendida'],
            ]}
          />
          <Grid
            title="Bloqueos de la cuenta"
            head={['Fecha', 'Acción', 'Responsable', 'Motivo']}
            empty="Sin bloqueos registrados."
            rows={f.account.blocks.map((b) => [
              dateTime(b.at),
              b.action === 'blocked' ? 'Bloqueada' : 'Desbloqueada',
              b.by ?? '—',
              b.reason ?? '—',
            ])}
          />
          <Grid
            title="PQRS de sus pedidos"
            head={['Asunto', 'Fecha', 'Estado']}
            empty="Sin PQRS relacionadas."
            rows={data.incidents.pqrs.map((p) => [p.subject ?? 'PQRS', day(p.createdAt), p.status])}
          />
        </div>
      )}

      {tab === 'finance' && data.finance && (
        <div className="space-y-6">
          <Facts
            title="Finanzas"
            items={[
              ...(d.baseFund != null ? ([['Fondo base', money(d.baseFund)]] as Array<[string, ReactNode]>) : []),
              ...(d.currentFund != null ? ([['Fondo actual', money(d.currentFund)]] as Array<[string, ReactNode]>) : []),
              ['Deuda pendiente', money(data.finance.pendingDebts.total)],
              ['Ganancias 30 días', money(data.finance.earningsLast30Days)],
              ['Ganancias acumuladas', money(data.finance.totalEarnings ?? d.totalEarnings)],
            ]}
          />
          {f.financeExtra && (
            <Facts
              title="Pagos"
              items={[
                ['Total ganado', money(f.financeExtra.totalEarned)],
                ['Total pagado', money(f.financeExtra.totalPaid)],
                ['Pendiente de pago', money(f.financeExtra.totalPending)],
                ['Último pago', f.financeExtra.lastPayment ? `${money(f.financeExtra.lastPayment.amount)} · ${day(f.financeExtra.lastPayment.at)}` : EMPTY],
              ]}
            />
          )}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Grid
              title="Pagos al domiciliario"
              head={['Fecha', 'Estado', 'Importe']}
              empty="Sin pagos registrados."
              right={[2]}
              rows={data.finance.payouts.map((p) => [day(p.createdAt), p.status, money(p.amount)])}
            />
            <Grid
              title="Liquidaciones"
              head={['Periodo', 'Neto']}
              empty="Sin liquidaciones."
              right={[1]}
              rows={data.finance.settlements.map((s) => [`${day(s.periodStart)} – ${day(s.periodEnd)}`, money(s.netAmount)])}
            />
            <Grid
              title="Deudas de efectivo pendientes"
              head={['Fecha', 'Importe']}
              empty="No tiene deudas pendientes."
              right={[1]}
              rows={data.finance.pendingDebts.items.map((debt) => [day(debt.createdAt), money(debt.amount)])}
            />
          </div>
        </div>
      )}

      {tab === 'history' && (
        <Grid
          title="Historial"
          head={['Fecha', 'Tipo', 'Acción', 'Responsable', 'Detalle']}
          empty="Sin eventos registrados."
          rows={f.history.map((h) => [
            dateTime(h.at),
            historyKindLabels[h.kind],
            h.action,
            h.by ?? '—',
            h.detail ?? '',
          ])}
        />
      )}

      {tab === 'notes' && data.notes !== null && (
        <section className="space-y-2">
          <h3 className="text-sm font-bold text-[var(--color-text-main)]">Notas internas</h3>
          <p className="text-[var(--color-text-secondary)]">
            No registres números de tarjeta, contraseñas, tokens ni datos financieros sensibles.
          </p>
          <InternalNotes entityType="driver" entityId={driverId} />
        </section>
      )}

      {tab === 'dossier' && canApprove && (
        <PermissionGate permission={Permission.DRIVERS_APPROVE}>
          <DriverDossier driverId={driverId} onChanged={onChanged} />
        </PermissionGate>
      )}
    </div>
  );
}
