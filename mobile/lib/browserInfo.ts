import { Dimensions, Platform } from 'react-native';

/**
 * El "navegador" que la app declara ante 3D Secure.
 *
 * 3DS v2 pide los datos del navegador en el que la persona resolverá el
 * reto del banco. En Zipp ese navegador es el WebView de pago, así que el
 * user agent que se declara aquí es **el mismo** que se le fija a ese
 * WebView (`PaymentWebView`). Si no coincidieran, el emisor vería una
 * autenticación iniciada desde un navegador y completada en otro, que es
 * justo la señal que busca para rechazar.
 *
 * Un user agent de navegador móvil corriente, con "Zipp" al final: las
 * páginas de los bancos lo tratan como Chrome o Safari móviles, y en los
 * registros del emisor se distingue de dónde vino.
 */
function buildUserAgent(): string {
  if (Platform.OS === 'ios') {
    const version = String(Platform.Version).replace(/\./g, '_');
    return (
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) ` +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zipp'
    );
  }
  const release = (Platform.constants as { Release?: string } | undefined)?.Release ?? String(Platform.Version);
  return (
    `Mozilla/5.0 (Linux; Android ${release}; Mobile) ` +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 Zipp'
  );
}

export const PAYMENT_USER_AGENT = buildUserAgent();

function locale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'es-CO';
  } catch {
    return 'es-CO';
  }
}

/**
 * Los seis campos que Wompi pide para 3D Secure, con sus nombres y todos
 * como texto, tal como los documenta.
 *
 * `browser_tz` es la diferencia con UTC en minutos según
 * `getTimezoneOffset()` —la definición de EMVCo—: 300 en Colombia (UTC−5).
 */
export function browserInfo(): Record<string, string> {
  const screen = Dimensions.get('screen');
  return {
    browser_color_depth: '24',
    browser_screen_height: String(Math.round(screen.height)),
    browser_screen_width: String(Math.round(screen.width)),
    browser_language: locale(),
    browser_user_agent: PAYMENT_USER_AGENT,
    browser_tz: String(new Date().getTimezoneOffset()),
  };
}
