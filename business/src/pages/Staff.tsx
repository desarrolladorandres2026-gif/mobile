import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, UserPlus, Users, ShieldCheck, X } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

/**
 * Quién más puede entrar al panel.
 *
 * Antes un negocio era una sola cuenta, así que el dueño le pasaba su
 * contraseña al cajero — y con ella iban las liquidaciones, los precios y
 * la cuenta bancaria donde entra el dinero. Cada empleado entra ahora con
 * su propia cuenta y ve solo lo suyo.
 */

type Role = 'manager' | 'staff';

interface StaffMember {
  _id: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  userId?: { _id: string; name?: string; phone?: string; email?: string };
}

const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  manager: {
    label: 'Encargado',
    description: 'Pedidos, menú, promociones, reseñas y analíticas. No ve liquidaciones ni ajustes.',
  },
  staff: {
    label: 'Mostrador',
    description: 'Solo los pedidos del día: aceptar, preparar y marcar listo.',
  },
};

export default function Staff() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [adding, setAdding] = useState(false);

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

  const add = async () => {
    if (!businessId) return;
    try {
      setError('');
      setAdding(true);
      await api.post(`/businesses/${businessId}/staff`, { phone: phone.trim(), role });
      setPhone('');
      await load();
    } catch (err) {
      // El servidor dice si esa persona no tiene cuenta todavía; su mensaje
      // explica qué hacer, así que se muestra tal cual.
      setError(apiMessage(err, 'No se pudo agregar al empleado.'));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (staffId: string) => {
    if (!businessId) return;
    try {
      setError('');
      await api.delete(`/businesses/${businessId}/staff/${staffId}`);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo retirar el acceso.'));
    }
  };

  const active = staff.filter((s) => s.isActive);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Equipo</h1>
          <p className="page-subtitle">
            Cada persona entra con su propia cuenta. Nadie más necesita tu contraseña
          </p>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-main)] shadow-xs">
          <Users className="w-3.5 h-3.5 text-[var(--color-primary)]" />
          <span>{active.length} con acceso</span>
        </div>
      </div>

      {(error || loadError) && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      <div className="zipp-card p-5 space-y-4">
        <h2 className="text-sm font-bold text-[var(--color-text-main)]">Agregar a alguien</h2>

        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Teléfono de su cuenta ZIPP"
            className="px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
          />

          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
          >
            <option value="staff">Mostrador</option>
            <option value="manager">Encargado</option>
          </select>

          <button
            onClick={add}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs flex items-center justify-center gap-1.5"
          >
            <UserPlus className="w-4 h-4" />
            {adding ? 'Agregando…' : 'Agregar'}
          </button>
        </div>

        <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
          <p className="text-xs font-bold text-[var(--color-text-main)] mb-1">
            {ROLE_INFO[role].label}
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">{ROLE_INFO[role].description}</p>
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          La persona tiene que tener ya una cuenta de ZIPP con ese teléfono. Si no la tiene,
          pídele que se registre en la app y vuelve aquí.
        </p>
      </div>

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando equipo...
        </div>
      ) : staff.length === 0 ? (
        <div className="table-container p-16 text-center space-y-2">
          <Users className="w-8 h-8 text-[var(--color-text-muted)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">Trabajas solo por ahora</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Cuando agregues a alguien, aparecerá aquí con lo que puede hacer.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {staff.map((member) => (
            <div
              key={member._id}
              className={`zipp-card p-4 flex flex-wrap items-center justify-between gap-4 ${
                member.isActive ? '' : 'opacity-60'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-[var(--color-sidebar-hover)] flex items-center justify-center text-sm font-bold text-white uppercase shrink-0">
                  {member.userId?.name?.charAt(0) ?? '?'}
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-[var(--color-text-main)]">
                      {member.userId?.name ?? 'Sin nombre'}
                    </p>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                      <ShieldCheck className="w-3 h-3" />
                      {ROLE_INFO[member.role].label}
                    </span>
                    {!member.isActive && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-danger-bg)] text-[var(--color-danger)]">
                        Sin acceso
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {member.userId?.phone ?? 'Sin teléfono'}
                  </p>
                </div>
              </div>

              {member.isActive && (
                <button
                  onClick={() => remove(member._id)}
                  className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <X className="w-4 h-4" />
                  Quitar acceso
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
