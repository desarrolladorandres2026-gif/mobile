import { lazy, type ComponentType } from 'react';

const RELOAD_FLAG = 'zipp:chunk-reload-at';

/** Cuándo fue la última recarga por esto, o `null` si no se puede saber. */
function lastReloadAt(): number | null {
  try {
    return Number(sessionStorage.getItem(RELOAD_FLAG)) || 0;
  } catch {
    return null;
  }
}

/**
 * `React.lazy` que sobrevive a un despliegue.
 *
 * Cada página vive en su propio archivo con hash en el nombre, y un deploy
 * borra los del anterior. Una pestaña abierta desde antes sigue apuntando a
 * los nombres viejos: al navegar a una página que todavía no había cargado,
 * la descarga da 404 y React muestra un error en blanco. En vez de eso se
 * recarga la página una vez, que trae el `index.html` nuevo con los nombres
 * nuevos. La marca en `sessionStorage` evita un bucle si el fallo es otro
 * (sin red, por ejemplo): en ese caso se deja ver el error. Sin
 * almacenamiento disponible no se arriesga la recarga.
 */
export function lazyPage<T extends ComponentType<object>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await load();
    } catch (error) {
      const last = lastReloadAt();
      if (last === null || Date.now() - last <= 10_000) throw error;
      try {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
      } catch {
        throw error;
      }
      window.location.reload();
      // La recarga ya está en camino; esto solo evita pintar el error.
      return new Promise<never>(() => {});
    }
  });
}
