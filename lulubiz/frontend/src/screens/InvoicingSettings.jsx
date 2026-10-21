import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { nitCheckDigit, taxIdTypesFor } from '../lib/nit.js';
import { useSession, useTenantApi } from '../lib/session.jsx';
import { SandboxNotice, useInvoicingStatus } from './Invoices.jsx';

const REGIMES = [
  { value: 'responsable_iva', label: 'Responsable de IVA' },
  { value: 'no_responsable', label: 'No responsable de IVA' },
];
const DOC_LABELS = { invoice: 'Facturas', credit_note: 'Notas crédito' };

function IssuerForm({ settings, accounts, canEdit, country, onSaved }) {
  const base = useTenantApi();
  const issuer = settings?.issuer;
  const mapping = settings?.accounts;
  const [form, setForm] = useState({
    name: issuer?.name ?? '',
    taxIdType: issuer?.taxIdType ?? taxIdTypesFor(country)[0].value,
    taxId: issuer?.taxId ?? '',
    regime: issuer?.regime ?? 'responsable_iva',
    email: issuer?.email ?? '',
    phone: issuer?.phone ?? '',
    line: issuer?.address?.line ?? '',
    city: issuer?.address?.city ?? '',
    region: issuer?.address?.region ?? '',
    receivable: mapping?.receivable ?? '',
    income: mapping?.income ?? '',
    vatPayable: mapping?.vatPayable ?? '',
    cash: mapping?.cash ?? '',
    payable: mapping?.payable ?? '',
    vatDeductible: mapping?.vatDeductible ?? '',
    customerAdvance: mapping?.customerAdvance ?? '',
    supplierAdvance: mapping?.supplierAdvance ?? '',
  });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const isNit = form.taxIdType === 'NIT';
  const checkDigit = isNit && form.taxId ? nitCheckDigit(form.taxId.replace(/\./g, '')) : null;

  const save = useSubmit(async () => {
    const body = {
      issuer: {
        name: form.name.trim(),
        taxIdType: form.taxIdType,
        taxId: form.taxId.replace(/[.\s]/g, ''),
        ...(isNit ? { checkDigit } : {}),
        regime: form.regime,
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        address: { line: form.line.trim(), city: form.city.trim(), region: form.region.trim() },
      },
      accounts: {
        receivable: form.receivable.trim(),
        income: form.income.trim(),
        vatPayable: form.vatPayable.trim(),
        ...(form.cash.trim() ? { cash: form.cash.trim() } : {}),
        ...(form.payable.trim() ? { payable: form.payable.trim() } : {}),
        ...(form.vatDeductible.trim() ? { vatDeductible: form.vatDeductible.trim() } : {}),
        ...(form.customerAdvance.trim() ? { customerAdvance: form.customerAdvance.trim() } : {}),
        ...(form.supplierAdvance.trim() ? { supplierAdvance: form.supplierAdvance.trim() } : {}),
      },
    };
    await api.put(`${base}/invoicing/settings`, body);
    onSaved();
  });

  const postable = accounts.filter((a) => a.postable);
  const lock = !canEdit;

  return (
    <form
      className="mb-8"
      onSubmit={(e) => {
        e.preventDefault();
        save.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Emisor de las facturas</h2>
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField label="Nombre o razón social" value={form.name} onChange={set('name')} disabled={lock} maxLength={200} required />
        <SelectField label="Régimen frente al IVA" value={form.regime} onChange={set('regime')} options={REGIMES} disabled={lock} hint="Un emisor no responsable de IVA no puede facturar con IVA." />
        <SelectField label="Tipo de documento" value={form.taxIdType} onChange={set('taxIdType')} options={taxIdTypesFor(country)} disabled={lock} />
        <div className="grid grid-cols-[1fr_6rem] gap-x-3">
          <TextField label="Número de documento" value={form.taxId} onChange={set('taxId')} disabled={lock} maxLength={30} required />
          {isNit ? <TextField label="Dígito" value={checkDigit ?? ''} readOnly hint="Se calcula solo." /> : null}
        </div>
        <TextField label="Correo electrónico" type="email" value={form.email} onChange={set('email')} disabled={lock} />
        <TextField label="Teléfono" value={form.phone} onChange={set('phone')} disabled={lock} maxLength={30} />
        <TextField label="Dirección" value={form.line} onChange={set('line')} disabled={lock} required />
        <div className="grid grid-cols-2 gap-x-3">
          <TextField label="Ciudad" value={form.city} onChange={set('city')} disabled={lock} required />
          <TextField label="Departamento" value={form.region} onChange={set('region')} disabled={lock} required />
        </div>
      </div>

      <h2 className="mb-1 mt-4 text-lg font-semibold text-tinta">Cuentas contables</h2>
      <p className="mb-3 text-sm text-tinta">Cada factura se contabiliza sola: débito a cuentas por cobrar (o a caja si se paga de contado y la hay), crédito a ingresos y a IVA por pagar. Cada compra se contabiliza a Proveedores y al IVA descontable.</p>
      <datalist id="cuentas-facturacion">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {[
          ['receivable', 'Cuentas por cobrar (clientes)'],
          ['income', 'Ingresos por ventas (por defecto)'],
          ['vatPayable', 'IVA por pagar'],
          ['cash', 'Caja (opcional, para ventas de contado)'],
          ['payable', 'Proveedores (para registrar compras)'],
          ['vatDeductible', 'IVA descontable (para registrar compras)'],
          ['customerAdvance', 'Anticipos de clientes (un pasivo)'],
          ['supplierAdvance', 'Anticipos a proveedores (un activo)'],
        ].map(([key, label]) => (
          <TextField
            key={key}
            label={label}
            list="cuentas-facturacion"
            value={form[key]}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, '') }))}
            hint={postable.find((a) => a.code === form[key])?.name ?? 'Código de una cuenta que admita asientos.'}
            disabled={lock}
            required={['receivable', 'income', 'vatPayable'].includes(key)}
          />
        ))}
      </div>
      {canEdit ? (
        <Button type="submit" variant="primary" busy={save.busy}>
          Guardar configuración
        </Button>
      ) : (
        <p className="text-sm text-tinta">Solo un propietario o administrador puede cambiar esta configuración.</p>
      )}
    </form>
  );
}

