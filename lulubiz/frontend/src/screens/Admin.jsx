import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

export const ROLE_LABELS = { owner: 'Propietario', admin: 'Administrador', accountant: 'Contador', cashier: 'Cajero', viewer: 'Lector' };

export function MembersScreen() {
  const base = useTenantApi();
  const { tenant, account } = useSession();
  const list = useLoad(() => api.get(`${base}/members`), [base]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [notice, setNotice] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const roleOptions = Object.entries(ROLE_LABELS)
    .filter(([value]) => value !== 'owner' || tenant.role === 'owner')
    .map(([value, label]) => ({ value, label }));

  const invite = useSubmit(async () => {
    const result = await api.post(`${base}/members`, { email: email.trim(), role });
    setNotice(
      result.delivered
        ? `Enviamos la invitación a ${email.trim()}. Vence en 7 días.`
        : `La invitación a ${email.trim()} quedó creada, pero no pudimos enviar el correo. Intenta invitar de nuevo en unos minutos.`,
    );
    setEmail('');
  });

  const change = useSubmit(async (member, newRole) => {
    await api.patch(`${base}/members/${member.userId}`, { role: newRole });
    list.reload();
  });
  const remove = useSubmit(async (member) => {
    await api.delete(`${base}/members/${member.userId}`);
    setConfirmRemove(null);
    list.reload();
  });

  const columns = [
    { key: 'email', title: 'Correo' },
    { key: 'name', title: 'Nombre' },
    {
      key: 'role',
      title: 'Rol',
      render: (m) => (
        <select
          aria-label={`Rol de ${m.email}`}
          value={m.role}
          onChange={(e) => change.run(m, e.target.value)}
          className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-sm text-tinta focus:outline-2 focus:outline-azul"
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value} disabled={value === 'owner' && tenant.role !== 'owner'}>
              {label}
            </option>
          ))}
        </select>
      ),
    },
    { key: 'verified', title: 'Correo confirmado', render: (m) => (m.emailVerified ? 'Sí' : 'No') },
    { key: 'mfa', title: 'Dos pasos', render: (m) => (m.mfaEnabled ? 'Activados' : 'No') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (m) =>
        // Si es el único propietario, el servidor siempre rechazaría quitarlo: no se ofrece una acción que no puede funcionar.
        m.role === 'owner' && (list.data?.items ?? []).filter((x) => x.role === 'owner').length === 1 ? (
          <span className="text-tinta-segundo">Único propietario</span>
        ) : confirmRemove === m.userId ? (
          <span className="flex gap-3">
            <TextButton danger onClick={() => remove.run(m)}>Sí, quitar</TextButton>
            <TextButton onClick={() => setConfirmRemove(null)}>Cancelar</TextButton>
          </span>
        ) : (
          <TextButton onClick={() => { setConfirmRemove(m.userId); remove.clearError(); }}>
            {m.email === account.email ? 'Salir de la empresa' : 'Quitar'}
          </TextButton>
        ),
    },
  ];

  return (
    <>
      <PageHeader title="Miembros" />
      {change.error ? <Notice kind="error">{errorMessage(change.error)}</Notice> : null}
      {remove.error ? <Notice kind="error">{errorMessage(remove.error)}</Notice> : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando miembros…</p> : null}
      {list.data ? <DataTable caption="Miembros de la empresa" columns={columns} rows={list.data.items} rowKey={(m) => m.userId} /> : null}

      <form
        className="mt-8 border-t border-borde pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          invite.run();
        }}
      >
        <h2 className="mb-3 text-lg font-semibold text-tinta">Invitar a una persona</h2>
        <p className="mb-3 text-sm text-tinta">Le llega un correo con un enlace para unirse con el rol que elijas. Solo puedes invitar si ya confirmaste tu propio correo.</p>
        {notice ? <Notice kind="success">{notice}</Notice> : null}
        {invite.error ? <Notice kind="error">{errorMessage(invite.error)}</Notice> : null}
        <div className="grid gap-x-4 sm:grid-cols-2">
          <TextField label="Correo electrónico" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <SelectField label="Rol" value={role} onChange={(e) => setRole(e.target.value)} options={roleOptions} />
        </div>
        <Button type="submit" variant="primary" busy={invite.busy}>Enviar invitación</Button>
      </form>
    </>
  );
}

