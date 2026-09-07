// Copia mobile/dist (generado por "npm run web:build" en mobile/) a
// backend/public/pwa, de donde app.ts la sirve como estático.
// Separado del build de TypeScript porque compilar la PWA vive en otro
// proyecto del monorepo con su propia toolchain (Expo/Metro).
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../../mobile/dist');
const dest = path.join(__dirname, '../public/pwa');

if (!fs.existsSync(src)) {
  console.error(
    `✗ No existe ${src}. Corre "npm run web:build" en mobile/ antes de "npm run build:pwa".`
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`✓ PWA copiada a ${dest}`);
