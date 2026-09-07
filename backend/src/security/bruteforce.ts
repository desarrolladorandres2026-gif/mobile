/**
 * In-memory brute force protection
 * For production, replace with Redis-backed implementation
 */

interface LoginAttempt {
  count: number;
  firstAttempt: number;
  lockedUntil?: number;
}

// Track attempts by IP and by user identifier
const ipAttempts = new Map<string, LoginAttempt>();
const userAttempts = new Map<string, LoginAttempt>();

// Configuration
const MAX_ATTEMPTS_PER_IP = 20;         // Max login attempts per IP in window
const MAX_ATTEMPTS_PER_USER = 5;        // Max login attempts per user in window
const WINDOW_MS = 15 * 60 * 1000;       // 15 minute window
const LOCK_DURATION_BASE_MS = 60 * 1000;  // Base lock: 1 minute
const LOCK_MULTIPLIER = 2;               // Lock doubles each time
const MAX_LOCK_DURATION_MS = 30 * 60 * 1000; // Max 30 minute lock

// Cleanup old entries every 10 minutes.
// unref() so this housekeeping timer never keeps the process alive on its
// own — otherwise scripts and test runners hang waiting for it.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of ipAttempts.entries()) {
    if (now - attempt.firstAttempt > WINDOW_MS && !attempt.lockedUntil) {
      ipAttempts.delete(key);
    }
    if (attempt.lockedUntil && now > attempt.lockedUntil) {
      ipAttempts.delete(key);
    }
  }
  for (const [key, attempt] of userAttempts.entries()) {
    if (now - attempt.firstAttempt > WINDOW_MS && !attempt.lockedUntil) {
      userAttempts.delete(key);
    }
    if (attempt.lockedUntil && now > attempt.lockedUntil) {
      userAttempts.delete(key);
    }
  }
}, 10 * 60 * 1000);

cleanupTimer.unref?.();

/**
 * Clears all tracked attempts.
 *
 * Counters are process-wide and in-memory, so tests must reset them between
 * cases or one suite's failed logins lock out the next.
 */
export function resetBruteForce(): void {
  ipAttempts.clear();
  userAttempts.clear();
}

export interface BruteForceCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

/**
 * Check if a login attempt should be allowed
 */
export function checkBruteForce(ip: string, userIdentifier: string): BruteForceCheckResult {
  const now = Date.now();

  // Check IP-based lockout
  const ipRecord = ipAttempts.get(ip);
  if (ipRecord?.lockedUntil && now < ipRecord.lockedUntil) {
    return {
      allowed: false,
      retryAfterMs: ipRecord.lockedUntil - now,
      reason: 'Demasiados intentos desde esta IP. Intenta más tarde.',
    };
  }

  // Check user-based lockout
  const userRecord = userAttempts.get(userIdentifier);
  if (userRecord?.lockedUntil && now < userRecord.lockedUntil) {
    return {
      allowed: false,
      retryAfterMs: userRecord.lockedUntil - now,
      reason: 'Cuenta temporalmente bloqueada por múltiples intentos fallidos.',
    };
  }

  return { allowed: true };
}

/**
 * Record a failed login attempt
 */
export function recordFailedAttempt(ip: string, userIdentifier: string): BruteForceCheckResult {
  const now = Date.now();

  // Update IP attempts
  const ipRecord = ipAttempts.get(ip) || { count: 0, firstAttempt: now };
  if (now - ipRecord.firstAttempt > WINDOW_MS) {
    ipRecord.count = 0;
    ipRecord.firstAttempt = now;
  }
  ipRecord.count++;

  if (ipRecord.count >= MAX_ATTEMPTS_PER_IP) {
    const lockDuration = Math.min(
      LOCK_DURATION_BASE_MS * Math.pow(LOCK_MULTIPLIER, Math.floor(ipRecord.count / MAX_ATTEMPTS_PER_IP)),
      MAX_LOCK_DURATION_MS
    );
    ipRecord.lockedUntil = now + lockDuration;
  }
  ipAttempts.set(ip, ipRecord);

  // Update user attempts
  const userRecord = userAttempts.get(userIdentifier) || { count: 0, firstAttempt: now };
  if (now - userRecord.firstAttempt > WINDOW_MS) {
    userRecord.count = 0;
    userRecord.firstAttempt = now;
  }
  userRecord.count++;

  if (userRecord.count >= MAX_ATTEMPTS_PER_USER) {
    const lockDuration = Math.min(
      LOCK_DURATION_BASE_MS * Math.pow(LOCK_MULTIPLIER, Math.floor(userRecord.count / MAX_ATTEMPTS_PER_USER)),
      MAX_LOCK_DURATION_MS
    );
    userRecord.lockedUntil = now + lockDuration;
    userAttempts.set(userIdentifier, userRecord);

    return {
      allowed: false,
      retryAfterMs: lockDuration,
      reason: `Cuenta bloqueada temporalmente. Intenta en ${Math.ceil(lockDuration / 1000)} segundos.`,
    };
  }

  userAttempts.set(userIdentifier, userRecord);

  const remaining = MAX_ATTEMPTS_PER_USER - userRecord.count;
  return {
    allowed: true,
    reason: remaining <= 2 ? `${remaining} intento(s) restante(s) antes del bloqueo.` : undefined,
  };
}

/**
 * Clear attempts after successful login
 */
export function clearAttempts(ip: string, userIdentifier: string): void {
  userAttempts.delete(userIdentifier);
  // Don't clear IP attempts entirely - just reduce
  const ipRecord = ipAttempts.get(ip);
  if (ipRecord) {
    ipRecord.count = Math.max(0, ipRecord.count - 1);
    if (ipRecord.count === 0) {
      ipAttempts.delete(ip);
    }
  }
}

/**
 * Get remaining attempts for a user
 */
export function getRemainingAttempts(userIdentifier: string): number {
  const record = userAttempts.get(userIdentifier);
  if (!record) return MAX_ATTEMPTS_PER_USER;
  return Math.max(0, MAX_ATTEMPTS_PER_USER - record.count);
}
