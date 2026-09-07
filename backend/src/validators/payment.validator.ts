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
