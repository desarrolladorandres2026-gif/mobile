import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, UserPlus, Users, ShieldCheck, X } from 'lucide-react';
import api from '../../services/api';
import { qk } from '../../lib/queryKeys';
import { useAuthStore } from '../../stores/authStore';
import { apiMessage } from '../../lib/apiError';

/**
 * Pestaña "Equipo" del perfil: quién más puede entrar al panel.
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
    description: 'Pedidos, menú, promociones y reseñas. No ve liquidaciones ni el perfil.',
  },
  staff: {
    label: 'Mostrador',
    description: 'Solo los pedidos del día: aceptar, preparar y marcar listo.',
  },
};

export default function TeamTab() {
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


  return (
    <div className="space-y-6">
      {(error || loadError) && (
        <div className="flex items-start gap-3 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">{error || loadError}</p>
        </div>
      )}

      <div className="cols3">
      <section className="space-y-4">
        <h2 className="col-title">Agregar a alguien</h2>

        <div className="grid gap-3">
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

        <p className="text-xs text-[var(--color-text-secondary)]">
          <strong className="text-[var(--color-text-main)]">{ROLE_INFO[role].label}:</strong> {ROLE_INFO[role].description}
        </p>

        <p className="text-xs text-[var(--color-text-muted)]">
          La persona tiene que tener ya una cuenta de ZIPP con ese teléfono. Si no la tiene,
          pídele que se registre en la app y vuelve aquí.
        </p>
      </section>

      {([['Con acceso', true], ['Sin acceso', false]] as const).map(([title, isActive]) => {
        const list = staff.filter((m) => m.isActive === isActive);
        return (
          <section key={title}>
            <h2 className="col-title">{title} · {list.length}</h2>
            {loading ? (
              <p className="py-2 text-xs font-semibold text-[var(--color-text-secondary)]">Cargando equipo...</p>
            ) : list.length === 0 ? (
              isActive ? (
                <div className="py-8 text-center space-y-2">
                  <Users className="w-8 h-8 text-[var(--color-text-muted)] mx-auto" />
                  <p className="text-sm font-bold text-[var(--color-text-main)]">Trabajas solo por ahora</p>
                  <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                    Cuando agregues a alguien, aparecerá aquí con lo que puede hacer.
                  </p>
                </div>
              ) : (
                <p className="py-2 text-xs text-[var(--color-text-muted)]">Nadie ha perdido el acceso.</p>
              )
            ) : (
              <ul className="divide-y divide-[var(--color-border-light)]">
                {list.map((member) => (
              <li
            key={member._id}
            className={`flex flex-wrap items-center justify-between gap-3 py-3 ${
              member.isActive ? '' : 'opacity-60'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-full bg-[var(--color-bg-alt)] flex items-center justify-center text-sm font-bold text-[var(--color-text-main)] uppercase shrink-0">
                {member.userId?.name?.charAt(0) ?? '?'}
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-bold text-[var(--color-text-main)]">
                    {member.userId?.name ?? 'Sin nombre'}
                  </p>
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    <ShieldCheck className="w-3 h-3" />
                    {ROLE_INFO[member.role].label}
                  </span>
                  {!member.isActive && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-danger)]">
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
                className="px-3.5 py-2 rounded-lg hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5"
              >
                <X className="w-4 h-4" />
                Quitar acceso
              </button>
            )}
          </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      </div>
    </div>
  );
}
