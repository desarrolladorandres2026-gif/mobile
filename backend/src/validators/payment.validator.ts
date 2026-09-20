import { z } from 'zod';
import { config } from '../config';

/**
 * Validation for the payment routes.
 *
 * These endpoints previously had none: `redirectUrl` travelled untouched
 * from the mobile client into the Web Checkout link's `redirect-url`
 * parameter, which means the gateway would send the customer anywhere the
 * caller named — from a page hosted on checkout.wompi.co, a domain with a
 * padlock and a reputation. That is a textbook open redirect (CWE-601) and
 * an unusually convincing phishing primitive.
 */

const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Identificador inválido');

/**
 * Where a post-payment redirect may land.
 *
 * An allowlist, never a denylist: the interesting attacks here are all
 * about what a blocklist forgot (`//evil.com`, `zipp:/\/evil`, userinfo
 * tricks like `https://zipp.co@evil.com`). Parsing with the URL constructor
 * and comparing the *parsed* origin sidesteps every one of them, because it
 * is the same parser the browser and the gateway will use.
 */
export function isAllowedRedirectUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // The app's own deep link — `zipp://payment-result`. This is the normal
  // path for a standalone build on iOS and Android.
  if (url.protocol === `${config.deepLinkScheme}:`) return true;

  // The web/PWA build returns to an origin we serve ourselves. Compared as
  // whole origins (scheme + host + port), so a lookalike host or a downgrade
  // to http on a production origin both fail.
  if (config.cors.origins.includes(url.origin)) return true;

  // Expo Go doesn't use `zipp://`: `Linking.createURL()` there returns
  // something like `exp://192.168.1.42:8081/--/payment-result`.
  //
  // This is deliberately not a wildcard on the `exp:` scheme — that would
  // accept a redirect to *any* Expo Go instance on *any* network, which is
  // exactly the open redirect this validator exists to close. Instead it
  // matches only `host:port` combinations Wompi's own dev config already
  // trusts for this exact purpose (see buildDevExpoRedirectHosts in
  // config/env.ts): the server's own detected LAN IP or localhost, on the
  // small set of ports Expo/Metro actually binds to.
  //
  // `config.devExpoRedirectHosts` is computed once at startup and is always
  // empty outside development, so this branch grants nothing in a deployed
  // build — there is no Expo Go client to return to there anyway.
  if (url.protocol === 'exp:' && config.devExpoRedirectHosts.includes(url.host)) {
    return true;
  }

  return false;
}

const redirectUrl = z
  .string()
  .trim()
  .max(2048, 'La URL de retorno es demasiado larga')
  .refine(isAllowedRedirectUrl, 'La URL de retorno no está permitida');

/**
 * POST /payments/orders/:orderId/pay
 *
 * `amount` is accepted only as a cross-check — PaymentService compares it
 * against the server's own figure and refuses on mismatch. It is never the
 * source of the charge, so it stays optional and is bounded here purely to
 * keep a nonsense value from reaching the comparison.
 */
export const initiatePaymentSchema = z.object({
  params: z.object({ orderId: objectId }),
  body: z
    .object({
      redirectUrl: redirectUrl.optional(),
      amount: z.number().int().min(0).max(100_000_000).optional(),
    })
    .strict(),
});

/**
 * Lo que un instrumento de pago **no** puede traer.
 *
 * El número de tarjeta y el CVV se tokenizan en el dispositivo contra Wompi
 * y jamás pasan por aquí. Si alguno llega, no es un caso que haya que
 * tolerar y limpiar: es un cliente mal programado mandando datos de tarjeta
 * a un servidor que no está preparado para verlos, y tiene que fallar de
 * forma ruidosa antes de que ese dato entre a un log de peticiones.
 *
 * Por eso cada variante es `.strict()` y además existe esta comprobación:
 * `.strict()` sola ya rechazaría el campo, pero con un mensaje genérico de
 * "clave desconocida" que nadie relacionaría con una fuga de PAN.
 */
