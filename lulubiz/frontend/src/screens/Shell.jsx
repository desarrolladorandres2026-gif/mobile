import { useEffect, useMemo, useRef, useState } from 'react';
import { Notice, SearchBox, TextButton, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { Link, Redirect, useRouter } from '../lib/router.jsx';
import { useSession } from '../lib/session.jsx';
import { AccountsScreen } from './Accounts.jsx';
import { CustomerAdvancesScreen, SupplierAdvancesScreen } from './Advances.jsx';
import { BankScreen } from './Bank.jsx';
import { BooksScreen } from './Books.jsx';
import { PurchaseOrdersScreen, QuotesScreen, RecurringScreen } from './Commercial.jsx';
import { CompanyDataScreen } from './CompanyData.jsx';
import { CostCentersScreen } from './CostCenters.jsx';
import { FixedAssetsScreen } from './FixedAssets.jsx';
import { EmployeesScreen, PayrollRunsScreen, PayrollSettingsScreen } from './Payroll.jsx';
import { BenefitsScreen, PayrollReportsScreen } from './PayrollExtras.jsx';
import { TaxesScreen } from './Taxes.jsx';
import { TerminationsScreen } from './Terminations.jsx';
import { BudgetScreen, CashFlowScreen } from './Planning.jsx';
import { AuditScreen, MembersScreen } from './Admin.jsx';
import { ApiKeysScreen } from './ApiKeys.jsx';
import { InvoicingSettingsScreen } from './InvoicingSettings.jsx';
import { ItemsScreen, StockScreen } from './Inventory.jsx';
import { CreditNotesScreen, InvoicesScreen } from './Invoices.jsx';
import { FinancialReportsScreen } from './FinancialReports.jsx';
import { GettingStartedScreen } from './GettingStarted.jsx';
import { HomeScreen } from './Home.jsx';
import { ImportScreen } from './Import.jsx';
import { OpeningBalancesScreen } from './OpeningBalances.jsx';
import { JournalsScreen } from './Journals.jsx';
import { PayablesScreen, PaymentsScreen } from './Payables.jsx';
import { PartiesScreen } from './Parties.jsx';
import { PosRegistersScreen, PosScreen, PosShiftsScreen } from './Pos.jsx';
import { PurchasesScreen, SupplierNotesScreen } from './Purchases.jsx';
import { ReceiptsScreen, ReceivablesScreen } from './Receivables.jsx';
import { BalancesScreen, PeriodsScreen } from './Reports.jsx';
import { SecurityScreen } from './Security.jsx';
import { YearEndScreen } from './YearEnd.jsx';
import { StockMovementsScreen } from './StockMovements.jsx';

/**
 * Secciones de la aplicación, agrupadas como se usan. `permission` solo decide qué mostrar; el servidor comprueba cada petición.
 * Un grupo sin secciones visibles no se muestra.
 */
const GROUPS = [
  {
    label: 'Contabilidad',
    sections: [
      { path: 'asientos', label: 'Asientos', permission: 'journals:read', Screen: JournalsScreen },
      { path: 'cuentas', label: 'Plan de cuentas', permission: 'accounts:read', Screen: AccountsScreen },
      { path: 'centros-costo', label: 'Centros de costo', permission: 'accounts:read', Screen: CostCentersScreen },
      { path: 'impuestos', label: 'Impuestos', permission: 'reports:read', Screen: TaxesScreen },
      { path: 'informes', label: 'Informes', permission: 'reports:read', Screen: FinancialReportsScreen },
      { path: 'libros', label: 'Libros y estados de cuenta', permission: 'reports:read', Screen: BooksScreen },
      { path: 'saldos', label: 'Saldos', permission: 'reports:read', Screen: BalancesScreen },
      { path: 'periodos', label: 'Períodos', permission: 'journals:read', Screen: PeriodsScreen },
      { path: 'cierre', label: 'Cierre de ejercicio', permission: 'reports:read', Screen: YearEndScreen },
    ],
  },
  {
    label: 'Tesorería y planeación',
    sections: [
      { path: 'conciliacion', label: 'Conciliación bancaria', permission: 'bank:read', Screen: BankScreen },
      { path: 'flujo-efectivo', label: 'Flujo de efectivo', permission: 'reports:read', Screen: CashFlowScreen },
      { path: 'presupuesto', label: 'Presupuesto', permission: 'reports:read', Screen: BudgetScreen },
      { path: 'activos-fijos', label: 'Activos fijos', permission: 'assets:read', Screen: FixedAssetsScreen },
    ],
  },
  {
    label: 'Punto de venta',
    sections: [
      { path: 'vender', label: 'Vender', permission: 'pos:sell', Screen: PosScreen },
      { path: 'turnos', label: 'Turnos y ventas', permission: 'pos:read', Screen: PosShiftsScreen },
      { path: 'cajas', label: 'Cajas', permission: 'pos:manage', Screen: PosRegistersScreen },
    ],
  },
  {
    label: 'Ventas',
    sections: [
      { path: 'cotizaciones', label: 'Cotizaciones', permission: 'invoices:read', Screen: QuotesScreen },
      { path: 'facturas', label: 'Facturas', permission: 'invoices:read', Screen: InvoicesScreen },
      { path: 'facturas-recurrentes', label: 'Facturas recurrentes', permission: 'invoices:read', Screen: RecurringScreen },
      { path: 'notas-credito', label: 'Notas crédito', permission: 'invoices:read', Screen: CreditNotesScreen },
      { path: 'cartera', label: 'Cartera', permission: 'invoices:read', Screen: ReceivablesScreen },
      { path: 'recibos', label: 'Recibos de caja', permission: 'invoices:read', Screen: ReceiptsScreen },
      { path: 'anticipos-clientes', label: 'Anticipos de clientes', permission: 'invoices:read', Screen: CustomerAdvancesScreen },
    ],
  },
  {
    label: 'Compras',
    sections: [
      { path: 'ordenes-compra', label: 'Órdenes de compra', permission: 'purchases:read', Screen: PurchaseOrdersScreen },
      { path: 'compras', label: 'Compras', permission: 'purchases:read', Screen: PurchasesScreen },
      { path: 'notas-proveedor', label: 'Notas de proveedor', permission: 'purchases:read', Screen: SupplierNotesScreen },
      { path: 'por-pagar', label: 'Cuentas por pagar', permission: 'purchases:read', Screen: PayablesScreen },
      { path: 'pagos', label: 'Pagos', permission: 'purchases:read', Screen: PaymentsScreen },
      { path: 'anticipos-proveedores', label: 'Anticipos a proveedores', permission: 'purchases:read', Screen: SupplierAdvancesScreen },
    ],
  },
  {
    label: 'Inventario',
    sections: [
      { path: 'articulos', label: 'Artículos', permission: 'inventory:read', Screen: ItemsScreen },
      { path: 'existencias', label: 'Existencias', permission: 'inventory:read', Screen: StockScreen },
      { path: 'ajustes', label: 'Ajustes y traspasos', permission: 'inventory:read', Screen: StockMovementsScreen },
    ],
  },
  {
    label: 'Nómina',
    sections: [
      { path: 'nomina', label: 'Nómina', permission: 'payroll:read', Screen: PayrollRunsScreen },
      { path: 'liquidacion-contrato', label: 'Liquidación de contrato', permission: 'payroll:read', Screen: TerminationsScreen },
      { path: 'prestaciones', label: 'Prestaciones sociales', permission: 'payroll:read', Screen: BenefitsScreen },
      { path: 'reportes-nomina', label: 'Reportes de nómina', permission: 'payroll:read', Screen: PayrollReportsScreen },
      { path: 'empleados', label: 'Empleados', permission: 'payroll:read', Screen: EmployeesScreen },
      { path: 'parametros-nomina', label: 'Parámetros de nómina', permission: 'payroll:manage', Screen: PayrollSettingsScreen },
    ],
  },
  {
    label: 'Administración',
    sections: [
      { path: 'primeros-pasos', label: 'Primeros pasos', permission: 'reports:read', Screen: GettingStartedScreen },
      { path: 'terceros', label: 'Terceros', permission: 'parties:read', Screen: PartiesScreen },
      { path: 'importar', label: 'Importar', permission: 'parties:manage', Screen: ImportScreen },
      { path: 'saldos-iniciales', label: 'Saldos iniciales', permission: 'journals:post', Screen: OpeningBalancesScreen },
      { path: 'facturacion', label: 'Facturación', permission: 'invoices:read', Screen: InvoicingSettingsScreen },
      { path: 'miembros', label: 'Miembros', permission: 'users:manage', Screen: MembersScreen },
      { path: 'claves-api', label: 'Claves de API', permission: 'apikeys:manage', Screen: ApiKeysScreen },
      { path: 'datos-empresa', label: 'Datos de la empresa', permission: 'tenant:manage', Screen: CompanyDataScreen },
      { path: 'auditoria', label: 'Auditoría', permission: 'audit:read', Screen: AuditScreen },
      { path: 'cuenta', label: 'Mi cuenta', permission: null, Screen: SecurityScreen },
    ],
  },
];

/** La pantalla de inicio no pertenece a ningún módulo: siempre está, para todos, y es donde se aterriza. */
const HOME = { path: 'inicio', label: 'Inicio', permission: null, Screen: HomeScreen };

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

/** Accesos del botón «Crear»: cada uno lleva a la pantalla donde se elabora el documento. */
const CREATE = [
  { label: 'Factura de venta', path: 'facturas' },
  { label: 'Cotización', path: 'cotizaciones' },
  { label: 'Recibo de caja', path: 'recibos' },
  { label: 'Venta de mostrador', path: 'vender' },
  { label: 'Factura de compra', path: 'compras' },
  { label: 'Orden de compra', path: 'ordenes-compra' },
  { label: 'Pago a proveedor', path: 'pagos' },
  { label: 'Asiento contable', path: 'asientos' },
  { label: 'Tercero', path: 'terceros' },
  { label: 'Artículo', path: 'articulos' },
];

/** Cierra un panel al pulsar fuera de él o la tecla Escape. */
function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}

