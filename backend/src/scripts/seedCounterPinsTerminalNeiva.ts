import mongoose from 'mongoose';
import { config } from '../config';
import { Business, BusinessStaff, BusinessRole, User, normalizeStaffRole } from '../models';
import { UserRole } from '../types';
import { TESTE_PASSWORD } from './teste/data/businesses';
import { hashPassword } from '../security/password';
import { PIN_LENGTH, pinProblem, unlockPin } from '../services/counterPin.service';

/**
 * PIN del mostrador para el propietario y los administradores de "Terminal
 * neiva" (solo dev). Si el negocio no tiene administrador, crea uno de prueba.
 * Escribe directo, sin la contraseña ni el 2FA que pide `setOwnPin`: son
 * cuentas de prueba. Idempotente: repetirlo deja los mismos PIN y levanta los
 * bloqueos por intentos fallidos.
 */

const SLUG = 'terminal-neiva';
const MANAGER = { name: 'Laura Pérez', phone: '3009990021', email: 'admin.neiva@teste.zipp.co' };
/** Un PIN por persona, repartidos en orden: propietario primero, luego administradores por nombre. */
const PINS = ['482915', '736204', '951738', '264087'];

async function main(): Promise<void> {
  // `isDev` exige NODE_ENV=development literal: staging o un entorno sin
  // NODE_ENV tampoco pueden recibir PIN y contraseñas de prueba conocidos.
  if (!config.isDev) {
    console.error('Este script solo corre con NODE_ENV=development.');
    process.exit(1);
  }
  await mongoose.connect(config.mongodb.uri);

  const business = await Business.findOne({ slug: SLUG });
  if (!business) throw new Error(`No existe el negocio ${SLUG}`);

  // Administrador de prueba: se crea con `User.create` para que `pre('save')` hashee la contraseña.
  let manager = await User.findOne({ email: MANAGER.email });
  if (!manager) {
    manager = await User.create({ ...MANAGER, password: TESTE_PASSWORD, role: UserRole.BUSINESS, isActive: true, isVerified: true });
    console.log(`Administrador creado: ${manager.name}`);
  } else if (manager.name !== MANAGER.name) {
    await User.updateOne({ _id: manager._id }, { $set: { name: MANAGER.name } });
  }
  await BusinessStaff.updateOne(
    { businessId: business._id, userId: manager._id },
    { $set: { role: BusinessRole.MANAGER, status: 'active', isActive: true } },
    { upsert: true }
  );

  const staff = await BusinessStaff.find({ businessId: business._id, isActive: true, status: 'active' }).select('userId role');
  const managerIds = staff.filter((row) => normalizeStaffRole(row.role) === BusinessRole.MANAGER).map((row) => row.userId);

  const users = await User.find({ _id: { $in: [business.ownerId, ...managerIds] }, isActive: true }).select('name email');
  const ownerId = business.ownerId.toString();
  const people = users.sort((a, b) =>
    a._id.toString() === ownerId ? -1 : b._id.toString() === ownerId ? 1 : a.name.localeCompare(b.name)
  );
  if (people.length > PINS.length) throw new Error(`Hay ${people.length} personas y solo ${PINS.length} PIN en la lista`);

  console.log(`Negocio: ${business.name} (${SLUG})`);
  for (const [i, user] of people.entries()) {
    const pin = PINS[i];
    const problem = pinProblem(pin);
    if (problem) throw new Error(`PIN de prueba inválido (${pin}): ${problem}`);
    await User.updateOne({ _id: user._id }, { $set: { counterPinHash: await hashPassword(pin), counterPinSetAt: new Date() } });
    await unlockPin(user._id.toString());
    const role = user._id.toString() === ownerId ? 'propietario' : 'administrador';
    console.log(`  ${role.padEnd(13)} ${user.name} <${user.email ?? 'sin correo'}>  PIN ${pin} (${PIN_LENGTH} dígitos)`);
  }
  if (people.length === 1) console.log('  (sin administradores activos: solo el propietario tiene PIN)');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
