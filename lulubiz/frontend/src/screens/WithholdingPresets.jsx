import { useState } from 'react';
import { DeleteButton, Button, DataTable, Notice, SelectField, TextField, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatPercent, parsePercent } from '../lib/invoicing.js';
import { WITHHOLDING_BASES } from '../lib/purchases.js';
import { useTenantApi } from '../lib/session.jsx';

const BASE_LABEL = Object.fromEntries(WITHHOLDING_BASES.map((b) => [b.value, b.label]));

/**
 * Retenciones que la empresa usa a menudo (retefuente 2,5 %, reteIVA 15 %…). Al registrar una compra se eligen de una
 * lista en vez de escribir nombre, cuenta y tarifa cada vez. Cada cambio guarda la lista completa.
 */
export function WithholdingPresets({ presets, accounts, canEdit, onSaved }) {
  const base = useTenantApi();
  const [form, setForm] = useState({ name: '', accountId: '', basis: 'subtotal', rate: '' });
  const [showErrors, setShowErrors] = useState(false);
  const liabilities = accounts.filter((a) => a.postable && a.type === 'liability');
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const save = useSubmit(async (next) => {
    await api.put(`${base}/invoicing/withholding-presets`, { presets: next });
    onSaved();
  });

  const rateBps = parsePercent(form.rate);
  const errors = {
    name: form.name.trim() ? undefined : 'Escribe un nombre.',
    accountId: liabilities.some((a) => a.code === form.accountId.trim()) ? undefined : 'Elige una cuenta de pasivo de la lista.',
    rate: form.rate.trim() && rateBps !== null && rateBps >= 1 ? undefined : 'Escribe la tarifa, por ejemplo 2,5.',
  };
  const valid = !errors.name && !errors.accountId && !errors.rate;

  const add = async (e) => {
    e.preventDefault();
    setShowErrors(true);
    if (!valid) return;
    await save.run([...presets, { name: form.name.trim(), accountId: form.accountId.trim(), basis: form.basis, rateBps }]);
    setForm({ name: '', accountId: '', basis: 'subtotal', rate: '' });
    setShowErrors(false);
  };

  const columns = [
    { key: 'name', title: 'Nombre' },
    { key: 'accountId', title: 'Cuenta por pagar', render: (p) => `${p.accountId} · ${accounts.find((a) => a.code === p.accountId)?.name ?? ''}` },
    { key: 'basis', title: 'Sobre', render: (p) => BASE_LABEL[p.basis] },
    { key: 'rate', title: 'Tarifa', align: 'right', render: (p) => formatPercent(p.rateBps) },
    {
      key: 'actions',
      title: 'Acciones',
      render: (p) => (canEdit ? <DeleteButton onClick={() => save.run(presets.filter((x) => x.name !== p.name))}>Quitar</DeleteButton> : null),
    },
  ];

  return (
    <section className="mb-8 border-t border-borde pt-6">
      <h2 className="mb-1 text-lg font-semibold text-tinta">Retenciones predefinidas</h2>
      <p className="mb-3 text-sm text-tinta">Las que usas a menudo al comprar. Se eligen de una lista al registrar la compra; la tarifa y la cuenta se pueden ajustar allí.</p>
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      <DataTable caption="Retenciones predefinidas" columns={columns} rows={presets} rowKey={(p) => p.name} empty="Todavía no hay retenciones predefinidas." />
      {canEdit ? (
        <form onSubmit={add} noValidate className="mt-4">
          <datalist id="cuentas-retencion-predefinida">
            {liabilities.map((a) => (
              <option key={a.code} value={a.code}>{a.name}</option>
            ))}
          </datalist>
          <div className="grid gap-x-4 sm:grid-cols-4">
            <TextField label="Nombre" value={form.name} onChange={set('name')} maxLength={60} error={showErrors ? errors.name : undefined} />
            <TextField label="Cuenta por pagar" list="cuentas-retencion-predefinida" value={form.accountId} onChange={set('accountId')} maxLength={12} error={showErrors ? errors.accountId : undefined} hint={liabilities.find((a) => a.code === form.accountId.trim())?.name} />
            <SelectField label="Sobre" value={form.basis} onChange={set('basis')} options={WITHHOLDING_BASES} />
            <TextField label="Tarifa %" value={form.rate} onChange={set('rate')} inputMode="decimal" error={showErrors ? errors.rate : undefined} />
          </div>
          <Button type="submit" busy={save.busy}>Agregar retención predefinida</Button>
        </form>
      ) : null}
    </section>
  );
}
