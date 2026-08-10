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

/** Valida un celular colombiano: diez dígitos que empiezan por 3. */
export function validatePhone(phone: string): string | null {
  const clean = phone.replace(/\D/g, '');
  if (!clean) return 'Escribe tu número de celular';
  if (clean.length !== 10) return 'El celular tiene 10 dígitos';
  if (!clean.startsWith('3')) return 'Los celulares en Colombia empiezan por 3';
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
