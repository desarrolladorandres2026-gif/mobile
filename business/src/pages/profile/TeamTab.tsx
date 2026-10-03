import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Ban, RotateCcw, Trash2, UserPlus, Users } from 'lucide-react';
import api from '../../services/api';
import { qk } from '../../lib/queryKeys';
import { useAuthStore } from '../../stores/authStore';
import { apiMessage } from '../../lib/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import ConfirmDialog from '../../components/ConfirmDialog';
import {
  normalizeRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type BusinessPermission,
  type BusinessRole,
  type StaffRole,
} from '../../lib/permissions';

/**
 * Pestaña "Equipo" del perfil: quién más puede entrar al panel.
 *
 * Antes un negocio era una sola cuenta, así que el dueño le pasaba su
 * contraseña al cajero — y con ella iban las liquidaciones, los precios y
 * la cuenta bancaria donde entra el dinero. Cada empleado entra ahora con
 * su propia cuenta y ve solo lo suyo.
 *
 * Invitar no da acceso: la persona tiene que aceptar desde su propia
 * sesión (ver `PendingInvitations`). El backend decide quién puede tocar a
 * quién; aquí solo se esconden los controles que de todas formas negaría.
 */

type Status = 'active' | 'pending' | 'suspended';

interface StaffMember {
  _id: string;
  role: string;
  status?: Status;
  isActive: boolean;
  invitedName?: string;
  invitedEmail?: string;
  acceptedAt?: string;
  createdAt: string;
  userId?: { _id: string; name?: string; phone?: string; email?: string; lastLoginAt?: string };
}

const STAFF_ROLES: StaffRole[] = ['manager', 'operator', 'cashier'];

const STATUS_INFO: Record<Status, { label: string; className: string }> = {
  active: { label: 'Activo', className: 'text-[var(--color-success)]' },
  pending: { label: 'Invitación pendiente', className: 'text-[var(--color-warning)]' },
  suspended: { label: 'Suspendido', className: 'text-[var(--color-danger)]' },
};

/** Filas viejas sin `status` se leen por `isActive`, igual que el backend. */
function statusOf(member: StaffMember): Status {
  return member.status ?? (member.isActive ? 'active' : 'suspended');
}

/**
 * Lo que este papel puede repartir. Espeja `assertCanGrant` del backend:
 * el administrador solo gestiona al personal operativo.
 */
function grantableBy(actor: BusinessRole | null | undefined): StaffRole[] {
  if (actor === 'owner') return STAFF_ROLES;
  if (actor === 'manager') return ['operator', 'cashier'];
  return [];
}

