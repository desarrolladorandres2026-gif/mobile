/**
 * Recorre, contra el servidor real (no la base directamente), cada función
 * que "Carnes Sofia" tiene disponible como comercio: perfil, catálogo,
 * pedidos, liquidación — y cierra con una campaña de publicidad pagada
 * (el flyer de carga) gestionada por un admin en su nombre, que es como
 * funciona de verdad esa función (ver advertisement.routes.ts: solo admin).
 *
 * Va por HTTP y no por Mongoose a propósito: así pasa por los mismos
 * validadores, autorizaciones y reglas de negocio que un comercio real
 * usaría, en vez de solo dejar filas en la base.
 *
 * Requiere el backend corriendo en local (`npm run dev`).
 */

const BASE = 'http://localhost:3000/api/v1';

const CREDENTIALS = {
  admin: { phone: '3001234567', password: 'Zipp.2026' },
  owner: { phone: '3171234567', password: 'Zipp.2026' },
  client: { phone: '3101234567', password: 'Zipp.2026' },
};

// Un par de km al norte de las coordenadas del negocio, para que el pedido
// tenga una distancia de reparto real y no un cuadro de 0 metros.
const DELIVERY = { lat: 2.212, lng: -75.615 };

let step = 0;
function log(msg: string) {
  step += 1;
  console.log(`\n[${String(step).padStart(2, '0')}] ${msg}`);
}

