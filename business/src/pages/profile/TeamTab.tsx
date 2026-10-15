import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Ban, RotateCcw, Trash2, UserPlus, Users, X } from 'lucide-react';
import api from '../../services/api';
import { qk } from '../../lib/queryKeys';
import { useAuthStore } from '../../stores/authStore';
import { apiMessage } from '../../lib/apiError';
import { usePermissions } from '../../hooks/usePermissions';
import ConfirmDialog from '../../components/ConfirmDialog';
import { isElevated } from '../../lib/counter';
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
  invitedPhone?: string;
  acceptedAt?: string;
  createdAt: string;
  userId?: { _id: string; name?: string; phone?: string; email?: string; lastLoginAt?: string };
}

const STAFF_ROLES: StaffRole[] = ['manager', 'employee'];

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
  if (actor === 'manager') return ['employee'];
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
  const [role, setRole] = useState<StaffRole>('employee');
  const [inviting, setInviting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<StaffMember | null>(null);
  // Entrada desde el mostrador: dar acceso a alguien pide la contraseña otra
  // vez (el backend la exige; ver `reauthIfFromCounter`). Una equivocada
  // cierra la entrada y el panel vuelve solo al mostrador.
  const needsPassword = isElevated();
  const [currentPassword, setCurrentPassword] = useState('');
  const proof = () => (needsPassword ? { currentPassword } : {});
  const missingPassword = () => {
    if (!needsPassword || currentPassword) return false;
    setError('Escribe tu contraseña arriba para confirmar que eres tú.');
    return true;
  };

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
    if (!businessId || !inviteRole || missingPassword()) return;
    if (!phone.trim()) { setError('Escribe el teléfono de la cuenta ZIPP de esa persona.'); return; }
    try {
      setError('');
      setInviting(true);
      await api.post(`/businesses/${businessId}/staff`, {
        phone: phone.trim(),
        role: inviteRole,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...proof(),
      });
      setCurrentPassword('');
      setPhone('');
      setName('');
      setEmail('');
      setInviteOpen(false);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo enviar la invitación.'));
    } finally {
      setInviting(false);
    }
  };

  const update = async (member: StaffMember, body: { role?: StaffRole; suspended?: boolean }) => {
    if (!businessId) return;
    // Suspender quita acceso: no pide contraseña. Cambiar papel o reactivar sí.
    const grants = body.role !== undefined || body.suspended === false;
    if (grants && missingPassword()) return;
    try {
      setError('');
      setBusyId(member._id);
      await api.patch(`/businesses/${businessId}/staff/${member._id}`, grants ? { ...body, ...proof() } : body);
      if (grants) setCurrentPassword('');
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

  const groups: Array<{ key: Status; title: string; list: StaffMember[] }> = [
    { key: 'pending', title: 'Invitaciones pendientes', list: staff.filter((m) => statusOf(m) === 'pending') },
    { key: 'active', title: 'Con acceso', list: staff.filter((m) => statusOf(m) === 'active') },
    { key: 'suspended', title: 'Suspendidos', list: staff.filter((m) => statusOf(m) === 'suspended') },
  ];

  const actionButton =
    'inline-flex items-center gap-1 text-xs font-semibold cursor-pointer hover:underline disabled:opacity-60 disabled:cursor-wait';

  return (
    <div className="space-y-6">
      {(error || loadError) && (
        <div role="alert" className="flex items-start gap-3 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">{error || loadError}</p>
        </div>
      )}

      {needsPassword && (canInvite || has('team:change_role')) && (
        <label className="block max-w-sm">
          <span className="text-xs font-semibold text-[var(--color-text-main)]">Tu contraseña</span>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => { setCurrentPassword(e.target.value); setError(''); }}
            className={`${inputClass} w-full mt-1`}
          />
          <span className="block mt-1 text-xs text-[var(--color-text-secondary)]">
            Entraste desde el mostrador: invitar, cambiar un papel o reactivar te la piden otra vez.
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-text-secondary)]">
          Cada persona entra con su propia cuenta y ve solo lo que su rol permite.
        </p>
        {canInvite && !inviteOpen && (
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="h-8 px-3 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] cursor-pointer flex items-center gap-1.5"
          >
            <UserPlus className="w-4 h-4" />
            Invitar a alguien
          </button>
        )}
      </div>

      {canInvite && inviteOpen && (
        <section className="space-y-4 max-w-2xl border-b border-[var(--color-border)] pb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-[var(--color-text-main)]">Invitar a alguien</h2>
            <button
              type="button"
              onClick={() => setInviteOpen(false)}
              aria-label="Cerrar"
              className="cursor-pointer text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>

          {inviteRole && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              <strong className="text-[var(--color-text-main)]">{ROLE_LABELS[inviteRole]}:</strong>{' '}
              {ROLE_DESCRIPTIONS[inviteRole]}
            </p>
          )}

          <p className="text-xs text-[var(--color-text-secondary)]">
            La persona necesita una cuenta de comercio de ZIPP con ese teléfono. Verá la
            invitación al entrar al panel y no tendrá acceso hasta aceptarla. Por privacidad,
            aquí no se confirma si el teléfono tiene cuenta: si no le llega, pídele que se
            registre y vuelve a invitarla.
          </p>

          <button
            onClick={invite}
            disabled={inviting}
            className="h-9 px-4 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-1.5"
          >
            <UserPlus className="w-4 h-4" />
            {inviting ? 'Invitando…' : 'Enviar invitación'}
          </button>
        </section>
      )}

      {loading ? (
        <p className="py-2 text-xs font-semibold text-[var(--color-text-secondary)]">Cargando equipo…</p>
      ) : staff.length === 0 ? (
        <div className="py-12 space-y-2 max-w-md">
          <Users className="w-6 h-6 text-[var(--color-text-secondary)]" />
          <p className="text-sm font-semibold text-[var(--color-text-main)]">Trabajas solo por ahora</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Cuando invites a alguien, aparecerá aquí con su rol y su estado.
          </p>
          {canInvite && (
            <button type="button" onClick={() => setInviteOpen(true)} className="text-xs font-semibold text-[var(--color-primary)] hover:underline cursor-pointer">
              Invitar a la primera persona
            </button>
          )}
        </div>
      ) : (
        groups.map(({ key, title, list }) =>
          list.length === 0 ? null : (
            <section key={key} className="space-y-1">
              <h2 className="text-[13px] font-semibold text-[var(--color-text-main)] border-b border-[var(--color-border)] pb-1.5">
                {title} · {list.length}
              </h2>
              <ul className="divide-y divide-[var(--color-border-light)]">
                {list.map((member) => {
                  const memberRole = normalizeRole(member.role) as StaffRole | null;
                  const status = statusOf(member);
                  // Un administrador ve a los otros administradores pero no los toca.
                  const manageable = !!memberRole && grantable.includes(memberRole);
                  const busy = busyId === member._id;
                  const displayName = member.userId?.name || member.invitedName || 'Sin nombre';
                  const contact =
                    [member.userId?.phone || member.invitedPhone, member.userId?.email || member.invitedEmail]
                      .filter(Boolean)
                      .join(' · ') || 'Sin contacto';
                  return (
                    <li
                      key={member._id}
                      className={`py-3 grid gap-3 md:gap-4 md:grid-cols-[auto_minmax(0,2fr)_9rem_minmax(0,1fr)_auto] md:items-center ${status === 'suspended' ? 'opacity-70' : ''}`}
                    >
                      <span
                        aria-hidden
                        className="hidden md:flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-surface-hover)] text-sm font-semibold text-[var(--color-text-secondary)]"
                      >
                        {(displayName.trim()[0] ?? '?').toUpperCase()}
                      </span>

                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">{displayName}</p>
                        <p className="text-xs text-[var(--color-text-secondary)] truncate">{contact}</p>
                      </div>

                      <div>
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
                      </div>

                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${STATUS_INFO[status].className}`}>{STATUS_INFO[status].label}</p>
                        <p className="text-xs text-[var(--color-text-secondary)] tabular">
                          {status === 'pending' ? 'Aún no acepta' : formatDate(member.userId?.lastLoginAt)}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:justify-end">
                        {manageable && status !== 'pending' && has('team:edit') && (
                          <button
                            onClick={() => update(member, { suspended: status !== 'suspended' })}
                            disabled={busy}
                            className={`${actionButton} ${status === 'suspended' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-secondary)]'}`}
                          >
                            {status === 'suspended' ? <RotateCcw className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                            {status === 'suspended' ? 'Reactivar' : 'Suspender'}
                          </button>
                        )}
                        {manageable && has('team:remove') && (
                          <button
                            onClick={() => setToRemove(member)}
                            disabled={busy}
                            className={`${actionButton} text-[var(--color-danger)]`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            {status === 'pending' ? 'Cancelar' : 'Eliminar'}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )
        )
      )}

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
