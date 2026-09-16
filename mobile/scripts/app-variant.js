/**
 * La variante de la app (`client` | `driver`) del lado de Node.
 *
 * Un solo proyecto produce dos apps distintas —Zipp y Zipp Domiciliarios— y
 * la decisión de cuál se está construyendo tiene que tomarse en un único
 * sitio que lean por igual `app.config.ts`, `metro.config.js` y los preloads
 * que Gradle pasa a `node -r` al empaquetar el JS.
 *
 * La variante viaja al bundle como `EXPO_PUBLIC_APP_VARIANT`: babel la
 * inlinea como literal, así que `constants/variant.ts` puede leerla sin
 * depender de `Constants.expoConfig` (que en Android se embebe una sola vez
 * por invocación de Gradle, no por flavor, y por eso no es fiable cuando se
 * compilan las dos apps juntas). Metro copia `process.env` a sus workers
 * al crear la granja, y `metro.config.js` se carga antes, así que fijar la
 * variable aquí basta para que llegue a la transformación.
 *
 * `.env` no puede decidir la variante a propósito: dotenv no pisa valores
 * existentes, pero sí rellenaría el hueco cuando un script se invoca sin
 * `APP_VARIANT` y eso ocultaría el error en vez de mostrarlo.
 */
const VALID = ['client', 'driver'];

function resolveAppVariant() {
  const raw = process.env.APP_VARIANT || process.env.EXPO_PUBLIC_APP_VARIANT || 'client';
  if (!VALID.includes(raw)) {
    throw new Error(`APP_VARIANT inválido: "${raw}". Usa client o driver.`);
  }
  process.env.APP_VARIANT = raw;
  process.env.EXPO_PUBLIC_APP_VARIANT = raw;
  return raw;
}

module.exports = { resolveAppVariant, VALID_VARIANTS: VALID };
