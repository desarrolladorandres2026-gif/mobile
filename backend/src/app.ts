import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import mongoose from 'mongoose';

import { config, connectDB } from './config';
import { errorHandler, securityHeaders, sanitizeRequest, requestId, perUserRateLimiter } from './middlewares';
import routes from './routes';
import businessShareRoutes from './routes/businessShare.routes';
import { initializeSocket } from './sockets';
import { setIO } from './sockets/emitter';
import { startDispatchSweeper, stopDispatchSweeper } from './services/dispatch.service';
import { startCartAbandonmentSweeper, stopCartAbandonmentSweeper } from './services/cartActivity.service';
import { startProRenewalSweeper, stopProRenewalSweeper } from './services/pro.service';
import { startPendingPaymentSweeper, stopPendingPaymentSweeper } from './services/payments';
import { startBackgroundRemovalSweeper, stopBackgroundRemovalSweeper } from './services/backgroundRemoval.service';
import { initCache, closeCache } from './cache';

const app = express();
const httpServer = createServer(app);

// ── Trust proxy for accurate IP detection ──
app.set('trust proxy', 1);

// ── Request ID tracking ──
app.use(requestId);

// ── Security headers (Helmet + custom) ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));
app.use(securityHeaders);

// ── CORS configuration ──
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (config.cors.origins.includes(origin) || config.nodeEnv === 'development') {
      return callback(null, true);
    }
    callback(new Error('No permitido por CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Device-ID'],
  exposedHeaders: ['X-Request-ID', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 86400,
}));

// ── Global rate limiting ──
// Per-endpoint limits (auth, OTP, sensitive operations) live with the auth
// routes in middlewares/security.ts. They used to be duplicated here too,
// which meant two limiters guarded the same endpoints with independent
// counters and only one of them honoured configuration — a confusing trap
// when a limit fired. This is now the single global limiter.
const globalLimiter = rateLimit({
  windowMs: config.security.rateLimit.windowMs,
  max: config.security.rateLimit.maxRequests,
  message: { success: false, message: 'Demasiadas peticiones. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
app.use('/api/', globalLimiter, perUserRateLimiter);

// ── Body parsing with size limits ──
//
// The raw body is captured verbatim for webhook routes. Gateway signatures
// are computed over the exact bytes sent, so re-serialising the parsed
// object would change key order or spacing and every signature check would
// fail. Kept to webhook paths only, to avoid doubling memory on uploads.
//
// Add a route here when a new gateway is mounted; the list is explicit so a
// webhook that silently loses its raw body fails loudly at review time
// instead of at signature-verification time in production.
const WEBHOOK_PATHS = new Set(['/api/v1/payments/webhook']);
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      // Matched on the exact path, not a substring: `includes('/webhook')`
      // also captured anything a future route happened to spell that way,
      // and quietly kept a full copy of every such body in memory.
      const requestPath = req.url?.split('?')[0];
      if (requestPath && WEBHOOK_PATHS.has(requestPath)) {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      }
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── NoSQL injection protection ──
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }: { req: any; key: string }) => {
    console.warn(`[SECURITY] NoSQL injection attempt in ${key} from IP: ${req.ip}`);
  },
}));

// ── HTTP Parameter Pollution protection ──
app.use(hpp());

// ── Custom input sanitization ──
app.use(sanitizeRequest);

// ── Compression ──
app.use(compression());

// ── Logging ── (silenced under test so the runner output stays readable)
if (config.nodeEnv === 'development') {
  app.use(morgan('dev'));
} else if (!config.isTest) {
  app.use(morgan(':remote-addr - :method :url :status :res[content-length] - :response-time ms'));
}

// ── Routes ──
app.use('/api/v1', routes);

// Fuera de `/api/v1`: es la URL corta que se comparte en WhatsApp, no un
// endpoint de la API. Vive fuera del alcance de `globalLimiter` (atado a
// `/api/`), así que lleva el mismo limitador a mano — sin él, esta ruta
// quedaría sin ningún tope de peticiones.
app.use('/negocio', globalLimiter, businessShareRoutes);

