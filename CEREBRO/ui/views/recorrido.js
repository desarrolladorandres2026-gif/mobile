// «El viaje de un pedido»: la historia de una compra contada sin tecnicismos. Contenido escrito a mano a partir del
// código (order.service.ts, dispatch.service.ts, review.service.ts) y del README; cada paso nombra de dónde sale.
import { esc } from '../lib.js';

const ACTORES = {
  tu: { n: 'Tú (cliente)', c: 'var(--info)' },
  comercio: { n: 'Comercio', c: 'var(--gold)' },
  repartidor: { n: 'Repartidor', c: 'var(--ok)' },
  zipp: { n: 'ZIPP (automático)', c: '#B79CFF' },
};

// act = hace algo · ver = solo ve o recibe
const PASOS = [
  {
    corto: 'Pides', titulo: 'Armas la bolsa y pagas', estado: 'Pendiente',
    lanes: { tu: 'act', zipp: 'act' },
    pasa: 'Eliges comercio y productos y pulsas pedir. ZIPP vuelve a calcular el precio por su cuenta —nunca confía en lo que muestra la app— con productos + envío + propina − descuento. Revisa que el comercio esté abierto, que haya stock (y lo aparta) y que seas mayor de edad si hay productos +18. Pagas en línea o en efectivo al recibir.',
    ve: { tu: 'Un resumen con el total exacto y el estado «Pendiente».' },
    falla: 'Producto agotado, comercio cerrado o pago rechazado: el pedido no se crea y no se cobra nada.',
    fuente: 'OrderService.create · pricing.service.ts',
  },
  {
    corto: 'Acepta', titulo: 'El comercio acepta', estado: 'Aceptado',
    lanes: { comercio: 'act', zipp: 'act', tu: 'ver' },
    pasa: 'El pedido le suena al comercio en su panel (o en Zipp Negocios). Si pagaste en línea, no puede aceptarlo hasta que el pago esté confirmado. Al aceptar, ZIPP genera dos códigos secretos de un solo uso: uno para la recogida y otro para la entrega.',
    ve: { tu: 'Cambia a «Aceptado».' },
    falla: 'Si nadie responde: a los 10 minutos ZIPP avisa a operaciones y a los 15 cancela solo y te devuelve el dinero.',
    fuente: 'updateStatus (ACCEPTED) · cancelUnacceptedOrders',
  },
  {
    corto: 'Prepara', titulo: 'Lo preparan', estado: 'En preparación → Listo',
    lanes: { comercio: 'act', tu: 'ver' },
    pasa: 'El comercio marca «En preparación» y, cuando termina, «Listo». Marcar «Listo» es la señal que pone en marcha la búsqueda de repartidor.',
    ve: { tu: 'Ves el avance en la pantalla del pedido.', comercio: 'Ve el código de recogida mientras el pedido está Listo y sin recoger.' },
    falla: 'Hasta «Listo» el comercio puede cancelar; tú ya no, porque la cocina empezó. Si falta un producto, existe un proceso de faltantes.',
    fuente: 'updateStatus (PREPARING, READY) · itemShortage.service.ts',
  },
  {
    corto: 'Busca', titulo: 'ZIPP busca repartidor', estado: 'Listo',
    lanes: { zipp: 'act', repartidor: 'act' },
    pasa: 'ZIPP ofrece el pedido por rondas, de más cerca a más lejos. Ronda 1: al repartidor más cercano, 45 segundos para aceptar. Ronda 2: a los 3 mejores, 30 segundos. Ronda 3: a todos los disponibles, 20 segundos. Si nadie acepta, espera 30 segundos y vuelve a empezar; tras 3 vueltas completas avisa a un administrador (pero sigue buscando).',
    ve: { repartidor: 'Recibe la oferta con tiempo límite; el primero que acepta se queda el pedido.', tu: 'Sigues en «Listo» hasta que alguien lo toma.' },
    falla: 'Es un interruptor: la variable DISPATCH_ENABLED nace apagada y se enciende desde el panel (dispatch.cascade). Apagado, funciona como autoservicio: lo toma quien pulse primero. No he verificado cómo está en producción.',
    fuente: 'dispatch.service.ts (ROUNDS, CYCLE_PAUSE_MS, CYCLES_BEFORE_ALERT)',
  },
  {
    corto: 'Recoge', titulo: 'El repartidor recoge', estado: 'Recogido',
    lanes: { repartidor: 'act', comercio: 'act' },
    pasa: 'El repartidor llega al comercio y lo marca. Toma una foto de lo que recibe. Entonces el comercio le dicta el código de recogida y él lo teclea. Solo con el código válido el pedido pasa a «Recogido».',
    ve: { repartidor: 'No ve el código: lo tiene que dictar el comercio. Así teclearlo prueba que estuvo ahí.', tu: 'Ves que ya fue recogido.' },
    falla: 'Código ya usado o equivocado: no avanza. Solo un administrador puede saltárselo y queda registrado como actividad sospechosa.',
    fuente: 'README «El traspaso del pedido» · pickup/arrive, evidence, verify',
  },
  {
    corto: 'En camino', titulo: 'Va hacia ti', estado: 'En camino',
    lanes: { repartidor: 'act', tu: 'ver' },
    pasa: 'El repartidor pulsa «En camino». Su posición viaja en vivo y la ves moverse en el mapa. En este momento ZIPP te muestra tu código de entrega (solo ahora, nunca antes).',
    ve: { tu: 'Mapa en vivo y tu código de entrega. No lo compartas hasta tener el pedido en la mano.', comercio: 'Ve que ya salió.' },
    falla: 'Si algo grave pasa en la calle, solo soporte o un administrador puede cancelar en este punto: el comercio ya no puede.',
    fuente: 'Seguimiento en vivo (README) · BUSINESS_CANCELLABLE_STATUSES',
  },
  {
    corto: 'Entrega', titulo: 'Te lo entrega', estado: 'Entregado',
    lanes: { repartidor: 'act', tu: 'act' },
    pasa: 'El repartidor llega, toma una foto de la entrega y tú le dictas tu código. Él lo teclea y el pedido pasa a «Entregado». La foto va antes que el código a propósito, para que nadie cierre la entrega y «suba la foto después».',
    ve: { tu: 'Estado «Entregado» y la opción de calificar.', repartidor: 'Pasa a disponible otra vez.' },
    falla: 'Sin código válido no hay «Entregado». Si pagabas en efectivo, aquí se cobra en la puerta.',
    fuente: 'delivery/arrive, evidence, verify · updateStatus (DELIVERED)',
  },
  {
    corto: 'Cierre', titulo: 'ZIPP reparte el dinero', estado: 'Entregado (cerrado)',
    lanes: { zipp: 'act', comercio: 'ver', repartidor: 'ver', tu: 'ver' },
    pasa: 'Al entregarse, ZIPP calcula la comisión de la plataforma, lo que le toca al comercio y lo que gana el repartidor, y lo anota en el libro contable. El comercio lo cobra en su liquidación semanal (Bogotá). La ganancia del repartidor se acumula. Si fue en efectivo, el repartidor queda debiendo ese dinero y se abre una conciliación.',
    ve: { comercio: 'La venta entra en «Liquidaciones» menos comisión y descuentos que asumió.', repartidor: 'Suma una entrega y sus ganancias; si cobró en efectivo, actualiza su fondo.', tu: 'Puedes calificar el pedido (solo se puede si está Entregado).' },
    falla: 'Hallazgos abiertos sobre esta etapa: M-003 (si falla el cierre, el repartidor puede quedar ocupado y el fondo sin devolver). Ver pestaña Hallazgos.',
    fuente: 'OrderService.onDelivered · payoutService.accrueForOrder · ledger.service.ts · review.service.ts',
  },
];

