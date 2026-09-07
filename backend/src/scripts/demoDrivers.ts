import mongoose from 'mongoose';
import { config } from '../config';
import { User, Driver, DriverDocument } from '../models';
import { DriverStatus, VehicleType } from '../types';

/**
 * Deja operativas las dos cuentas de domiciliario de demostración.
 *
 * ── Por qué NO se toca `assertDocumentsCurrent` ──────────────────────
 *
 * El problema real era que las cuentas sembradas no podían conectarse:
 * `updateStatus` exige identidad, licencia y SOAT aprobados antes de
 * ponerse `available`, y el seed nunca creó ni el perfil `Driver` ni un
 * solo documento.
 *
 * La salida fácil habría sido una excepción por teléfono dentro de esa
 * guarda. No se hizo, y la razón no es purismo: esa comprobación no es una
 * regla de producto, es cumplimiento. En Colombia un domiciliario sin SOAT
 * vigente que se accidenta es responsabilidad de la plataforma que lo puso
 * a rodar. Una lista de teléfonos exentos dentro de esa función es
 * exactamente la clase de código que sobrevive a un `NODE_ENV` mal puesto,
 * a un `.env` copiado a producción o a que alguien añada un tercer número
 * "solo un momento".
 *
 * Así que la guarda queda intacta y se le da a las cuentas de prueba lo que
 * pide: documentos aprobados. El camino que recorren es el real —el mismo
 * que recorrerá un domiciliario de verdad— así que probar el seguimiento
 * GPS con ellas prueba el flujo auténtico, no un atajo.
 *
 * Las referencias empiezan por `DEMO-` a propósito: si alguna vez alguien
 * audita la tabla de documentos, tiene que poder distinguir de un vistazo
 * un SOAT sembrado de uno que alguien subió.
 */

/** Los dos domiciliarios de demostración del README. */
export const DEMO_DRIVER_PHONES = ['3111234567', '3121234567'] as const;

/**
 * Documentos que `assertDocumentsCurrent` exige para poder operar.
 *
 * Sin `expiresAt` a propósito: la comprobación acepta un documento sin
 * fecha de vencimiento (`!d.expiresAt || d.expiresAt >= now`). Ponerle un
 * año haría que las cuentas de prueba dejaran de funcionar solas dentro de
 * doce meses, y el fallo aparecería como "el domiciliario ya no puede
 * conectarse" sin ninguna pista de por qué.
 */
const REQUIRED_DOCUMENTS = ['identity', 'license', 'soat'] as const;

export interface DemoDriverReport {
  phone: string;
  name: string;
  driverId: string;
  profileCreated: boolean;
  documentsCreated: number;
}

/**
 * Idempotente: crea lo que falte y no pisa lo que ya existe.
 *
 * Correrlo dos veces no duplica nada, y no degrada un documento que un
 * administrador hubiera revisado a mano — solo rellena huecos.
 */
export async function ensureDemoDriversOperational(): Promise<DemoDriverReport[]> {
  const report: DemoDriverReport[] = [];

  for (const phone of DEMO_DRIVER_PHONES) {
    const user = await User.findOne({ phone, role: 'driver' }).select('_id name');
    if (!user) {
      console.warn(`   ⚠️  ${phone}: no existe como usuario domiciliario. Corre "npm run seed" primero.`);
      continue;
    }

    let driver = await Driver.findOne({ userId: user._id });
    const profileCreated = !driver;

    if (!driver) {
      driver = await Driver.create({
        userId: user._id,
        vehicleType: VehicleType.MOTORCYCLE,
        licensePlate: `DEMO${phone.slice(-2)}`,
        status: DriverStatus.OFFLINE,
        baseFund: config.platform.defaultDriverBaseFund,
        currentFund: config.platform.defaultDriverBaseFund,
        isActive: true,
        isApproved: true,
      });
    }

    let documentsCreated = 0;
    for (const type of REQUIRED_DOCUMENTS) {
      const existing = await DriverDocument.findOne({ driverId: driver._id, type });
      // Un documento ya aprobado y vigente se respeta. Uno vencido o
      // rechazado se repara: la cuenta de prueba tiene que poder volver a
      // operar sin que nadie borre nada a mano.
      if (existing && existing.status === 'approved' && (!existing.expiresAt || existing.expiresAt >= new Date())) {
        continue;
      }

      await DriverDocument.findOneAndUpdate(
        { driverId: driver._id, type },
        {
          driverId: driver._id,
          type,
          reference: `DEMO-${type.toUpperCase()}-${phone}`,
          status: 'approved',
          reviewedAt: new Date(),
          $unset: { expiresAt: '' },
        },
        { upsert: true, new: true, runValidators: true }
      );
      documentsCreated += 1;
    }

    report.push({
      phone,
      name: user.name,
      driverId: driver._id.toString(),
      profileCreated,
      documentsCreated,
    });
  }

  return report;
}

/**
 * Entrada de línea de comandos: `npm run seed:demo-drivers`.
 *
 * A diferencia del seed, este script **no borra nada**, así que se puede
 * correr sobre una base con datos de prueba en curso sin perderlos. Por eso
 * mismo necesita la guarda de producción que el seed no necesita: el seed
 * es evidentemente destructivo y nadie lo apunta a producción por error,
 * pero un script llamado "habilitar domiciliarios" es justo lo que alguien
 * podría ejecutar contra la base equivocada — y sembraría un SOAT aprobado
 * que nadie verificó.
 */
async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error(
      '\n❌ Este script no corre en producción.\n\n' +
        '   Crea documentos APROBADOS sin que nadie los haya verificado. En una\n' +
        '   base real eso es un domiciliario habilitado sin SOAT comprobado, que\n' +
        '   es precisamente lo que la validación existe para impedir.\n'
    );
    process.exit(1);
  }

  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  const report = await ensureDemoDriversOperational();

  if (report.length === 0) {
    console.log('\n⚠️  No se encontró ninguna cuenta de demostración. Corre "npm run seed" primero.\n');
  } else {
    console.log('\n🛵 Domiciliarios de prueba habilitados:\n');
    for (const row of report) {
      const parts = [
        row.profileCreated ? 'perfil creado' : 'perfil ya existía',
        row.documentsCreated > 0 ? `${row.documentsCreated} documento(s) aprobados` : 'documentos ya vigentes',
      ];
      console.log(`   ${row.phone}  ${row.name} — ${parts.join(', ')}`);
    }
    console.log('\n   Ya pueden ponerse "Disponible" en la app y reportar ubicación.\n');
  }

  await mongoose.disconnect();
  process.exit(0);
}

// Solo corre como script; importarlo desde el seed no dispara nada.
if (process.argv[1] && process.argv[1].includes('demoDrivers')) {
  main().catch((err) => {
    console.error('❌ Error habilitando domiciliarios de prueba:', err);
    process.exit(1);
  });
}
