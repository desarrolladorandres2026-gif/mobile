import mongoose, { Schema, Document } from 'mongoose';

/**
 * Freno a los intentos de acceso por fuerza bruta.
 *
 * Vivía en dos `Map` de memoria del proceso, con una nota que decía
 * "reemplazar por Redis en producción". El problema no era la elegancia:
 * un contador de intentos fallidos que se borra al reiniciar convierte
 * cualquier despliegue en una amnistía, y con dos instancias de PM2 cada
 * una contaba la mitad de los intentos, así que el atacante disponía del
 * doble antes del bloqueo.
 *
 * Está en Mongo y no en Redis porque Mongo ya es una dependencia de este
 * proyecto y Redis no. Un intento de acceso ya escribe en la base de datos
 * de todas formas —hay que leer el usuario—, así que el coste añadido de
 * una lectura indexada más no cambia nada, y evita montar y operar una
 * pieza de infraestructura entera para dos contadores.
 *
 * Tres contadores por intento fallido:
 * - `ip`: una misma IP probando muchas cuentas.
 * - `user`: una cuenta desde una IP concreta. Es el bloqueo corto, y va por
 *   cuenta+IP a propósito: atado solo al teléfono, cualquiera podía dejar
 *   bloqueado a un comercio o a un domiciliario fallando cinco veces con su
 *   número, sin saber su contraseña.
 * - `identifier`: una cuenta desde cualquier IP, con un umbral mucho más
 *   alto. Frena el ataque distribuido (una lista de contraseñas repartida
 *   entre muchas IPs) sin que un atacante solo pueda bloquear a nadie.
 *
 * Cuando un bloqueo vence, el contador vuelve a empezar: antes seguía en 5 y
 * un único fallo posterior volvía a bloquear, así que bastaba un intento cada
 * pocos minutos para mantener a alguien fuera indefinidamente. La escalada
 * (cada bloqueo dura el doble que el anterior) se lleva aparte, en
 * `lockLevel`, y se olvida tras una hora sin bloqueos.
 */

export type AttemptScope = 'ip' | 'user' | 'identifier';

export interface ILoginAttempt extends Document {
  scope: AttemptScope;
  key: string;
  count: number;
  firstAttemptAt: Date;
  lockedUntil?: Date;
  /** Cuántos bloqueos seguidos lleva esta clave; decide la duración del próximo. */
  lockLevel?: number;
  updatedAt: Date;
}

const loginAttemptSchema = new Schema<ILoginAttempt>({
  scope: { type: String, enum: ['ip', 'user', 'identifier'], required: true },
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  firstAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date },
  lockLevel: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

loginAttemptSchema.index({ scope: 1, key: 1 }, { unique: true });

// Dos horas cubren la ventana de quince minutos, el bloqueo máximo de
// treinta y la hora de memoria de la escalada. El TTL solo limpia: la
// corrección la da la comparación de `lockedUntil` contra el reloj.
loginAttemptSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 2 * 60 * 60 });

export const LoginAttempt = mongoose.model<ILoginAttempt>('LoginAttempt', loginAttemptSchema);

// ── Configuración ──
const MAX_ATTEMPTS_PER_IP = 20;
const MAX_ATTEMPTS_PER_USER = 5;
const MAX_ATTEMPTS_PER_IDENTIFIER = 25;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_BASE_MS = 60 * 1000;
const MAX_LOCK_DURATION_MS = 30 * 60 * 1000;
/** Tras esto sin un bloqueo nuevo, la escalada vuelve al nivel inicial. */
const LOCK_LEVEL_MEMORY_MS = 60 * 60 * 1000;

const userKey = (identifier: string, ip: string) => `${identifier}|${ip}`;

/**
 * Borra todos los contadores.
 *
 * Las pruebas lo necesitan entre casos: sin esto, los inicios de sesión
 * fallidos de una suite bloquean a la siguiente.
 */
export async function resetBruteForce(): Promise<void> {
  await LoginAttempt.deleteMany({});
}

export interface BruteForceCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

/**
 * ¿Se puede intentar entrar, o hay un bloqueo vivo?
 *
 * El mensaje es el mismo exista o no la cuenta: los contadores se llevan por
 * identificador escrito, no por usuario encontrado, así que un bloqueo no
 * revela si ese teléfono está registrado.
 */
export async function checkBruteForce(ip: string, userIdentifier: string): Promise<BruteForceCheckResult> {
  const now = Date.now();

  const records = await LoginAttempt.find({
    $or: [
      { scope: 'ip', key: ip },
      { scope: 'user', key: userKey(userIdentifier, ip) },
      { scope: 'identifier', key: userIdentifier },
    ],
  }).lean();

  const live = records
    .filter((r) => r.lockedUntil && now < r.lockedUntil.getTime())
    .sort((a, b) => b.lockedUntil!.getTime() - a.lockedUntil!.getTime())[0];

  if (!live) return { allowed: true };

  return {
    allowed: false,
    retryAfterMs: live.lockedUntil!.getTime() - now,
    reason:
      live.scope === 'ip'
        ? 'Demasiados intentos desde esta conexión. Intenta más tarde.'
        : 'Demasiados intentos para esta cuenta. Intenta más tarde.',
  };
}

