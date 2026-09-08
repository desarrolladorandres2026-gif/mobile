# Pruebas de carga de ZIPP

Hay dos preguntas distintas que la gente junta bajo "¿aguanta 7.000 usuarios?",
y necesitan herramientas distintas. Confundirlas es la razón por la que muchos
proyectos tienen una prueba de carga verde y se caen el día del lanzamiento.

| Pregunta | Qué la contesta | Dónde |
|---|---|---|
| ¿Se descuadra el dinero cuando miles de operaciones compiten? | `npm run test:load` | Este repositorio, ya escrito |
| ¿Cuántas peticiones por segundo aguanta el servidor? | Una herramienta de carga contra un despliegue real | Requiere infraestructura |

## Nivel 1 — Invariantes bajo concurrencia (`npm run test:load`)

Monta 7.000 usuarios de los cuatro roles y lanza miles de operaciones
simultáneas contra el **código de negocio real**: creación de pedidos,
reclamo de pedidos por parte de repartidores, canje de puntos, entregas,
liquidaciones.

Al terminar comprueba lo que no puede fallar nunca:

- El libro mayor cuadra: débitos totales = créditos totales.
- Ningún producto se vendió por debajo de cero.
- Ningún cupón superó su tope de usos.
- Ningún pedido tiene dos pagos al repartidor.
- Ningún repartidor quedó con el fondo en negativo.
- El fondo retenido de cada repartidor coincide exactamente con los pedidos
  que lleva encima.
- El saldo de puntos de cada cliente coincide con la suma de sus movimientos.
- Ningún payout entró en dos liquidaciones.

**Por qué esto es lo primero que había que escribir:** todos los bugs graves
que ha tenido este proyecto han sido carreras —el fondo del repartidor, el
canje de puntos, el reclamo del pedido, el presupuesto del cupón— y ninguno
se ve con un usuario a la vez. Un servidor rapidísimo que cobra dos veces es
peor que uno lento.

### Lo que este nivel NO prueba

Corre sobre `mongodb-memory-server` en el mismo proceso, sin HTTP. Por tanto
no dice nada sobre:

- Peticiones por segundo, latencia, ni percentiles.
- El pool de conexiones contra Atlas ni los límites del plan contratado.
- El bucle de eventos de Node bajo carga de red real.
- Nginx, PM2, TLS, ni el ancho de banda.
- Los sockets (Socket.IO) con miles de conexiones abiertas a la vez.

Tampoco mide argon2id, porque la población se inserta con el driver nativo
saltándose el `pre('save')`. **Eso es un hallazgo en sí mismo**: si algún día
hay que importar usuarios en bloque, el cuello de botella es argon2 —
memory-hard a propósito—, no Mongo.

## Nivel 2 — Throughput real

Necesita un despliegue de verdad. **Nunca contra la base de datos de
desarrollo**: es Atlas, compartida, y llenarla de basura de carga rompe el
trabajo de todos y puede costar dinero.

### Requisitos

1. Un entorno de staging con su propia base de datos.
2. `PAYMENT_PROVIDER=sandbox` — la pasarela real no admite miles de intentos.
3. Datos sembrados: usuarios, comercios y productos suficientes.
4. Una herramienta: [k6](https://k6.io) o [autocannon](https://github.com/mcollina/autocannon).

### Guion mínimo con k6

```js
// staging-load.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 500 },   // subida
    { duration: '5m', target: 2000 },  // meseta
    { duration: '2m', target: 0 },     // bajada
  ],
  thresholds: {
    // Un pedido que tarda más de dos segundos se abandona.
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE = __ENV.BASE_URL;

export default function () {
  const res = http.get(`${BASE}/api/v1/businesses`);
  check(res, { 'listado ok': (r) => r.status === 200 });
}
```

```bash
k6 run -e BASE_URL=https://staging.tu-dominio staging-load.js
```

### Qué mirar, en este orden

1. **`http_req_failed`** — si sube, algo se está cayendo, y el resto de
   números no significan nada.
2. **p95 de latencia**, no la media. La media esconde justo a la gente que se
   va.
3. **Conexiones de Mongo** en el panel de Atlas. El pool por defecto de
   Mongoose es 100; si se saturan, la latencia se dispara sin que la CPU
   suba, y parece un problema de código cuando es de configuración.
4. **Memoria del proceso**. Una fuga se ve como una meseta que sube y no baja
   entre tandas.

### Recordatorio de red

FortiGate bloquea `sslip.io` en la red local. Si la carga contra la API
desplegada falla entera y de golpe, comprobar el cortafuegos antes de buscar
en el código.
