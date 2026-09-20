/**
 * Mensajes de error para el usuario.
 *
 * El backend ya devuelve mensajes en español y específicos ("Este cupón
 * venció", "No hay cobertura en esa dirección"). Se prefieren siempre sobre
 * un texto genérico: quien mejor sabe qué salió mal es quien lo rechazó.
 */
export function apiMessage(error: unknown, fallback: string): string {
  const e = error as any;

  const fromServer = e?.response?.data?.message;
  if (typeof fromServer === 'string' && fromServer.trim()) return fromServer;

  // Sin respuesta: la petición no llegó a salir o se venció el tiempo.
  if (e?.code === 'ECONNABORTED') {
    return 'La conexión está lenta. Inténtalo de nuevo.';
  }
  if (e?.message === 'Network Error' || !e?.response) {
    return 'No pudimos conectarnos. Revisa tu internet.';
  }

  if (e?.response?.status === 429) {
    return 'Demasiados intentos seguidos. Espera un momento.';
  }
  if (e?.response?.status >= 500) {
    return 'Tuvimos un problema de nuestro lado. Vuelve a intentarlo.';
  }

  return fallback;
}

/**
 * Como `apiMessage`, pero prefiere el motivo del primer campo de un 400 del
 * validador ("La cédula tiene entre 5 y 10 dígitos") sobre el genérico
 * "Error de validación".
 *
 * No se hace en `apiMessage` para todo: no todos los esquemas del backend
 * traen mensajes propios, y los de Zod por defecto están en inglés. Úsalo
 * solo donde el esquema los escribe en español (p. ej. `updateProfileSchema`).
 */
export function fieldMessage(error: unknown, fallback: string): string {
  const first = (error as any)?.response?.data?.errors?.[0]?.message;
  return typeof first === 'string' && first.trim() ? first : apiMessage(error, fallback);
}

/** Valida un celular colombiano: diez dígitos que empiezan por 3. */
export function validatePhone(phone: string): string | null {
  const clean = phone.replace(/\D/g, '');
  if (!clean) return 'Escribe tu número de celular';
  if (clean.length !== 10) return 'El celular tiene 10 dígitos';
  if (!clean.startsWith('3')) return 'Los celulares en Colombia empiezan por 3';
  return null;
}

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Escribe tu correo';
  if (!/^\S+@\S+\.\S+$/.test(trimmed)) return 'Ese correo no es válido';
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Escribe tu contraseña';
  if (password.length < 6) return 'Mínimo 6 caracteres';
  return null;
}

export function validateName(name: string): string | null {
  if (!name.trim()) return 'Escribe tu nombre';
  if (name.trim().length < 3) return 'Escribe tu nombre completo';
  return null;
}