const ACTIONS = {
  'tenant.register': 'Creó la empresa',
  'auth.login': 'Inició sesión',
  'auth.login_failed': 'Intento de inicio de sesión fallido',
  'auth.email_verified': 'Confirmó su correo',
  'auth.password_reset': 'Restableció su contraseña',
  'auth.mfa_enabled': 'Activó los dos pasos',
  'auth.mfa_disabled': 'Desactivó los dos pasos',
  'auth.recovery_codes_regenerated': 'Regeneró los códigos de recuperación',
  'account.create': 'Creó una cuenta',
  'account.seed': 'Cargó el plan de cuentas inicial',
  'account.deactivate': 'Desactivó una cuenta',
  'account.activate': 'Reactivó una cuenta',
  'party.create': 'Creó un tercero',
  'party.update': 'Editó un tercero',
  'party.activate': 'Activó un tercero',
  'party.deactivate': 'Desactivó un tercero',
  'journal.post': 'Registró un asiento',
  'journal.reverse': 'Revirtió un asiento',
  'period.close': 'Cerró un período',
  'period.reopen': 'Reabrió un período',
  'member.invite': 'Invitó a una persona',
  'member.accept_invitation': 'Aceptó una invitación',
  'member.change_role': 'Cambió un rol',
  'member.remove': 'Quitó a un miembro',
  'year.close': 'Cerró un ejercicio',
  'year.reopen': 'Reabrió un ejercicio',
  'apikey.create': 'Creó una clave de API',
  'apikey.revoke': 'Revocó una clave de API',
};

const stamp = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-CO')} ${d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`;
};

export function AuditScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const list = useLoad(() => api.get(`${base}/audit?limit=50`), [base]);
  const members = useLoad(() => api.get(`${base}/members`), [base]);
  const keys = useLoad(() => (can('apikeys:manage') ? api.get(`${base}/api-keys`) : Promise.resolve(null)), [base]);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);

  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const who = (e) =>
    e.apiKeyId
      ? `Clave de API${keys.data?.items.find((k) => k._id === e.apiKeyId) ? `: ${keys.data.items.find((k) => k._id === e.apiKeyId).name}` : ''}`
      : (members.data?.items.find((m) => m.userId === e.userId)?.email ?? (e.userId ? 'Usuario retirado' : 'Sistema'));

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get(`${base}/audit?limit=50&cursor=${next}`);
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const columns = [
    { key: 'at', title: 'Fecha y hora', render: (e) => <span className="tabular-nums">{stamp(e.at)}</span> },
    { key: 'user', title: 'Quién', render: (e) => who(e) },
    { key: 'action', title: 'Qué hizo', render: (e) => ACTIONS[e.action] ?? e.action },
    { key: 'target', title: 'Sobre', render: (e) => e.target ?? '' },
    { key: 'details', title: 'Detalle', render: (e) => (e.details ? Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join(' · ') : '') },
    { key: 'ip', title: 'Dirección IP', render: (e) => e.ip ?? '' },
  ];

  return (
    <>
      <PageHeader title="Auditoría" />
      <p className="mb-4 text-sm text-tinta">Registro de lo que se hizo en la empresa, del más reciente al más antiguo. No se puede editar ni borrar.</p>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando la auditoría…</p> : null}
      {list.data ? <DataTable caption="Auditoría" columns={columns} rows={items} rowKey={(e) => e._id} empty="Todavía no hay eventos." /> : null}
      {moreError ? <Notice kind="error">{errorMessage(moreError)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={loadingMore} onClick={loadMore}>Cargar más eventos</Button>
        </div>
      ) : null}
    </>
  );
}
