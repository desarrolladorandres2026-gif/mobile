import { expect, test } from '@playwright/test';
import { checkDesign } from './helpers.js';

/** El verificador de diseño tiene que fallar de verdad: una comprobación que nunca falla no prueba nada. */
test.describe('el verificador del reglamento de diseño detecta las infracciones', () => {
  const page = (html) => `<body style="font-family:'Segoe UI Variable';color:#1a2230;background:#fff">${html}</body>`;

  const cases = [
    ['un icono SVG', '<svg width="16" height="16"><circle r="4"/></svg>', /imagen o icono/],
    ['una imagen', '<img alt="" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', /imagen o icono/],
    ['una sombra', '<div style="box-shadow:0 2px 4px #000">x</div>', /sombra/],
    ['un degradado', '<div style="background-image:linear-gradient(#fff,#000)">x</div>', /degradado/],
    ['esquinas redondeadas', '<div style="border-radius:12px;border:1px solid #c4ccd8">x</div>', /esquina redondeada/],
    ['opacidad', '<div style="opacity:.5">x</div>', /opacidad/],
    ['un texto dorado', '<p style="color:#d4af37">precio</p>', /texto fuera de paleta/],
    ['un texto naranja', '<p style="color:#ff8800">aviso</p>', /texto fuera de paleta/],
    ['un fondo morado', '<div style="background:#7c3aed">x</div>', /fondo fuera de paleta/],
    ['un borde fuera de paleta', '<div style="border:1px solid #ff00ff">x</div>', /borde fuera de paleta/],
    ['texto gris deslavado', '<p style="color:#8f9bad">tenue</p>', /contraste/],
    ['otra tipografía', '<p style="font-family:Georgia">serif</p>', /tipografía/],
  ];

  for (const [name, html, expected] of cases) {
    test(`detecta ${name}`, async ({ page: browserPage }) => {
      await browserPage.setContent(page(html));
      await expect(checkDesign(browserPage, name)).rejects.toThrow(expected);
    });
  }

  test('no da falsos positivos con una página que cumple', async ({ page: browserPage }) => {
    await browserPage.setContent(
      page('<h1 style="font-size:24px;color:#1a2230">Título</h1><p style="color:#3b4658">Texto</p><button style="background:#1b4f9c;color:#fff;border:0;border-radius:2px;font-family:\'Segoe UI Variable\'">Aceptar</button>'),
    );
    await checkDesign(browserPage, 'página correcta');
  });
});
