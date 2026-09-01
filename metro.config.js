// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Sin esto, Metro resuelve paquetes como "zustand" a su build ESM (.mjs) en
// web, y ese build usa `import.meta.env` a nivel de módulo. El bundle de
// Metro para web no se sirve como <script type="module">, así que el
// navegador revienta con "Cannot use 'import.meta' outside a module" antes
// de pintar nada — no solo en /login, en cualquier ruta. Priorizar las
// condiciones "react-native"/"require" hace que Metro use el build CJS
// (sin import.meta) en todas las plataformas, que es como ya se resolvía
// para iOS/Android.
config.resolver.unstable_conditionNames = ['require', 'react-native'];

module.exports = config;
