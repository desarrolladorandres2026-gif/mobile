// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Metro vigila TODO el proyecto salvo lo que se le excluya aquí — no lee
// .gitignore. `expo export` deja ~13 MB de HTML/JS generados en dist/ (y
// web-build/), cientos de archivos dentro del árbol vigilado. Sin Watchman
// en Windows, Metro usa el watcher de Node, que con ese ruido pierde
// eventos de "archivo guardado" y deja de recompilar solo: toca dar reload
// a mano para ver los cambios. Excluir el build de salida lo devuelve.
//
// El prebuild de Android (necesario tras subir a SDK 55) generó
// android/.gradle, android/build y android/app/build: miles de artefactos
// de compilación que cambian en cada build nativo. Es el mismo ruido que
// dist/ y web-build/ de arriba, solo que peor, y reproduce exactamente el
// mismo síntoma: hay que dar reload a mano porque Metro deja de detectar
// los archivos guardados.
//
// `blockList` acepta un RegExp o un array de RegExp; concatenamos los
// nuestros al valor por defecto de Expo para no pisar sus exclusiones.
const extraBlockList = [
  /\/dist\/.*/,
  /\/web-build\/.*/,
  /\/android\/\.gradle\/.*/,
  /\/android\/build\/.*/,
  /\/android\/app\/build\/.*/,
  /\/android\/app\/\.cxx\/.*/,
];
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, extraBlockList)
  : extraBlockList;

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