const panel = 'absolute z-10 border border-borde-fuerte bg-papel';
const panelLink = 'block px-4 py-2 text-sm text-tinta no-underline hover:bg-azul-suave hover:text-azul-oscuro';

/** «Buscar en Lulubiz»: localiza una sección por su nombre o por el de su módulo. */
function SectionSearch({ groups, go }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const close = () => setText('');
  useDismiss(ref, text !== '', close);
  const results = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return groups.flatMap((g) => g.sections.filter((s) => s.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)).map((s) => ({ ...s, group: g.label }))).slice(0, 12);
  }, [groups, text]);
  const pick = (s) => {
    close();
    go(s.query ? `${s.path}?q=${encodeURIComponent(s.query)}` : s.path);
  };
  // Además de las secciones, lo escrito se puede buscar entre terceros y artículos (si tienes acceso a esas pantallas).
  const entityResults = useMemo(() => {
    const q = text.trim();
    if (q.length < 2) return [];
    const paths = new Set(groups.flatMap((g) => g.sections.map((s) => s.path)));
    return [
      { path: 'terceros', label: `Terceros que contengan «${q}»`, group: 'Buscar', query: q },
      { path: 'articulos', label: `Artículos que contengan «${q}»`, group: 'Buscar', query: q },
    ].filter((r) => paths.has(r.path));
  }, [groups, text]);
  const all = [...results, ...entityResults];
  return (
    <div ref={ref} className="relative w-full max-w-sm">
      <SearchBox
        compact
        className="max-w-sm"
        aria-label="Ir a una sección"
        placeholder="Ir a una sección, tercero o artículo   ( / )"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onSubmit={() => {
          if (all[0]) pick(all[0]);
        }}
      />
      {text.trim() ? (
        <ul role="listbox" aria-label="Resultados de la búsqueda" className={`${panel} left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto`}>
          {all.length === 0 ? <li className="px-4 py-2 text-sm text-tinta">Nada coincide con esa búsqueda.</li> : null}
          {all.map((s) => (
            <li key={`${s.path}${s.query ?? ''}`} role="presentation">
              <button type="button" role="option" aria-selected="false" aria-label={s.label} onClick={() => pick(s)} className={`${panelLink} flex w-full justify-between gap-4 text-left`}>
                <span>{s.label}</span>
                <span className="text-tinta-segundo">{s.group}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Botón «Crear»: al pulsarlo o apuntarlo se despliega la lista de accesos, uno por documento, debajo del botón.
 * Es un panel plano de texto, sin animación.
 */
function CreateMenu({ visiblePaths, open, setOpen }) {
  const ref = useRef(null);
  const close = () => setOpen(false);
  useDismiss(ref, open, close);
  const items = CREATE.filter((c) => visiblePaths.has(c.path));
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={close}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Crear"
        onClick={() => setOpen(!open)}
        className="rounded-sm border border-azul bg-azul px-4 py-1.5 text-sm font-semibold text-white hover:border-azul-oscuro hover:bg-azul-oscuro focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul"
      >
        Crear
      </button>
      {open ? (
        <ul aria-label="Crear" className={`${panel} right-0 top-full w-56`}>
          {items.map((c) => (
            <li key={c.path}>
              <Link href={`/app/${c.path}`} onClick={close} className={`${panelLink} text-tinta! no-underline!`}>
                {c.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Shell() {
  const { account, memberships, tenant, can, logout, selectTenant } = useSession();
  const { pathname, navigate } = useRouter();
  const [expanded, setExpanded] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Atajos: Ctrl+Enter envía el formulario donde estás; «/» salta a la búsqueda.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const form = document.activeElement?.closest?.('form');
        if (form) {
          e.preventDefault();
          form.requestSubmit();
        }
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') && !document.activeElement?.isContentEditable) {
        const box = document.querySelector('input[aria-label="Ir a una sección"]');
        if (box) {
          e.preventDefault();
          box.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Al cambiar de pantalla vuelve a quedar desplegado el módulo donde estás.
  useEffect(() => {
    setExpanded(null);
    setMenuOpen(false);
    setCreateOpen(false);
  }, [pathname]);

  const groups = GROUPS.map((g) => ({ ...g, sections: g.sections.filter((s) => !s.permission || can(s.permission)) })).filter((g) => g.sections.length > 0);
  const visible = groups.flatMap((g) => g.sections);
  const active = [HOME, ...visible].find((s) => pathname === `/app/${s.path}`) ?? null;
  const visiblePaths = useMemo(() => new Set(visible.map((s) => s.path)), [visible]);

  // La ruta no existe o no tienes acceso: se vuelve a la primera sección disponible.
  if (!active) return <Redirect to="/app/inicio" />;

  const Screen = active.Screen;
  const activeGroup = groups.find((g) => g.sections.includes(active));
  // Mientras no toques el menú queda desplegado el módulo de la pantalla actual; al tocarlo manda tu elección.
  const open = expanded === null ? activeGroup : groups.find((g) => g.label === expanded) ?? null;
  const canConfigure = visiblePaths.has('facturacion');

  return (
    <div className="flex h-screen flex-col bg-papel-fondo print:h-auto">
      <header className="print:hidden relative z-20 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-borde bg-papel px-4 py-2 md:px-6">
        <span className="text-lg font-semibold tracking-tight text-azul">Lulubiz</span>
        {memberships.length > 1 ? (
          <label className="flex items-center gap-2 text-sm text-tinta">
            <span className="font-semibold">Empresa</span>
            <select value={tenant.tenantId} onChange={(e) => selectTenant(e.target.value)} className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-sm focus:outline-2 focus:outline-azul">
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
        <div className="order-last w-full md:order-none md:w-auto md:min-w-0 md:flex-1">
          <SectionSearch groups={groups} go={(path) => navigate(`/app/${path}`)} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-4 text-sm text-tinta md:ml-0">
          <CreateMenu visiblePaths={visiblePaths} open={createOpen} setOpen={setCreateOpen} />
          {canConfigure ? (
            <Link href="/app/facturacion" className="rounded-sm border border-borde-fuerte bg-papel px-3 py-1.5 text-sm font-semibold text-tinta! no-underline! hover:bg-azul-suave">
              Configuración
            </Link>
          ) : null}
          <button type="button" onClick={logout} className="rounded-sm border border-borde-fuerte bg-papel px-3 py-1.5 text-sm font-semibold text-tinta hover:bg-azul-suave focus-visible:outline-2 focus-visible:outline-azul">
            Cerrar sesión
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden print:overflow-visible">
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="menu-principal"
          onClick={() => setMenuOpen((v) => !v)}
          className="border-b border-azul bg-azul-oscuro px-4 py-3 text-left text-sm font-semibold text-papel md:hidden print:hidden"
        >
          {menuOpen ? 'Cerrar menú' : `Menú: ${active.label}`}
        </button>
        <nav id="menu-principal" aria-label="Principal" className={`shrink-0 bg-azul-oscuro md:block md:w-56 md:overflow-y-auto ${menuOpen ? 'block' : 'hidden'} print:hidden`}>
          <ul>
            <li>
              <Link
                href="/app/inicio"
                aria-current={active === HOME ? 'page' : undefined}
                className={`block border-l-4 px-4 py-3 text-sm text-papel no-underline! hover:bg-azul hover:text-papel ${active === HOME ? 'border-papel font-semibold' : 'border-transparent'}`}
              >
                Inicio
              </Link>
            </li>
            {groups.map((g) => {
              const isOpen = open === g;
              const isCurrent = g === activeGroup;
              return (
                <li key={g.label}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => setExpanded(isOpen ? '' : g.label)}
                    className={`flex w-full items-center justify-between gap-2 border-l-4 px-4 py-3 text-left text-sm text-papel hover:bg-azul focus:outline-2 focus:outline-offset-[-2px] focus:outline-papel ${isCurrent ? 'border-papel font-semibold' : 'border-transparent'}`}
                  >
                    <span>{g.label}</span>
                    <span aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
                  </button>
                  {isOpen ? (
                    <ul aria-label={g.label} className="bg-azul">
                      {g.sections.map((s) => (
                        <li key={s.path}>
                          <Link
                            href={`/app/${s.path}`}
                            aria-current={s === active ? 'page' : undefined}
                            className={`block py-2 pl-8 pr-4 text-sm text-papel no-underline! hover:bg-azul-oscuro hover:text-papel ${s === active ? 'bg-azul-oscuro font-semibold' : ''}`}
                          >
                            {s.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 px-4 py-5 md:overflow-y-auto md:px-6 print:overflow-visible">
          {!account.emailVerified && active.path !== 'cuenta' ? <VerifyEmailBanner /> : null}
          <Screen />
        </main>
      </div>
    </div>
  );
}
