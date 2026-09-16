import { Platform } from 'react-native';

/**
 * Qué app es esta: Zipp (cliente) o Zipp Domiciliarios (driver).
 *
 * Las dos salen del mismo proyecto; lo que cambia es la variable
 * `EXPO_PUBLIC_APP_VARIANT` con la que se generó el bundle. Babel la
 * inlinea como literal, así que aquí ya viene resuelta y todo lo que
 * dependa de ella (`IS_DRIVER_APP`, `HOME_ROUTE`…) es una constante más.
 *
 * No se usa `Constants.expoConfig.extra.variant` para decidir nada: en
 * Android ese JSON lo embebe una tarea global de Gradle que corre una sola
 * vez aunque se compilen los dos flavors, y puede decir "client" dentro del
 * APK de domiciliarios. La variable de entorno viaja dentro del bundle que
 * cada flavor genera por separado, y por eso es la fuente de verdad.
 */
export type AppVariant = 'client' | 'driver';

/** Rol de backend que acepta cada app; es el mismo string que `User.role`. */
export type AcceptedRole = 'client' | 'driver';

/**
 * Normaliza el valor crudo de la variable. Un valor raro cae a `client`
 * en vez de reventar en el scope de módulo: los scripts de build ya
 * validan la variante antes de llegar aquí, y un release nunca debería
 * morir por esto. En desarrollo sí se avisa, porque casi siempre significa
 * que se arrancó Metro sin pasar por `npm run start:client|driver`.
 */
export function parseVariant(raw: string | undefined): AppVariant {
  if (raw === 'client' || raw === 'driver') return raw;
  if (__DEV__ && raw !== undefined) {
    console.warn(`[variant] EXPO_PUBLIC_APP_VARIANT="${raw}" no es válida; usando "client".`);
  }
  return 'client';
}

export const APP_VARIANT: AppVariant = parseVariant(process.env.EXPO_PUBLIC_APP_VARIANT);

export const IS_DRIVER_APP = APP_VARIANT === 'driver';
export const IS_CLIENT_APP = !IS_DRIVER_APP;

/** El único rol con el que se puede iniciar sesión en esta app. */
export const ACCEPTED_ROLE: AcceptedRole = IS_DRIVER_APP ? 'driver' : 'client';

export const APP_DISPLAY_NAME = IS_DRIVER_APP ? 'Zipp Domiciliarios' : 'Zipp';
export const APP_SCHEME = IS_DRIVER_APP ? 'zippdriver' : 'zipp';

/** Grupo de rutas de expo-router que existe en este bundle. */
export const ROUTE_GROUP = IS_DRIVER_APP ? '/(driver)' : '/(client)';
export const HOME_ROUTE = IS_DRIVER_APP ? '/(driver)/(tabs)/dashboard' : '/(client)/(tabs)/home';
export const PROFILE_ROUTE = `${ROUTE_GROUP}/(tabs)/profile` as const;

interface OtherAppInfo {
  name: string;
  variant: AppVariant;
  androidPackage: string;
  scheme: string;
  /** Ficha web de Play Store; abre en navegador si no hay app de Play. */
  playUrl: string;
  /** Abre directamente la app de Play Store; falla si no está instalada. */
  marketUrl: string;
  // TODO(tienda): id de App Store cuando exista la ficha de iOS.
  appStoreUrl: string | null;
}

const OTHER_APP_PACKAGE = IS_DRIVER_APP ? 'com.zipp.app' : 'com.zipp.driver';

/**
 * La app hermana, para mandar al usuario cuando entró en la equivocada
 * (una cuenta de cliente en Zipp Domiciliarios, o al revés).
 */
export const OTHER_APP: OtherAppInfo = {
  name: IS_DRIVER_APP ? 'Zipp' : 'Zipp Domiciliarios',
  variant: IS_DRIVER_APP ? 'client' : 'driver',
  androidPackage: OTHER_APP_PACKAGE,
  scheme: IS_DRIVER_APP ? 'zipp' : 'zippdriver',
  playUrl: `https://play.google.com/store/apps/details?id=${OTHER_APP_PACKAGE}`,
  marketUrl: `market://details?id=${OTHER_APP_PACKAGE}`,
  appStoreUrl: null,
};

/** URL de tienda de la app hermana para la plataforma actual. */
export const OTHER_APP_STORE_URL: string = Platform.select({
  ios: OTHER_APP.appStoreUrl ?? OTHER_APP.playUrl,
  default: OTHER_APP.playUrl,
});