const CANCELACION = [
  ['Tú', 'Hasta que el comercio acepta (Pendiente y Aceptado). Después de que empiezan a preparar, ya no.'],
  ['Comercio', 'Hasta que está Listo. En camino ya no puede: lo resuelve soporte.'],
  ['Administrador', 'Casi en cualquier momento, incluso En camino. Es el único que puede forzar un cierre.'],
  ['ZIPP solo', 'Pedidos en línea abandonados sin pagar, y pedidos que el comercio no acepta en 15 minutos.'],
  ['Nadie', 'Entre Recogido y En camino no hay cancelación posible, ni para un administrador. Entregado y Cancelado son finales.'],
];

const lane = (k) => `<span class="rc-who" style="--c:${ACTORES[k].c}">${esc(ACTORES[k].n)}</span>`;

function tira() {
  const cols = PASOS.length;
  const head = PASOS.map((p, i) => `<button type="button" class="rc-h" data-i="${i}"><b>${i + 1}</b>${esc(p.corto)}</button>`).join('');
  const rows = Object.keys(ACTORES).map((k) => `<div class="rc-lane" style="--c:${ACTORES[k].c}"><span class="rc-ln">${esc(ACTORES[k].n)}</span>${PASOS.map((p) => `<span class="rc-cell">${p.lanes[k] ? `<i class="rc-dot ${p.lanes[k]}"></i>` : ''}</span>`).join('')}</div>`).join('');
  return `<div class="rc-strip" style="--cols:${cols}"><div class="rc-lane rc-heads"><span class="rc-ln"></span>${head}</div>${rows}</div>
  <p class="small muted2" style="margin-top:8px"><i class="rc-dot act"></i> hace algo &nbsp; <i class="rc-dot ver"></i> ve o recibe &nbsp;·&nbsp; pulsa un paso para ir a su detalle</p>`;
}

