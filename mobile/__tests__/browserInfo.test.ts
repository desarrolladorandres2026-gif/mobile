import { browserInfo, PAYMENT_USER_AGENT } from '../lib/browserInfo';

describe('browserInfo (3D Secure)', () => {
  it('entrega los seis campos de Wompi, todos como texto', () => {
    const info = browserInfo();
    expect(Object.keys(info).sort()).toEqual([
      'browser_color_depth',
      'browser_language',
      'browser_screen_height',
      'browser_screen_width',
      'browser_tz',
      'browser_user_agent',
    ]);
    Object.values(info).forEach((value) => expect(typeof value).toBe('string'));
  });

  it('declara el mismo user agent que usa el WebView del reto', () => {
    expect(browserInfo().browser_user_agent).toBe(PAYMENT_USER_AGENT);
    expect(PAYMENT_USER_AGENT).toMatch(/^Mozilla\/5\.0 .*Zipp$/);
  });

  it('la zona horaria es el desfase de getTimezoneOffset, en minutos', () => {
    expect(browserInfo().browser_tz).toBe(String(new Date().getTimezoneOffset()));
  });
});