const PROHIBITED_CARD_FIELDS = [
  'number',
  'card_number',
  'cardNumber',
  'pan',
  'cvc',
  'cvv',
  'card_holder',
  'exp_month',
  'exp_year',
];

export const noRawCardData = (value: unknown, ctx: z.RefinementCtx) => {
  if (!value || typeof value !== 'object') return;
  for (const field of PROHIBITED_CARD_FIELDS) {
    if (field in (value as Record<string, unknown>)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        fatal: true,
        message:
          'Los datos de la tarjeta no se envían a este servidor: tokenízalos contra la pasarela desde la aplicación.',
      });
      return;
    }
  }
};

/** `tok_test_…` / `tok_prod_…`, emitido por Wompi al dispositivo. */
const cardToken = z
  .string()
  .min(10)
  .max(120)
  .regex(/^tok_[a-z]+_[A-Za-z0-9_-]+$/, 'Token de tarjeta inválido');

/**
 * Con qué se cobra, discriminado por `kind`.
 *
 * Unión discriminada y no un objeto con todo opcional: así un Nequi no
 * puede traer campos de PSE "por si acaso", y lo que no corresponde al
 * carril elegido se rechaza en el borde en vez de ignorarse silenciosamente
 * en el proveedor.
 */
/**
 * Lo que la tokenización devolvió al dispositivo para pintar la tarjeta.
 * Nada de esto permite cobrar: marca, últimos cuatro y vencimiento.
 */
const cardDisplay = z
  .object({
    brand: z.string().trim().min(2).max(20).regex(/^[A-Za-z_ ]+$/),
    lastFour: z.string().regex(/^\d{4}$/),
    expMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
    expYear: z.string().regex(/^\d{2}$/),
  })
  .strict();

const installments = z.number().int().min(1).max(36);

export const paymentInstrument = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('card_token'),
      token: cardToken,
      // Wompi las exige en toda transacción con tarjeta. 1 = una sola cuota.
      installments: installments.default(1),
      save: z.boolean().optional(),
      card: cardDisplay.optional(),
    })
    .strict(),
  // Por **nuestro** id, nunca por el de la pasarela: ese es un entero
  // adivinable y aceptarlo permitiría cobrar la tarjeta de otra persona.
  z
    .object({
      kind: z.literal('saved_card'),
      savedCardId: objectId,
      installments: installments.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('nequi'),
      // Celular colombiano: 10 dígitos empezando por 3.
      phone: z.string().regex(/^3\d{9}$/, 'Número de Nequi inválido'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pse'),
      financialInstitutionCode: z.string().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/),
      // Codificación de Wompi: 0 natural, 1 jurídica.
      userType: z.union([z.literal(0), z.literal(1)]),
      userLegalIdType: z.enum(['CC', 'CE', 'NIT', 'TI', 'PP', 'DNI', 'RG', 'OTHER']),
      userLegalId: z.string().min(4).max(20).regex(/^[A-Za-z0-9]+$/),
    })
    .strict(),
]).refine((value) => value.kind !== 'card_token' || !value.save || Boolean(value.card), {
  message: 'Para guardar la tarjeta hacen falta su marca, últimos cuatro y vencimiento',
  path: ['card'],
});

/**
 * POST /payments/orders/:orderId/pay-native
 *
 * `params` se declara para que el id llegue a Mongo ya comprobado como
 * ObjectId, igual que en `/pay`.
 */
