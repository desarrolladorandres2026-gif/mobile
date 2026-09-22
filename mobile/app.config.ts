import type { ConfigContext, ExpoConfig } from 'expo/config';

// CommonJS a propósito: este mismo módulo lo cargan metro.config.js y los
// preloads de Gradle, y así los tres leen la variante del mismo sitio.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveAppVariant } = require('./scripts/app-variant');

/**
 * Configuración dinámica de Expo: una sola base (`app.json`) y encima lo
 * que cambia entre Zipp (cliente) y Zipp Domiciliarios (driver).
 *
 * En Android esto casi no toca nada nativo: `android/` está commiteada y no
 * se regenera con prebuild, así que el applicationId, el nombre, el scheme
 * y los permisos los deciden los product flavors de `android/app/build.gradle`.
 * En iOS sí manda todo, porque `ios/` se genera por variante con
 * `npm run prebuild:ios:client|driver`.
 */
const variant = resolveAppVariant() as 'client' | 'driver';
const isDriver = variant === 'driver';

const APP = isDriver
  ? {
      name: 'Zipp Domiciliarios',
      scheme: 'zippdriver',
      bundleId: 'com.zipp.driver',
      // TODO(diseño): ícono propio para la app de domiciliarios. Mientras
      // tanto comparte el trazo del cliente sobre un fondo distinto para
      // que los dos íconos se distingan a simple vista.
      icon: './assets/icon.png',
      adaptiveIconBackground: '#141A2E',
    }
  : {
      name: 'Zipp',
      scheme: 'zipp',
      bundleId: 'com.zipp.app',
      icon: './assets/icon.png',
      adaptiveIconBackground: '#BA954F',
    };

const GOOGLE_SIGNIN_PLUGIN: [string, Record<string, unknown>] = [
  '@react-native-google-signin/google-signin',
  { iosUrlScheme: 'com.googleusercontent.apps.939093803417-68c0mgopu2f0q8fckpd6nepedv5j0uff' },
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: APP.name,
  slug: config.slug ?? 'zipp',
  scheme: APP.scheme,
  icon: APP.icon,
  ios: {
    ...config.ios,
    bundleIdentifier: APP.bundleId,
    infoPlist: {
      ...config.ios?.infoPlist,
      // Sin esta clave, iOS limita a 60 fps las apps de terceros en iPhone
      // con ProMotion. Con ella, el reloj de animación de Reanimated puede
      // pedir 120 Hz; la pantalla vuelve a bajar sola cuando nada se mueve.
      CADisableMinimumFrameDurationOnPhone: true,
    },
  },
  android: {
    ...config.android,
    package: APP.bundleId,
    adaptiveIcon: {
      ...config.android?.adaptiveIcon,
      backgroundColor: APP.adaptiveIconBackground,
    },
  },
  plugins: [
    'expo-router',
    [
      'expo-location',
      isDriver
        ? {
            locationAlwaysAndWhenInUsePermission:
              'Zipp Domiciliarios usa tu ubicación para asignarte pedidos cercanos y para que el cliente vea tu llegada en el mapa.',
            locationWhenInUsePermission:
              'Zipp Domiciliarios usa tu ubicación para asignarte pedidos cercanos.',
            isAndroidBackgroundLocationEnabled: true,
            isIosBackgroundLocationEnabled: true,
            isAndroidForegroundServiceEnabled: true,
          }
        : {
            locationWhenInUsePermission:
              'Zipp usa tu ubicación para mostrarte negocios cercanos y calcular el costo del domicilio.',
            isAndroidBackgroundLocationEnabled: false,
            isIosBackgroundLocationEnabled: false,
            isAndroidForegroundServiceEnabled: false,
          },
    ],
    [
      'expo-font',
      {
        fonts: [
          './node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf',
        ],
      },
    ],
    'expo-web-browser',
    [
      'expo-image-picker',
      {
        photosPermission: `${APP.name} usa tus fotos para que elijas una imagen de perfil.`,
        cameraPermission: `${APP.name} usa la cámara para que tomes tu foto de perfil.`,
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#141A2E',
      },
    ],
    'expo-secure-store',
    // Builds de tienda más livianos y rápidos de cargar: R8 minimiza y
    // optimiza el código nativo y descarta los recursos que nadie usa. Va
    // aquí y no a mano en android/gradle.properties para que sobreviva a
    // `expo prebuild` (sin --clean: ver la nota del keystore).
    //
    // OJO antes de publicar: R8 puede quitar clases que alguna librería
    // busque por reflexión. Probar SIEMPRE un build release en un teléfono
    // real (login, pago, mapa, notificaciones, cámara) antes de subirlo.
    [
      'expo-build-properties',
      {
        android: {
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
    // Deja la variante en ios/.xcode.env.local para que Xcode empaquete el
    // JavaScript correcto también en un Archive. Ver el plugin.
    ['./plugins/withXcodeEnvVariant', { variant }],
    // Google Sign-In solo existe en la app de clientes: los domiciliarios
    // los da de alta admin y entran con teléfono o correo.
    ...(isDriver ? [] : [GOOGLE_SIGNIN_PLUGIN]),
  ],
  extra: {
    ...config.extra,
    // Solo informativo (aparece en `expo config`); la app decide con
    // EXPO_PUBLIC_APP_VARIANT, ver constants/variant.ts.
    variant,
  },
});
