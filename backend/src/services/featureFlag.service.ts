import { createHash } from 'crypto';
import { FeatureFlag, IFeatureFlag, FeatureAudience } from '../models/FeatureFlag';
import { UserRole } from '../types';
import { AppError } from '../middlewares/errorHandler';
import { disconnectAllAdminSockets } from './authzSockets.service';

/** Interruptor que decide si el RBAC bloquea (`enforce`) o solo observa. Ver `authorization.service`. */
export const RBAC_ENFORCE_FLAG = 'rbac_enforce';

/** `rbac_enforce` es idéntico para todos los admins: solo esas audiencias tienen sentido. */
const RBAC_ENFORCE_AUDIENCES: FeatureAudience[] = ['all', 'staff', 'off'];

/**
 * Interruptores de funcionalidad.
 *
 * Existe por una lección concreta de este proyecto: el reparto automático
 * se escribió, se probó y se desplegó correcto, y aun así habría roto la
 * operación, porque la app del domiciliario todavía no sabía mostrar una
 * oferta. Hizo falta una variable de entorno de urgencia para poder
 * desplegar el código sin encender el comportamiento.
 *
 * Eso no debería requerir un redespliegue ni una variable nueva cada vez.
 * Un interruptor que se mueve desde el panel separa dos cosas que no tienen
 * por qué ocurrir a la vez: publicar código y cambiar lo que pasa en la
 * calle.
 */

/**
 * Lo mínimo para decidir. La caché no guarda documentos de Mongoose: solo
 * necesita estos tres campos, y cargar objetos completos por cada consulta
 * en un camino caliente sería pagar por algo que no se usa.
 */
interface FlagRecord {
  key: string;
  audience: FeatureAudience;
  percentage: number;
}

interface CacheEntry {
  flags: Map<string, FlagRecord>;
  at: number;
}

/**
 * Caché corta de todos los interruptores.
 *
 * Se consultan en caminos calientes —cada pedido, cada arranque de app— y
 * son un puñado de documentos que cambian una vez al día como mucho. Diez
 * segundos de desfase es un precio ridículo comparado con una lectura por
 * petición, y sigue siendo lo bastante rápido como para que apagar algo
 * roto se note enseguida.
 */
const CACHE_TTL_MS = 10_000;
let cache: CacheEntry | null = null;

async function load(): Promise<Map<string, FlagRecord>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.flags;

  const all = await FeatureFlag.find().select('key audience percentage').lean();
  const flags = new Map<string, FlagRecord>();
  for (const flag of all) {
    flags.set(flag.key, {
      key: flag.key,
      audience: flag.audience,
      percentage: flag.percentage,
    });
  }

  cache = { flags, at: Date.now() };
  return flags;
}

/** Olvida la caché. Se llama al escribir, para que el cambio se vea ya. */
export function invalidate(): void {
  cache = null;
}

export interface FlagSubject {
  userId?: string;
  role?: string;
}

/**
 * Reparte un porcentaje de forma estable.
 *
 * El mismo usuario cae siempre del mismo lado mientras el porcentaje no
 * cambie. Con un sorteo al azar en cada consulta, la función aparecería y
 * desaparecería entre pantallas, que es peor que no tenerla: el usuario no
 * distingue un reparto gradual de una aplicación rota.
 */
function bucketOf(key: string, userId: string): number {
  const digest = createHash('sha1').update(`${key}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function evaluate(flag: FlagRecord | undefined, subject: FlagSubject): boolean {
  if (!flag) return false;

  switch (flag.audience) {
    case 'all':
      return true;
    case 'staff':
      return subject.role === UserRole.ADMIN;
    case 'percentage':
      // Sin usuario identificado no se puede repartir de forma estable, y
      // un sorteo distinto en cada llamada sería peor que decir que no.
      if (!subject.userId) return false;
      return bucketOf(flag.key, subject.userId) < flag.percentage;
    case 'off':
    default:
      return false;
  }
}

/** ¿Está encendida esta función para este usuario? */
export async function isEnabled(key: string, subject: FlagSubject = {}): Promise<boolean> {
  const flags = await load();
  return evaluate(flags.get(key), subject);
}

/**
 * ¿Existe un interruptor guardado con esta clave?
 *
 * Distinto de `isEnabled`: esa devuelve `false` tanto si el interruptor
 * está apagado como si nadie lo ha creado todavía, y esa ambigüedad es
 * justo lo que dejaba a `DISPATCH_ENABLED` (variable de entorno) ganarle al
 * apagado explícito del panel (O2). Con esto, quien llama puede saber si
 * hay una decisión guardada o si debe caer al valor por defecto.
 */
export async function isConfigured(key: string): Promise<boolean> {
  const flags = await load();
  return flags.has(key);
}

/** Todos los interruptores resueltos para un usuario, para mandárselos a la app. */
export async function resolveAll(subject: FlagSubject = {}): Promise<Record<string, boolean>> {
  const flags = await load();
  const resolved: Record<string, boolean> = {};
  for (const [key, flag] of flags) resolved[key] = evaluate(flag, subject);
  return resolved;
}

export async function list() {
  return FeatureFlag.find().sort({ key: 1 }).lean();
}

export async function upsert(
  key: string,
  input: { description?: string; audience?: FeatureAudience; percentage?: number },
  updatedBy?: string
): Promise<IFeatureFlag> {
  if (key === RBAC_ENFORCE_FLAG && input.audience !== undefined && !RBAC_ENFORCE_AUDIENCES.includes(input.audience)) {
    throw new AppError(
      `El interruptor ${RBAC_ENFORCE_FLAG} solo admite las audiencias: ${RBAC_ENFORCE_AUDIENCES.join(', ')}.`,
      400
    );
  }
  if (input.audience === 'percentage' && (input.percentage ?? 0) <= 0) {
    throw new AppError(
      'Un reparto por porcentaje con cero por ciento no enciende nada. Usa "off" si esa es la intención.',
      400
    );
  }

  // `description` va en uno u otro operador, nunca en los dos: Mongo
  // rechaza la escritura entera si `$set` y `$setOnInsert` tocan el mismo
  // campo. Cuando viene en la petición manda `$set` —vale para crear y para
  // actualizar—; cuando no, solo hace falta un valor de partida al crear.
  const hasDescription = input.description !== undefined;

  const flag = await FeatureFlag.findOneAndUpdate(
    { key },
    {
      $set: {
        ...(hasDescription ? { description: input.description } : {}),
        ...(input.audience !== undefined ? { audience: input.audience } : {}),
        ...(input.percentage !== undefined ? { percentage: input.percentage } : {}),
        ...(updatedBy ? { updatedBy } : {}),
      },
      $setOnInsert: { key, ...(hasDescription ? {} : { description: key }) },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  invalidate();
  // Cambia el modo de todos los admins: sus salas de socket se recalculan al reconectar.
  if (key === RBAC_ENFORCE_FLAG) await disconnectAllAdminSockets();
  return flag;
}

export async function remove(key: string): Promise<void> {
  await FeatureFlag.deleteOne({ key });
  invalidate();
  if (key === RBAC_ENFORCE_FLAG) await disconnectAllAdminSockets();
}

export const featureFlagService = {
  isEnabled,
  resolveAll,
  list,
  upsert,
  remove,
  invalidate,
};
