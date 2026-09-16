# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

## Este proyecto produce DOS apps

`mobile/` es un solo proyecto del que salen dos aplicaciones distintas:

| | Zipp | Zipp Domiciliarios |
|---|---|---|
| Para | clientes | repartidores |
| `APP_VARIANT` | `client` | `driver` |
| Package / bundle id | `com.zipp.app` | `com.zipp.driver` |
| Scheme | `zipp://` | `zippdriver://` |
| Flavor de Gradle | `client` | `driver` |
| Grupo de rutas | `app/(client)/` | `app/(driver)/` |

### Cómo se elige la variante

Todo sale de la variable de entorno `APP_VARIANT`, que
`scripts/app-variant.js` valida y copia a `EXPO_PUBLIC_APP_VARIANT` para que
babel la inline dentro del bundle. Los tres sitios que la leen:

- `app.config.ts` → nombre, ids, scheme, íconos y qué plugins se aplican.
- `metro.config.js` → deja fuera del bundle el grupo de rutas de la otra app.
- `constants/variant.ts` → lo que usa el código (`IS_DRIVER_APP`, `HOME_ROUTE`,
  `ACCEPTED_ROLE`, `OTHER_APP`…).

**Nunca** decidas nada con `Constants.expoConfig.extra.variant`: en Android ese
JSON lo genera una tarea de Gradle que corre una sola vez por invocación, así
que al compilar los dos flavors juntos puede decir `client` dentro del APK de
domiciliarios. `extra.variant` está solo para inspeccionarlo con `expo config`.

**Nunca** pongas `APP_VARIANT` en `.env`: taparía el error cuando alguien
arranca sin pasar por los scripts.

### Comandos

```bash
npm run start:client      # Metro para la app de clientes
npm run start:driver      # Metro para la app de domiciliarios
npm run android:client    # instala Zipp en el teléfono
npm run android:driver    # instala Zipp Domiciliarios (van los dos a la vez)
npm run release:android   # los dos APK firmados, en android/app/build/outputs/apk/
```

Los scripts llevan `--clear` porque el file map de Metro se cachea en disco y
al cambiar de variante quedaría el de la anterior. Los dos APK de depuración
apuntan al mismo Metro (8081): usa uno a la vez, o `--port` distinto.

### Reglas al escribir código

- Para navegar entre pantallas que existen en las dos apps usa `ROUTES` de
  `lib/routing.ts`; escribir `/(client)/help` a mano deja una ruta muerta en la
  app de domiciliarios.
- Las pantallas comunes viven en `screens/shared/` y cada grupo las monta con
  un shim de una línea, para que sigan dentro del stack de su app (en el
  domiciliario eso conserva el tracking, la hoja de ofertas y el botón SOS).
- La decisión de a dónde va alguien tras identificarse está solo en
  `lib/routing.ts` (`decideAfterAuth` / `decideAtStart`). No la repitas.
- `index.ts` es el entry real: ahí se registra la tarea de GPS en segundo
  plano, que **tiene** que definirse al cargar el bundle (el sistema puede
  arrancar la app directamente en la tarea, sin pantallas).

### iOS

`ios/` está gitignoreado y se genera por variante:

```bash
npm run prebuild:ios:client    # requiere macOS o Linux
npm run prebuild:ios:driver
```

En Windows Expo omite la generación del proyecto iOS; hay que hacerlo desde
macOS. El plugin `plugins/withXcodeEnvVariant.js` deja la variante en
`ios/.xcode.env.local` para que también un Archive desde Xcode empaquete el
JavaScript correcto.

**Siempre con `--platform ios`.** Un `prebuild --clean` sin plataforma borra
`android/`, y ahí dentro vive el keystore de publicación (gitignoreado, sin
copia).