async function api<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let bodyInit: any;
  if (opts.form) {
    bodyInit = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(opts.body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyInit });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${json.message ?? res.statusText}\n${JSON.stringify(json.errors ?? '')}`);
  }
  return json as T;
}

async function login(creds: { phone: string; password: string }): Promise<{ token: string; userId: string }> {
  const res = await api('POST', '/auth/login', { body: creds });
  return { token: res.data.accessToken, userId: res.data.user._id };
}

async function main() {
  // ── 0. Autenticación de los tres actores ──
  log('Iniciando sesión como admin, dueño del comercio y cliente de prueba');
  const admin = await login(CREDENTIALS.admin);
  const owner = await login(CREDENTIALS.owner);
  const client = await login(CREDENTIALS.client);
  console.log('    admin  →', admin.userId);
  console.log('    dueño  →', owner.userId);
  console.log('    cliente→', client.userId);

  // ── 1. El dueño ve sus comercios ──
  log('Comercio: "Mis negocios"');
  const mine = await api('GET', '/businesses/my/businesses', { token: owner.token });
  const business = mine.data.find((b: any) => b.name === 'Carnes Sofia');
  if (!business) throw new Error('No aparece Carnes Sofia en "mis negocios" del dueño');
  const businessId = business._id;
  console.log(`    ${business.name} — ${business.slug} — aprobado:${business.isApproved} activo:${business.isActive}`);

  // ── 2. El dueño actualiza el perfil del comercio ──
  log('Comercio: actualizar perfil (descripción, tiempo de entrega y pedido mínimo)');
  const updated = await api('PUT', `/businesses/${businessId}`, {
    token: owner.token,
    body: {
      description: 'Carnicería de barrio: cortes frescos de res, cerdo y pollo, y embutidos. Ahora con domicilio.',
      deliveryTime: 20,
      minOrder: 15000,
    },
  });
  console.log(`    minOrder ahora: ${updated.data.minOrder} — tiempo de entrega: ${updated.data.deliveryTime} min`);

  // ── 3. Catálogo: categorías y productos, como los ve el propio panel ──
  log('Comercio: catálogo (categorías y productos)');
  const categories = await api('GET', `/categories/business/${businessId}`, { token: owner.token });
  const products = await api('GET', `/products/business/${businessId}`, { token: owner.token });
  console.log(`    ${categories.data.length} categorías, ${products.data.length} productos`);
  const firstProduct = products.data[0];

  // ── 4. Opciones de imagen del producto (sin volver a subir el archivo) ──
  if (firstProduct?.imageAsset) {
    log(`Comercio: ajustar mejora automática de "${firstProduct.name}"`);
    await api('PATCH', `/products/${firstProduct._id}/image`, {
      token: owner.token,
      body: { businessId, enhance: false },
    });
    await api('PATCH', `/products/${firstProduct._id}/image`, {
      token: owner.token,
      body: { businessId, enhance: true },
    });
    console.log('    mejora desactivada y reactivada — variantes recalculadas sin re-subir el archivo');
  }

  // ── 5. Estado de cuenta (lo que ZIPP le debe al comercio) ──
  log('Comercio: estado de cuenta');
  const statement = await api('GET', `/businesses/${businessId}/statement`, { token: owner.token });
  console.log('    ', JSON.stringify(statement.data));
  const statementLines = await api('GET', `/businesses/${businessId}/statement/lines`, { token: owner.token });
  console.log(`    ${statementLines.data.length ?? 0} líneas de liquidación (comercio nuevo, se espera 0)`);

  // ── 6. Pedidos del comercio, antes de que exista ninguno ──
  log('Comercio: pedidos (antes de la compra)');
  const ordersBefore = await api('GET', `/orders/business/${businessId}`, { token: owner.token });
  console.log(`    ${ordersBefore.data.length} pedidos existentes`);

  // ── 7. Pago contra entrega está desactivado en la config vigente ──
  //
  // El pedido de prueba lo paga en efectivo el domiciliario al cliente, así
  // que hace falta esa opción encendida. Es config global del admin, no de
  // este comercio, así que se guarda el valor original para devolverlo tal
  // como estaba al terminar — este ejercicio no debe dejar el pago contra
  // entrega prendido para el resto de la plataforma si no lo estaba.
  log('Admin: revisar configuración de pago contra entrega');
  const configBefore = await api('GET', '/finance/config', { token: admin.token });
  const codWasEnabled = configBefore.data.cashOnDeliveryEnabled;
  console.log(`    cashOnDeliveryEnabled actualmente: ${codWasEnabled}`);
  if (!codWasEnabled) {
    await api('PUT', '/finance/config', {
      token: admin.token,
      body: { cashOnDeliveryEnabled: true, reason: 'Habilitar temporalmente para probar el flujo de compra de Carnes Sofia' },
    });
    console.log('    habilitado temporalmente para esta prueba');
  }

  // ── 8. El cliente cotiza el pedido ──
  const cartProducts = products.data.slice(0, 3);
  const items = cartProducts.map((p: any) => ({ productId: p._id, quantity: 1 }));
  log(`Cliente: cotizar carrito (${cartProducts.map((p: any) => p.name).join(', ')})`);
  const quote = await api('POST', '/orders/quote', {
    token: client.token,
    body: {
      businessId,
      items,
      paymentMethod: 'cash_on_delivery',
      deliveryLongitude: DELIVERY.lng,
      deliveryLatitude: DELIVERY.lat,
    },
  });
  console.log(`    subtotal: ${quote.data.subtotal} — envío: ${quote.data.deliveryFee} — total: ${quote.data.total}`);

  // ── 9. El cliente hace el pedido de verdad ──
  log('Cliente: crear el pedido');
  const order = await api('POST', '/orders', {
    token: client.token,
    body: {
      businessId,
      items,
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Carrera 5 # 12-34, Garzón',
      deliveryDetails: 'Casa de dos pisos, portón verde',
      deliveryLongitude: DELIVERY.lng,
      deliveryLatitude: DELIVERY.lat,
      notes: 'Pedido de prueba end-to-end',
    },
  });
  const orderId = order.data._id;
  console.log(`    pedido ${order.data.orderNumber} creado — total: ${order.data.total} — estado: ${order.data.status}`);

  // ── 10. El comercio ve el pedido entrar y lo mueve por su parte del flujo ──
  log('Comercio: aceptar → preparar → listo para recoger');
  for (const status of ['accepted', 'preparing', 'ready'] as const) {
    const res = await api('PATCH', `/orders/${orderId}/status`, { token: owner.token, body: { status } });
    console.log(`    → ${res.data.status}`);
  }

  const ordersAfter = await api('GET', `/orders/business/${businessId}`, { token: owner.token });
  console.log(`    el comercio ahora tiene ${ordersAfter.data.length} pedido(s) en su panel`);

  if (!codWasEnabled) {
    await api('PUT', '/finance/config', {
      token: admin.token,
      body: { cashOnDeliveryEnabled: false, reason: 'Revertir tras la prueba del flujo de compra de Carnes Sofia' },
    });
    console.log('    cashOnDeliveryEnabled devuelto a como estaba (desactivado)');
  }

  // ── 10. Publicidad pagada: el flyer de carga, gestionado por ZIPP ──
  //
  // No es autoservicio — advertisement.routes.ts solo deja crear campañas a
  // un admin — así que aquí se simula lo que pasaría de verdad: el comercio
  // paga, y el equipo de ZIPP monta la campaña a su nombre.
  log('Admin: subir el flyer publicitario de Carnes Sofia');
  const flyerPhoto = await fetch('https://loremflickr.com/1080/1350/butchershop,meat,sale');
  if (!flyerPhoto.ok) throw new Error(`No se pudo descargar la foto del flyer: ${flyerPhoto.status}`);
  const flyerBuffer = Buffer.from(await flyerPhoto.arrayBuffer());

  const form = new FormData();
  form.append('flyer', new Blob([flyerBuffer], { type: 'image/jpeg' }), 'carnes-sofia-flyer.jpg');
  const uploadRes = await api<{ data: { url: string } }>('POST', '/advertisements/upload', {
    token: admin.token,
    form,
  });
  console.log(`    flyer subido: ${uploadRes.data.url}`);

  log('Admin: crear la campaña pagada (flyer de carga al abrir la app)');
  const startDate = new Date();
  const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const campaign = await api('POST', '/advertisements', {
    token: admin.token,
    body: {
      campaignName: 'Carnes Sofia — Apertura',
      advertiserName: 'Carnes Sofia',
      flyerUrl: uploadRes.data.url,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      isActive: true,
      priority: 10,
      actionType: 'business',
      businessId,
      maxImpressions: 0,
      durationSeconds: 6,
      pricePaid: 150000,
      internalNotes: 'Campaña de prueba: comercio paga por aparecer en el flyer de carga.',
    },
  });
  console.log(`    campaña "${campaign.data.campaignName}" creada — id ${campaign.data._id} — $${campaign.data.pricePaid} pagados`);

  log('Verificación: la app pediría esto al abrir');
  const active = await api('GET', '/advertisements/active');
  console.log(`    activa: ${active.data?.campaignName ?? 'ninguna'} (${active.data?.advertiserName ?? '—'})`);

  console.log('\n✅ Ejercicio completo: perfil, catálogo, pedido de compra, liquidación y publicidad pagada.');
}

main().catch((err) => {
  console.error('\n❌ Falló el ejercicio:', err.message);
  process.exit(1);
});
