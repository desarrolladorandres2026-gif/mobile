import mongoose from 'mongoose';
import { config } from '../config';
import { Driver, DriverLocation } from '../models';
import { Types } from 'mongoose';

/**
 * Qué está reportando cada domiciliario, ahora mismo.
 *
 * Existe porque el seguimiento GPS falla en silencio por naturaleza: un
 * domiciliario que desaparece del mapa no produce ningún error en ninguna
 * parte —ni en el teléfono ni en el servidor— y sin esta foto la única
 * forma de diagnosticarlo es adivinar. Responde de un vistazo las tres
 * preguntas que importan:
 *
 *   ¿está en servicio? · ¿cuándo reportó por última vez? · ¿con qué calidad?
 *
 * Solo lee. No modifica nada, así que es seguro correrlo en cualquier
 * entorno y en cualquier momento.
 */

interface Row {
  name: string;
  status: string;
  ageSeconds: number | null;
  accuracy: number | null;
  battery: number | null;
  trailPoints: number;
}

/**
 * El diagnóstico depende de **dos** cosas, no de una.
 *
 * "Hace cuánto reportó" por sí solo no dice nada: un domiciliario fuera de
 * servicio que reportó hace 30 s está perfectamente bien, y uno en servicio
 * que reportó hace 30 s también — pero uno en servicio que lleva 5 minutos
 * callado es el fallo que hay que perseguir. Solo la combinación de estado
 * y antigüedad distingue los tres casos.
 */
function verdict(row: Row): string {
  const onDuty = row.status === 'available' || row.status === 'busy';
  const staleSeconds = config.tracking.staleAfterMs / 1000;

  if (!onDuty) {
    return row.ageSeconds === null
      ? 'nunca ha reportado'
      : `fuera de servicio (última posición hace ${row.ageSeconds}s)`;
  }

  if (row.ageSeconds === null) return '⚠️  EN SERVICIO PERO SIN NINGUNA POSICIÓN';

  if (row.ageSeconds > staleSeconds) {
    return `⚠️  PERDIDO — en servicio pero lleva ${row.ageSeconds}s sin reportar (umbral ${staleSeconds}s)`;
  }

  return 'en vivo';
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  ${mongoose.connection.name}\n`);

  const drivers = await Driver.find({ isActive: true })
    .select('userId status lastLocationAt locationAccuracy batteryLevel currentLocation')
    .populate('userId', 'name phone');

  if (drivers.length === 0) {
    console.log('No hay domiciliarios activos.\n');
    await mongoose.disconnect();
    return;
  }

  const now = Date.now();

  for (const driver of drivers) {
    const user = driver.userId as unknown as { name?: string; phone?: string };
    const row: Row = {
      name: `${user?.name ?? 'Domiciliario'} (${user?.phone ?? '—'})`,
      status: driver.status,
      ageSeconds: driver.lastLocationAt
        ? Math.round((now - driver.lastLocationAt.getTime()) / 1000)
        : null,
      accuracy: driver.locationAccuracy ?? null,
      battery: driver.batteryLevel ?? null,
      trailPoints: await DriverLocation.countDocuments({
        driverId: driver._id as Types.ObjectId,
      }),
    };

    console.log(`${row.name}`);
    console.log(`   estado    : ${row.status} — ${verdict(row)}`);
    console.log(
      `   posición  : ${row.ageSeconds === null ? 'nunca' : `hace ${row.ageSeconds}s`}` +
        `   precisión: ${row.accuracy ?? '—'} m   batería: ${row.battery ?? '—'}%`
    );
    // Un rastro con 0 puntos y un domiciliario en entrega significa que las
    // posiciones no se están atando al pedido: mirar `activeOrderIdFor`.
    console.log(`   rastro    : ${row.trailPoints} punto(s) guardados\n`);

    // Una precisión pegada al techo es la causa más común de "desaparece
    // del mapa": los fixes siguientes se descartan y nadie se entera.
    if (row.accuracy !== null && row.accuracy >= config.tracking.maxAccuracyMeters * 0.9) {
      console.log(
        `   ⚠️  Precisión al límite (máx ${config.tracking.maxAccuracyMeters} m). En interiores\n` +
          `      los fixes se descartan por imprecisos. Sube TRACKING_MAX_ACCURACY_METERS\n` +
          `      para probar bajo techo.\n`
      );
    }
  }

  console.log('Umbrales activos:');
  console.log(`   escritura mínima cada : ${config.tracking.minPersistIntervalMs / 1000}s`);
  console.log(`   movimiento mínimo     : ${config.tracking.minMoveMeters} m`);
  console.log(`   precisión máxima      : ${config.tracking.maxAccuracyMeters} m`);
  console.log(`   se da por perdido a   : ${config.tracking.staleAfterMs / 1000}s\n`);

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error leyendo el estado del seguimiento:', err);
    process.exit(1);
  });