// ── Health check ──
app.get('/health', async (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
  const isHealthy = dbState === 1;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'OK' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: config.nodeEnv,
    uptime: Math.floor(process.uptime()),
    database: dbStatus,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
  });
});

// ── PWA (app/mobile exportada como sitio estático) ──
// `npm run build:pwa` copia mobile/dist aquí. En dev normalmente no existe
// -se usa `expo start --web` directo en el puerto 8081- así que si falta la
// carpeta simplemente no se registra nada, sin romper el arranque.
const pwaDir = path.join(__dirname, '../public/pwa');
if (fs.existsSync(pwaDir)) {
  // Lo que Expo exporta con hash en el nombre no cambia nunca: un año de
  // caché y sin revalidar. Antes cada carga de la PWA preguntaba por cada
  // archivo a Node. Lo demás (el HTML, el manifiesto) se revalida siempre.
  app.use(
    express.static(pwaDir, {
      index: false,
      setHeaders: (res, filePath) => {
        const hashed = /[\\/](_expo[\\/]static|assets)[\\/]/.test(filePath);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    })
  );

  // SPA fallback: cualquier GET que no sea /api ni /health y pida HTML
  // recibe el shell de la PWA; el router de expo-router decide la pantalla
  // en el cliente. Sin esto, refrescar la página en /orders daría 404.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health' || !req.accepts('html')) {
      return next();
    }
    res.sendFile(path.join(pwaDir, 'index.html'));
  });
} else if (config.nodeEnv !== 'test') {
  console.log('ℹ️  PWA no encontrada en public/pwa — corre "npm run build:pwa" para servirla.');
}

// ── 404 handler for API routes ──
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint no encontrado' });
});

// ── Error handler ──
app.use(errorHandler);

// ── Socket.IO ──
const io = initializeSocket(httpServer);
app.set('io', io);
setIO(io);

// Exported for integration tests, which drive the app with supertest and
// must not open a port or connect to a real database.
export default app;

// ── Start server ──
const start = async () => {
  await connectDB();

  const cacheKind = initCache();
  console.log(
    cacheKind === 'redis'
      ? '🧠 Caché de lecturas: Redis'
      : cacheKind === 'memory'
        ? '🧠 Caché de lecturas: en memoria (sin REDIS_URL)'
        : '🧠 Caché de lecturas: desactivada (CACHE_DISABLED)'
  );

  // Arranca aquí y no al importar el módulo: las pruebas de integración
  // cargan `app` con supertest y un intervalo de reparto suelto las
  // dejaría escribiendo en la base entre casos.
  startDispatchSweeper();
  startCartAbandonmentSweeper();
  startProRenewalSweeper();
  startPendingPaymentSweeper();
  startBackgroundRemovalSweeper();

  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`\n🚀 ZIPP API en puerto ${config.port}`);
    console.log(`📍 Entorno: ${config.nodeEnv}`);
    console.log(`🔗 http://localhost:${config.port}/health`);
    if (config.nodeEnv === 'development') {
      console.log(`📱 LAN: http://${config.localIP}:${config.port}/health`);
    }
    console.log(`🔒 Helmet, CORS, Rate Limiting, MongoSanitize, HPP activos`);
    console.log(`🛡️  Argon2id, RBAC, 2FA, Anti-Fraude, Auditoría activos\n`);
  });
};

// ── Graceful shutdown ──
const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Cerrando servidor...`);
  stopDispatchSweeper();
  stopCartAbandonmentSweeper();
  stopProRenewalSweeper();
  stopPendingPaymentSweeper();
  stopBackgroundRemovalSweeper();
  httpServer.close(async () => {
    await closeCache();
    try {
      await mongoose.connection.close();
      console.log('[Shutdown] Conexión MongoDB cerrada.');
    } catch (err) {
      console.error('[Shutdown] Error cerrando MongoDB:', err);
    }
    process.exit(0);
  });

  // Force shutdown if it takes too long
  setTimeout(() => {
    console.error('[Shutdown] Forzando cierre tras timeout.');
    process.exit(1);
  }, 10000);
};

if (!config.isTest) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });

  start().catch((err) => {
    console.error('Error fatal al iniciar:', err);
    process.exit(1);
  });
}

export { app, io, start };
