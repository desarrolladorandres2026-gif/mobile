import { describe, it, expect } from 'vitest';
import { decideNavigation, isSameOrigin, isExternalLinkAllowed } from '../src/shared/navigation';

const PANEL = 'https://comercios.zipp.example';

describe('Navegación de la ventana principal', () => {
  it('el propio panel se queda dentro', () => {
    expect(decideNavigation(`${PANEL}/orders/123`, PANEL)).toEqual({ action: 'allow' });
    expect(isSameOrigin(`${PANEL}/settings`, PANEL)).toBe(true);
  });

  it('un puerto distinto no es el mismo origen', () => {
    expect(isSameOrigin('https://comercios.zipp.example:8443/', PANEL)).toBe(false);
  });

  it('http en vez de https no es el mismo origen, aunque el host coincida', () => {
    expect(isSameOrigin('http://comercios.zipp.example/', PANEL)).toBe(false);
  });

  it('WhatsApp, un tel: y una URL de documento firmada se abren afuera', () => {
    expect(decideNavigation('https://wa.me/573112421673', PANEL)).toEqual({ action: 'open-external' });
    expect(decideNavigation('tel:+573112421673', PANEL)).toEqual({ action: 'open-external' });
    expect(decideNavigation('https://res.cloudinary.com/zipp/doc.pdf?sig=abc', PANEL)).toEqual({ action: 'open-external' });
    expect(isExternalLinkAllowed('mailto:soporte@zipp.example')).toBe(true);
  });

  it('un enlace a otro dominio https se abre en el navegador del sistema, nunca dentro de la ventana', () => {
    // No se bloquea: el navegador del sistema muestra la URL real en su
    // barra de direcciones, que es justo la protección contra un dominio
    // parecido ("comercios-zipp" en vez de "comercios.zipp") suplantando al
    // panel. Lo peligroso sería dejarlo cargar DENTRO de la ventana, sin esa
    // barra — eso es lo que `isSameOrigin` impide.
    expect(decideNavigation('https://comercios-zipp.example/login', PANEL)).toEqual({ action: 'open-external' });
  });

  it('file:, javascript: y un esquema inventado se bloquean, no se abren afuera', () => {
    expect(decideNavigation('file:///etc/passwd', PANEL)).toEqual({ action: 'deny' });
    expect(decideNavigation('javascript:alert(1)', PANEL)).toEqual({ action: 'deny' });
    expect(decideNavigation('zippapp://whatever', PANEL)).toEqual({ action: 'deny' });
  });

  it('una URL rota nunca se deja pasar', () => {
    expect(decideNavigation('no-es-una-url', PANEL)).toEqual({ action: 'deny' });
  });
});
