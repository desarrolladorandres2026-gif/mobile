/**
 * La regla de "a dónde va alguien" tras entrar o al arrancar, para las dos
 * apps. Es la que impide que un cliente se quede dentro de Zipp
 * Domiciliarios (o al revés), así que se prueba la matriz completa.
 */
import { decideAfterAuth, decideAtStart, hrefFor, ROUTES } from '../lib/routing';

const client = { role: 'client', isVerified: true };
const driver = { role: 'driver', isVerified: true };
const admin = { role: 'admin', isVerified: true };
const business = { role: 'business', isVerified: true };

describe('decideAfterAuth', () => {
  it('en la app de clientes: cliente entra, domiciliario va a wrong-app', () => {
    expect(decideAfterAuth(client, {}, 'client')).toEqual({ kind: 'home' });
    expect(decideAfterAuth(driver, {}, 'client')).toEqual({ kind: 'wrong-app', role: 'driver' });
  });

  it('en la app de domiciliarios: domiciliario entra, cliente va a wrong-app', () => {
    expect(decideAfterAuth(driver, {}, 'driver')).toEqual({ kind: 'home' });
    expect(decideAfterAuth(client, {}, 'driver')).toEqual({ kind: 'wrong-app', role: 'client' });
  });

  it('admin y comercio nunca entran por el móvil, en ninguna app', () => {
    for (const variant of ['client', 'driver'] as const) {
      expect(decideAfterAuth(admin, {}, variant)).toEqual({ kind: 'web-only', role: 'admin' });
      expect(decideAfterAuth(business, {}, variant)).toEqual({ kind: 'web-only', role: 'business' });
    }
  });

  it('el rol se comprueba antes que la verificación: un cliente sin verificar tampoco entra en driver', () => {
    expect(decideAfterAuth({ ...client, isVerified: false }, {}, 'driver')).toEqual({
      kind: 'wrong-app',
      role: 'client',
    });
  });

  it('sin verificar → OTP; con needsPhone (login social) → completar perfil antes que nada', () => {
    expect(decideAfterAuth({ ...client, isVerified: false }, {}, 'client')).toEqual({ kind: 'otp' });
    expect(decideAfterAuth({ ...client, isVerified: false }, { needsPhone: true }, 'client')).toEqual({
      kind: 'complete-profile',
    });
  });
});

describe('decideAtStart', () => {
  it('sin sesión, la app de clientes respeta el onboarding', () => {
    const base = { isAuthenticated: false, user: null };
    expect(decideAtStart({ ...base, onboardingSeen: false }, 'client')).toEqual({ kind: 'welcome' });
    expect(decideAtStart({ ...base, onboardingSeen: true }, 'client')).toEqual({ kind: 'login' });
  });

  it('sin sesión, la app de domiciliarios va directo al login (no hay onboarding)', () => {
    const base = { isAuthenticated: false, user: null };
    expect(decideAtStart({ ...base, onboardingSeen: false }, 'driver')).toEqual({ kind: 'login' });
    expect(decideAtStart({ ...base, onboardingSeen: true }, 'driver')).toEqual({ kind: 'login' });
  });

  it('con sesión guardada aplica la misma regla que tras el login', () => {
    const session = (user: typeof client) => ({ isAuthenticated: true, user, onboardingSeen: true });
    expect(decideAtStart(session(client), 'client')).toEqual({ kind: 'home' });
    expect(decideAtStart(session(driver), 'client')).toEqual({ kind: 'wrong-app', role: 'driver' });
    expect(decideAtStart(session(client), 'driver')).toEqual({ kind: 'wrong-app', role: 'client' });
    expect(decideAtStart(session(admin), 'driver')).toEqual({ kind: 'web-only', role: 'admin' });
  });

  it('isAuthenticated sin user (almacenamiento a medio cargar) se trata como sin sesión', () => {
    expect(decideAtStart({ isAuthenticated: true, user: null, onboardingSeen: true }, 'client')).toEqual({
      kind: 'login',
    });
  });
});

describe('hrefFor', () => {
  it('home es el inicio de cada app', () => {
    expect(hrefFor({ kind: 'home' }, 'client')).toBe('/(client)/(tabs)/home');
    expect(hrefFor({ kind: 'home' }, 'driver')).toBe('/(driver)/(tabs)/dashboard');
  });

  it('wrong-app y web-only llevan el rol en la URL para que la pantalla explique cuál es', () => {
    expect(hrefFor({ kind: 'wrong-app', role: 'driver' }, 'client')).toBe('/(auth)/wrong-app?role=driver');
    expect(hrefFor({ kind: 'web-only', role: 'business' }, 'driver')).toBe('/(auth)/wrong-app?role=business');
  });

  it('las pantallas de auth son las mismas rutas en ambas apps', () => {
    for (const variant of ['client', 'driver'] as const) {
      expect(hrefFor({ kind: 'otp' }, variant)).toBe('/(auth)/otp');
      expect(hrefFor({ kind: 'login' }, variant)).toBe('/(auth)/login');
      expect(hrefFor({ kind: 'welcome' }, variant)).toBe('/(auth)/welcome');
      expect(hrefFor({ kind: 'complete-profile' }, variant)).toBe('/(auth)/complete-profile');
    }
  });
});

describe('ROUTES (del bundle actual, que en tests es la app de clientes)', () => {
  it('apunta siempre al grupo de esta app, nunca al otro', () => {
    for (const value of [ROUTES.home, ROUTES.profile, ROUTES.help, ROUTES.legal, ROUTES.requests, ROUTES.orders]) {
      expect(value).toMatch(/^\/\(client\)\//);
    }
    expect(ROUTES.orderTimeline('abc')).toEqual({ pathname: '/(client)/order-timeline', params: { id: 'abc' } });
    expect(ROUTES.legalDocument('terms', 'Términos')).toEqual({
      pathname: '/(client)/legal-document',
      params: { kind: 'terms', title: 'Términos' },
    });
  });
});
