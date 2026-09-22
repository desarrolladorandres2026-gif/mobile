/**
 * Logos PNG de concepto: Twemoji 14 (CC-BY 4.0, atribución en el Centro
 * legal). Los archivos los genera `scripts/logos/build.mjs` desde el SVG
 * oficial; Metro elige `@2x`/`@3x` según la densidad, nítidos hasta 96 dp.
 * Para agregar uno: sumarlo a `scripts/logos/manifest.json`, regenerar y
 * registrarlo aquí.
 */
export const LOGOS = {
  trofeo: require('../assets/logos/trofeo.png'),
  racha: require('../assets/logos/racha.png'),
  cupon: require('../assets/logos/cupon.png'),
  favorito: require('../assets/logos/favorito.png'),
  paquete: require('../assets/logos/paquete.png'),
  tarjeta: require('../assets/logos/tarjeta.png'),
  efectivo: require('../assets/logos/efectivo.png'),
  billetera: require('../assets/logos/billetera.png'),
  domiciliario: require('../assets/logos/domiciliario.png'),
  calificacion: require('../assets/logos/calificacion.png'),
  seguridad: require('../assets/logos/seguridad.png'),
  ubicacion: require('../assets/logos/ubicacion.png'),
  notificaciones: require('../assets/logos/notificaciones.png'),
  ayuda: require('../assets/logos/ayuda.png'),
  regalo: require('../assets/logos/regalo.png'),
  documento: require('../assets/logos/documento.png'),
  negocio: require('../assets/logos/negocio.png'),
  dulce: require('../assets/logos/dulce.png'),
  bebida: require('../assets/logos/bebida.png'),
  etiqueta: require('../assets/logos/etiqueta.png'),
  corona: require('../assets/logos/corona.png'),
  tendencia: require('../assets/logos/tendencia.png'),
  hielo: require('../assets/logos/hielo.png'),
  explorar: require('../assets/logos/explorar.png'),
  bolsa: require('../assets/logos/bolsa.png'),
  consentimiento: require('../assets/logos/consentimiento.png'),
  nuevo: require('../assets/logos/nuevo.png'),
  estrella: require('../assets/logos/estrella.png'),
  repetir: require('../assets/logos/repetir.png'),
  casa: require('../assets/logos/casa.png'),
  trabajo: require('../assets/logos/trabajo.png'),
  familia: require('../assets/logos/familia.png'),
  restaurant: require('../assets/logos/restaurant.png'),
  fast_food: require('../assets/logos/fast_food.png'),
  pharmacy: require('../assets/logos/pharmacy.png'),
  cafe: require('../assets/logos/cafe.png'),
  supermarket: require('../assets/logos/supermarket.png'),
} satisfies Record<string, number>;

export type LogoName = keyof typeof LOGOS;

/**
 * Logo por clave de categoría de negocio. `errand` no es categoría: es la
 * salida de "no está en carta" (mandados) y usa la caja.
 */
const CATEGORY_LOGOS: Record<string, number> = {
  restaurant: LOGOS.restaurant,
  fast_food: LOGOS.fast_food,
  pharmacy: LOGOS.pharmacy,
  cafe: LOGOS.cafe,
  supermarket: LOGOS.supermarket,
  errand: LOGOS.paquete,
};

export const categoryLogo = (key: string): number | undefined => CATEGORY_LOGOS[key];
