import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AddressPicker } from '../components/AddressPicker';
import { LinkButton, PlainButton } from '../components/Button';
import { FormStatus, TextAreaField, TextField } from '../components/Form';
import { StateMessage } from '../components/StateMessage';
import { authApi } from '../lib/authApi';
import { clearCart, removeLine, setQuantity, useCart, MAX_LINE_QUANTITY } from '../lib/cart';
import {
  addressPoint, orderApi, paymentApi,
  type Address, type PaymentMethod, type QuoteInput,
} from '../lib/commerceApi';
import { money } from '../lib/format';
import { ApiError } from '../lib/http';
import { isWompiUrl } from '../lib/payUrl';
import { setPageMeta } from '../lib/meta';
import { describeExtras } from '../lib/modifiers';
import { isValidPhone } from '../lib/validate';
import { ME_KEY } from '../lib/useAuth';

const TIPS = [0, 1000, 2000, 3000, 5000];

/** Clave única por visita al pedido: si se pulsa dos veces o la red reintenta, el servidor reconoce el duplicado. */
function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 py-1 text-base ${strong ? 'font-semibold text-text-main' : 'text-text-main'}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export default function Pedido() {
  const cart = useCart();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const idempotencyKey = useRef(newIdempotencyKey());

  const [address, setAddress] = useState<Address | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash_on_delivery');
  const [needsChange, setNeedsChange] = useState(false);
  const [payingWith, setPayingWith] = useState('');
  const [tip, setTip] = useState(0);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState('');
  const [notes, setNotes] = useState('');
  const [forOther, setForOther] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [askBirth, setAskBirth] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPageMeta({ title: 'Tu pedido | ZIPP' });
  }, []);

  const point = address ? addressPoint(address) : null;

  const items = useMemo(
    () =>
      cart.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        // Solo ids y cantidades: los precios los pone el servidor.
        selectedExtras: l.choices.map((c) => ({ name: c.name, quantity: 1, groupId: c.groupId, optionId: c.optionId })),
        notes: l.notes,
      })),
    [cart.lines],
  );

  // El método de pago no cambia ninguna cifra: se cotiza con el elegido para ver los mismos números.
  const quoteInput: QuoteInput | null =
    cart.businessId && point && items.length > 0
      ? {
          businessId: cart.businessId,
          items,
          paymentMethod: method,
          deliveryLatitude: point.lat,
          deliveryLongitude: point.lng,
          couponCode: coupon || undefined,
          tip,
        }
      : null;

  const quoteQuery = useQuery({
    queryKey: ['quote', quoteInput],
    queryFn: () => orderApi.quote(quoteInput!),
    enabled: quoteInput !== null,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
  const quote = quoteQuery.data;
  const quoteError = quoteQuery.error instanceof ApiError ? quoteQuery.error.message : quoteQuery.error ? 'No pudimos calcular el total.' : null;

  if (cart.lines.length === 0 || !cart.businessId) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold text-text-main">Tu pedido</h1>
        <StateMessage kind="empty" title="Tu pedido está vacío">
          Elige un comercio y agrega productos para empezar.
        </StateMessage>
        <LinkButton href="/comercios" variant="primary">Ver comercios</LinkButton>
      </div>
    );
  }

  const applyCoupon = () => setCoupon(couponInput.trim().toUpperCase());

  const saveBirthDate = async () => {
    setError(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) { setError('Escribe tu fecha de nacimiento completa.'); return; }
    try {
      await authApi.updateProfile({ birthDate });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      setAskBirth(false);
      void place();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No pudimos guardar tu fecha de nacimiento.');
    }
  };

  async function place() {
    setError(null);
    if (!address || !point) { setError('Elige una dirección de entrega con punto en el mapa.'); return; }
    if (!quote) { setError(quoteError ?? 'Espera a que calculemos el total.'); return; }
    if (quote.total < quote.minOrder) { setError(`El pedido mínimo de este comercio es ${money(quote.minOrder)}.`); return; }
    if (forOther && (recipientName.trim().length < 2 || !isValidPhone(recipientPhone))) {
      setError('Escribe el nombre y el celular (10 dígitos) de quien recibe.');
      return;
    }
    const paying = Number(payingWith.replace(/\D/g, ''));
    if (method === 'cash_on_delivery' && needsChange && paying < quote.total) {
      setError('Con cuánto vas a pagar debe ser igual o mayor al total.');
      return;
    }

    setSubmitting(true);
    try {
      const order = await orderApi.create({
        businessId: cart.businessId!,
        items,
        paymentMethod: method,
        deliveryAddress: address.address,
        deliveryDetails: address.details || '',
        deliveryLatitude: point.lat,
        deliveryLongitude: point.lng,
        notes: notes.trim() || undefined,
        couponCode: coupon || undefined,
        tip,
        expectedTotal: quote.total,
        cashPayment: method === 'cash_on_delivery' ? { needsChange, payingWith: needsChange ? paying : undefined } : undefined,
        recipient: forOther ? { name: recipientName.trim(), phone: recipientPhone } : undefined,
        idempotencyKey: idempotencyKey.current,
      });

      if (method === 'online') {
        // El pedido ya existe: el carrito se vacía antes de ir a pagar para que un "atrás" no lo duplique.
        clearCart();
        try {
          const redirectUrl = `${window.location.origin}/pago/retorno?pedido=${encodeURIComponent(order._id)}`;
          const intent = await paymentApi.pay(order._id, redirectUrl);
          if (intent.checkoutUrl && isWompiUrl(intent.checkoutUrl)) {
            window.location.assign(intent.checkoutUrl);
            return;
          }
          if (intent.status !== 'approved') {
            navigate(`/pedidos/${order._id}`, { replace: true, state: { payError: 'Creamos tu pedido, pero no pudimos iniciar el cobro. Puedes pagarlo desde aquí.' } });
            return;
          }
        } catch (err) {
          navigate(`/pedidos/${order._id}`, {
            replace: true,
            state: { payError: err instanceof ApiError ? err.message : 'Creamos tu pedido, pero no pudimos iniciar el cobro.' },
          });
          return;
        }
      } else {
        clearCart();
      }
      navigate(`/pedidos/${order._id}`, { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'BIRTHDATE_REQUIRED') {
        setAskBirth(true);
      } else if (code === 'IDEMPOTENCY_MISMATCH') {
        // La misma clave ya creó un pedido distinto (p. ej. la respuesta se perdió y luego cambiaste el carrito).
        idempotencyKey.current = newIdempotencyKey();
        setError('Ya habías enviado un pedido distinto a este. Revisa «Mis pedidos» antes de confirmar otro.');
      } else if (!(err instanceof ApiError)) {
        // Corte por tiempo o de red: el servidor pudo crear el pedido. La clave se conserva para que reintentar no lo duplique.
        setError('La conexión se cortó y no sabemos si tu pedido se creó. Revisa «Mis pedidos»; si no está, vuelve a confirmar.');
      } else if (code === 'PRICE_CHANGED') {
        void quoteQuery.refetch();
        setError('El total de tu pedido cambió. Revisa el nuevo total y confírmalo de nuevo.');
      } else {
        setError(err instanceof ApiError ? err.message : 'No pudimos crear tu pedido. Inténtalo de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Tu pedido</h1>
      <p className="mt-1 text-base text-text-secondary">
        <Link to={`/negocio/${cart.businessSlug}`} className="underline underline-offset-4">{cart.businessName}</Link>
      </p>

      <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-productos">
        <h2 id="h-productos" className="text-xl font-semibold text-text-main">Productos</h2>
        <ul>
          {cart.lines.map((l) => (
            <li key={l.key} className="flex flex-wrap items-start justify-between gap-x-4 border-b border-border py-3">
              <div className="min-w-0">
                <p className="text-base font-semibold text-text-main">{l.name}</p>
                {l.choices.length > 0 && (
                  <p className="text-sm text-text-secondary">
                    {describeExtras(l.choices.map((c) => ({ name: c.name, groupName: c.groupName, optionId: c.optionId })))}
                  </p>
                )}
                {l.notes && <p className="text-sm text-text-secondary">Nota: {l.notes}</p>}
              </div>
              <div className="flex items-center">
                <button type="button" aria-label={`Una unidad menos de ${l.name}`} onClick={() => setQuantity(l.key, l.quantity - 1)} className="min-h-11 min-w-11 border border-border-strong text-lg font-semibold">−</button>
                <span className="min-w-11 text-center text-base font-semibold tabular-nums" aria-live="polite">{l.quantity}</span>
                <button type="button" aria-label={`Una unidad más de ${l.name}`} disabled={l.quantity >= MAX_LINE_QUANTITY} onClick={() => setQuantity(l.key, l.quantity + 1)} className="min-h-11 min-w-11 border border-border-strong text-lg font-semibold disabled:text-text-secondary">+</button>
                <button type="button" onClick={() => removeLine(l.key)} className="ml-3 min-h-11 text-base text-text-secondary underline underline-offset-4">Quitar</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-direccion">
        <h2 id="h-direccion" className="text-xl font-semibold text-text-main">Dirección de entrega</h2>
        <AddressPicker selectedId={address?._id ?? null} onSelect={setAddress} />
        {address && !point && <p className="mt-2 text-base text-text-main">Esta dirección no tiene punto en el mapa. Crea una nueva para poder pedir.</p>}
      </section>

      <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-pago">
        <h2 id="h-pago" className="text-xl font-semibold text-text-main">Pago</h2>
        <fieldset className="mt-2">
          <legend className="sr-only">Método de pago</legend>
          {([['cash_on_delivery', 'Efectivo al recibir'], ['online', 'En línea: tarjeta, PSE o Nequi']] as const).map(([value, label]) => (
            <label key={value} className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
              <input type="radio" name="pago" checked={method === value} onChange={() => setMethod(value)} className="h-5 w-5 accent-primary" />
              {label}
            </label>
          ))}
        </fieldset>
        {method === 'cash_on_delivery' && (
          <div className="mt-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
              <input type="checkbox" checked={needsChange} onChange={(e) => setNeedsChange(e.target.checked)} className="h-5 w-5 accent-primary" />
              Necesito cambio
            </label>
            {needsChange && (
              <div className="mt-2 max-w-xs">
                <TextField label="Pagas con" inputMode="numeric" value={payingWith} onChange={(e) => setPayingWith(e.target.value.replace(/\D/g, ''))} maxLength={7} />
              </div>
            )}
          </div>
        )}
        {method === 'online' && (
          <p className="mt-2 text-sm text-text-secondary">Te llevaremos a la página segura de Wompi para pagar y volverás aquí.</p>
        )}
      </section>

      <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-extras">
        <h2 id="h-extras" className="text-xl font-semibold text-text-main">Propina y cupón</h2>
        <p className="mt-2 text-base text-text-secondary">La propina llega completa a quien entrega.</p>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Propina">
          {TIPS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tip === t}
              onClick={() => setTip(t)}
              className={`min-h-11 border px-4 text-base ${tip === t ? 'border-primary-text font-semibold text-text-main' : 'border-border-strong text-text-secondary'}`}
            >
              {t === 0 ? 'Sin propina' : money(t)}
            </button>
          ))}
        </div>
        <div className="mt-4 flex max-w-sm items-end gap-3">
          <div className="flex-1">
            <TextField label="Cupón" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} maxLength={30} />
          </div>
          <PlainButton type="button" variant="secondary" onClick={applyCoupon}>Aplicar</PlainButton>
        </div>
        {quote?.suggestedCoupon && !coupon && (
          <button
            type="button"
            onClick={() => { setCouponInput(quote.suggestedCoupon!.code); setCoupon(quote.suggestedCoupon!.code); }}
            className="mt-2 min-h-11 text-base font-semibold text-primary-text underline underline-offset-4"
          >
            Usar el cupón {quote.suggestedCoupon.code}{quote.suggestedCoupon.title ? `: ${quote.suggestedCoupon.title}` : ''}
          </button>
        )}
      </section>

      <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-entrega">
        <h2 id="h-entrega" className="text-xl font-semibold text-text-main">Entrega</h2>
        <div className="mt-2 flex flex-col gap-4">
          <TextAreaField label="Nota para el pedido (opcional)" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
            <input type="checkbox" checked={forOther} onChange={(e) => setForOther(e.target.checked)} className="h-5 w-5 accent-primary" />
            Es para otra persona
          </label>
          {forOther && (
            <>
              <TextField label="Nombre de quien recibe" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={60} />
              <TextField label="Celular de quien recibe" type="tel" inputMode="numeric" maxLength={10} value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value.replace(/\D/g, ''))} />
            </>
          )}
        </div>
      </section>

      <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-resumen" aria-live="polite">
        <h2 id="h-resumen" className="text-xl font-semibold text-text-main">Resumen</h2>
        {!point ? (
          <p className="mt-2 text-base text-text-secondary">Elige una dirección para ver el domicilio y el total.</p>
        ) : quote ? (
          <dl className="mt-2">
            <Row label="Productos" value={money(quote.productSubtotal)} />
            <Row label="Domicilio" value={quote.freeDeliveryApplied || quote.deliveryPayable === 0 ? 'Gratis' : money(quote.deliveryPayable)} />
            {quote.customerServiceFee > 0 && <Row label="Tarifa de servicio" value={money(quote.customerServiceFee)} />}
            {quote.discount > 0 && <Row label={quote.coupon ? `Descuento (${quote.coupon.code})` : 'Descuento'} value={`− ${money(quote.discount)}`} />}
            {quote.tip > 0 && <Row label="Propina" value={money(quote.tip)} />}
            <Row label="Total" value={money(quote.total)} strong />
            <p className="mt-2 text-sm text-text-secondary">
              Entrega estimada: {quote.etaMinutesMin} a {quote.etaMinutesMax} minutos.
            </p>
            {quote.proBenefitNotice?.message && <p className="mt-2 text-sm text-text-secondary">{quote.proBenefitNotice.message}</p>}
            {quote.requiresAgeVerification && <p className="mt-2 text-sm text-text-main">Tu pedido incluye productos para mayores de 18 años. Te pediremos la cédula al entregar.</p>}
          </dl>
        ) : quoteQuery.isFetching ? (
          <p className="mt-2 text-base text-text-secondary">Calculando el total…</p>
        ) : null}
        {quoteError && <p role="alert" className="mt-2 text-base text-error">{quoteError}</p>}
      </section>

      {askBirth && (
        <section className="mt-6 border-t border-border pt-6">
          <h2 className="text-xl font-semibold text-text-main">Confirma tu edad</h2>
          <p className="mt-2 text-base text-text-secondary">Tu pedido tiene productos para mayores de 18 años. Necesitamos tu fecha de nacimiento; se guarda una sola vez.</p>
          <div className="mt-2 max-w-xs">
            <TextField label="Fecha de nacimiento" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </div>
          <div className="mt-3"><PlainButton type="button" onClick={saveBirthDate}>Guardar y continuar</PlainButton></div>
        </section>
      )}

      <div className="mt-6"><FormStatus error={error} /></div>
      <div className="mt-4 pb-6">
        <PlainButton type="button" onClick={() => void place()} disabled={submitting} className="w-full sm:w-auto">
          {submitting ? 'Creando tu pedido…' : method === 'online' ? 'Confirmar y pagar' : 'Confirmar pedido'}
        </PlainButton>
      </div>
    </div>
  );
}
