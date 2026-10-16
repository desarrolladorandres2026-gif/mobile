#!/usr/bin/env node
// CLI de CEREBRO. Sin dependencias: solo Node 20+ y el `typescript` que ya está instalado en el repo.
import { build } from './lib/build.mjs';
import { log, fmtMs } from './lib/util.mjs';

const [, , cmd = 'ayuda', ...args] = process.argv;

const AYUDA = `
CEREBRO — mapa técnico vivo de ZIPP

  node CEREBRO/scripts/cerebro.mjs <comando>

  construir      Reconstrucción COMPLETA desde cero (analiza todo; unos 3-4 min).
  actualizar     Actualización INCREMENTAL: solo lo que cambió desde la última construcción.
  iniciar        Arranca en segundo plano el vigilante + la interfaz (http://127.0.0.1:3900).
  detener        Detiene el vigilante.
  estado         Muestra si el vigilante corre y cuándo fue la última actualización.
  servir         Arranca solo la interfaz (sin vigilar).
  vigilar        Vigilante en primer plano (Ctrl+C para salir).
  verificar      Ejecuta las suites de pruebas seguras y guarda la evidencia.
  revisar        Registra un rango de líneas leído:  revisar <archivo> <desde-hasta> [nota]
  reanclar       Actualiza los números de línea de las anclas manuales que solo se movieron.
  comprobar      Comprueba la coherencia de lo generado y de las referencias manuales.
`;

async function main() {
  switch (cmd) {
    case 'construir':
    case 'build': {
      log('Reconstrucción completa…');
      const r = await build({ modo: 'completo', origen: 'manual' });
      log(`Listo en ${fmtMs(r.meta.duracionMs)} · instantánea ${r.meta.id}`);
      console.log(JSON.stringify(r.meta.conteos));
      break;
    }
    case 'actualizar':
    case 'update': {
      log('Actualización incremental…');
      const r = await build({ modo: 'incremental', origen: 'manual' });
      log(`Listo en ${fmtMs(r.meta.duracionMs)} · cambios: +${r.archivosCambiados.nuevos.length} ~${r.archivosCambiados.modificados.length} -${r.archivosCambiados.eliminados.length}`);
      break;
    }
    case 'servir': {
      const { serve } = await import('./lib/server.mjs');
      await serve({});
      break;
    }
    case 'vigilar': {
      const { watch } = await import('./lib/watch.mjs');
      await watch({ serve: true });
      break;
    }
    case 'iniciar': {
      const { start } = await import('./lib/daemon.mjs');
      start();
      break;
    }
    case 'detener': {
      const { stop } = await import('./lib/daemon.mjs');
      stop();
      break;
    }
    case 'estado': {
      const { status } = await import('./lib/daemon.mjs');
      status();
      break;
    }
    case 'verificar': {
      const { verify } = await import('./lib/verify.mjs');
      await verify(args);
      break;
    }
    case 'revisar': {
      const { addReview } = await import('./lib/review.mjs');
      addReview(args);
      break;
    }
    case 'reanclar': {
      const { reanchor } = await import('./lib/reanchor.mjs');
      const r = reanchor({ aplicar: !args.includes('--simular') });
      console.log(`Anclas: ${r.ok} vigentes, ${r.movidas} actualizadas, ${r.perdidas.length} perdidas (requieren revisión humana).`);
      for (const p of r.perdidas) console.log('  PERDIDA ' + p);
      break;
    }
    case 'comprobar': {
      const { check } = await import('./lib/check.mjs');
      await check(args);
      break;
    }
    default:
      console.log(AYUDA);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
