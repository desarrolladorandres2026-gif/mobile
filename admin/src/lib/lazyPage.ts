import { lazy, type ComponentType } from 'react';

const RELOAD_FLAG = 'zipp:chunk-reload-at';

/**
 * Ruta -> cargar su archivo, para poder pedirlo antes del clic.
 *
 * Un enlace del menu lateral no descarga nada hasta que se pulsa: recien
 * entonces empieza a viajar el archivo de la pagina, y mientras tanto el
 * `Suspense` ensena el spinner. El raton llega al enlace unas decimas antes
 * que el clic, y en tactil el `touchstart` llega antes que el `click`: ese
 * hueco es gratis y basta para que el archivo ya este cuando de verdad se
 * navega.
 */
const loaders = new Map<string, () => void>();

/** Pide el archivo de una pagina sin navegar a ella. Repetirlo no cuesta. */
export function preloadPage(path: string): void {
  loaders.get(path)?.();
}

/**
 * Cuanto tiene que quedarse el puntero sobre un enlace para creerle.
 *
 * Sin esta espera, cruzar el menu de arriba abajo pedia el archivo de cada
 * seccion por la que pasa el raton -- y en admin una de ellas es el mapa de
 * flota, medio mega de mapbox-gl. Con el dedo no hace falta: un `touchstart`
 * ya es una decision, y ahi los milisegundos hasta el `click` son justo lo
 * que se quiere aprovechar.
 */
const HOVER_DWELL_MS = 120;

let dwell: ReturnType<typeof setTimeout> | null = null;

function cancelDwell() {
  if (dwell) clearTimeout(dwell);
  dwell = null;
}

/** Props para un enlace del menu: pide su pagina en cuanto hay intencion. */
export function preloadOn(path: string) {
  return {
    onMouseEnter: () => {
      cancelDwell();
      dwell = setTimeout(() => preloadPage(path), HOVER_DWELL_MS);
    },
    onMouseLeave: cancelDwell,
    onFocus: () => preloadPage(path),
    onTouchStart: () => preloadPage(path),
  };
}


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
export function lazyPage<T extends ComponentType<object>>(
  load: () => Promise<{ default: T }>,
  /** Ruta con la que se registra para `preloadPage`. Ver `loaders`. */
  path?: string,
) {
  if (path) {
    let started: Promise<unknown> | null = null;
    // El propio empaquetador cachea el `import()`, pero guardar la promesa
    // evita rehacer el trabajo en cada `mouseenter` del mismo enlace.
    loaders.set(path, () => {
      started ??= load().catch(() => {
        // Que falle la precarga no es un error del usuario: no ha pedido
        // nada todavia. Si luego navega de verdad, `lazyPage` reintenta y
        // ahi si hay a quien contarselo.
        started = null;
      });
    });
  }

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
