/**
 * Banco de pruebas de extremo a extremo: el servidor real (Fastify + MongoDB en memoria con
 * transacciones) y el frontend ya compilado, servidos desde un mismo origen como en producción.
 *
 *   :4100  interfaz estática + proxy de /v1 hacia la API
 *   :4101  API
 *
 * Solo para pruebas: añade `/__mail` (último correo enviado a una dirección) y `/__reset` (base limpia).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureIndexes } from '../backend/src/data/db.js';
import { buildApp } from '../backend/src/http/app.js';
import { loadConfig } from '../backend/src/http/config.js';
import { createMemoryMailer } from '../backend/src/mail/mailer.js';
import { startMongo } from '../backend/src/testing/mongo.js';

const WEB_PORT = 4100;
const API_PORT = 4101;
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const DIST = resolve(fileURLToPath(new URL('../frontend/dist', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const mongo = await startMongo('lulubiz_e2e');
const mailer = createMemoryMailer();

const config = loadConfig({});
config.allowedOrigins = [ORIGIN];
config.appBaseUrl = ORIGIN;
config.mfaEncryptionKey = Buffer.alloc(32, 11).toString('base64');
// Las pruebas inician sesión muchas veces desde la misma IP.
config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));

async function reset() {
  await mongo.db.dropDatabase();
  await ensureIndexes(mongo.db);
  mailer.sent.length = 0;
}
await reset();

const api = await buildApp({
  client: mongo.client,
  db: mongo.db,
  config,
  mailer,
  passwordParams: { N: 2 ** 10, r: 8, p: 1 },
  reporter: { report: async (err) => console.error('error no controlado en la API:', err) },
});
await api.listen({ port: API_PORT, host: '127.0.0.1' });

async function proxy(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = { ...req.headers, host: `127.0.0.1:${API_PORT}` };
  const upstream = await fetch(`http://127.0.0.1:${API_PORT}${req.url}`, {
    method: req.method,
    headers,
    ...(body.length ? { body: body.toString("utf8") } : {}),
    redirect: 'manual',
  });
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (!['content-length', 'transfer-encoding', 'connection', 'set-cookie', 'content-encoding'].includes(key)) res.setHeader(key, value);
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function serveStatic(req, res) {
  const path = normalize(decodeURIComponent(new URL(req.url, ORIGIN).pathname));
  let file = join(DIST, path);
  // Nada fuera de `dist`, y cualquier ruta sin archivo cae en index.html (aplicación de una sola página).
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/__mail') {
      const mail = mailer.last(url.searchParams.get('to'));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(mail));
    }
    if (url.pathname === '/__reset') {
      await reset();
      res.statusCode = 204;
      return res.end();
    }
    if (url.pathname.startsWith('/v1/') || url.pathname === '/healthz') return await proxy(req, res);
    return serveStatic(req, res);
  } catch (err) {
    console.error('error del banco de pruebas:', err);
    res.statusCode = 500;
    res.end('error del banco de pruebas');
  }
}).listen(WEB_PORT, '127.0.0.1', () => console.log(`banco de pruebas listo en ${ORIGIN}`));

const stop = async () => {
  await api.close();
  await mongo.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
