import { Pencil, Trash2 } from 'lucide-react';
import { money } from '../lib/orderFlow';
import {
  TYPE_LABELS, consumption, discountLabel, resolveStatus,
  type Coupon,
} from '../lib/promotions';
import { CouponLogo, RatingLogo, WalletLogo } from './logos';
import PromotionStatusBadge from './PromotionStatusBadge';

/**
 * Una promoción de la lista, como tarjeta: el valor grande, cómo se activa, lo
 * que lleva gastado y un interruptor. El color de la franja superior es el
 * estado (activa, programada, agotada). Las acciones aparecen al pasar el
 * cursor o con el foco, y siempre se ven en pantallas táctiles.
 */

interface Props {
  coupon: Coupon;
  index: number;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}

const dateEs = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

export default function PromotionCard({ coupon, index, onEdit, onToggle, onDelete }: Props) {
  const used = consumption(coupon);
  const { tone } = resolveStatus(coupon);
  const Logo = coupon.autoApply ? RatingLogo : coupon.type === 'fixed' ? WalletLogo : CouponLogo;

  const details = [
    coupon.minOrderAmount ? `Mínimo ${money(coupon.minOrderAmount)}` : null,
    coupon.firstOrderOnly ? 'Primer pedido' : null,
    coupon.validFromTime && coupon.validUntilTime ? `${coupon.validFromTime}–${coupon.validUntilTime}` : null,
  ].filter((d): d is string => !!d);

  return (
    <article
      className={`promo-card ${coupon.isActive ? '' : 'opacity-75'}`}
      data-tone={tone}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <Logo size={44} />
        <div className="flex items-center gap-3">
          <PromotionStatusBadge promotion={coupon} />
          <button
            type="button"
            role="switch"
            aria-checked={coupon.isActive}
            aria-label={coupon.isActive ? `Desactivar ${coupon.title}` : `Activar ${coupon.title}`}
            onClick={onToggle}
            className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
              coupon.isActive
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
                : 'border-[var(--color-border-strong)] bg-[var(--color-bg-alt)]'
            }`}
          >
            <span
              className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
                coupon.isActive ? 'left-[1.1rem] bg-[var(--zipp-obsidian)]' : 'left-0.5 bg-[var(--color-text-secondary)]'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="min-w-0 space-y-0.5">
        <p className="text-3xl font-semibold leading-none tabular text-[var(--color-text-main)]">
          {discountLabel(coupon.type, coupon.value)}
          <span className="ml-2 text-xs font-medium text-[var(--color-text-secondary)]">{TYPE_LABELS[coupon.type]}</span>
        </p>
        <h3 className="truncate pt-1.5 text-sm font-semibold text-[var(--color-text-main)]">{coupon.title}</h3>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {coupon.autoApply ? (
            <>Automática · {coupon.productIds?.length ?? 0} producto(s)</>
          ) : (
            <>Código <span className="font-mono font-semibold text-[var(--color-text-main)]">{coupon.code}</span></>
          )}
        </p>
        {details.length > 0 && (
          <p className="text-xs text-[var(--color-text-secondary)]">{details.join(' · ')}</p>
        )}
        <p className="text-xs text-[var(--color-text-secondary)]">
          {coupon.validFrom ? `${dateEs(coupon.validFrom)} → ` : 'Hasta el '}
          {dateEs(coupon.validUntil)}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs tabular text-[var(--color-text-secondary)]">
          {coupon.usedCount ?? 0} {(coupon.usedCount ?? 0) === 1 ? 'uso' : 'usos'}
          {used ? ` · ${used.label}` : ' · sin tope'}
        </p>
        {used && (
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
            role="progressbar"
            aria-valuenow={Math.round(used.ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full transition-all ${used.ratio >= 0.9 ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-primary)]'}`}
              style={{ width: `${used.ratio * 100}%` }}
            />
          </div>
        )}
      </div>

      <div className="promo-card__actions flex items-center gap-4 border-t border-[var(--color-border)] pt-2.5">
        <button type="button" onClick={onEdit} className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-[var(--color-text-main)] hover:underline">
          <Pencil className="h-3.5 w-3.5" /> Editar
        </button>
        {(coupon.usedCount ?? 0) === 0 && (
          <button type="button" onClick={onDelete} className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-[var(--color-danger)] hover:underline">
            <Trash2 className="h-3.5 w-3.5" /> Eliminar
          </button>
        )}
      </div>
    </article>
  );
}