function paso(p, i) {
  const quien = Object.keys(p.lanes).filter((k) => p.lanes[k] === 'act').map(lane).join(' ');
  const ve = Object.entries(p.ve).map(([k, t]) => `<div class="rc-ve">${lane(k)} <span>${esc(t)}</span></div>`).join('');
  return `<div class="step rc-step" id="rc-${i}">
    <div class="step-h"><span class="step-k">Paso ${i + 1}</span><span class="step-t">${esc(p.titulo)}</span><span class="tag gold">Estado: ${esc(p.estado)}</span></div>
    <div class="rc-quien small">${quien}</div>
    <div class="step-d">${esc(p.pasa)}</div>
    <div class="rc-ves">${ve}</div>
    <div class="note warn small" style="margin-top:6px"><b>Si algo falla:</b> ${esc(p.falla)}</div>
    <div class="small muted2" style="margin-top:4px">Sale de: ${esc(p.fuente)}</div>
  </div>`;
}

export default async function render(el) {
  el.innerHTML = `
  <div class="page-head"><h1>El viaje de un pedido</h1>
    <p class="lede">Lo que pasa desde que alguien compra hasta que el dinero queda repartido, contado paso a paso. Cuatro participantes: tú que compras, el comercio que prepara, el repartidor que lleva y ZIPP que vigila y hace las cuentas solo.</p></div>
  ${tira()}
  <div class="section"><h2>Paso a paso</h2><div class="trace">${PASOS.map(paso).join('')}</div></div>
  <div class="section"><h2>Los dos candados</h2>
    <p class="lede">El pedido cambia de manos dos veces, y cada una exige un código secreto más una foto. Es lo que impide que alguien declare «ya entregué» desde el sofá.</p>
    <div class="rc-codes">
      <div><b>Código de recogida</b><span>Lo ve el comercio. Se lo dicta al repartidor cuando le entrega el pedido.</span></div>
      <div><b>Código de entrega</b><span>Lo ves tú, solo cuando va en camino. Se lo dictas al repartidor al recibir.</span></div>
    </div>
    <p class="small muted2" style="margin-top:8px">El repartidor y el administrador nunca ven los códigos, y las notificaciones tampoco los llevan.</p></div>
  <div class="section"><h2>Y si se cancela</h2>
    <div class="twrap"><table><thead><tr><th>Quién</th><th>Hasta cuándo puede cancelar</th></tr></thead><tbody>${CANCELACION.map(([q, t]) => `<tr><td><b>${esc(q)}</b></td><td>${esc(t)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted2" style="margin-top:8px">Al cancelar, ZIPP devuelve el stock y el cupón y, si ya habías pagado, pide el reembolso completo de forma automática. El estado, la hora y quién canceló quedan guardados en el pedido.</p></div>
  <div class="section"><h2>Qué tan seguro es esto</h2>
    <p class="small muted2">Hecho confirmado: los estados, quién puede mover cada uno, los tiempos de la cascada y el reparto del dinero salen del código leído el 2026-10-16. Pendiente de verificar: si la cascada de repartidores está encendida en producción, y los costos de Wompi dentro del reparto del dinero (hallazgo M-006). Para ver la máquina de estados exacta, usa «Pedidos y estados».</p></div>`;
  el.querySelector('.rc-strip')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('.rc-h');
    if (b) el.querySelector(`#rc-${b.dataset.i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
