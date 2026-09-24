// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveAppVariant } = require('./scripts/app-variant');

// Fija EXPO_PUBLIC_APP_VARIANT en este proceso antes de que Metro cree sus
// workers de transformación (que reciben una copia de process.env): así el
// literal que babel inlinea en constants/variant.ts coincide con la app que
// se está construyendo. Ver scripts/app-variant.js.
const appVariant = resolveAppVariant();

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
//
// Los patrones se prueban contra rutas ABSOLUTAS tal como las construye el
// sistema operativo, y de ahí las dos trampas que hay aquí:
//
//  1. En Windows los separadores son backslash, así que un `\/` literal no
//     casa nunca y la exclusión no hace nada. `[\\/]` acepta los dos.
//  2. Un patrón sin anclar casa en cualquier punto de la ruta, también
//     dentro de node_modules: `/dist/` a secas se lleva por delante
//     `node_modules/whatwg-fetch/dist/fetch.umd.js` y el bundle muere con
//     "main module field could not be resolved". Por eso van anclados a la
//     raíz del proyecto, que es lo único que se quiere excluir.
const ROOT = __dirname
  .split(/[\\/]/)
  .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('[\\\\/]');
/** Ruta del propio proyecto, con cualquier separador. */
const own = (...segments) => new RegExp(`^${ROOT}[\\\\/]${segments.join('[\\\\/]')}[\\\\/]`);

const extraBlockList = [
  own('dist'),
  own('web-build'),
  own('android', '\\.gradle'),
  own('android', 'build'),
  own('android', 'app', 'build'),
  own('android', 'app', '\\.cxx'),
];

// Cada app solo lleva su propio grupo de rutas. Un archivo bloqueado no
// existe para el file map de Metro, y expo-router arma sus rutas con un
// `require.context` sobre ese mapa, así que para el bundle de clientes el
// grupo (driver) sencillamente no está (ni sus pantallas, ni lo que solo
// ellas importan). Al cambiar de variante hay que arrancar con `--clear`:
// el file map se cachea en disco.
//
// Las pantallas que existen en las dos apps viven en screens/shared y cada
// grupo las monta con un shim de una línea; las navegaciones entre ellas
// pasan por lib/routing.ts, que ya sabe en qué grupo está.
const ownFile = (...segments) => new RegExp(`^${ROOT}[\\\\/]${segments.join('[\\\\/]')}$`);

const VARIANT_BLOCK = {
  client: [
    own('app', '\\(driver\\)'),
    ownFile('app', '\\(auth\\)', 'become-driver\\.tsx'),
  ],
  driver: [
    own('app', '\\(client\\)'),
    ownFile('app', '\\(auth\\)', '(welcome|complete-profile)\\.tsx'),
    // La vista previa del constructor de Explorar es del panel y de la web
    // de clientes; la app de domiciliarios no pinta Explorar.
    own('app', 'preview'),
  ],
};

config.resolver.blockList = [].concat(
  config.resolver.blockList ?? [],
  extraBlockList,
  VARIANT_BLOCK[appVariant],
);

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
