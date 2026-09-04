/**
 * Corta una promesa a un plazo fijo sin cancelar el trabajo de fondo.
 *
 * Usado por el flyer publicitario de arranque: ni la consulta de la
 * campaña activa ni la precarga de su imagen pueden demorar el arranque de
 * ZIPP más de lo estrictamente acotado aquí. Si el plazo se cumple primero,
 * la promesa original sigue corriendo pero su resultado ya no le importa a
 * nadie — exactamente lo que se busca: "sin publicidad" es un resultado
 * tan válido como "con publicidad", nunca "esperando publicidad".
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tiempo agotado (${ms}ms)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
