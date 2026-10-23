import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LinkButton } from '../components/Button';
import { StateMessage } from '../components/StateMessage';
import { orderApi, paymentApi } from '../lib/commerceApi';
import { setPageMeta } from '../lib/meta';
import { declinedMessage } from '../lib/paymentCopy';
import { paymentPollInterval } from '../lib/paymentPolling';
import { ApiError } from '../lib/http';
import { useAuth } from '../lib/useAuth';

const MAX_POLL_MS = 15 * 60_000;

type Phase = 'checking' | 'approved' | 'declined' | 'pending' | 'unknown';

/**
 * A donde vuelve Wompi (y los bancos de PSE) tras el pago.
 *
 * El resultado oficial lo decide el webhook del servidor, no la URL: aquí solo
 * se pregunta y se muestra. Si la persona perdió el parámetro, se recupera el
 * estado desde el propio pedido.
 */
export default function PagoRetorno() {
  const [params] = useSearchParams();
  const orderId = params.get('pedido');
  const transactionId = params.get('id');
  const { status: auth } = useAuth();
  const [phase, setPhase] = useState<Phase>('checking');
  const [reason, setReason] = useState<string | null>(null);
  const started = useRef(0);

  useEffect(() => {
    setPageMeta({ title: 'Resultado del pago | ZIPP' });
  }, []);

  useEffect(() => {
    if (auth !== 'authenticated') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    started.current = Date.now();

    const check = async () => {
      let next = 'unknown' as Phase;
      try {
        // Con `pedido` manda el estado del propio pedido: `id` solo es una pista y no se cruza con él.
        if (transactionId && !orderId) {
          const s = await paymentApi.status(transactionId);
          if (s.status === 'approved') next = 'approved';
          else if (s.status === 'declined' || s.status === 'error' || s.status === 'voided') {
            next = 'declined';
            setReason(s.declineReason ?? null);
          } else next = 'pending';
        } else if (orderId) {
          const o = await orderApi.get(orderId);
          if (o.paymentStatus === 'paid') next = 'approved';
          else if (o.paymentStatus === 'failed') next = 'declined';
          else next = 'pending';
        }
      } catch (err) {
        // Un 429 o un corte de red no es un pago fallido: se sigue preguntando.
        next = err instanceof ApiError && err.status < 500 && err.status !== 429 ? 'unknown' : 'pending';
      }
      if (cancelled) return;
      setPhase(next);
      // Tope de 15 min: pasado ese tiempo se deja de preguntar y la persona ve el estado en su pedido.
      if ((next === 'pending' || next === 'checking') && Date.now() - started.current < MAX_POLL_MS) {
        timer = setTimeout(check, paymentPollInterval(Date.now() - started.current));
      }
    };

    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [auth, orderId, transactionId]);

  const orderLink = orderId ? `/pedidos/${orderId}` : '/pedidos';

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Resultado del pago</h1>

      {auth === 'loading' && <StateMessage kind="loading" title="Cargando tu cuenta" />}

      {auth === 'anonymous' && (
        <StateMessage kind="error" title="Inicia sesión para ver tu pago">
          <Link to={`/ingresar?volver=${encodeURIComponent(`/pago/retorno${window.location.search}`)}`} className="font-semibold underline underline-offset-4">
            Ingresar
          </Link>
        </StateMessage>
      )}

      {auth === 'authenticated' && (
        <>
          {phase === 'checking' && <StateMessage kind="loading" title="Confirmando tu pago">Esto toma unos segundos.</StateMessage>}
          {phase === 'approved' && (
            <StateMessage kind="empty" title="Pago aprobado">El comercio ya recibió tu pedido.</StateMessage>
          )}
          {phase === 'declined' && (
            <StateMessage kind="error" title="El pago no se completó">
              {declinedMessage(reason, 'Puedes intentarlo de nuevo desde tu pedido.')}
            </StateMessage>
          )}
          {phase === 'pending' && (
            <StateMessage kind="loading" title="Tu pago sigue en revisión">
              Algunos bancos y Nequi tardan unos minutos. Puedes cerrar esta página: te avisaremos cuando se confirme.
            </StateMessage>
          )}
          {phase === 'unknown' && (
            <StateMessage kind="error" title="No pudimos confirmar tu pago">
              Revisa el estado en tu pedido. Si te cobraron y no ves el pedido aprobado, escríbenos desde Soporte.
            </StateMessage>
          )}
          <LinkButton href={orderLink} variant="primary">Ver mi pedido</LinkButton>
        </>
      )}
    </div>
  );
}
