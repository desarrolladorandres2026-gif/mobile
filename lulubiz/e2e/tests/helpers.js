import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export const PASSWORD = 'correcto-caballo-grapa';

/** Paleta del reglamento de diseño: todo color visible en la interfaz debe estar aquí. */
export const PALETTE = [
  '#1b4f9c', '#143c78', '#e6edf8', // azul
  '#1e7b4a', '#e3f2ea', // verde
  '#b3261e', '#8f1e18', '#fbe9e7', // rojo
  '#ffffff', '#f3f5f8', // superficies
  '#c4ccd8', '#8f9bad', // bordes
  '#1a2230', '#3b4658', // texto
];

const SHOTS = new URL('../shots/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });
let counter = 0;
export const shot = (page, name) =>
  page.screenshot({ path: fileURLToPath(new URL(`${String(++counter).padStart(2, '0')}-${name}.png`, SHOTS)), fullPage: true });

/** Último correo enviado a una dirección, leído del banco de pruebas. */
export async function lastMail(request, to) {
  const response = await request.get(`/__mail?to=${encodeURIComponent(to)}`);
  return response.json();
}

export async function tokenFromMail(request, to) {
  const mail = await lastMail(request, to);
  expect(mail, `no hay correo para ${to}`).not.toBeNull();
  return decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
}

/**
 * Comprueba el reglamento de diseño sobre lo que se ve en la pantalla:
 * sin iconos ni imágenes, sin sombras ni degradados, esquinas casi rectas, sin opacidades,
 * solo colores de la paleta (texto, fondos y bordes), tipografía Segoe UI Variable y contraste suficiente.
 */
export async function checkDesign(page, label) {
  const problems = await page.evaluate((palette) => {
    const found = [];
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const hex = ({ r, g, b }) => `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
    const allowed = new Set(palette);
    const luminance = ({ r, g, b }) => {
      const channel = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const backgroundOf = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg.a === 1) return bg;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const name = (el) => `${el.tagName.toLowerCase()}${el.textContent ? `«${el.textContent.trim().slice(0, 28)}»` : ''}`;

    const qr = (el) => el.closest('svg')?.getAttribute('aria-label')?.startsWith('Código QR');
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || qr(el)) continue;
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      if (['svg', 'img', 'canvas', 'video', 'picture'].includes(tag)) found.push(`imagen o icono <${tag}>`);
      if (cs.boxShadow !== 'none') found.push(`sombra en ${name(el)}`);
      if (cs.backgroundImage !== 'none') found.push(`degradado o imagen de fondo en ${name(el)}`);
      for (const corner of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
        if (parseFloat(cs[`border${corner}Radius`]) > 4) found.push(`esquina redondeada en ${name(el)}`);
      }
      if (parseFloat(cs.opacity) < 1) found.push(`opacidad en ${name(el)}`);
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0 && !allowed.has(hex(bg))) found.push(`fondo fuera de paleta ${hex(bg)} en ${name(el)}`);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') {
          const color = parse(cs[`border${side}Color`]);
          if (color && color.a > 0 && !allowed.has(hex(color))) found.push(`borde fuera de paleta ${hex(color)} en ${name(el)}`);
        }
      }
      const hasText =
        ['input', 'select', 'textarea', 'button'].includes(tag) ||
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText) {
        const color = parse(cs.color);
        if (color) {
          if (!allowed.has(hex(color))) found.push(`texto fuera de paleta ${hex(color)} en ${name(el)}`);
          const bgColor = backgroundOf(el);
          const size = parseFloat(cs.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
          const ratio = contrast(color, bgColor);
          if (ratio < (large ? 3 : 4.5)) found.push(`contraste ${ratio.toFixed(2)} insuficiente en ${name(el)}`);
        }
        if (!cs.fontFamily.toLowerCase().startsWith('"segoe ui variable"')) found.push(`tipografía ${cs.fontFamily.slice(0, 30)} en ${name(el)}`);
      }
    }
    return [...new Set(found)];
  }, PALETTE);
  expect(problems, `reglamento de diseño incumplido en «${label}»:\n${problems.join('\n')}`).toEqual([]);
}

export async function login(page, email, password = PASSWORD) {
  await page.goto('/iniciar-sesion');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
}
