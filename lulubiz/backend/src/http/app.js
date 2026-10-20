import { createHash, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { createAccountService } from '../accounts/accounts.js';
import { createAuditService } from '../audit/audit.js';
import { createAuthService } from '../auth/auth.js';
import { parseKey } from '../auth/secretbox.js';
import { COUNTRY_PACKS } from '../countries/index.js';
import { COLLECTIONS } from '../data/db.js';
import { MODULE_DOC_TYPES, createLedger } from '../ledger/ledger.js';
import { createLogMailer, createSmtpMailer } from '../mail/mailer.js';
import { combineReporters, createLogReporter, createWebhookReporter } from '../observability/errorReporter.js';
import { createPartyService } from '../parties/parties.js';
import { createPayablesService } from '../purchases/payables.js';
import { createPurchasesService } from '../purchases/purchases.js';
import { createReceivablesService } from '../receivables/receivables.js';
import { createInventoryService } from '../inventory/inventory.js';
import { createReportService } from '../reports/reports.js';
import { errorHandler } from './errors.js';
import { createMetrics } from './metrics.js';
import { creditNoteReasonsFor, vatRatesFor } from '../countries/index.js';
import { createInvoicingService } from '../invoicing/invoices.js';
import { createSandboxProvider } from '../invoicing/provider.js';
import { createResolutionService } from '../invoicing/resolutions.js';
import { createSettingsService } from '../invoicing/settings.js';

const sha256 = (text) => createHash('sha256').update(text).digest();

const OBJECT_ID = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const money53 = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const DAY = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' };
const PERIOD = { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' };
const TOKEN = { type: 'string', minLength: 43, maxLength: 43 };
const tenantParams = { type: 'object', required: ['tenantId'], properties: { tenantId: OBJECT_ID } };
const idParams = { type: 'object', required: ['tenantId', 'id'], properties: { tenantId: OBJECT_ID, id: OBJECT_ID } };
const memberParams = { type: 'object', required: ['tenantId', 'userId'], properties: { tenantId: OBJECT_ID, userId: OBJECT_ID } };
const periodParams = { type: 'object', required: ['tenantId', 'period'], properties: { tenantId: OBJECT_ID, period: PERIOD } };
const idempotencyHeader = {
  type: 'object',
  required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128 } },
};
const money = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const pageQuery = {
  limit: { type: 'string', pattern: '^[0-9]{1,4}$' },
  cursor: OBJECT_ID,
};
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const bodyOf = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const NOT_FOUND = { error: 'NOT_FOUND', message: 'ruta no encontrada' };

/**
 * Construye la aplicación HTTP. No abre puertos: `app.inject` permite probarla entera sin red.
 * Las dependencias externas (`mailer`, `reporter`, `now`, `passwordParams`) se pueden inyectar
 * para pruebas; sin ellas se arman desde la configuración.
 */
