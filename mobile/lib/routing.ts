import {
  APP_VARIANT,
  ROUTE_GROUP,
  HOME_ROUTE,
  PROFILE_ROUTE,
  IS_DRIVER_APP,
  type AppVariant,
} from '../constants/variant';

/**
 * A dónde va alguien después de identificarse (o al arrancar con sesión).
 *
 * Antes esta decisión vivía repetida en seis sitios —splash, login (dos
 * veces), OTP, recuperar contraseña, tocar una push— y cada copia miraba
 * `user.role` a su manera. Al partir la app en dos, la regla cambia de
 * "¿qué rol tienes?" a "¿es esta tu app?", y eso solo se puede mantener
 * en un único lugar.
 *
 * Es lógica pura: recibe la variante como argumento (con la de este bundle
 * por defecto) para poder probar las dos apps desde un mismo test.
 */
export type StartDecision =
  | { kind: 'home' }
  | { kind: 'otp' }
  | { kind: 'complete-profile' }
  | { kind: 'login' }
  /** Cuenta válida, pero de la otra app (cliente en Zipp Domiciliarios o al revés). */
  | { kind: 'wrong-app'; role: 'client' | 'driver' }
  /** Cuentas que solo operan desde los paneles web. */
  | { kind: 'web-only'; role: 'admin' | 'business' };

export interface SessionUser {
  role: string;
  isVerified: boolean;
}

export interface SessionSnapshot {
  isAuthenticated: boolean;
  user: SessionUser | null;
}

const acceptedRoleFor = (variant: AppVariant) => (variant === 'driver' ? 'driver' : 'client');

/**
 * Tras un login, registro, OTP o cambio de contraseña con éxito.
 *
 * `needsPhone` viene de los logins sociales: Google/Apple no dan celular y
 * la cuenta queda a medio crear hasta que lo escriba. Solo aplica en la app
 * de clientes; en la de domiciliarios no hay login social.
 */
export function decideAfterAuth(
  user: SessionUser,
  opts: { needsPhone?: boolean } = {},
  variant: AppVariant = APP_VARIANT,
): StartDecision {
  if (user.role === 'admin' || user.role === 'business') {
    return { kind: 'web-only', role: user.role };
  }
  if (user.role !== acceptedRoleFor(variant)) {
    return { kind: 'wrong-app', role: user.role === 'driver' ? 'driver' : 'client' };
  }
  if (opts.needsPhone) return { kind: 'complete-profile' };
  if (!user.isVerified) return { kind: 'otp' };
  return { kind: 'home' };
}

/** Al arrancar la app, con lo que haya en el almacenamiento. */
export function decideAtStart(
  session: SessionSnapshot,
  variant: AppVariant = APP_VARIANT,
): StartDecision {
  if (session.isAuthenticated && session.user) {
    return decideAfterAuth(session.user, {}, variant);
  }
  return { kind: 'login' };
}

/** La ruta de expo-router que corresponde a cada decisión. */
export function hrefFor(decision: StartDecision, variant: AppVariant = APP_VARIANT): string {
  switch (decision.kind) {
    case 'home':
      return variant === 'driver' ? '/(driver)/(tabs)/dashboard' : '/(client)/(tabs)/home';
    case 'otp':
      return '/(auth)/otp';
    case 'complete-profile':
      return '/(auth)/complete-profile';
    case 'login':
      return '/(auth)/login';
    case 'wrong-app':
    case 'web-only':
      return `/(auth)/wrong-app?role=${decision.role}`;
  }
}

/**
 * Pantallas que existen en las dos apps, cada una dentro de su propio
 * grupo de rutas. Navegar con esto en vez de escribir `/(client)/help` a
 * mano es lo que permite que el grupo de la otra app no exista en el
 * bundle: una ruta cruzada sería una pantalla en blanco.
 */
export const ROUTES = {
  home: HOME_ROUTE,
  profile: PROFILE_ROUTE,
  help: `${ROUTE_GROUP}/help`,
  legal: `${ROUTE_GROUP}/legal`,
  requests: `${ROUTE_GROUP}/requests`,
  /** Listado de pedidos: el cliente lo tiene como pantalla suelta, el domiciliario como pestaña. */
  orders: IS_DRIVER_APP ? '/(driver)/(tabs)/orders' : '/(client)/orders',
  legalDocument: (kind: string, title?: string) => ({
    pathname: `${ROUTE_GROUP}/legal-document`,
    params: title ? { kind, title } : { kind },
  }),
  orderTimeline: (id: string) => ({
    pathname: `${ROUTE_GROUP}/order-timeline`,
    params: { id },
  }),
} as const;
