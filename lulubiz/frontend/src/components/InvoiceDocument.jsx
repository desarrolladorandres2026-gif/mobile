import { formatDay } from '../lib/format.js';
import { formatPercent, formatQuantity } from '../lib/invoicing.js';
import { formatAmount } from '../lib/money.js';
import { QrCode } from '../screens/Security.jsx';

const REGIME = { responsable_iva: 'Responsable de IVA', no_responsable: 'No responsable de IVA' };
const PAYMENT = { cash: 'Contado', credit: 'Crédito' };
const taxIdText = (p) => `${p.taxIdType} ${p.taxId}${p.checkDigit !== undefined ? `-${p.checkDigit}` : ''}`;
const addressText = (a) => [a?.line, a?.city, a?.region].filter(Boolean).join(', ');

/**
 * Representación impresa de una factura: lo que se entrega al cliente. Pensada para papel (o «Guardar como PDF» del
 * navegador): texto negro sobre blanco, sin colores de la interfaz. `issuer` viene de la configuración de facturación.
 */
export function InvoiceDocument({ invoice, issuer }) {
  const currency = invoice.currency;
  const c = invoice.customer;
  return (
    <article className="max-w-4xl bg-papel text-sm text-tinta" aria-label={`Factura ${invoice.fullNumber}`}>
      {invoice.provider?.sandbox ? (
        <p className="mb-4 border-b border-tinta pb-2 font-semibold">Documento de pruebas: no tiene validez ante la autoridad tributaria.</p>
      ) : null}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-6 border-b border-tinta pb-4">
        <div>
          <h2 className="text-xl font-semibold">{issuer?.name ?? ''}</h2>
          {issuer ? (
            <>
              <p>{taxIdText(issuer)}</p>
              <p>{REGIME[issuer.regime] ?? ''}</p>
              <p>{addressText(issuer.address)}</p>
              {issuer.phone || issuer.email ? <p>{[issuer.phone, issuer.email].filter(Boolean).join(' · ')}</p> : null}
            </>
          ) : null}
        </div>
        <div className="text-right">
          <p className="font-semibold">Factura electrónica de venta</p>
          <p className="text-xl font-semibold">{invoice.fullNumber}</p>
          <p>Fecha: {formatDay(invoice.issueDate)}</p>
          {invoice.dueDate ? <p>Vence: {formatDay(invoice.dueDate)}</p> : null}
          <p>Forma de pago: {PAYMENT[invoice.paymentMethod] ?? invoice.paymentMethod}</p>
        </div>
      </header>

      <section className="mb-6">
        <h3 className="font-semibold">Cliente</h3>
        <p>{c.name}</p>
        <p>{taxIdText(c)}</p>
        {addressText(c.address) ? <p>{addressText(c.address)}</p> : null}
        {c.phone || c.email ? <p>{[c.phone, c.email].filter(Boolean).join(' · ')}</p> : null}
      </section>

      <div className="relative overflow-x-auto">
        <table className="mb-4 w-full border-collapse">
          <thead>
            <tr className="border-b border-tinta text-left">
              <th scope="col" className="py-1 pr-3 font-semibold">Descripción</th>
              <th scope="col" className="py-1 pr-3 text-right font-semibold">Cant.</th>
              <th scope="col" className="py-1 pr-3 text-right font-semibold">Precio</th>
              <th scope="col" className="py-1 pr-3 text-right font-semibold">Desc.</th>
              <th scope="col" className="py-1 pr-3 text-right font-semibold">IVA</th>
              <th scope="col" className="py-1 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l, i) => (
              <tr key={i} className="border-b border-borde align-top">
                <td className="py-1 pr-3">{l.description}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{formatAmount(l.unitPrice, currency)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{l.discountBps ? formatPercent(l.discountBps) : ''}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{formatPercent(l.vatBps)}</td>
                <td className="py-1 text-right tabular-nums">{formatAmount(l.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mb-6 ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        <dt>Subtotal</dt>
        <dd className="text-right tabular-nums">{formatAmount(invoice.totals.subtotal + invoice.totals.discount, currency)}</dd>
        {invoice.totals.discount ? (
          <>
            <dt>Descuentos</dt>
            <dd className="text-right tabular-nums">-{formatAmount(invoice.totals.discount, currency)}</dd>
          </>
        ) : null}
        {invoice.totals.taxByRate.map((r) => (
          <div key={r.vatBps} className="contents">
            <dt>IVA {formatPercent(r.vatBps)}</dt>
            <dd className="text-right tabular-nums">{formatAmount(r.tax, currency)}</dd>
          </div>
        ))}
        <dt className="border-t border-tinta pt-1 font-semibold">Total a pagar ({currency})</dt>
        <dd className="border-t border-tinta pt-1 text-right font-semibold tabular-nums">{formatAmount(invoice.totals.total, currency)}</dd>
      </dl>

      {invoice.notes ? <p className="mb-4">Notas: {invoice.notes}</p> : null}

      <footer className="flex flex-wrap items-end justify-between gap-4 border-t border-tinta pt-3 text-xs">
        <div className="min-w-0 flex-1">
          <p>Resolución {invoice.resolution.number}, numeración del {invoice.resolution.from} al {invoice.resolution.to}, vigente hasta {formatDay(invoice.resolution.validTo)}.</p>
          {invoice.cufe ? <p className="break-all">CUFE: {invoice.cufe}</p> : null}
          {invoice.validatedAt ? <p>Validada el {formatDay(invoice.validatedAt)}.</p> : null}
          {invoice.provider ? <p>Proveedor tecnológico: {invoice.provider.name}.</p> : null}
        </div>
        {invoice.qr ? <QrCode value={invoice.qr} label="Código QR de la factura" /> : null}
      </footer>
    </article>
  );
}
