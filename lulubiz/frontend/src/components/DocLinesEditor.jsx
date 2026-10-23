import { useId } from 'react';
import { blankLine } from '../lib/commercial.js';
import { computeLine, formatPercent, parsePercent, parseQuantity } from '../lib/invoicing.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { CostCenterSelect } from './CostCenterSelect.jsx';
import { ItemPicker } from './ItemPicker.jsx';
import { DeleteButton, TextButton } from './ui.jsx';

const cell = 'w-full rounded-sm border bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul';

/**
 * Tabla de líneas de una cotización, una orden de compra o una factura recurrente. `accountMode` es `income` (cuenta de
 * ingreso opcional), `expense` (cuenta de gasto, costo o activo; obligatoria si no hay artículo) o `null`. `accounts` son
 * las cuentas que reciben asientos; `centers` los centros de costo activos (la columna sale solo si hay).
 */
export function DocLinesEditor({ base, lines, setLines, rates, currency, errors = [], showErrors = false, accountMode = null, accounts = [], centers = [], defaultRate }) {
  const listId = useId();
  const setLine = (i, field) => (e) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, [field]: field === 'vatBps' ? Number(e.target.value) : e.target.value } : l)));
  const pickItem = (i) => (itemText, item) =>
    setLines((ls) =>
      ls.map((l, n) => {
        if (n !== i) return l;
        const chosen = item && (!l.item || l.item._id !== item._id);
        return {
          ...l,
          itemText,
          item,
          ...(chosen && !l.description.trim() ? { description: item.name } : {}),
          ...(chosen && accountMode === 'income' && !l.unitPrice.trim() && item.price !== undefined ? { unitPrice: formatAmount(item.price, currency) } : {}),
        };
      }),
    );
  const accountsForMode = accounts.filter((a) => (accountMode === 'income' ? a.type === 'income' : ['asset', 'expense', 'cost'].includes(a.type)));

  return (
    <>
      <datalist id={listId}>
        {accountsForMode.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </datalist>
      <div className="relative overflow-x-auto">
        <table className="mb-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-borde-fuerte text-left">
              <th scope="col" className="px-2 py-2 font-semibold">Artículo (opcional)</th>
              <th scope="col" className="px-2 py-2 font-semibold">Descripción</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Cantidad</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Precio ({currency})</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Descuento %</th>
              <th scope="col" className="px-2 py-2 font-semibold">IVA</th>
              {accountMode ? <th scope="col" className="px-2 py-2 font-semibold">{accountMode === 'income' ? 'Cuenta' : 'Cuenta'}</th> : null}
              {centers.length ? <th scope="col" className="px-2 py-2 font-semibold">Centro de costo</th> : null}
              <th scope="col" className="px-2 py-2 text-right font-semibold">Total</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const e = (showErrors && errors[i]) || {};
              const quantity = parseQuantity(line.quantity);
              const unit = parseAmount(line.unitPrice, currency);
              const discount = parsePercent(line.discount);
              const preview = quantity !== null && unit !== null && discount !== null && line.unitPrice.trim() ? computeLine({ quantity, unitPrice: unit, discountBps: discount, vatBps: line.vatBps }) : null;
              const field = (name, label, className = '', props = {}) => (
                <input aria-label={`${label} de la línea ${i + 1}`} value={line[name]} onChange={setLine(i, name)} className={`${cell} ${e[name] ? 'border-rojo' : 'border-borde-fuerte'} ${className}`} {...props} />
              );
              const error = (name, align = '') => (e[name] ? <p role="alert" className={`text-xs font-semibold text-rojo ${align}`}>{e[name]}</p> : null);
              return (
                <tr key={i} className="border-b border-borde align-top">
                  <td className="px-2 py-2">
                    <ItemPicker base={base} label={`Artículo de la línea ${i + 1}`} className="w-40" text={line.itemText} item={line.item} onChange={pickItem(i)} error={e.item} showStock={false} />
                  </td>
                  <td className="px-2 py-2">
                    {field('description', 'Descripción', 'min-w-48', { maxLength: 200 })}
                    {error('description')}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('quantity', 'Cantidad', 'w-24 text-right tabular-nums', { inputMode: 'decimal' })}
                    {error('quantity', 'text-left')}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('unitPrice', 'Precio unitario', 'w-36 text-right tabular-nums', { inputMode: 'decimal' })}
                    {error('unitPrice', 'text-left')}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('discount', 'Descuento', 'w-20 text-right tabular-nums', { inputMode: 'decimal' })}
                    {error('discount', 'text-left')}
                  </td>
                  <td className="px-2 py-2">
                    <select aria-label={`IVA de la línea ${i + 1}`} value={line.vatBps} onChange={setLine(i, 'vatBps')} className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul">
                      {rates.map((r) => (
                        <option key={r} value={r}>{formatPercent(r)}</option>
                      ))}
                    </select>
                  </td>
                  {accountMode ? (
                    <td className="px-2 py-2">
                      {line.item && accountMode === 'expense' ? (
                        <p className="text-sm text-tinta">{line.item.inventoryAccount} (inventario)</p>
                      ) : (
                        <>
                          {field('accountId', 'Cuenta', 'w-28', { list: listId, ...(accountMode === 'income' && line.item?.incomeAccount ? { placeholder: line.item.incomeAccount } : {}) })}
                          {accountsForMode.find((a) => a.code === line.accountId.trim()) ? <p className="max-w-28 text-xs text-tinta">{accountsForMode.find((a) => a.code === line.accountId.trim()).name}</p> : null}
                          {error('accountId')}
                        </>
                      )}
                    </td>
                  ) : null}
                  {centers.length ? (
                    <td className="px-2 py-2">
                      <CostCenterSelect centers={centers} label={`Centro de costo de la línea ${i + 1}`} value={line.costCenter} onChange={setLine(i, 'costCenter')} />
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-tinta">{preview ? formatAmount(preview.total, currency) : ''}</td>
                  <td className="px-2 py-2">{lines.length > 1 ? <DeleteButton onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Quitar</DeleteButton> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TextButton onClick={() => setLines((ls) => [...ls, blankLine(defaultRate)])}>Agregar línea</TextButton>
    </>
  );
}

/** Subtotal, IVA por tarifa y total de unas líneas ya validadas. */
export function DocTotals({ totals, currency, totalLabel = 'Total' }) {
  return (
    <dl className="mb-4 mt-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
      <dt>Subtotal</dt>
      <dd className="text-right tabular-nums">{formatAmount(totals.subtotal, currency)}</dd>
      {totals.taxByRate.map((r) => (
        <div key={r.vatBps} className="contents">
          <dt>IVA {formatPercent(r.vatBps)} sobre {formatAmount(r.base, currency)}</dt>
          <dd className="text-right tabular-nums">{formatAmount(r.tax, currency)}</dd>
        </div>
      ))}
      <dt className="font-semibold">{totalLabel}</dt>
      <dd className="text-right text-base font-semibold tabular-nums">{formatAmount(totals.total, currency)}</dd>
    </dl>
  );
}
