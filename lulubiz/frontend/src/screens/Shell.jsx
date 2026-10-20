import { useState } from 'react';
import { Button, Notice, TextButton, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { Link, Redirect, useRouter } from '../lib/router.jsx';
import { useSession } from '../lib/session.jsx';
import { AccountsScreen } from './Accounts.jsx';
import { AuditScreen, MembersScreen } from './Admin.jsx';
import { InvoicingSettingsScreen } from './InvoicingSettings.jsx';
import { CreditNotesScreen, InvoicesScreen } from './Invoices.jsx';
import { FinancialReportsScreen } from './FinancialReports.jsx';
import { JournalsScreen } from './Journals.jsx';
import { PayablesScreen, PaymentsScreen } from './Payables.jsx';
import { PartiesScreen } from './Parties.jsx';
import { PurchasesScreen, SupplierNotesScreen } from './Purchases.jsx';
import { ReceiptsScreen, ReceivablesScreen } from './Receivables.jsx';
import { BalancesScreen, PeriodsScreen } from './Reports.jsx';
import { SecurityScreen } from './Security.jsx';

/** Secciones de la aplicación. `permission` solo decide qué mostrar; el servidor comprueba cada petición. */
const SECTIONS = [
  { path: 'asientos', label: 'Asientos', permission: 'journals:read', Screen: JournalsScreen },
  { path: 'cuentas', label: 'Plan de cuentas', permission: 'accounts:read', Screen: AccountsScreen },
  { path: 'terceros', label: 'Terceros', permission: 'parties:read', Screen: PartiesScreen },
  { path: 'facturas', label: 'Facturas', permission: 'invoices:read', Screen: InvoicesScreen },
  { path: 'cartera', label: 'Cartera', permission: 'invoices:read', Screen: ReceivablesScreen },
  { path: 'recibos', label: 'Recibos de caja', permission: 'invoices:read', Screen: ReceiptsScreen },
  { path: 'notas-credito', label: 'Notas crédito', permission: 'invoices:read', Screen: CreditNotesScreen },
  { path: 'compras', label: 'Compras', permission: 'purchases:read', Screen: PurchasesScreen },
  { path: 'notas-proveedor', label: 'Notas de proveedor', permission: 'purchases:read', Screen: SupplierNotesScreen },
  { path: 'por-pagar', label: 'Cuentas por pagar', permission: 'purchases:read', Screen: PayablesScreen },
  { path: 'pagos', label: 'Pagos', permission: 'purchases:read', Screen: PaymentsScreen },
  { path: 'informes', label: 'Informes', permission: 'reports:read', Screen: FinancialReportsScreen },
  { path: 'saldos', label: 'Saldos', permission: 'reports:read', Screen: BalancesScreen },
  { path: 'periodos', label: 'Períodos', permission: 'journals:read', Screen: PeriodsScreen },
  { path: 'facturacion', label: 'Facturación', permission: 'invoices:read', Screen: InvoicingSettingsScreen },
  { path: 'miembros', label: 'Miembros', permission: 'users:manage', Screen: MembersScreen },
  { path: 'auditoria', label: 'Auditoría', permission: 'audit:read', Screen: AuditScreen },
  { path: 'cuenta', label: 'Mi cuenta', permission: null, Screen: SecurityScreen },
];

function VerifyEmailBanner() {
  const { account } = useSession();
  const [sent, setSent] = useState(null);
  const resend = useSubmit(async () => {
    const result = await api.post('/v1/auth/resend-verification');
    setSent(result.sent ? 'Enviamos un enlace nuevo a tu correo.' : 'Ya enviamos un enlace hace un momento; revisa tu correo.');
  });
  return (
    <Notice kind="info" title="Confirma tu correo">
      Enviamos un enlace a {account.email}. Hasta que lo abras no puedes invitar a otras personas.{' '}
      {sent ?? (
        <TextButton onClick={resend.run}>{resend.busy ? 'Enviando…' : 'Reenviar el enlace'}</TextButton>
      )}
      {resend.error ? <span className="font-semibold text-rojo"> {errorMessage(resend.error)}</span> : null}
    </Notice>
  );
}

export function Shell() {
  const { account, memberships, tenant, can, logout, selectTenant } = useSession();
  const { pathname } = useRouter();

  const visible = SECTIONS.filter((s) => !s.permission || can(s.permission));
  const active = visible.find((s) => pathname === `/app/${s.path}`) ?? null;

  // La ruta no existe o no tienes acceso: se vuelve a la primera sección disponible.
  if (!active) return <Redirect to={`/app/${visible[0].path}`} />;

  const Screen = active.Screen;

  return (
    <div className="flex min-h-screen flex-col bg-papel-fondo">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-borde bg-papel px-6 py-3">
        <div className="flex items-center gap-4">
          <span className="text-lg font-semibold tracking-tight text-azul">Lulubiz</span>
          {memberships.length > 1 ? (
            <label className="flex items-center gap-2 text-sm text-tinta">
              <span className="font-semibold">Empresa</span>
              <select
                value={tenant.tenantId}
                onChange={(e) => selectTenant(e.target.value)}
                className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-sm focus:outline-2 focus:outline-azul"
              >
                {memberships.map((m) => (
                  <option key={m.tenantId} value={m.tenantId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-sm font-semibold text-tinta">{tenant.name}</span>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm text-tinta">
          <span>{account.email}</span>
          <Button onClick={logout}>Cerrar sesión</Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Principal" className="shrink-0 border-b border-borde bg-papel py-2 md:w-56 md:border-b-0 md:border-r md:py-4">
          <ul className="flex flex-wrap md:block">
            {visible.map((s) => {
              const isActive = s === active;
              return (
                <li key={s.path}>
                  <Link
                    href={`/app/${s.path}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`block border-l-4 px-5 py-2 text-sm no-underline ${isActive ? 'border-azul bg-azul-suave font-semibold text-azul-oscuro' : 'border-transparent text-tinta hover:bg-papel-fondo'}`}
                  >
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 px-6 py-5">
          {!account.emailVerified && active.path !== 'cuenta' ? <VerifyEmailBanner /> : null}
          <Screen />
        </main>
      </div>
    </div>
  );
}