/** Suma un intento fallido a un contador y decide si toca bloquear. */
async function bump(scope: AttemptScope, key: string, maxAttempts: number): Promise<{ count: number; lockedForMs?: number }> {
  const now = new Date();
  const existing = await LoginAttempt.findOne({ scope, key });

  // Fuera de la ventana, o con un bloqueo ya vencido, el contador empieza de
  // cero: quien falló hace media hora no está atacando nada, y quien ya
  // cumplió su bloqueo no debe volver a quedar fuera por un único fallo.
  const lockExpired = !!existing?.lockedUntil && existing.lockedUntil.getTime() <= now.getTime();
  const stale = !!existing && now.getTime() - existing.firstAttemptAt.getTime() > WINDOW_MS;
  const restart = !existing || stale || lockExpired;

  const count = restart ? 1 : existing!.count + 1;
  const firstAttemptAt = restart ? now : existing!.firstAttemptAt;

  const recentLock =
    !!existing?.lockedUntil && now.getTime() - existing.lockedUntil.getTime() < LOCK_LEVEL_MEMORY_MS;
  const previousLevel = recentLock ? existing!.lockLevel ?? 0 : 0;

  const update: Record<string, unknown> = { count, firstAttemptAt, updatedAt: now };
  const unset: Record<string, 1> = {};
  let lockedForMs: number | undefined;

  if (count >= maxAttempts) {
    const level = previousLevel + 1;
    // El bloqueo se duplica en cada tanda: molesta poco a quien se equivocó
    // de contraseña y mucho a quien está probando una lista.
    lockedForMs = Math.min(LOCK_DURATION_BASE_MS * 2 ** (level - 1), MAX_LOCK_DURATION_MS);
    update.lockedUntil = new Date(now.getTime() + lockedForMs);
    update.lockLevel = level;
  } else if (lockExpired) {
    unset.lockedUntil = 1;
    update.lockLevel = previousLevel;
  }

  await LoginAttempt.updateOne(
    { scope, key },
    { $set: update, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { upsert: true }
  );

  return { count, lockedForMs };
}

/** Registra un intento fallido contra la IP, la cuenta desde esa IP y la cuenta en global. */
export async function recordFailedAttempt(ip: string, userIdentifier: string): Promise<BruteForceCheckResult> {
  const [ipResult, user, identifier] = await Promise.all([
    bump('ip', ip, MAX_ATTEMPTS_PER_IP),
    bump('user', userKey(userIdentifier, ip), MAX_ATTEMPTS_PER_USER),
    bump('identifier', userIdentifier, MAX_ATTEMPTS_PER_IDENTIFIER),
  ]);

  const lockedForMs = Math.max(ipResult.lockedForMs ?? 0, user.lockedForMs ?? 0, identifier.lockedForMs ?? 0);
  if (lockedForMs > 0) {
    return {
      allowed: false,
      retryAfterMs: lockedForMs,
      reason: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(lockedForMs / 60000)} minuto(s).`,
    };
  }

  const remaining = MAX_ATTEMPTS_PER_USER - user.count;
  return {
    allowed: true,
    reason: remaining <= 2 ? `${remaining} intento(s) restante(s) antes del bloqueo.` : undefined,
  };
}

/**
 * Limpia tras un acceso correcto.
 *
 * La cuenta desde esa IP se libera del todo; la IP solo baja un punto. Detrás
 * de una misma IP hay una casa entera o un café: que uno acierte no demuestra
 * que los otros diecinueve intentos fueran legítimos. El contador global de
 * la cuenta no se toca: un acierto del titular no debe borrar el rastro de un
 * ataque distribuido en curso contra ella.
 */
export async function clearAttempts(ip: string, userIdentifier: string): Promise<void> {
  await LoginAttempt.deleteOne({ scope: 'user', key: userKey(userIdentifier, ip) });

  const ipRecord = await LoginAttempt.findOne({ scope: 'ip', key: ip });
  if (!ipRecord) return;

  const count = Math.max(0, ipRecord.count - 1);
  if (count === 0) {
    await LoginAttempt.deleteOne({ _id: ipRecord._id });
    return;
  }

  await LoginAttempt.updateOne({ _id: ipRecord._id }, { $set: { count, updatedAt: new Date() } });
}

/** Intentos que le quedan a una cuenta desde una IP antes del bloqueo. */
export async function getRemainingAttempts(userIdentifier: string, ip = 'unknown'): Promise<number> {
  const record = await LoginAttempt.findOne({ scope: 'user', key: userKey(userIdentifier, ip) }).lean();
  if (!record) return MAX_ATTEMPTS_PER_USER;
  return Math.max(0, MAX_ATTEMPTS_PER_USER - record.count);
}

/**
 * Levanta todos los bloqueos de una cuenta (desde cualquier IP). Lo usa el
 * restablecimiento de contraseña por un administrador: quien acaba de
 * recibir una contraseña nueva no debe seguir bloqueado por los intentos
 * fallidos con la anterior.
 */
export async function clearAccountLocks(userIdentifier: string): Promise<void> {
  const escaped = userIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await LoginAttempt.deleteMany({
    $or: [
      { scope: 'identifier', key: userIdentifier },
      { scope: 'user', key: { $regex: `^${escaped}\\|` } },
    ],
  });
}