function ResolutionForm({ onCreated, onCancel }) {
  const base = useTenantApi();
  const [form, setForm] = useState({ docType: 'invoice', prefix: '', number: '', from: '', to: '', validFrom: '', validTo: '' });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = useSubmit(async () => {
    const created = await api.post(`${base}/invoicing/resolutions`, {
      docType: form.docType,
      ...(form.prefix.trim() ? { prefix: form.prefix.trim().toUpperCase() } : {}),
      number: form.number.trim(),
      from: Number(form.from),
      to: Number(form.to),
      validFrom: form.validFrom,
      validTo: form.validTo,
    });
    onCreated(created);
  });
  return (
    <form
      className="mb-6 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Nueva resolución de numeración</h3>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Para" value={form.docType} onChange={set('docType')} options={[{ value: 'invoice', label: 'Facturas' }, { value: 'credit_note', label: 'Notas crédito' }]} />
        <TextField label="Prefijo" value={form.prefix} onChange={set('prefix')} maxLength={6} hint="Letras o números; puede ir vacío." />
        <TextField label="Número de la resolución" value={form.number} onChange={set('number')} maxLength={40} required />
        <TextField label="Desde" inputMode="numeric" value={form.from} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value.replace(/\D/g, '') }))} required />
        <TextField label="Hasta" inputMode="numeric" value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value.replace(/\D/g, '') }))} required />
        <span />
        <TextField label="Vigente desde" type="date" value={form.validFrom} onChange={set('validFrom')} required />
        <TextField label="Vigente hasta" type="date" value={form.validTo} onChange={set('validTo')} required />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Crear resolución</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function InvoicingSettingsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const canEdit = can('settings:manage');
  const status = useInvoicingStatus();
  const settings = useLoad(() => api.get(`${base}/invoicing/settings`), [base]);
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const resolutions = useLoad(() => api.get(`${base}/invoicing/resolutions`), [base]);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);

  const deactivate = useSubmit(async (resolution) => {
    await api.post(`${base}/invoicing/resolutions/${resolution._id}/deactivate`);
    setConfirming(null);
    resolutions.reload();
    status.reload();
  });

  const columns = [
    { key: 'type', title: 'Para', render: (r) => DOC_LABELS[r.docType] },
    { key: 'prefix', title: 'Prefijo', render: (r) => r.prefix || '—' },
    { key: 'number', title: 'Resolución', render: (r) => r.number },
    { key: 'range', title: 'Rango', align: 'right', render: (r) => `${r.from} a ${r.to}` },
    { key: 'next', title: 'Siguiente', align: 'right', render: (r) => (r.next > r.to ? 'Agotada' : r.next) },
    { key: 'validity', title: 'Vigencia', nowrap: true, render: (r) => `${formatDay(r.validFrom)} a ${formatDay(r.validTo)}` },
    { key: 'active', title: 'Estado', render: (r) => (!r.active ? 'Desactivada' : new Date(r.validTo) < new Date() ? 'Vencida' : r.next > r.to ? 'Agotada' : 'Vigente') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (r) =>
        canEdit && r.active ? (
          confirming === r._id ? (
            <span className="flex gap-3">
              <TextButton danger onClick={() => deactivate.run(r)}>Sí, desactivar</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          ) : (
            <TextButton onClick={() => { setConfirming(r._id); deactivate.clearError(); }}>Desactivar</TextButton>
          )
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Facturación electrónica" />
      <SandboxNotice status={status.data} />
      {status.data ? (
        <dl className="mb-6 grid max-w-xl grid-cols-[10rem_1fr] gap-y-1 text-sm text-tinta">
          <dt className="font-semibold">Proveedor</dt>
          <dd>{status.data.configured ? `${status.data.provider}${status.data.sandbox ? ' (simulado)' : ''}` : 'Sin proveedor conectado'}</dd>
          <dt className="font-semibold">Estado</dt>
          <dd>{status.data.ready ? 'Lista para emitir' : `Falta: ${status.data.missing.join(', ') || 'conectar un proveedor'}`}</dd>
        </dl>
      ) : null}
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      {settings.error ? <Notice kind="error">{errorMessage(settings.error)}</Notice> : null}
      {settings.data && accounts.data ? (
        <IssuerForm
          key={settings.data.settings?.updatedAt ?? 'nueva'}
          settings={settings.data.settings}
          accounts={accounts.data.items}
          canEdit={canEdit}
          country={tenant.country}
          onSaved={() => {
            setNotice('Configuración guardada.');
            settings.reload();
            status.reload();
          }}
        />
      ) : (
        <p className="text-sm text-tinta">Cargando la configuración…</p>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-t border-borde pt-6">
        <h2 className="text-lg font-semibold text-tinta">Resoluciones de numeración</h2>
        {canEdit && !creating ? <Button onClick={() => { setCreating(true); setNotice(null); }}>Nueva resolución</Button> : null}
      </div>
      <p className="mb-3 text-sm text-tinta">La autoridad tributaria autoriza el rango de números de cada tipo de documento. Los números se asignan sin huecos, de a uno por documento.</p>
      {creating ? (
        <ResolutionForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setNotice('Resolución creada.');
            resolutions.reload();
            status.reload();
          }}
        />
      ) : null}
      {deactivate.error ? <Notice kind="error">{errorMessage(deactivate.error)}</Notice> : null}
      {resolutions.error ? <Notice kind="error">{errorMessage(resolutions.error)}</Notice> : null}
      {resolutions.data ? <DataTable caption="Resoluciones de numeración" columns={columns} rows={resolutions.data.items} rowKey={(r) => r._id} empty="Todavía no hay resoluciones. Sin una vigente no se pueden emitir documentos." /> : null}
    </>
  );
}
