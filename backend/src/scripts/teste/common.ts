import mongoose from 'mongoose';
import { config } from '../../config';
import { User } from '../../models';
import { TESTE_EMAIL_DOMAIN, TESTE_PHONE_PREFIX } from './data/businesses';

/**
 * Lo que comparten los scripts del TESTE: cómo se reconoce un dato TESTE,
 * dónde queda el punto base y las guardas que impiden correr esto donde
 * no toca.
 */

/** Mismo punto que usan los fixtures de prueba (`GARZON` en factories.ts). */
export const TESTE_BASE = { lat: 2.1958, lng: -75.6258 };

/** Un punto a `north` km al norte y `east` km al este del base. */
export function offsetPoint(offset: { north: number; east: number }) {
  // 0.009° de latitud ≈ 1 km; en longitud se corrige por la latitud.
  const lat = TESTE_BASE.lat + offset.north * 0.009;
  const lng = TESTE_BASE.lng + offset.east * (0.009 / Math.cos((TESTE_BASE.lat * Math.PI) / 180));
  return { lat, lng };
}

export const isTesteEmail = (email: string | null | undefined) =>
  typeof email === 'string' && email.toLowerCase().endsWith(`@${TESTE_EMAIL_DOMAIN}`);

export const isTestePhone = (phone: string | null | undefined) =>
  typeof phone === 'string' && phone.startsWith(TESTE_PHONE_PREFIX);

/** Filtro de Mongo para los usuarios del TESTE. */
export const testeUserFilter = () => ({
  email: { $regex: new RegExp(`@${TESTE_EMAIL_DOMAIN.replace('.', '\\.')}$`, 'i') },
});

/**
 * Se niega a tocar la base equivocada.
 *
 * La base de desarrollo es Atlas, no local, así que un script apuntado por
 * error a producción haría daño real. Por eso hacen falta las dos cosas: no
 * ser producción y decir por nombre la base que se espera.
 */
export async function connectGuarded(expectedDb: string | undefined): Promise<void> {
  if (config.nodeEnv === 'production') {
    throw new Error('Los scripts del TESTE no corren en producción.');
  }
  if (!expectedDb) {
    throw new Error('Indica la base con --db=<nombre>; tiene que coincidir con la de MONGODB_URI.');
  }
  await mongoose.connect(config.mongodb.uri);
  const actual = mongoose.connection.name;
  if (actual !== expectedDb) {
    await mongoose.disconnect();
    throw new Error(`La conexión apunta a "${actual}", no a "${expectedDb}". No se tocó nada.`);
  }
  console.log(`🗄️  ${mongoose.connection.host} / ${actual}`);
}

/**
 * Un teléfono o correo TESTE que ya pertenece a alguien que no es TESTE es
 * una colisión: sembrar encima pisaría una cuenta real.
 */
export async function assertNoAccountCollision(accounts: Array<{ phone: string; email: string }>): Promise<void> {
  for (const account of accounts) {
    const byPhone = await User.findOne({ phone: account.phone }).select('email phone');
    if (byPhone && !isTesteEmail(byPhone.email)) {
      throw new Error(`El teléfono ${account.phone} ya es de una cuenta que no es TESTE (${byPhone.email ?? 'sin correo'}).`);
    }
    const byEmail = await User.findOne({ email: account.email }).select('email phone');
    if (byEmail && !isTestePhone(byEmail.phone)) {
      throw new Error(`El correo ${account.email} ya es de una cuenta que no es TESTE (${byEmail.phone ?? 'sin teléfono'}).`);
    }
  }
}

/** `--db=x --apply` → { db: 'x', apply: true } */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    out[key] = value === undefined ? true : value;
  }
  return out;
}
