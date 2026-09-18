import { Smartphone } from 'lucide-react';
import { LinkButton } from '../components/Button';

/**
 * A donde vuelve el banco después de un pago con PSE.
 *
 * En el camino normal esta página **no se llega a cargar**: el pago ocurre
 * dentro de un WebView de la app Zipp, que intercepta esta dirección antes
 * de abrirla y pasa a consultar el resultado. Existe para el caso raro en
 * que el banco termine fuera de ese WebView (otra pestaña, otro
 * navegador): sin ella, la persona acabaría en un 404 justo después de
 * pagar.
 *
 * No dice si el pago salió bien, y es a propósito: esta página no sabe
 * nada del pago. El resultado lo confirma Wompi y lo muestra la app.
 */
export default function PaymentReturn() {
  return (
    <div className="px-6 sm:px-10 py-24 text-center max-w-md mx-auto">
      <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-full bg-primary-bg text-primary">
        <Smartphone className="h-7 w-7" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Vuelve a Zipp para ver tu pago</h1>
      <p className="mt-3 text-sm text-text-secondary">
        Tu banco terminó el proceso. El resultado de tu pago y el estado de tu pedido
        aparecen en la app Zipp en cuanto Wompi lo confirma.
      </p>
      <LinkButton href="zipp://payment-result" variant="primary" className="mt-8 w-full sm:w-auto">
        Volver a la app Zipp
      </LinkButton>
      <p className="mt-3 text-xs text-text-muted">
        Si el botón no hace nada, abre Zipp y revisa el pedido en Mis pedidos.
      </p>
    </div>
  );
}
