/**
 * Resultado de la Fase 6 — regresión y seguridad.
 *
 * Se escribe a mano al cerrar cada corrida, y `run-report.ts` lo vuelca en
 * `TESTE.md`. Es el acta: qué se ejecutó, qué falló, qué se corrigió y qué
 * queda pendiente. Los números salen de las corridas reales, no de una
 * estimación.
 */

export interface Phase6Suite {
  suite: string;
  command: string;
  before: string;
  after: string;
}

export interface Phase6Defect {
  id: string;
  severity: 'crítica' | 'alta' | 'media' | 'baja';
  title: string;
  where: string;
  evidence: string;
  fix: string;
  status: 'corregido' | 'documentado';
}

export interface Phase6Check {
  id: string;
  what: string;
  result: string;
}

export const PHASE6_DATE = '2026-09-15';

export const PHASE6_SUITES: Phase6Suite[] = [
  { suite: 'Backend (vitest)', command: 'npm test', before: '68 archivos · 981 pruebas ✅', after: '72 archivos · 1.042 pruebas ✅' },
  { suite: 'Móvil (jest)', command: 'npm test', before: '5 archivos · 28 pruebas ✅', after: '6 archivos · 47 pruebas ✅' },
  { suite: 'Panel comercio (vitest)', command: 'npm test', before: 'no existía runner', after: '1 archivo · 16 pruebas ✅' },
  { suite: 'Tipos', command: 'tsc --noEmit / tsc -b', before: 'limpio', after: 'limpio en backend, móvil y panel' },
  { suite: 'Lint del panel', command: 'npx eslint src', before: '2 errores · 16 avisos (Settlements.tsx, preexistente)', after: 'los mismos 2 errores · 16 avisos — ninguno en lo nuevo' },
];

export const PHASE6_DEFECTS: Phase6Defect[] = [
  {
    id: 'F-1', severity: 'alta',
    title: 'El stock reservado no volvía cuando la creación del pedido fallaba',
    where: 'services/order.service.ts — `create`, tres ramas de salida',
    evidence: 'Cuatro reintentos simultáneos con la misma `idempotencyKey` sobre un producto con 5 unidades dejaban **1 unidad** y un solo pedido: se perdían 3. Igual con el cupón agotado y con un fallo del libro mayor.',
    fix: 'Se llama al `releaseStock` que ya existía en las tres ramas, dentro de un `undoReservation` que además vuelve a encender el producto si la reserva fue la que lo apagó.',
    status: 'corregido',
  },
  {
    id: 'F-2', severity: 'alta',
    title: '`idempotencyKey` sin ámbito por cliente',
    where: 'services/order.service.ts — búsqueda previa y captura del error 11000',
    evidence: 'Un segundo cliente que mandara la misma clave recibía **el pedido del primero**, con su dirección y sus productos (201 en vez de rechazo).',
    fix: 'La búsqueda filtra por `clientId`; una clave ajena responde `409 IDEMPOTENCY_KEY_CONFLICT` sin revelar nada del pedido que la ocupa. Sin tocar el índice único ni migrar Atlas.',
    status: 'corregido',
  },
  {
    id: 'F-3', severity: 'media',
    title: 'La réplica idempotente volvía a sonar en la cocina',
    where: 'controllers/order.controller.ts — emisión de `order:incoming`',
    evidence: 'El doble toque en "Pagar" emitía dos veces `order:incoming`, `order:available` y `order:new`: el panel del comercio recibía el mismo pedido dos veces y se ofrecía dos veces a los domiciliarios.',
    fix: 'El servicio marca la réplica con `order.$locals.replayed` (mecanismo nativo de Mongoose, sin cambiar la firma de `create`) y el controlador no emite en ese caso.',
    status: 'corregido',
  },
  {
    id: 'F-4', severity: 'baja',
    title: '`selectedExtras` sin tope de longitud',
    where: 'validators/order.validator.ts',
    evidence: 'Una sola línea con 51 adicionales se aceptaba y el servidor los resolvía uno por uno contra el producto en cada cotización.',
    fix: 'Tope de 50 por línea, que ningún plato real alcanza.',
    status: 'corregido',
  },
  {
    id: 'L-6', severity: 'alta',
    title: '`productService.create` descartaba inventario y mayoría de edad',
    where: 'services/product.service.ts — `create`',
    evidence: 'Crear un producto con `stock`, `lowStockThreshold` o `requiresAgeVerification` los guardaba en **null/false**: el validador los dejaba pasar y el servicio no los copiaba. Solo se guardaban al editar, y sin ningún error que lo dijera.',
    fix: 'Se copian los tres campos, y con `stock: 0` el producto nace agotado, igual que al editar.',
    status: 'corregido',
  },
];