export const payNativeSchema = z.object({
  params: z.object({ orderId: objectId }),
  body: z
    .object({
      // La guarda corre **antes** del esquema: con `.strict()` sola, un
      // `cvc` colado saldría como "clave desconocida" y nadie lo leería
      // como lo que es.
      instrument: z.unknown().superRefine(noRawCardData).pipe(paymentInstrument),
      // El token de aceptación de Wompi es un JWT; se acota por forma y
      // longitud, pero quien decide si sigue vigente es la pasarela.
      acceptanceToken: z.string().min(20).max(2000),
      personalDataAuthToken: z.string().min(20).max(2000).optional(),
      // Sin `redirectUrl`: la dirección de regreso de PSE la fija el
      // servidor (https, dominio propio). Aceptarla de la app sería volver a
      // abrir la puerta a un redireccionamiento arbitrario.
      amount: z.number().int().min(0).max(100_000_000).optional(),
      /**
       * Solo para cuentas creadas con teléfono, que no tienen correo. Wompi
       * lo exige para mandar su comprobante; en el Web Checkout lo pedía su
       * propia página, y ahora que no hay página lo pide la app. Si la
       * cuenta ya tiene correo, este campo se ignora.
       */
      customerEmail: z.string().trim().toLowerCase().email().max(254).optional(),
      /**
       * Datos del navegador que 3D Secure v2 exige, con los nombres de Wompi
       * (`browser_color_depth`, `browser_user_agent`…). Solo se acota la
       * forma —claves `browser_*`, valores de texto cortos— y se reenvían tal
       * cual: su significado es del estándar, y validarlos campo a campo
       * aquí rompería el día que el estándar añada uno.
       */
      browserInfo: z
        .record(z.string().regex(/^browser_[a-z_]{2,40}$/), z.string().max(400))
        .refine((value) => Object.keys(value).length <= 20, 'Demasiados campos de navegador')
        .optional(),
    })
    .strict(),
});

/**
 * POST /payments/cards — guardar una tarjeta sin cobrar nada.
 *
 * El consentimiento de datos personales es obligatorio aquí, no opcional:
 * no hay forma de guardar una tarjeta sin él.
 */
export const saveCardSchema = z.object({
  body: z
    .object({
      token: cardToken,
      card: cardDisplay,
      acceptanceToken: z.string().min(20).max(2000),
      personalDataAuthToken: z.string().min(20).max(2000),
      customerEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    })
    .strict(),
});

/** DELETE /payments/cards/:id */
export const savedCardParamsSchema = z.object({
  params: z.object({ id: objectId }),
});

/**
 * GET /payments/status/:transactionId
 *
 * The key is either our own reference (`ZIPP-<id>-<base36>-<hex>`) or a
 * Wompi transaction id (`1234-1610641025-49201`). Both are conservative
 * alphanumerics with hyphens, so one pattern covers them and nothing that
 * could read as a Mongo operator gets through.
 */
export const paymentStatusSchema = z.object({
  params: z.object({
    transactionId: z
      .string()
      .min(6)
      .max(120)
      .regex(/^[A-Za-z0-9_-]+$/, 'Referencia de pago inválida'),
  }),
});

/** Any payment route keyed only by the order it belongs to. */
export const orderPaymentsSchema = z.object({
  params: z.object({ orderId: objectId }),
});

/**
 * POST /payments/orders/:orderId/chargeback
 *
 * Esta ruta no tenía ninguna validación, y mueve dinero: reversa asientos,
 * deshace liquidaciones y devuelve el cupón. Sin esquema, `amount` podía
 * llegar como decimal, negativo o directamente como un objeto —que acababa
 * en un 500 al llegar a `assertMoney`— y `reference` como cualquier cosa.
 *
 * `reference` es obligatoria y ese es el arreglo importante: es la clave de
 * idempotencia del contracargo (`chargeback:<reference>`). El controlador
 * la rellenaba con `Date.now()` cuando faltaba, así que cada reintento
 * generaba una clave distinta y registraba **otro** contracargo por el mismo
 * dinero. Un contracargo real siempre trae su referencia de la pasarela;
 * exigirla es lo que hace que reintentar sea gratis.
 */
export const chargebackSchema = z.object({
  params: z.object({ orderId: objectId }),
  body: z
    .object({
      amount: z.number().int().positive().max(100_000_000).optional(),
      reference: z
        .string()
        .trim()
        .min(4, 'Indica la referencia del contracargo de la pasarela')
        .max(120)
        .regex(/^[A-Za-z0-9_:.-]+$/, 'Referencia de contracargo inválida'),
    })
    .strict(),
});
