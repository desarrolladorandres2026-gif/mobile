/**
 * La variante decide qué app es esta. Un error aquí no se ve en desarrollo
 * (Metro arranca igual) y sí en producción: un APK de domiciliarios que
 * cree ser el de clientes manda a todo el mundo a la pantalla equivocada.
 */

// Reimporta constants/variant.ts con la variable de entorno dada, porque
// las constantes se calculan una sola vez al cargar el módulo.
function loadVariant(raw: string | undefined) {
  const before = process.env.EXPO_PUBLIC_APP_VARIANT;
  if (raw === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
  else process.env.EXPO_PUBLIC_APP_VARIANT = raw;
  let mod: typeof import('../constants/variant');
  jest.isolateModules(() => {
    mod = require('../constants/variant');
  });
  if (before === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
  else process.env.EXPO_PUBLIC_APP_VARIANT = before;
  return mod!;
}

describe('parseVariant', () => {
  it('acepta las dos variantes conocidas', () => {
    const { parseVariant } = loadVariant('client');
    expect(parseVariant('client')).toBe('client');
    expect(parseVariant('driver')).toBe('driver');
  });

  it('cae a client con un valor raro o ausente, sin reventar', () => {
    const { parseVariant } = loadVariant('client');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseVariant(undefined)).toBe('client');
    expect(parseVariant('business')).toBe('client');
    expect(parseVariant('')).toBe('client');
    warn.mockRestore();
  });
});

describe('constantes derivadas', () => {
  it('app de clientes: rol client, rutas (client), apunta a la app de domiciliarios', () => {
    const v = loadVariant('client');
    expect(v.APP_VARIANT).toBe('client');
    expect(v.IS_CLIENT_APP).toBe(true);
    expect(v.IS_DRIVER_APP).toBe(false);
    expect(v.ACCEPTED_ROLE).toBe('client');
    expect(v.APP_DISPLAY_NAME).toBe('Zipp');
    expect(v.APP_SCHEME).toBe('zipp');
    expect(v.HOME_ROUTE).toBe('/(client)/(tabs)/home');
    expect(v.PROFILE_ROUTE).toBe('/(client)/(tabs)/profile');
    expect(v.OTHER_APP.androidPackage).toBe('com.zipp.driver');
    expect(v.OTHER_APP.name).toBe('Zipp Domiciliarios');
    expect(v.OTHER_APP.playUrl).toContain('id=com.zipp.driver');
  });

  it('app de domiciliarios: rol driver, rutas (driver), apunta a la app de clientes', () => {
    const v = loadVariant('driver');
    expect(v.APP_VARIANT).toBe('driver');
    expect(v.IS_DRIVER_APP).toBe(true);
    expect(v.ACCEPTED_ROLE).toBe('driver');
    expect(v.APP_DISPLAY_NAME).toBe('Zipp Domiciliarios');
    expect(v.APP_SCHEME).toBe('zippdriver');
    expect(v.HOME_ROUTE).toBe('/(driver)/(tabs)/dashboard');
    expect(v.PROFILE_ROUTE).toBe('/(driver)/(tabs)/profile');
    expect(v.OTHER_APP.androidPackage).toBe('com.zipp.app');
    expect(v.OTHER_APP.name).toBe('Zipp');
    expect(v.OTHER_APP.marketUrl).toBe('market://details?id=com.zipp.app');
  });

  it('sin variable de entorno es la app de clientes', () => {
    const v = loadVariant(undefined);
    expect(v.APP_VARIANT).toBe('client');
  });
});

describe('scripts/app-variant (lado Node)', () => {
  const { resolveAppVariant } = require('../scripts/app-variant');
  const snapshot = { ...process.env };
  afterEach(() => {
    delete process.env.APP_VARIANT;
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    if (snapshot.APP_VARIANT) process.env.APP_VARIANT = snapshot.APP_VARIANT;
    if (snapshot.EXPO_PUBLIC_APP_VARIANT) process.env.EXPO_PUBLIC_APP_VARIANT = snapshot.EXPO_PUBLIC_APP_VARIANT;
  });

  it('propaga APP_VARIANT a EXPO_PUBLIC_APP_VARIANT para que Metro la inlinee', () => {
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    process.env.APP_VARIANT = 'driver';
    expect(resolveAppVariant()).toBe('driver');
    expect(process.env.EXPO_PUBLIC_APP_VARIANT).toBe('driver');
  });

  it('sin nada en el entorno construye la app de clientes', () => {
    delete process.env.APP_VARIANT;
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    expect(resolveAppVariant()).toBe('client');
  });

  it('rechaza una variante desconocida antes de construir nada', () => {
    process.env.APP_VARIANT = 'admin';
    expect(() => resolveAppVariant()).toThrow(/APP_VARIANT inválido/);
  });

  it('el preload de Gradle aborta si el entorno trae la otra variante', () => {
    const preload = require('../scripts/variant-preload/_preload');
    process.env.APP_VARIANT = 'client';
    expect(() => preload('driver')).toThrow(/flavor de Gradle es "driver"/);
    delete process.env.APP_VARIANT;
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    expect(() => preload('driver')).not.toThrow();
    expect(process.env.EXPO_PUBLIC_APP_VARIANT).toBe('driver');
  });
});