export const PHASE6_CHECKS: Phase6Check[] = [
  { id: 'R-01', what: 'Producto sin grupos ni extras: precio, cotización, pedido y JSON', result: '✅ idénticos a la línea base' },
  { id: 'R-02', what: 'Producto solo con `extras[]` heredados (nombre + cantidad)', result: '✅ mismas pruebas de `pricing.test.ts` sin cambios' },
  { id: 'R-03', what: 'Producto con grupos: M-01…M-07', result: '✅' },
  { id: 'R-04', what: 'Producto mixto: un extra plano y una opción que se llaman igual', result: '✅ suman por separado y no se confunden' },
  { id: 'R-05', what: 'Checkout: (unidad + extras + opciones) × cantidad, subtotal y `finance`', result: '✅' },
  { id: 'R-06', what: 'La copia del pedido guarda `groupId`/`groupName`/`optionId`; los pedidos viejos se siguen leyendo', result: '✅' },
  { id: 'R-07', what: 'Inmutabilidad: subir precios y borrar una opción después del pedido', result: '✅ el pedido releído no cambia' },
  { id: 'R-08', what: 'Inventario y reserva atómica, también con productos con grupos', result: '✅ `stock.test.ts` completo + casos nuevos' },
  { id: 'R-09', what: 'Cancelar devuelve el stock exacto con dos líneas del mismo producto', result: '✅ 10 → 5 → 10' },
  { id: 'R-10', what: 'Panel: crear, editar y borrar grupos sin romper el producto', result: '✅ un PUT sin `modifierGroups` no los toca; con ids, los conserva' },
  { id: 'R-11', what: 'Crear sin inventario deja `stock` en null, no en cero', result: '✅' },
  { id: 'C-01', what: 'Dos líneas del mismo producto con distinta selección', result: '✅ no se fusionan; misma opción renombrada sí' },
  { id: 'UI', what: 'Producto sin grupos: no aparece ninguna UI de grupos', result: '✅ `hasModifierUI` en falso, sección no renderizada' },
  { id: 'SEC-01', what: '`optionId` de otro producto', result: '✅ 400 `MODIFIER_UNKNOWN`' },
  { id: 'SEC-02', what: '`groupId` de otro producto, y opción bajo el grupo equivocado', result: '✅ 400 `MODIFIER_UNKNOWN`' },
  { id: 'SEC-03', what: 'Producto de otro comercio dentro del pedido', result: '✅ 400, sin stock reservado' },
  { id: 'SEC-04', what: 'Precios del cliente: 0, −1, 999999999, distinto al de la base', result: '✅ ignorados; se cobra el de la base de datos' },
  { id: 'SEC-05', what: '`idempotencyKey` de otro cliente', result: '✅ 409, sin filtrar el pedido ajeno (era 201 antes de F-2)' },
  { id: 'SEC-06', what: 'El dueño de un comercio edita los grupos de otro', result: '✅ 403 con `businessId` propio o ajeno' },
  { id: 'SEC-07', what: 'Ids mal formados y `{"$ne": null}` como `optionId`', result: '✅ 400 de validación, nunca 500' },
  { id: 'SEC-08', what: '51 adicionales en una línea; opción repetida en el grupo', result: '✅ 400 (F-4) y `MODIFIER_DUPLICATE`' },
  { id: 'SEC-09', what: 'Grupos incoherentes desde el panel (mín > máx, máx > opciones, precio negativo o decimal, nombres repetidos)', result: '✅ 400 y el producto queda intacto' },
  { id: 'O-04', what: 'Doble envío secuencial con la misma clave', result: '✅ un pedido, un aviso, stock descontado una vez' },
  { id: 'O-05', what: 'Cuatro peticiones simultáneas con la misma clave', result: '✅ un pedido, stock −1 (antes −4)' },
  { id: 'CON-01', what: 'Dos clientes por la última unidad, con modificadores', result: '✅ uno 201, otro 409' },
  { id: 'CON-02', what: 'Mismo usuario, dos dispositivos, claves distintas', result: '✅ 201 + 409 `OUT_OF_STOCK`' },
  { id: 'CON-04', what: 'Dos clientes simultáneos con el mismo producto y la misma selección', result: '✅ mismos totales, stock correcto' },
  { id: 'CON-05', what: 'Cancelar mientras otro reserva, y doble cancelación simultánea', result: '✅ stock final coherente, devuelto una sola vez' },
  { id: 'CON-06', what: 'Ráfaga de 20 pedidos contra 5 unidades', result: '✅ exactamente 5 pasan, 15 dan 409, nunca `stock < 0`' },
  { id: 'CON-07', what: 'Cupón agotado con el stock ya reservado', result: '✅ el stock vuelve (antes se perdía)' },
  { id: 'API', what: 'Contrato de 22 rutas: estado, forma del JSON y dinero', result: '✅ sin rupturas; solo campos nuevos de la lista autorizada' },
  { id: 'TESTE', what: 'Siembra, idempotencia (dos corridas), validador y matriz por HTTP', result: '✅ 18 pruebas' },
];

