import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';
import { UserRole } from '../types';
import { validatePasswordComplexity } from '../security';
import { pricingConfigService } from '../services/pricingConfig.service';
import { migrateRbac } from '../migrations/002-rbac';

/**
 * Arranque de una base de datos de producción vacía.
 *
 * Crea lo mínimo imprescindible para poder entrar al panel por primera vez:
 * la configuración de precios v1, UNA cuenta de administrador y los roles
 * del RBAC. Nada más — ni comercios de prueba, ni repartidores demo, ni
 * catálogo.
 *
 * Es lo contrario de `seed.ts`, que empieza borrando 28 colecciones. Este
 * script no borra nada nunca: si ya hay un administrador, se detiene y lo
 * dice. Esa asimetría es deliberada — `seed.ts` es para desarrollo, donde
 * volver al estado inicial es lo que quieres, y este es para producción,
 * donde ejecutarlo dos veces por error no puede costarte los datos.
 *
 *   ADMIN_NAME="..." ADMIN_EMAIL="..." \
 *   ADMIN_PASSWORD="..." npm run bootstrap:admin
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`❌ Falta la variable ${name}.`);
    process.exit(1);
  }
  return value.trim();
}

const bootstrapAdmin = async () => {
  const name = required('ADMIN_NAME');
  // El panel admin entra por correo, no por celular (ver
  // `auth.service.ts::login`): es lo único que este script exige además del
  // nombre y la contraseña. El celular queda opcional.
  const email = required('ADMIN_EMAIL');
  const password = required('ADMIN_PASSWORD');
  const phone = process.env.ADMIN_PHONE?.trim() || undefined;

  // Se valida ANTES de tocar la base: el modelo hashea en un hook pre-save,
  // así que una contraseña débil se guardaría sin protestar y solo daría la
  // cara al intentar cambiarla desde el panel.
  const check = validatePasswordComplexity(password);
  if (!check.valid) {
    console.error('❌ La contraseña no cumple la política:');
    for (const err of check.errors) console.error(`   • ${err}`);
    process.exit(1);
  }

  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  const existing = await User.findOne({ role: UserRole.ADMIN }).sort({ createdAt: 1 });
  if (existing) {
    console.error(
      `\n❌ Ya existe una cuenta de administrador (${existing.email || existing.phone}). ` +
        'Este script no sobrescribe cuentas: crea los administradores siguientes ' +
        'desde el panel, que además deja rastro en la auditoría.\n'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // Versión 1 de los precios, derivada del .env. Sin esto la plataforma no
  // sabe cuánto cobra por un domicilio ni qué comisión aplica.
  pricingConfigService.invalidate();
  const pricing = await pricingConfigService.getCurrent();
  console.log(`💰 Configuración de precios v${pricing.version} publicada`);

  const admin = await User.create({
    name,
    phone,
    email,
    password, // el hook pre-save lo hashea con Argon2id
    role: UserRole.ADMIN,
    isActive: true,
    isVerified: true,
    // Sin `isFinanceAdmin`: el poder viene del rol super_admin que asigna
    // `migrateRbac` justo abajo.
  });
  console.log(`👤 Administrador creado: ${admin.name} (${admin.phone})`);

  // Crea cargos y roles base y le asigna el de super admin a la cuenta
  // `role: admin` más antigua — que acaba de ser la recién creada.
  const report = await migrateRbac();
  console.log(`🔐 Roles creados: ${report.rolesCreated.join(', ') || '(ninguno nuevo)'}`);
  console.log(`🔐 Cargos creados: ${report.positionsCreated.join(', ') || '(ninguno nuevo)'}`);
  console.log(`🔐 Super admin asignado a: ${report.superAdminAssignedTo ?? '(nadie)'}`);
  for (const w of report.warnings) console.warn(`⚠️  ${w}`);

  await mongoose.disconnect();
  console.log('\n✅ Base lista. Entra al panel con el celular y la contraseña de arriba.\n');
};

bootstrapAdmin().catch(async (err) => {
  console.error('❌ El arranque falló:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