export async function buildApp({ client, db, config, logger = false, passwordParams, mailer, reporter, now, invoicingProvider }) {
  const app = Fastify({
    logger: logger
      ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] }
      : false,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Sin coerción: un importe "100" como texto es un error, no un 100.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  });

  const resolvedMailer =
    mailer ?? (config.smtpUrl ? createSmtpMailer({ url: config.smtpUrl, from: config.mailFrom }) : createLogMailer(app.log));
  const resolvedReporter =
    reporter ??
    combineReporters(
      createLogReporter(app.log),
      ...(config.errorWebhookUrl
        ? [createWebhookReporter({ url: config.errorWebhookUrl, environment: config.production ? 'production' : 'development' })]
        : []),
    );
  app.decorate('reporter', resolvedReporter);

  const auth = createAuthService(client, db, {
    ...(passwordParams ? { passwordParams } : {}),
    ...(now ? { now } : {}),
    mailer: resolvedMailer,
    appBaseUrl: config.appBaseUrl,
    mfaKey: config.mfaEncryptionKey ? parseKey(config.mfaEncryptionKey) : null,
    onMailError: (err, info) => app.log.error({ err, subject: info.subject }, 'no se pudo enviar el correo'),
  });
  const accounts = createAccountService(client, db);
  const parties = createPartyService(client, db);
  const ledger = createLedger(client, db);
  const auditLog = createAuditService(db);
  const reports = createReportService(db, accounts);
  const metrics = createMetrics();
  const settingsService = createSettingsService(client, db, accounts);
  const resolutionService = createResolutionService(client, db);
  const provider = invoicingProvider !== undefined ? invoicingProvider : config.invoicingProvider === 'sandbox' ? createSandboxProvider() : null;
  const invoicing = createInvoicingService({ client, db, ledger, accounts, parties, settings: settingsService, resolutions: resolutionService, provider });
  const receivables = createReceivablesService({ client, db, ledger, accounts, parties });
  const inventory = createInventoryService({ client, db, ledger, accounts });
  const purchases = createPurchasesService({ client, db, ledger, accounts, parties, settings: settingsService, inventory });
  const payables = createPayablesService({ db, ledger, accounts, parties });

  /** Contexto de una operación de facturación: la clave de idempotencia, quién la hace y cómo auditar dentro de su transacción. */
  const invoicingContext = (request) => ({
    idempotencyKey: request.headers['idempotency-key'],
    userId: request.ctx.userId,
    auditTx: (session, event) =>
      auditLog.record(
        { tenantId: request.ctx.tenantId, userId: request.ctx.userId, ip: request.ip, requestId: request.id, ...event },
        { session },
      ),
  });
  const outcomeStatus = (result) => (result.replayed ? 200 : result.pending ? 202 : 201);

  /**
   * Devuelve la función `inTx` que registra el evento de auditoría con la sesión de la transacción
   * de la operación: ambas se confirman juntas o ninguna. `pick(resultado)` aporta el objetivo y detalles.
   */
  const tx = (request, action, pick = () => ({})) => async (session, result) => {
    await auditLog.record(
      {
        tenantId: request.ctx?.tenantId ?? null,
        userId: request.ctx?.userId ?? null,
        action,
        ip: request.ip,
        requestId: request.id,
        ...(pick(result) ?? {}),
      },
      { session },
    );
  };

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => reply.status(404).send(NOT_FOUND));

  app.addHook('onResponse', async (request, reply) => {
    // Patrón de ruta, no URL real: evita una serie nueva por cada empresa o documento.
    metrics.observe(request.method, request.routeOptions?.url ?? 'sin-ruta', reply.statusCode, reply.elapsedTime / 1000);
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: true, ...config.rateLimit.global });

  // Solo JSON: quitar text/plain impide el POST "simple" entre sitios que evita la comprobación previa del navegador.
  app.removeContentTypeParser('text/plain');

  // Defensa contra CSRF además de la cookie SameSite=Strict: un Origin presente debe estar permitido.
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    const { origin } = request.headers;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return reply.status(403).send({ error: 'FORBIDDEN_ORIGIN', message: 'origen no permitido' });
    }
  });

  // Nada de la API se guarda en cachés compartidas ni del navegador: son datos de una sesión.
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
  });

  const guard = (permission) => async (request) => {
    request.ctx = await auth.authorize(
      request.cookies[config.cookieName],
      new ObjectId(request.params.tenantId),
      permission,
    );
    // Desde aquí, cada línea del log de esta petición lleva la empresa y el usuario.
    request.log = request.log.child({ tenantId: String(request.ctx.tenantId), userId: String(request.ctx.userId) });
  };

  /** Exige una sesión válida, sin empresa: para operaciones sobre la propia cuenta. */
  const session = async (request) => {
    request.ctx = await auth.verifySession(request.cookies[config.cookieName]);
  };

  const optionalSessionUser = async (request) => {
    const token = request.cookies[config.cookieName];
    if (!token) return undefined;
    try {
      return (await auth.verifySession(token)).userId;
    } catch {
      return undefined;
    }
  };

  const setSessionCookie = (reply, { token, expiresAt }) =>
    reply.setCookie(config.cookieName, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    });

  // ================================================================ estado del servicio
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (request, reply) => {
    try {
      await db.command({ ping: 1 });
      return { status: 'ready' };
    } catch (err) {
      request.log.error({ err }, 'base de datos no disponible');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/metrics', async (request, reply) => {
    if (!config.metricsToken) return reply.status(404).send(NOT_FOUND);
    const sent = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!timingSafeEqual(sha256(sent), sha256(config.metricsToken))) {
      return reply.status(401).send({ error: 'INVALID_SESSION', message: 'token de métricas inválido' });
    }
    return reply.type('text/plain; version=0.0.4').send(metrics.render());
  });

  // ================================================================ cuenta y sesión
  app.post(
    '/v1/auth/register',
    {
      config: { rateLimit: config.rateLimit.register },
      schema: {
        body: bodyOf(
          {
            companyName: { type: 'string', maxLength: 200 },
            country: { type: 'string', minLength: 2, maxLength: 2 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            ownerName: { type: 'string', maxLength: 200 },
            email: { type: 'string', maxLength: 254 },
            password: { type: 'string', maxLength: 128 },
          },
          ['companyName', 'country', 'currency', 'email', 'password'],
        ),
      },
    },
    async (request, reply) => {
      const { tenantId, userId } = await auth.registerTenant(request.body, {
        inTx: tx(request, 'tenant.register', (r) => ({ tenantId: r.tenantId, userId: r.userId, target: r.tenantId })),
      });
      return reply.status(201).send({ tenantId, userId });
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: { rateLimit: config.rateLimit.login },
      schema: { body: bodyOf({ email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 128 } }, ['email', 'password']) },
    },
    async (request, reply) => {
      let result;
      try {
        result = await auth.login(request.body.email, request.body.password, {
          inTx: tx(request, 'auth.login', (r) => ({ userId: r.userId })),
        });
      } catch (err) {
        if (err?.code === 'INVALID_CREDENTIALS') {
          // No acompaña a ninguna escritura: se anota suelto, y si falla solo queda en el log.
          await auditLog
            .record({
              action: 'auth.login_failed',
              ip: request.ip,
              requestId: request.id,
              details: { email: String(request.body.email).trim().toLowerCase() },
            })
            .catch((e) => request.log.error({ err: e }, 'no se pudo anotar el inicio de sesión fallido'));
        }
        throw err;
      }
      if (result.mfaRequired) return { mfaRequired: true, challenge: result.challenge };
      setSessionCookie(reply, result);
      return { userId: result.userId, memberships: await auth.listMemberships(result.userId) };
    },
  );

  app.post(
    '/v1/auth/mfa/verify',
    {
      config: { rateLimit: config.rateLimit.mfa },
      schema: { body: bodyOf({ challenge: TOKEN, code: { type: 'string', maxLength: 32 } }, ['challenge', 'code']) },
    },
    async (request, reply) => {
      const result = await auth.verifyMfaLogin(request.body.challenge, request.body.code, {
        inTx: tx(request, 'auth.login', (r) => ({ userId: r.userId, details: { mfa: true, recoveryCode: r.usedRecoveryCode } })),
      });
      setSessionCookie(reply, result);
      return { userId: result.userId, memberships: await auth.listMemberships(result.userId), usedRecoveryCode: result.usedRecoveryCode };
    },
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies[config.cookieName]);
    reply.clearCookie(config.cookieName, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/v1/me', { preValidation: session }, async (request) => ({
    account: await auth.getAccount(request.ctx.userId),
    memberships: await auth.listMemberships(request.ctx.userId),
  }));

  // ---- Verificación de correo ----
  app.post(
    '/v1/auth/verify-email',
    { config: { rateLimit: config.rateLimit.token }, schema: { body: bodyOf({ token: TOKEN }, ['token']) } },
    async (request, reply) => {
      await auth.verifyEmail(request.body.token, { inTx: tx(request, 'auth.email_verified', (r) => ({ userId: r.userId })) });
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/resend-verification',
    { preValidation: session, config: { rateLimit: config.rateLimit.passwordReset } },
    async (request) => auth.resendVerification(request.ctx.userId),
  );

  // ---- Recuperación de contraseña ----
  app.post(
    '/v1/auth/password/forgot',
    {
      config: { rateLimit: config.rateLimit.passwordReset },
      schema: { body: bodyOf({ email: { type: 'string', maxLength: 254 } }, ['email']) },
    },
    async (request, reply) => reply.status(202).send(await auth.requestPasswordReset(request.body.email)),
  );

  app.post(
    '/v1/auth/password/reset',
    {
      config: { rateLimit: config.rateLimit.token },
      schema: { body: bodyOf({ token: TOKEN, password: { type: 'string', maxLength: 128 } }, ['token', 'password']) },
    },
    async (request, reply) => {
      await auth.resetPassword(request.body.token, request.body.password, {
        inTx: tx(request, 'auth.password_reset', (r) => ({ userId: r.userId })),
      });
      reply.clearCookie(config.cookieName, { path: '/' });
      return reply.status(204).send();
    },
  );

  // ---- Verificación en dos pasos ----
  const withCode = bodyOf({ password: { type: 'string', maxLength: 128 }, code: { type: 'string', maxLength: 32 } }, ['password', 'code']);

  app.post('/v1/auth/mfa/enroll', { preValidation: session, config: { rateLimit: config.rateLimit.mfa } }, async (request) =>
    auth.startMfaEnrollment(request.ctx.userId),
  );

  app.post(
    '/v1/auth/mfa/confirm',
    {
      preValidation: session,
      config: { rateLimit: config.rateLimit.mfa },
      schema: { body: bodyOf({ code: { type: 'string', maxLength: 32 } }, ['code']) },
    },
    async (request) =>
      auth.confirmMfaEnrollment(request.ctx.userId, request.body.code, { inTx: tx(request, 'auth.mfa_enabled', (r) => ({ userId: r.userId })) }),
  );

  app.post(
    '/v1/auth/mfa/disable',
    { preValidation: session, config: { rateLimit: config.rateLimit.mfa }, schema: { body: withCode } },
    async (request, reply) => {
      await auth.disableMfa(request.ctx.userId, request.body, { inTx: tx(request, 'auth.mfa_disabled', (r) => ({ userId: r.userId })) });
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/mfa/recovery-codes',
    { preValidation: session, config: { rateLimit: config.rateLimit.mfa }, schema: { body: withCode } },
    async (request) =>
      auth.regenerateRecoveryCodes(request.ctx.userId, request.body, { inTx: tx(request, 'auth.recovery_codes_regenerated', (r) => ({ userId: r.userId })) }),
  );

  // ---- Invitaciones (las abre quien recibe el enlace, con o sin cuenta) ----
  app.post(
    '/v1/invitations/lookup',
    { config: { rateLimit: config.rateLimit.token }, schema: { body: bodyOf({ token: TOKEN }, ['token']) } },
    async (request) => auth.getInvitation(request.body.token),
  );

  app.post(
    '/v1/invitations/accept',
    {
      config: { rateLimit: config.rateLimit.token },
      schema: {
        body: bodyOf({ token: TOKEN, name: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 128 } }, ['token']),
      },
    },
    async (request, reply) => {
      const sessionUserId = await optionalSessionUser(request);
      const result = await auth.acceptInvitation(
        request.body.token,
        { sessionUserId, name: request.body.name, password: request.body.password },
        {
          inTx: tx(request, 'member.accept_invitation', (r) => ({ tenantId: r.tenantId, userId: r.userId, target: r.userId, details: { role: r.role, createdAccount: r.createdAccount } })),
        },
      );
      return reply.status(201).send(result);
    },
  );

  // ================================================================ rutas de empresa
  const base = '/v1/tenants/:tenantId';

  // ---- Plan de cuentas ----
  const accountsQuery = {
    type: 'object',
    properties: {
      parentCode: { type: 'string', pattern: '^[0-9]{1,12}$' },
      activeOnly: { type: 'string', enum: ['true', 'false'] },
    },
  };

  app.get(`${base}/accounts`, { preValidation: guard('accounts:read'), schema: { params: tenantParams, querystring: accountsQuery } }, async (request) => ({
    items: await accounts.list(request.ctx.tenantId, {
      activeOnly: request.query.activeOnly === 'true',
      ...(request.query.parentCode ? { parentCode: request.query.parentCode } : {}),
    }),
  }));

  app.post(
    `${base}/accounts`,
    {
      preValidation: guard('accounts:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            code: { type: 'string', maxLength: 12 },
            name: { type: 'string', maxLength: 200 },
            type: { type: 'string', maxLength: 20 },
            nature: { type: 'string', maxLength: 10 },
            parentCode: { type: 'string', maxLength: 12 },
            postable: { type: 'boolean' },
          },
          ['code', 'name', 'type'],
        ),
      },
    },
    async (request, reply) => {
      const account = await accounts.create(request.ctx.tenantId, request.body, {
        inTx: tx(request, 'account.create', (a) => ({ target: a.code })),
      });
      return reply.status(201).send(account);
    },
  );

  app.post(`${base}/accounts/seed`, { preValidation: guard('accounts:manage'), schema: { params: tenantParams } }, async (request) => {
    const tenant = await db.collection(COLLECTIONS.tenants).findOne({ _id: request.ctx.tenantId });
    const pack = COUNTRY_PACKS[tenant.country];
    if (!pack?.defaultChart) {
      const err = new Error(`no hay plan de cuentas inicial para ${tenant.country}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const { created } = await accounts.seed(request.ctx.tenantId, pack.defaultChart, {
      inTx: tx(request, 'account.seed', (r) => ({ details: { country: tenant.country, created: r.created } })),
    });
    return { country: tenant.country, created, draft: Boolean(pack.defaultChartIsDraft) };
  });

  app.post(
    `${base}/accounts/:code/deactivate`,
    {
      preValidation: guard('accounts:manage'),
      schema: {
        params: {
          type: 'object',
          required: ['tenantId', 'code'],
          properties: { tenantId: OBJECT_ID, code: { type: 'string', pattern: '^[0-9]{1,12}$' } },
        },
      },
    },
    async (request, reply) => {
      await accounts.deactivate(request.ctx.tenantId, request.params.code, {
        inTx: tx(request, 'account.deactivate', (r) => ({ target: r.code })),
      });
      return reply.status(204).send();
    },
  );

  app.post(
    `${base}/accounts/:code/activate`,
    {
      preValidation: guard('accounts:manage'),
      schema: {
        params: {
          type: 'object',
          required: ['tenantId', 'code'],
          properties: { tenantId: OBJECT_ID, code: { type: 'string', pattern: '^[0-9]{1,12}$' } },
        },
      },
    },
    async (request, reply) => {
      await accounts.reactivate(request.ctx.tenantId, request.params.code, {
        inTx: tx(request, 'account.activate', (r) => ({ target: r.code })),
      });
      return reply.status(204).send();
    },
  );

  // ---- Terceros ----
  const partyFields = {
    name: { type: 'string', maxLength: 200 },
    roles: { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: 2 },
    email: { type: 'string', maxLength: 254 },
    phone: { type: 'string', maxLength: 30 },
    address: {
      type: 'object',
      additionalProperties: false,
      properties: {
        line: { type: 'string', maxLength: 200 },
        city: { type: 'string', maxLength: 100 },
        region: { type: 'string', maxLength: 100 },
        country: { type: 'string', maxLength: 2 },
      },
    },
  };

  const partyQuery = {
    type: 'object',
    properties: {
      role: { type: 'string', maxLength: 20 },
      search: { type: 'string', maxLength: 100 },
      activeOnly: { type: 'string', enum: ['true', 'false'] },
      ...pageQuery,
    },
  };

  app.get(`${base}/parties`, { preValidation: guard('parties:read'), schema: { params: tenantParams, querystring: partyQuery } }, async (request) => {
    const { role, search, activeOnly, limit, cursor } = request.query;
    return parties.list(request.ctx.tenantId, {
      ...(role ? { role } : {}),
      ...(search ? { search } : {}),
      activeOnly: activeOnly === 'true',
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });
  });

  app.post(
    `${base}/parties`,
    {
      preValidation: guard('parties:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            ...partyFields,
            taxIdType: { type: 'string', maxLength: 20 },
            taxId: { type: 'string', maxLength: 30 },
            checkDigit: { type: 'integer', minimum: 0, maximum: 9 },
          },
          ['name', 'roles', 'taxIdType', 'taxId'],
        ),
      },
    },
    async (request, reply) => {
      const party = await parties.create(request.ctx.tenantId, request.body, {
        inTx: tx(request, 'party.create', (p) => ({ target: p._id })),
      });
      return reply.status(201).send(party);
    },
  );

  app.get(`${base}/parties/:id`, { preValidation: guard('parties:read'), schema: { params: idParams } }, async (request, reply) => {
    const party = await parties.get(request.ctx.tenantId, request.params.id);
    if (!party) return reply.status(404).send({ error: 'NOT_FOUND', message: 'el tercero no existe' });
    return party;
  });

  app.patch(
    `${base}/parties/:id`,
    {
      preValidation: guard('parties:manage'),
      // Sin additionalProperties:false a propósito: si llega la identificación, el servicio la rechaza con IMMUTABLE.
      schema: { params: idParams, body: { type: 'object', properties: partyFields } },
    },
    async (request) =>
      parties.update(request.ctx.tenantId, request.params.id, request.body, {
        inTx: tx(request, 'party.update', (r) => ({ target: r.id, details: { fields: r.fields } })),
      }),
  );

  app.post(
    `${base}/parties/:id/active`,
    {
      preValidation: guard('parties:manage'),
      schema: { params: idParams, body: bodyOf({ active: { type: 'boolean' } }, ['active']) },
    },
    async (request, reply) => {
      await parties.setActive(request.ctx.tenantId, request.params.id, request.body.active, {
        inTx: tx(request, request.body.active ? 'party.activate' : 'party.deactivate', (r) => ({ target: r.id })),
      });
      return reply.status(204).send();
    },
  );

  // ---- Libro contable ----
  app.get(
    `${base}/journals`,
    {
      preValidation: guard('journals:read'),
      schema: {
        params: tenantParams,
        querystring: {
          type: 'object',
          properties: {
            period: PERIOD,
            docType: { type: 'string', maxLength: 10 },
            accountId: { type: 'string', pattern: '^[0-9]{1,12}$' },
            ...pageQuery,
          },
        },
      },
    },
    async (request) => {
      const { period, docType, accountId, limit, cursor } = request.query;
      return ledger.listJournals(request.ctx.tenantId, {
        ...(period ? { period } : {}),
        ...(docType ? { docType } : {}),
        ...(accountId ? { accountId } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
        ...(cursor ? { cursor } : {}),
      });
    },
  );

  app.post(
    `${base}/journals`,
    {
      preValidation: guard('journals:post'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            docType: { type: 'string', minLength: 1, maxLength: 10 },
            date: { type: 'string', maxLength: 40 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            description: { type: 'string', maxLength: 500 },
            lines: {
              type: 'array',
              minItems: 2,
              maxItems: 500,
              items: bodyOf(
                {
                  accountId: { type: 'string', maxLength: 12 },
                  debit: money,
                  credit: money,
                  description: { type: 'string', maxLength: 200 },
                },
                ['accountId'],
              ),
            },
          },
          ['docType', 'date', 'currency', 'lines'],
        ),
      },
    },
    async (request, reply) => {
      if (MODULE_DOC_TYPES.includes(request.body.docType.toUpperCase())) {
        throw Object.assign(new Error(`el tipo ${request.body.docType} lo generan los documentos (facturas, cobros, compras…); usa otro tipo para un asiento manual`), { code: 'IMMUTABLE' });
      }
      const { journal, replayed } = await ledger.postJournal(
        request.ctx.tenantId,
        { ...request.body, date: new Date(request.body.date), idempotencyKey: request.headers['idempotency-key'] },
        {
          inTx: tx(request, 'journal.post', (r) => ({ target: r.journal._id, details: { docType: r.journal.docType, number: r.journal.number } })),
        },
      );
      return reply.status(replayed ? 200 : 201).send({ replayed, journal });
    },
  );

  app.get(`${base}/journals/:id`, { preValidation: guard('journals:read'), schema: { params: idParams } }, async (request, reply) => {
    const journal = await ledger.getJournal(request.ctx.tenantId, new ObjectId(request.params.id));
    if (!journal) return reply.status(404).send({ error: 'NOT_FOUND', message: 'el asiento no existe' });
    return journal;
  });

  app.post(
    `${base}/journals/:id/reverse`,
    {
      // El cuerpo es opcional: sin él, se valida como objeto vacío en vez de fallar con 400.
      preValidation: [
        guard('journals:reverse'),
        async (request) => {
          request.body ??= {};
        },
      ],
      schema: {
        params: idParams,
        headers: idempotencyHeader,
        body: bodyOf({ date: { type: 'string', maxLength: 40 }, description: { type: 'string', maxLength: 500 } }),
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const target = await ledger.getJournal(request.ctx.tenantId, new ObjectId(request.params.id));
      if (target?.source?.kind) {
        throw Object.assign(new Error('este asiento lo generó un documento: corrígelo desde el documento (nota crédito, anulación del recibo…)'), { code: 'IMMUTABLE' });
      }
      const { journal, replayed } = await ledger.reverseJournal(
        request.ctx.tenantId,
        new ObjectId(request.params.id),
        {
          idempotencyKey: request.headers['idempotency-key'],
          ...(body.date ? { date: new Date(body.date) } : {}),
          ...(body.description ? { description: body.description } : {}),
        },
        { inTx: tx(request, 'journal.reverse', (r) => ({ target: request.params.id, details: { reversalNumber: r.journal.number } })) },
      );
      return reply.status(replayed ? 200 : 201).send({ replayed, journal });
    },
  );

  app.get(
    `${base}/balances`,
    {
      preValidation: guard('reports:read'),
      schema: {
        params: tenantParams,
        querystring: bodyOf(
          {
            account: { type: 'string', pattern: '^[0-9]{1,12}$' },
            period: PERIOD,
            currency: { type: 'string', minLength: 3, maxLength: 3 },
          },
          ['account', 'period', 'currency'],
        ),
      },
    },
    async (request) => {
      const { account, period, currency } = request.query;
      return ledger.getBalance(request.ctx.tenantId, account, period, currency);
    },
  );

  // ---- Cartera: recibos de caja y cartera por edades ----
  app.post(
    `${base}/receipts`,
    {
      preValidation: guard('receipts:create'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            partyId: OBJECT_ID,
            date: DAY,
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            depositAccount: { type: 'string', pattern: '^[0-9]{1,12}$' },
            notes: { type: 'string', maxLength: 500 },
            allocations: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: bodyOf({ invoiceId: OBJECT_ID, amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['invoiceId', 'amount']),
            },
          },
          ['partyId', 'date', 'depositAccount', 'allocations'],
        ),
      },
    },
    async (request, reply) => {
      const { receipt, replayed } = await receivables.createReceipt(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, receipt });
    },
  );

  app.get(
    `${base}/receipts`,
    {
      preValidation: guard('invoices:read'),
      schema: {
        params: tenantParams,
        querystring: bodyOf({ status: { type: 'string', enum: ['posted', 'void'] }, partyId: OBJECT_ID, ...pageQuery }),
      },
    },
    async (request) => receivables.listReceipts(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/receipts/:id`, { preValidation: guard('invoices:read'), schema: { params: idParams } }, async (request, reply) => {
    const receipt = await receivables.getReceipt(request.ctx.tenantId, request.params.id);
    if (!receipt) return reply.status(404).send({ error: 'NOT_FOUND', message: 'el recibo no existe' });
    return receipt;
  });

  app.post(
    `${base}/receipts/:id/void`,
    {
      preValidation: [
        guard('receipts:void'),
        async (request) => {
          request.body ??= {};
        },
      ],
      schema: { params: idParams, body: bodyOf({ date: DAY }) },
    },
    async (request) => receivables.voidReceipt(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );

  app.get(
    `${base}/receivables/aging`,
    {
      preValidation: guard('invoices:read'),
      schema: { params: tenantParams, querystring: bodyOf({ currency: { type: 'string', minLength: 3, maxLength: 3 } }, ['currency']) },
    },
    async (request) => receivables.aging(request.ctx.tenantId, request.query),
  );

  app.get(
    `${base}/receivables/open`,
    {
      preValidation: guard('invoices:read'),
      schema: {
        params: tenantParams,
        querystring: bodyOf({ partyId: OBJECT_ID, currency: { type: 'string', minLength: 3, maxLength: 3 } }, ['partyId', 'currency']),
      },
    },
    async (request) => ({ items: await receivables.listOpenInvoices(request.ctx.tenantId, request.query) }),
  );

  // ---- Compras: facturas de proveedor, notas de proveedor, pagos y cuentas por pagar ----
  const NOT_FOUND_BODY = (message) => ({ error: 'NOT_FOUND', message });
  const CURRENCY_Q = { type: 'string', minLength: 3, maxLength: 3 };

  app.get(`${base}/purchasing/status`, { preValidation: guard('purchases:read'), schema: { params: tenantParams } }, async (request) =>
    purchases.status(request.ctx.tenantId),
  );

  app.post(
    `${base}/purchases`,
    {
      preValidation: guard('purchases:create'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            supplierId: OBJECT_ID,
            supplierDocNumber: { type: 'string', minLength: 1, maxLength: 40 },
            issueDate: DAY,
            dueDate: DAY,
            notes: { type: 'string', maxLength: 500 },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: bodyOf(
                {
                  description: { type: 'string', maxLength: 200 },
                  quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                  unitPrice: money53,
                  discountBps: { type: 'integer', minimum: 0, maximum: 10_000 },
                  vatBps: { type: 'integer', minimum: 0, maximum: 10_000 },
                  accountId: { type: 'string', pattern: '^[0-9]{1,12}$' },
                  itemId: OBJECT_ID,
                  warehouseId: OBJECT_ID,
                },
                ['description', 'quantity', 'unitPrice'],
              ),
            },
            withholdings: {
              type: 'array',
              maxItems: 10,
              items: bodyOf(
                {
                  name: { type: 'string', maxLength: 60 },
                  accountId: { type: 'string', pattern: '^[0-9]{1,12}$' },
                  basis: { type: 'string', enum: ['subtotal', 'vat'] },
                  rateBps: { type: 'integer', minimum: 1, maximum: 10_000 },
                },
                ['name', 'accountId', 'basis', 'rateBps'],
              ),
            },
          },
          ['supplierId', 'supplierDocNumber', 'issueDate', 'lines'],
        ),
      },
    },
    async (request, reply) => {
      const { purchase, replayed } = await purchases.createPurchase(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, purchase });
    },
  );

  app.get(
    `${base}/purchases`,
    {
      preValidation: guard('purchases:read'),
      schema: { params: tenantParams, querystring: bodyOf({ status: { type: 'string', enum: ['posted', 'void'] }, supplierId: OBJECT_ID, ...pageQuery }) },
    },
    async (request) => purchases.listPurchases(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/purchases/:id`, { preValidation: guard('purchases:read'), schema: { params: idParams } }, async (request, reply) => {
    const purchase = await purchases.getPurchase(request.ctx.tenantId, request.params.id);
    return purchase ?? reply.status(404).send(NOT_FOUND_BODY('la factura de compra no existe'));
  });

  const optionalBody = async (request) => {
    request.body ??= {};
  };

  app.post(
    `${base}/purchases/:id/void`,
    { preValidation: [guard('purchases:void'), optionalBody], schema: { params: idParams, body: bodyOf({ date: DAY }) } },
    async (request) => purchases.voidPurchase(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );

  app.post(
    `${base}/purchases/:id/credit-notes`,
    {
      preValidation: guard('purchases:create'),
      schema: {
        params: idParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            reason: { type: 'string', minLength: 1, maxLength: 200 },
            supplierDocNumber: { type: 'string', minLength: 1, maxLength: 40 },
            issueDate: DAY,
            all: { type: 'boolean' },
            lines: {
              type: 'array',
              maxItems: 200,
              items: bodyOf({ lineIndex: { type: 'integer', minimum: 0, maximum: 199 }, quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['lineIndex', 'quantity']),
            },
          },
          ['reason', 'supplierDocNumber'],
        ),
      },
    },
    async (request, reply) => {
      const { note, replayed } = await purchases.createSupplierNote(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, note });
    },
  );

  app.get(
    `${base}/supplier-notes`,
    { preValidation: guard('purchases:read'), schema: { params: tenantParams, querystring: bodyOf({ purchaseId: OBJECT_ID, ...pageQuery }) } },
    async (request) => purchases.listSupplierNotes(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/supplier-notes/:id`, { preValidation: guard('purchases:read'), schema: { params: idParams } }, async (request, reply) => {
    const note = await purchases.getSupplierNote(request.ctx.tenantId, request.params.id);
    return note ?? reply.status(404).send(NOT_FOUND_BODY('la nota de proveedor no existe'));
  });

  app.post(
    `${base}/supplier-notes/:id/void`,
    { preValidation: [guard('purchases:void'), optionalBody], schema: { params: idParams, body: bodyOf({ date: DAY }) } },
    async (request) => purchases.voidSupplierNote(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );

  app.post(
    `${base}/payments`,
    {
      preValidation: guard('payments:create'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            partyId: OBJECT_ID,
            date: DAY,
            currency: CURRENCY_Q,
            paymentAccount: { type: 'string', pattern: '^[0-9]{1,12}$' },
            notes: { type: 'string', maxLength: 500 },
            allocations: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: bodyOf({ purchaseId: OBJECT_ID, amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['purchaseId', 'amount']),
            },
          },
          ['partyId', 'date', 'paymentAccount', 'allocations'],
        ),
      },
    },
    async (request, reply) => {
      const { payment, replayed } = await payables.createPayment(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, payment });
    },
  );

  app.get(
    `${base}/payments`,
    {
      preValidation: guard('purchases:read'),
      schema: { params: tenantParams, querystring: bodyOf({ status: { type: 'string', enum: ['posted', 'void'] }, partyId: OBJECT_ID, ...pageQuery }) },
    },
    async (request) => payables.listPayments(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/payments/:id`, { preValidation: guard('purchases:read'), schema: { params: idParams } }, async (request, reply) => {
    const payment = await payables.getPayment(request.ctx.tenantId, request.params.id);
    return payment ?? reply.status(404).send(NOT_FOUND_BODY('el comprobante de egreso no existe'));
  });

  app.post(
    `${base}/payments/:id/void`,
    { preValidation: [guard('payments:void'), optionalBody], schema: { params: idParams, body: bodyOf({ date: DAY }) } },
    async (request) => payables.voidPayment(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );

  app.get(
    `${base}/payables/aging`,
    { preValidation: guard('purchases:read'), schema: { params: tenantParams, querystring: bodyOf({ currency: CURRENCY_Q }, ['currency']) } },
    async (request) => payables.aging(request.ctx.tenantId, request.query),
  );

  app.get(
    `${base}/payables/open`,
    {
      preValidation: guard('purchases:read'),
      schema: { params: tenantParams, querystring: bodyOf({ partyId: OBJECT_ID, currency: CURRENCY_Q }, ['partyId', 'currency']) },
    },
    async (request) => ({ items: await payables.listOpenPurchases(request.ctx.tenantId, request.query) }),
  );

  // ---- Inventario: artículos, bodegas, existencias, kardex, ajustes y traspasos ----
  const itemBody = {
    sku: { type: 'string', minLength: 1, maxLength: 40 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    type: { type: 'string', enum: ['goods', 'service'] },
    unit: { type: 'string', maxLength: 10 },
    inventoryAccount: { type: 'string', maxLength: 12 },
    cogsAccount: { type: 'string', maxLength: 12 },
    incomeAccount: { type: 'string', maxLength: 12 },
    price: money53,
    vatBps: { type: 'integer', minimum: 0, maximum: 10_000 },
    minStock: money53,
  };

  app.get(
    `${base}/items`,
    {
      preValidation: guard('inventory:read'),
      schema: {
        params: tenantParams,
        querystring: bodyOf({
          search: { type: 'string', maxLength: 100 },
          type: { type: 'string', enum: ['goods', 'service'] },
          active: { type: 'string', enum: ['true', 'false'] },
          ...pageQuery,
        }),
      },
    },
    async (request) => inventory.listItems(request.ctx.tenantId, request.query),
  );

  app.post(
    `${base}/items`,
    { preValidation: guard('inventory:manage'), schema: { params: tenantParams, body: bodyOf(itemBody, ['sku', 'name', 'type']) } },
    async (request, reply) => {
      const item = await inventory.createItem(request.ctx.tenantId, request.body, { inTx: tx(request, 'item.create', (i) => ({ target: i._id, details: { sku: i.sku } })) });
      return reply.status(201).send(item);
    },
  );

  app.get(`${base}/items/:id`, { preValidation: guard('inventory:read'), schema: { params: idParams } }, async (request, reply) => {
    const item = await inventory.getItem(request.ctx.tenantId, request.params.id);
    return item ?? reply.status(404).send({ error: 'NOT_FOUND', message: 'el artículo no existe' });
  });

  app.patch(
    `${base}/items/:id`,
    {
      preValidation: guard('inventory:manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: itemBody.name,
            unit: itemBody.unit,
            inventoryAccount: itemBody.inventoryAccount,
            cogsAccount: itemBody.cogsAccount,
            incomeAccount: { type: ['string', 'null'], maxLength: 12 },
            price: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            vatBps: { type: ['integer', 'null'], minimum: 0, maximum: 10_000 },
            minStock: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => inventory.updateItem(request.ctx.tenantId, request.params.id, request.body, { inTx: tx(request, 'item.update', () => ({ target: request.params.id })) }),
  );

  app.get(`${base}/warehouses`, { preValidation: guard('inventory:read'), schema: { params: tenantParams } }, async (request) => ({
    items: await inventory.listWarehouses(request.ctx.tenantId),
  }));

  app.post(
    `${base}/warehouses`,
    {
      preValidation: guard('inventory:manage'),
      schema: { params: tenantParams, body: bodyOf({ code: { type: 'string', minLength: 1, maxLength: 10 }, name: { type: 'string', minLength: 1, maxLength: 100 } }, ['code', 'name']) },
    },
    async (request, reply) => {
      const created = await inventory.createWarehouse(request.ctx.tenantId, request.body, { inTx: tx(request, 'warehouse.create', (w) => ({ target: w._id, details: { code: w.code } })) });
      return reply.status(201).send(created);
    },
  );

  app.post(
    `${base}/warehouses/:id/active`,
    { preValidation: guard('inventory:manage'), schema: { params: idParams, body: bodyOf({ active: { type: 'boolean' } }, ['active']) } },
    async (request) => inventory.setWarehouseActive(request.ctx.tenantId, request.params.id, request.body.active, { inTx: tx(request, 'warehouse.active', () => ({ target: request.params.id, details: { active: request.body.active } })) }),
  );

  app.get(
    `${base}/stock`,
    { preValidation: guard('inventory:read'), schema: { params: tenantParams, querystring: bodyOf({ itemId: OBJECT_ID, warehouseId: OBJECT_ID }) } },
    async (request) => ({ items: await inventory.listStock(request.ctx.tenantId, request.query) }),
  );

  app.get(
    `${base}/kardex`,
    {
      preValidation: guard('inventory:read'),
      schema: { params: tenantParams, querystring: bodyOf({ itemId: OBJECT_ID, warehouseId: OBJECT_ID, from: DAY, to: DAY, limit: pageQuery.limit, cursor: OBJECT_ID }, ['itemId']) },
    },
    async (request) => inventory.kardex(request.ctx.tenantId, request.query),
  );

  app.get(
    `${base}/inventory/valuation`,
    { preValidation: guard('inventory:read'), schema: { params: tenantParams, querystring: bodyOf({ warehouseId: OBJECT_ID }) } },
    async (request) => inventory.valuation(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/inventory/low-stock`, { preValidation: guard('inventory:read'), schema: { params: tenantParams } }, async (request) => ({
    items: await inventory.lowStock(request.ctx.tenantId),
  }));

  app.post(
    `${base}/stock/adjustments`,
    {
      preValidation: guard('inventory:adjust'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            itemId: OBJECT_ID,
            warehouseId: OBJECT_ID,
            date: DAY,
            direction: { type: 'string', enum: ['in', 'out'] },
            quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            unitCost: money53,
            counterAccount: { type: 'string', pattern: '^[0-9]{1,12}$' },
            reason: { type: 'string', minLength: 1, maxLength: 200 },
          },
          ['itemId', 'date', 'direction', 'quantity', 'counterAccount', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const { doc, replayed } = await inventory.adjust(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, doc });
    },
  );

  app.post(
    `${base}/stock/transfers`,
    {
      preValidation: guard('inventory:adjust'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            itemId: OBJECT_ID,
            fromWarehouseId: OBJECT_ID,
            toWarehouseId: OBJECT_ID,
            date: DAY,
            quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            note: { type: 'string', maxLength: 200 },
          },
          ['itemId', 'fromWarehouseId', 'toWarehouseId', 'date', 'quantity'],
        ),
      },
    },
    async (request, reply) => {
      const { doc, replayed } = await inventory.transfer(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, doc });
    },
  );

  app.get(
    `${base}/stock/documents`,
    { preValidation: guard('inventory:read'), schema: { params: tenantParams, querystring: bodyOf({ kind: { type: 'string', enum: ['adjustment', 'transfer'] }, ...pageQuery }) } },
    async (request) => inventory.listStockDocs(request.ctx.tenantId, request.query),
  );

  // ---- Reportes contables ----
  const CURRENCY = { type: 'string', minLength: 3, maxLength: 3 };
  const reportRoute = (path, query, required, run) =>
    app.get(
      `${base}/reports/${path}`,
      { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf(query, required) } },
      async (request) => run(request.ctx.tenantId, request.query),
    );
  reportRoute('trial-balance', { from: PERIOD, to: PERIOD, currency: CURRENCY }, ['from', 'to', 'currency'], (t, q) => reports.trialBalance(t, q));
  reportRoute('income-statement', { from: PERIOD, to: PERIOD, currency: CURRENCY }, ['from', 'to', 'currency'], (t, q) => reports.incomeStatement(t, q));
  reportRoute('balance-sheet', { to: PERIOD, currency: CURRENCY }, ['to', 'currency'], (t, q) => reports.balanceSheet(t, q));
  reportRoute(
    'general-ledger',
    {
      account: { type: 'string', pattern: '^[0-9]{1,12}$' },
      from: PERIOD,
      to: PERIOD,
      currency: CURRENCY,
      limit: { type: 'string', pattern: '^[0-9]{1,3}$' },
      cursor: { type: 'string', minLength: 1, maxLength: 512 },
    },
    ['account', 'from', 'to', 'currency'],
    (t, q) => reports.generalLedger(t, q),
  );

  // ---- Períodos contables ----
  app.get(`${base}/periods`, { preValidation: guard('journals:read'), schema: { params: tenantParams } }, async (request) => ({
    items: await ledger.listPeriods(request.ctx.tenantId),
  }));

  app.post(`${base}/periods/:period/close`, { preValidation: guard('periods:manage'), schema: { params: periodParams } }, async (request) =>
    ledger.closePeriod(request.ctx.tenantId, request.params.period, request.ctx.userId, {
      inTx: tx(request, 'period.close', (r) => ({ target: r.period })),
    }),
  );

  app.post(`${base}/periods/:period/reopen`, { preValidation: guard('periods:reopen'), schema: { params: periodParams } }, async (request) =>
    ledger.reopenPeriod(request.ctx.tenantId, request.params.period, request.ctx.userId, {
      inTx: tx(request, 'period.reopen', (r) => ({ target: r.period })),
    }),
  );

  // ---- Miembros de la empresa ----
  app.get(`${base}/members`, { preValidation: guard('users:manage'), schema: { params: tenantParams } }, async (request) => ({
    items: await auth.listMembers(request.ctx.tenantId),
  }));

  app.post(
    `${base}/members`,
    {
      preValidation: guard('users:manage'),
      config: { rateLimit: config.rateLimit.passwordReset },
      schema: { params: tenantParams, body: bodyOf({ email: { type: 'string', maxLength: 254 }, role: { type: 'string', maxLength: 20 } }, ['email', 'role']) },
    },
    async (request, reply) =>
      reply.status(202).send(
        await auth.inviteMember(request.ctx, request.body, {
          inTx: tx(request, 'member.invite', (r) => ({ target: r.email, details: { role: r.role } })),
        }),
      ),
  );

  app.patch(
    `${base}/members/:userId`,
    {
      preValidation: guard('users:manage'),
      schema: { params: memberParams, body: bodyOf({ role: { type: 'string', maxLength: 20 } }, ['role']) },
    },
    async (request, reply) => {
      await auth.changeRole(request.ctx, new ObjectId(request.params.userId), request.body.role, {
        inTx: tx(request, 'member.change_role', (r) => ({ target: r.userId, details: { role: r.role } })),
      });
      return reply.status(204).send();
    },
  );

  app.delete(`${base}/members/:userId`, { preValidation: guard('users:manage'), schema: { params: memberParams } }, async (request, reply) => {
    await auth.removeMember(request.ctx, new ObjectId(request.params.userId), {
      inTx: tx(request, 'member.remove', (r) => ({ target: r.userId })),
    });
    return reply.status(204).send();
  });

  // ---- Facturación electrónica ----
  const addressSchema = bodyOf({ line: { type: 'string', maxLength: 200 }, city: { type: 'string', maxLength: 100 }, region: { type: 'string', maxLength: 100 } });
  const listQueryInvoices = {
    type: 'object',
    properties: { status: { type: 'string', maxLength: 20 }, customerId: OBJECT_ID, invoiceId: OBJECT_ID, from: DAY, to: DAY, ...pageQuery },
  };
  const listOptions = (q) => ({
    ...(q.status ? { status: q.status } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.limit ? { limit: Number(q.limit) } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  const notFound = (reply, message) => reply.status(404).send({ error: 'NOT_FOUND', message });

  app.get(`${base}/invoicing/status`, { preValidation: guard('invoices:read'), schema: { params: tenantParams } }, async (request) => {
    const tenant = await db.collection(COLLECTIONS.tenants).findOne({ _id: request.ctx.tenantId });
    return {
      ...(await invoicing.status(request.ctx.tenantId)),
      country: tenant.country,
      currency: tenant.currency,
      vatRatesBps: vatRatesFor(tenant.country) ?? [0],
      creditNoteReasons: creditNoteReasonsFor(tenant.country),
    };
  });

  app.get(`${base}/invoicing/settings`, { preValidation: guard('invoices:read'), schema: { params: tenantParams } }, async (request) => ({
    settings: await settingsService.get(request.ctx.tenantId),
  }));

  app.put(
    `${base}/invoicing/settings`,
    {
      preValidation: guard('settings:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            issuer: bodyOf(
              {
                name: { type: 'string', maxLength: 200 },
                taxIdType: { type: 'string', maxLength: 20 },
                taxId: { type: 'string', maxLength: 30 },
                checkDigit: { type: 'integer', minimum: 0, maximum: 9 },
                regime: { type: 'string', maxLength: 30 },
                email: { type: 'string', maxLength: 254 },
                phone: { type: 'string', maxLength: 30 },
                address: addressSchema,
              },
              ['name', 'taxIdType', 'taxId', 'regime', 'address'],
            ),
            accounts: bodyOf(
              { receivable: { type: 'string', maxLength: 12 }, income: { type: 'string', maxLength: 12 }, vatPayable: { type: 'string', maxLength: 12 }, cash: { type: 'string', maxLength: 12 }, payable: { type: 'string', maxLength: 12 }, vatDeductible: { type: 'string', maxLength: 12 } },
              ['receivable', 'income', 'vatPayable'],
            ),
          },
          ['issuer', 'accounts'],
        ),
      },
    },
    async (request) => ({
      settings: await settingsService.save(request.ctx.tenantId, request.body, { inTx: tx(request, 'invoicing.settings_update', () => ({})) }),
    }),
  );

  app.get(`${base}/invoicing/resolutions`, { preValidation: guard('invoices:read'), schema: { params: tenantParams } }, async (request) => ({
    items: await resolutionService.list(request.ctx.tenantId),
  }));

  app.post(
    `${base}/invoicing/resolutions`,
    {
      preValidation: guard('settings:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            docType: { type: 'string', maxLength: 20 },
            prefix: { type: 'string', maxLength: 6 },
            number: { type: 'string', maxLength: 40 },
            from: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
            to: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
            validFrom: DAY,
            validTo: DAY,
          },
          ['docType', 'number', 'from', 'to', 'validFrom', 'validTo'],
        ),
      },
    },
    async (request, reply) =>
      reply.status(201).send(
        await resolutionService.create(request.ctx.tenantId, request.body, {
          inTx: tx(request, 'invoicing.resolution_create', (r) => ({ target: r._id, details: { docType: r.docType, prefix: r.prefix, from: r.from, to: r.to } })),
        }),
      ),
  );

  app.post(
    `${base}/invoicing/resolutions/:id/deactivate`,
    { preValidation: guard('settings:manage'), schema: { params: idParams } },
    async (request, reply) => {
      await resolutionService.deactivate(request.ctx.tenantId, request.params.id, {
        inTx: tx(request, 'invoicing.resolution_deactivate', (r) => ({ target: r.id })),
      });
      return reply.status(204).send();
    },
  );

  app.get(`${base}/invoices`, { preValidation: guard('invoices:read'), schema: { params: tenantParams, querystring: listQueryInvoices } }, async (request) =>
    invoicing.listInvoices(request.ctx.tenantId, listOptions(request.query)),
  );

  app.get(`${base}/invoices/:id`, { preValidation: guard('invoices:read'), schema: { params: idParams } }, async (request, reply) => {
    const invoice = await invoicing.getInvoice(request.ctx.tenantId, request.params.id);
    return invoice ?? notFound(reply, 'la factura no existe');
  });

  app.post(
    `${base}/invoices`,
    {
      preValidation: guard('invoices:issue'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            customerId: OBJECT_ID,
            issueDate: DAY,
            dueDate: DAY,
            paymentMethod: { type: 'string', maxLength: 10 },
            notes: { type: 'string', maxLength: 500 },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: bodyOf(
                {
                  description: { type: 'string', maxLength: 200 },
                  quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                  unitPrice: money53,
                  discountBps: { type: 'integer', minimum: 0, maximum: 10_000 },
                  vatBps: { type: 'integer', minimum: 0, maximum: 10_000 },
                  accountId: { type: 'string', maxLength: 12 },
                },
                ['description', 'quantity', 'unitPrice'],
              ),
            },
          },
          ['customerId', 'issueDate', 'paymentMethod', 'lines'],
        ),
      },
    },
    async (request, reply) => {
      const result = await invoicing.issueInvoice(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(outcomeStatus(result)).send(result);
    },
  );

  app.post(`${base}/invoices/:id/sync`, { preValidation: guard('invoices:issue'), schema: { params: idParams } }, async (request) =>
    invoicing.submitInvoice(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  );

  app.post(`${base}/invoices/:id/account`, { preValidation: guard('invoices:issue'), schema: { params: idParams } }, async (request) => ({
    invoice: await invoicing.accountInvoice(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  }));

  app.post(
    `${base}/invoices/:id/credit-notes`,
    {
      preValidation: guard('invoices:issue'),
      schema: {
        params: idParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            reasonCode: { type: 'string', maxLength: 10 },
            issueDate: DAY,
            all: { type: 'boolean' },
            lines: {
              type: 'array',
              maxItems: 200,
              items: bodyOf({ lineIndex: { type: 'integer', minimum: 0 }, quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['lineIndex', 'quantity']),
            },
          },
          ['reasonCode'],
        ),
      },
    },
    async (request, reply) => {
      const result = await invoicing.issueCreditNote(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request));
      return reply.status(outcomeStatus(result)).send(result);
    },
  );

  app.get(`${base}/credit-notes`, { preValidation: guard('invoices:read'), schema: { params: tenantParams, querystring: listQueryInvoices } }, async (request) =>
    invoicing.listCreditNotes(request.ctx.tenantId, listOptions(request.query)),
  );

  app.get(`${base}/credit-notes/:id`, { preValidation: guard('invoices:read'), schema: { params: idParams } }, async (request, reply) => {
    const note = await invoicing.getCreditNote(request.ctx.tenantId, request.params.id);
    return note ?? notFound(reply, 'la nota crédito no existe');
  });

  app.post(`${base}/credit-notes/:id/sync`, { preValidation: guard('invoices:issue'), schema: { params: idParams } }, async (request) =>
    invoicing.submitCreditNote(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  );

  app.post(`${base}/credit-notes/:id/account`, { preValidation: guard('invoices:issue'), schema: { params: idParams } }, async (request) => ({
    note: await invoicing.accountCreditNote(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  }));

  // ---- Auditoría ----
  app.get(
    `${base}/audit`,
    {
      preValidation: guard('audit:read'),
      schema: { params: tenantParams, querystring: { type: 'object', properties: pageQuery } },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      return auditLog.list(request.ctx.tenantId, { ...(limit ? { limit: Number(limit) } : {}), ...(cursor ? { cursor } : {}) });
    },
  );

  return app;
}