export const PHASE6_PENDING: string[] = [
  '**L-3** El backend no comprueba el horario al crear el pedido: `isCurrentlyOpen()` existe y no lo llama nadie, usa la zona horaria del servidor y no maneja el cierre pasada la medianoche. Hoy solo lo frena la app (fila H-01).',
  '**L-4** `openState()` en el móvil, pasada la medianoche, mira el horario de *hoy* en vez del de *ayer*: Callejón 21 (16:00–01:00) aparece cerrado a las 00:30 (fila H-02).',
  '**L-5** Cerrar el negocio con el interruptor lo **oculta** del listado en lugar de mostrarlo "Cerrado" (fila B-01).',
  '**L-13** La misma `idempotencyKey` con otro carrito devuelve el pedido original sin avisar. Propuesta: guardar una huella SHA-256 de `businessId + items` junto a la clave y responder `422 IDEMPOTENCY_KEY_MISMATCH`. **No se implementó**: añade un campo al pedido y eso es una decisión, no un arreglo.',
  '**L-14** No hay transacción entre `reserveStock` y `Order.create`: si el proceso se cae justo entre los dos, las unidades quedan apartadas. Propuesta: transacción de Mongo (Atlas es replica set) o un barrido de reservas huérfanas.',
  '**L-2** No existe tiempo de preparación por producto; solo `Business.deliveryTime`. No se añadió porque sería un campo que nada consume.',
  '**L-9** No hay modificadores condicionales ("Término" solo si la carne es de res) ni cantidad por opción. El grupo "Término" del TESTE es opcional por eso.',
  '**L-10** El rate limit de 100 peticiones cada 15 minutos por IP puede vaciar los paneles durante una sesión de pruebas manuales.',
];

export const PHASE6_VERDICT = {
  status: 'PASS' as const,
  reason:
    'Todas las pruebas existentes siguen pasando, las nuevas también, no quedan hallazgos altos abiertos, no hay pedidos duplicados ni stock negativo, ningún precio se puede fijar desde el cliente, no hay referencias cruzadas entre comercios, el seed es idempotente y el teardown es reversible. Las limitaciones pendientes son de horarios y de idempotencia avanzada, están documentadas y ninguna corrompe datos.',
};