function formatDate(value?: string): string {
  if (!value) return 'Nunca';
  return new Date(value).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

const inputClass =
  'px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

export default function TeamTab() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  const { access } = usePermissions(businessId);
  // Sin respuesta todavía no se pinta ningún control: en esta pantalla un
  // botón que aparece y luego desaparece confunde más que esperar.
  const has = (permission: BusinessPermission) => !!access?.permissions.includes(permission);
  const grantable = grantableBy(access?.role);

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('operator');
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<StaffMember | null>(null);

  const staffQuery = useQuery({
    queryKey: qk.staff(businessId),
    enabled: !!businessId,
    queryFn: async () => (await api.get(`/businesses/${businessId}/staff`)).data.data as StaffMember[],
  });
  const staff = useMemo(() => staffQuery.data ?? [], [staffQuery.data]);
  const loading = !!businessId && staffQuery.isPending;
  const loadError = staffQuery.isError ? apiMessage(staffQuery.error, 'No se pudo cargar el equipo.') : '';

  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.staff(businessId) }),
    [queryClient, businessId]
  );

  // Si el papel elegido no se puede repartir (un administrador no invita
  // administradores), se usa el primero que sí.
  const inviteRole = grantable.includes(role) ? role : grantable[0];

  const invite = async () => {
    if (!businessId || !inviteRole) return;
    try {
      setError('');
      setInviting(true);
      await api.post(`/businesses/${businessId}/staff`, {
        phone: phone.trim(),
        role: inviteRole,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setPhone('');
      setName('');
      setEmail('');
      await load();
    } catch (err) {
      // El servidor dice si esa persona no tiene cuenta todavía; su mensaje
      // explica qué hacer, así que se muestra tal cual.
      setError(apiMessage(err, 'No se pudo enviar la invitación.'));
    } finally {
      setInviting(false);
    }
  };

  const update = async (member: StaffMember, body: { role?: StaffRole; suspended?: boolean }) => {
    if (!businessId) return;
    try {
      setError('');
      setBusyId(member._id);
      await api.patch(`/businesses/${businessId}/staff/${member._id}`, body);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo actualizar a esta persona.'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    const member = toRemove;
    setToRemove(null);
    if (!businessId || !member) return;
    try {
      setError('');
      setBusyId(member._id);
      await api.delete(`/businesses/${businessId}/staff/${member._id}`);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo eliminar a esta persona.'));
    } finally {
      setBusyId(null);
    }
  };

  const canInvite = has('team:invite') && grantable.length > 0;

  return (
    <div className="space-y-6">
      {(error || loadError) && (
        <div role="alert" className="flex items-start gap-3 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">{error || loadError}</p>
        </div>
      )}

      <div className="cols3">
        {canInvite && (
          <section className="space-y-4">
            <h2 className="col-title">Invitar a alguien</h2>

            <div className="grid gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre (opcional)"
                aria-label="Nombre"
                className={inputClass}
              />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="Correo (opcional)"
                aria-label="Correo"
                className={inputClass}
              />
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                placeholder="Teléfono de su cuenta ZIPP"
                aria-label="Teléfono"
                className={inputClass}
              />
              <select
                value={inviteRole}
                onChange={(e) => setRole(e.target.value as StaffRole)}
                aria-label="Rol"
                className={inputClass}
              >
                {grantable.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>

              <button
                onClick={invite}
                disabled={inviting}
                className="px-4 py-2 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-1.5"
              >
                <UserPlus className="w-4 h-4" />
                {inviting ? 'Invitando…' : 'Enviar invitación'}
              </button>
            </div>

            {inviteRole && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                <strong className="text-[var(--color-text-main)]">{ROLE_LABELS[inviteRole]}:</strong>{' '}
                {ROLE_DESCRIPTIONS[inviteRole]}
              </p>
            )}

            <p className="text-xs text-[var(--color-text-secondary)]">
              La persona necesita una cuenta de ZIPP con ese teléfono. Verá la invitación al
              entrar al panel y no tendrá acceso hasta aceptarla.
            </p>
          </section>
        )}

        <section className="span2">
          <h2 className="col-title">Equipo · {staff.length}</h2>
          {loading ? (
            <p className="py-2 text-xs font-semibold text-[var(--color-text-secondary)]">Cargando equipo…</p>
          ) : staff.length === 0 ? (
            <div className="py-8 text-center space-y-2">
              <Users className="w-8 h-8 text-[var(--color-text-secondary)] mx-auto" />
              <p className="text-sm font-semibold text-[var(--color-text-main)]">Trabajas solo por ahora</p>
              <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                Cuando invites a alguien, aparecerá aquí con su rol y su estado.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="table-header-cell">Nombre</th>
                    <th className="table-header-cell">Rol</th>
                    <th className="table-header-cell">Estado</th>
                    <th className="table-header-cell">Último acceso</th>
                    <th className="table-header-cell text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((member) => {
                    const memberRole = normalizeRole(member.role) as StaffRole | null;
                    const status = statusOf(member);
                    // Un administrador ve a los otros administradores pero no los toca.
                    const manageable = !!memberRole && grantable.includes(memberRole);
                    const busy = busyId === member._id;
                    const displayName = member.userId?.name || member.invitedName || 'Sin nombre';
                    return (
                      <tr key={member._id} className={status === 'suspended' ? 'opacity-70' : ''}>
                        <td className="table-body-cell">
                          <p className="text-sm font-semibold text-[var(--color-text-main)]">{displayName}</p>
                          <p className="text-xs text-[var(--color-text-secondary)]">
                            {[member.userId?.phone, member.userId?.email || member.invitedEmail].filter(Boolean).join(' · ') || 'Sin contacto'}
                          </p>
                        </td>
                        <td className="table-body-cell">
                          {manageable && has('team:change_role') ? (
                            <select
                              value={memberRole ?? ''}
                              disabled={busy}
                              aria-label={`Rol de ${displayName}`}
                              onChange={(e) => update(member, { role: e.target.value as StaffRole })}
                              className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)] cursor-pointer"
                            >
                              {grantable.map((r) => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-xs font-semibold text-[var(--color-text-main)]">
                              {memberRole ? ROLE_LABELS[memberRole] : member.role}
                            </span>
                          )}
                        </td>
                        <td className={`table-body-cell text-xs font-semibold ${STATUS_INFO[status].className}`}>
                          {STATUS_INFO[status].label}
                        </td>
                        <td className="table-body-cell text-xs text-[var(--color-text-main)] tabular">
                          {status === 'pending' ? 'Aún no acepta' : formatDate(member.userId?.lastLoginAt)}
                        </td>
                        <td className="table-body-cell">
                          {manageable && (
                            <div className="flex items-center justify-end gap-1">
                              {status !== 'pending' && has('team:edit') && (
                                <button
                                  onClick={() => update(member, { suspended: status !== 'suspended' })}
                                  disabled={busy}
                                  title={status === 'suspended' ? 'Reactivar acceso' : 'Suspender acceso'}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                                >
                                  {status === 'suspended' ? <RotateCcw className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                                  {status === 'suspended' ? 'Reactivar' : 'Suspender'}
                                </button>
                              )}
                              {has('team:remove') && (
                                <button
                                  onClick={() => setToRemove(member)}
                                  disabled={busy}
                                  title={status === 'pending' ? 'Cancelar invitación' : 'Eliminar del equipo'}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  {status === 'pending' ? 'Cancelar' : 'Eliminar'}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {toRemove && (
        <ConfirmDialog
          title={statusOf(toRemove) === 'pending' ? 'Cancelar invitación' : 'Eliminar del equipo'}
          message={
            statusOf(toRemove) === 'pending'
              ? 'La invitación desaparece y esa persona ya no podrá aceptarla.'
              : 'Pierde el acceso al panel de inmediato. Los pedidos que atendió quedan en el historial. Si solo es temporal, mejor suspéndela.'
          }
          confirmLabel={statusOf(toRemove) === 'pending' ? 'Cancelar invitación' : 'Eliminar'}
          cancelLabel="Volver"
          variant="danger"
          onConfirm={remove}
          onCancel={() => setToRemove(null)}
        />
      )}
    </div>
  );
}
