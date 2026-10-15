import { money } from '../../lib/orderFlow';
import { discountLabel, type AutoForm, type CodeForm } from '../../lib/promotions';
import { CouponLogo } from '../logos';

/**
 * Cómo lo verá el cliente: un cupón con su línea de corte. Es solo la cara del
 * descuento; lo que cuesta de verdad lo cuenta la simulación, a su lado.
 */

const dateEs = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });

export default function CouponTicket({ form, isCode }: { form: CodeForm | AutoForm; isCode: boolean }) {
  const code = isCode ? (form as CodeForm) : null;
  const productCount = isCode ? 0 : (form as AutoForm).productIds.length;
  const min = code?.minOrderAmount ?? 0;

  const lines = [
    min > 0 ? `Pedido mínimo ${money(min)}` : null,
    form.firstOrderOnly ? 'Solo primer pedido' : null,
    form.validFromTime && form.validUntilTime ? `De ${form.validFromTime} a ${form.validUntilTime}` : null,
    form.validUntil ? `Hasta el ${dateEs(form.validUntil)}` : 'Sin fecha de fin todavía',
  ].filter((line): line is string => !!line);

  return (
    <div className="promo-ticket" aria-label="Vista previa del cupón">
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">Así lo verá el cliente</p>
          <p className="text-4xl font-semibold leading-none tabular text-[var(--color-text-main)]">
            {discountLabel(form.type, form.value)}
          </p>
          <p className="truncate text-sm font-semibold text-[var(--color-text-main)]">
            {form.title.trim() || 'Sin título todavía'}
          </p>
        </div>
        <CouponLogo size={52} />
      </div>
      <div className="promo-ticket__rip" />
      <div className="space-y-1.5 p-4">
        {code ? (
          <p className="font-mono text-sm font-semibold tracking-wider text-[var(--color-text-main)]">
            {code.code.trim() || 'SIN CÓDIGO'}
          </p>
        ) : (
          <p className="text-sm font-semibold text-[var(--color-text-main)]">
            Se aplica sola · {productCount} producto(s)
          </p>
        )}
        {lines.map((line) => (
          <p key={line} className="text-xs text-[var(--color-text-secondary)]">{line}</p>
        ))}
      </div>
    </div>
  );
}
