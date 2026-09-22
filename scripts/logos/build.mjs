// Genera los logos PNG de concepto (Twemoji) para los cuatro frontends desde
// los SVG oficiales. Las carpetas de salida son 100 % generadas: se borran y
// se rehacen en cada corrida. Uso: `cd scripts/logos && npm install && npm run build`.
import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'));

// mobile: 96 px base + @2x/@3x, que Metro elige por densidad; nítido hasta 96 dp.
const TARGETS = {
  mobile: { dir: 'mobile/assets/logos', sizes: [[96, ''], [192, '@2x'], [288, '@3x']] },
  admin: { dir: 'admin/src/assets/logos', sizes: [[144, '']] },
  business: { dir: 'business/src/assets/logos', sizes: [[144, '']] },
  web: { dir: 'web/src/assets/logos', sizes: [[288, '']] },
};

const LICENSE = `Graphics: Twemoji ${manifest.twemoji} — https://github.com/twitter/twemoji
Copyright 2019 Twitter, Inc and other contributors.
Licensed under CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/

Changes: rasterized from the original SVGs to PNG and renamed by concept
(scripts/logos/build.mjs). No other modifications.
`;

const svgUrl = (cp) =>
  `https://cdn.jsdelivr.net/gh/twitter/twemoji@${manifest.twemoji}/assets/svg/${cp}.svg`;

for (const { dir } of Object.values(TARGETS)) {
  await rm(join(root, dir), { recursive: true, force: true });
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, 'LICENSE-TWEMOJI.txt'), LICENSE);
}

let written = 0;
for (const [name, { cp, targets }] of Object.entries(manifest.logos)) {
  const res = await fetch(svgUrl(cp));
  if (!res.ok) throw new Error(`${name} (${cp}): HTTP ${res.status}`);
  const svg = await res.text();

  for (const target of targets) {
    const spec = TARGETS[target];
    if (!spec) throw new Error(`${name}: destino desconocido "${target}"`);
    for (const [px, suffix] of spec.sizes) {
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng();
      await writeFile(join(root, spec.dir, `${name}${suffix}.png`), png);
      written++;
    }
  }
}

console.log(`${written} PNG generados.`);
