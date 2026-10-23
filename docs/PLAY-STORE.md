# Publicar en Google Play: estado y pendientes

Auditoría del 2026-10-23 sobre `mobile/` y `web/`. Cada punto dice si se comprobó en el
código (**hecho**) o si depende de la consola de Play o de un dato externo (**no verificable
en el repo**). Dos apps, dos fichas: `com.zipp.app` (cliente) y `com.zipp.driver` (domiciliario);
cada una necesita su propia declaración de Seguridad de los datos y de permisos.

## Resuelto en el código

| Punto | Estado |
|---|---|
| Eliminar cuenta dentro de la app (cliente y domiciliario) | Hecho: Mi cuenta, Eliminar mi cuenta (`DeleteAccountScreen`) |
| URL pública para eliminar cuenta y datos | Hecho: `/eliminar-cuenta` en `web/` (sin sesión, con código por WhatsApp) |
| Política de privacidad pública y enlazable | Hecho en código: `/legal/privacy`. Falta el dominio real y el contenido publicado desde admin |
| `targetSdk` 36, 64 bits, sin tráfico sin cifrar en release | Hecho |
| `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW` y la clave de Google Maps de relleno | Quitados del manifest; `microphonePermission: false` en `expo-image-picker` |
| Script de AAB | `npm run bundle:android` (el APK de `release:android` no sirve para publicar) |

## Pendiente, por riesgo de rechazo

1. **Ubicación en segundo plano del domiciliario.** Es una función central (seguimiento de la entrega) y se defiende, pero Play exige tres cosas que no existen:
   - una pantalla de divulgación propia antes del diálogo del sistema (qué se recoge, para qué y que sigue con la app cerrada);
   - el formulario de permisos de ubicación en segundo plano en la consola;
   - un vídeo que muestre la divulgación, el permiso, la función y la notificación persistente.
   Declarar también el tipo de servicio en primer plano `location`.
2. **Dominio.** `REEMPLAZAR_DOMINIO` sigue sin definir y la API cuelga de `sslip.io`. Sin dominio no hay URL de privacidad estable ni de eliminación. Reemplazarlo antes de enviar.
3. **Cuenta de prueba para el revisor, en producción.** Una de cliente y una de domiciliario aprobada, sin depender del código por WhatsApp (el revisor no puede recibirlo), con comercios abiertos y un pedido listo para asignar, en la zona que se sirve. Las cuentas del `seed` viven solo en la base de desarrollo.
4. **Alcohol y productos para mayores de 18.** Hay verificación en el servidor (fecha de nacimiento) y cédula en la puerta, pero en la app `ageInBogota` (`mobile/lib/birthDate.ts`) es un esqueleto pendiente de implementar. Declarar el contenido en el cuestionario de clasificación y revisar la política de Play sobre alcohol vigente.
5. **Firma y versiones.** No existe `eas.json` y el `projectId` de EAS es un marcador. El build sale por Gradle local: usar el keystore real (si no existe `android/keystore.properties`, el release se firma en silencio con la clave de debug), subir `versionCode` en cada envío y probar el release con R8 en un teléfono real (inicio de sesión, pago, mapa, cámara).
6. **Notificaciones push en Android.** No hay `google-services.json` ni credenciales FCM: en release no llegan. Crear el proyecto Firebase con un archivo por sabor y poner el `projectId` real.
7. **Zipp Pro frente a la política de pagos.** Se cobra por Wompi, no por Google Play Billing. Sus beneficios son envío gratis y descuentos en entregas físicas, que es defendible (servicio del mundo real), pero un revisor puede objetarlo. Si lo hace, existe el interruptor que cierra Pro.
8. **Reseñas.** No hay botón de reportar. Si los comentarios los ve alguien más que el comercio y administración, añadirlo; si no, dejar documentado que son privados y moderados.
9. **Botones de acceso sin configurar.** Facebook y Apple tienen identificadores de relleno; ocultarlos mientras no estén configurados. Registrar el SHA-1 del keystore de release y el de la firma de Play en la consola de Google.
10. **Icono propio del domiciliario** (hoy comparte el del cliente).
11. **Cuenta de desarrollador personal nueva:** Play puede exigir una prueba cerrada con testers durante 14 días antes de producción.

## Seguridad de los datos (inventario para el formulario)

Recogido y enviado al backend propio, cifrado en tránsito:

- **Ubicación precisa:** cliente en primer plano; domiciliario también en segundo plano, con batería y velocidad, compartida con el cliente del pedido.
- **Datos personales:** nombre, celular, correo (opcional), fecha de nacimiento, tipo y número de documento.
- **Fotos y archivos:** foto de perfil, documentos del domiciliario (cédula, licencia, SOAT, tecnomecánica, tarjeta de propiedad), evidencias de entrega.
- **Pagos:** tarjeta, PSE y Nequi se procesan con un tercero (Wompi); ZIPP no guarda el número de tarjeta.
- **Identificadores:** identificador propio del dispositivo, token de notificaciones.
- **Diagnóstico:** informes de fallos al propio backend. Sin Sentry, Firebase Analytics ni SDK de anuncios de terceros.
- **Publicidad propia de comercios** (impresiones y clics): marcar «contiene anuncios».
- **Terceros:** Wompi, Mapbox (el mapa se carga desde `api.mapbox.com`), Google (inicio de sesión), Expo (notificaciones y actualizaciones).
- **Eliminación:** se puede pedir dentro de la app y en `/eliminar-cuenta`. Los pedidos, pagos y asientos contables se conservan sin nombre ni contacto por obligación legal.
