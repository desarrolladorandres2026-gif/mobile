import { createHash, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { createAccountService } from '../accounts/accounts.js';
import { createAdvancesService } from '../advances/advances.js';
import { createBankService } from '../bank/bank.js';
import { createBenefitsService } from '../payroll/benefits.js';
import { createPayrollService } from '../payroll/payroll.js';
import { createPayrollReports } from '../payroll/reports.js';
import { createTerminationService } from '../payroll/terminations.js';
import { createTaxService } from '../taxes/taxes.js';
import { createBudgetService } from '../budgets/budgets.js';
import { createCashFlowReport } from '../reports/cashflow.js';
import { createFixedAssetService } from '../fixedAssets/fixedAssets.js';
import { createCommercialService } from '../commercial/commercial.js';
import { Readable } from 'node:stream';
import { createAuditService } from '../audit/audit.js';
import { createExportService } from '../exporting/tenantExport.js';
import { createYearEndService } from '../closing/yearEnd.js';
import { createCostCenterService } from '../costCenters/costCenters.js';
import { GRANTABLE_SCOPES, createApiKeyService } from '../auth/apiKeys.js';
import { createAuthService } from '../auth/auth.js';
import { parseKey } from '../auth/secretbox.js';
import { COUNTRY_PACKS } from '../countries/index.js';
import { COLLECTIONS } from '../data/db.js';
import { MODULE_DOC_TYPES, createLedger, journalPayloadHash, normalizeDocType } from '../ledger/ledger.js';
import { createLogMailer, createSmtpMailer } from '../mail/mailer.js';
import { combineReporters, createLogReporter, createWebhookReporter } from '../observability/errorReporter.js';
import { createPartyService } from '../parties/parties.js';
import { createPayablesService } from '../purchases/payables.js';
import { createPurchasesService } from '../purchases/purchases.js';
import { createReceivablesService } from '../receivables/receivables.js';
import { createInventoryService } from '../inventory/inventory.js';
import { can } from '../auth/permissions.js';
import { createOnboardingService } from '../onboarding/onboarding.js';
import { createPosService } from '../pos/pos.js';
import { createBooksService } from '../reports/books.js';
import { createDimensionReports } from '../reports/dimensions.js';
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

  // Las rutas registradas, para que una prueba compruebe que la documentación de la API las cubre todas.
  const routeList = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD' && method !== 'OPTIONS') routeList.push({ method, url: route.url, permission: [route.preValidation].flat().find((hook) => hook?.permission)?.permission ?? null });
    }
  });
  app.decorate('routeList', routeList);

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
  const apiKeys = createApiKeyService({ client, db, ...(now ? { now } : {}) });
  const accounts = createAccountService(client, db);
  const parties = createPartyService(client, db);
  const ledger = createLedger(client, db);
  const auditLog = createAuditService(db);
  const reports = createReportService(db, accounts);
  const books = createBooksService(db);
  const dimensionReports = createDimensionReports(db, accounts);
  const costCenters = createCostCenterService({ client, db, ...(now ? { now } : {}) });
  const yearEnd = createYearEndService({ client, db, ledger, accounts, ...(now ? { now } : {}) });
  const metrics = createMetrics();
  const settingsService = createSettingsService(client, db, accounts);
  /** Cuentas que mantienen los documentos y no admiten asientos manuales: código → nombre del documento que las mueve. */
  const controlAccounts = async (tenantId) => {
    const cfg = await settingsService.get(tenantId);
    const names = { receivable: 'cartera', payable: 'proveedores', vatPayable: 'IVA por pagar', vatDeductible: 'IVA descontable', customerAdvance: 'anticipos de clientes', supplierAdvance: 'anticipos a proveedores' };
    return new Map(Object.entries(names).filter(([key]) => cfg?.accounts?.[key]).map(([key, name]) => [cfg.accounts[key], name]));
  };
  const exporter = createExportService({ db, ...(now ? { now } : {}) });
  const resolutionService = createResolutionService(client, db);
  const provider = invoicingProvider !== undefined ? invoicingProvider : config.invoicingProvider === 'sandbox' ? createSandboxProvider() : null;
  const inventory = createInventoryService({ client, db, ledger, accounts });
  const invoicing = createInvoicingService({ client, db, ledger, accounts, parties, settings: settingsService, resolutions: resolutionService, provider, inventory });
  const receivables = createReceivablesService({ client, db, ledger, accounts, parties });
  const pos = createPosService({ client, db, ledger, accounts, parties, settings: settingsService, inventory });
  const advances = createAdvancesService({ client, db, ledger, accounts, parties, settings: settingsService, ...(now ? { now } : {}) });
  const bank = createBankService({ client, db, ledger, accounts, ...(now ? { now } : {}) });
  const purchases = createPurchasesService({ client, db, ledger, accounts, parties, settings: settingsService, inventory });
  const payables = createPayablesService({ db, ledger, accounts, parties });
  const commercial = createCommercialService({ db, invoicing, purchases, parties, ...(now ? { now } : {}) });
  app.decorate('commercial', commercial);
  const budgets = createBudgetService({ db, accounts, ...(now ? { now } : {}) });
  const cashFlowReport = createCashFlowReport(db, accounts);
  const payroll = createPayrollService({ client, db, ledger, accounts, ...(now ? { now } : {}) });
  const benefits = createBenefitsService({ db, ledger, accounts, payroll, ...(now ? { now } : {}) });
  const payrollReports = createPayrollReports({ db, accounts, payroll });
  const terminations = createTerminationService({ db, ledger, accounts, payroll, ...(now ? { now } : {}) });
  const taxes = createTaxService({ db, ledger, accounts, settings: settingsService, ...(now ? { now } : {}) });
  const fixedAssets = createFixedAssetService({ client, db, ledger, accounts, ...(now ? { now } : {}) });
  const onboarding = createOnboardingService({ db, invoicing, purchases });

  /** Contexto de una operación de facturación: la clave de idempotencia, quién la hace y cómo auditar dentro de su transacción. */
  const invoicingContext = (request) => ({
    idempotencyKey: request.headers['idempotency-key'],
    userId: request.ctx.userId,
    auditTx: (session, event) =>
      auditLog.record(
        { tenantId: request.ctx.tenantId, userId: request.ctx.userId, apiKeyId: request.ctx.apiKeyId, ip: request.ip, requestId: request.id, ...event },
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
        apiKeyId: request.ctx?.apiKeyId,
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
    // Una clave de API viaja en una cabecera que ningún sitio ajeno puede añadir a una petición del navegador: no hay CSRF que defender.
    if (/^Bearer\s+lbk_/i.test(request.headers.authorization ?? '')) return;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return reply.status(403).send({ error: 'FORBIDDEN_ORIGIN', message: 'origen no permitido' });
    }
  });

  // Nada de la API se guarda en cachés compartidas ni del navegador: son datos de una sesión.
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
  });

  /** Clave de API de la cabecera `Authorization: Bearer ...`, si viene; la sesión por cookie no la necesita. */
  const bearerOf = (request) => /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? null;

  /**
   * `stepUp`: la operación es delicada y exige haber confirmado la contraseña hace poco (el inicio de sesión cuenta; si no,
   * `POST /v1/auth/step-up`). Solo aplica a sesiones: una clave de API nunca tiene estos permisos.
   */
  const guard = (permission, { stepUp = false } = {}) => Object.assign(async (request) => {
    const tenantId = new ObjectId(request.params.tenantId);
    const token = bearerOf(request);
    // Una clave de API se prueba contra la empresa de la ruta y el permiso de la ruta, como una sesión.
    request.ctx = token ? await apiKeys.authenticate(token, tenantId, permission) : await auth.authorize(request.cookies[config.cookieName], tenantId, permission, { stepUp });
    // Desde aquí, cada línea del log de esta petición lleva la empresa y el usuario.
    request.log = request.log.child({ tenantId: String(request.ctx.tenantId), userId: String(request.ctx.userId) });
  }, { permission, stepUp });

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

  // ---- Sesiones abiertas y contraseña ----
  app.get('/v1/auth/sessions', { preValidation: session }, async (request) => ({
    items: await auth.listSessions(request.ctx.userId, request.cookies[config.cookieName]),
  }));

  app.delete('/v1/auth/sessions/:id', { preValidation: session, schema: { params: { type: 'object', required: ['id'], properties: { id: OBJECT_ID } } } }, async (request, reply) => {
    const result = await auth.revokeSession(request.ctx.userId, request.params.id, request.cookies[config.cookieName], {
      inTx: tx(request, 'auth.session_revoked', (r) => ({ userId: r.userId, target: r.sessionId, details: { current: r.current } })),
    });
    if (result.current) reply.clearCookie(config.cookieName, { path: '/' });
    return reply.status(204).send();
  });

  app.post(
    '/v1/auth/password/change',
    {
      preValidation: session,
      config: { rateLimit: config.rateLimit.mfa },
      schema: {
        body: bodyOf(
          { currentPassword: { type: 'string', maxLength: 128 }, newPassword: { type: 'string', maxLength: 128 }, code: { type: 'string', maxLength: 32 }, logoutAll: { type: 'boolean' } },
          ['currentPassword', 'newPassword'],
        ),
      },
    },
    async (request, reply) => {
      const result = await auth.changePassword(request.ctx.userId, request.cookies[config.cookieName], request.body, {
        inTx: tx(request, 'auth.password_changed', (r) => ({ userId: r.userId, details: { loggedOutEverywhere: r.loggedOut } })),
      });
      if (result.loggedOut) reply.clearCookie(config.cookieName, { path: '/' });
      return reply.status(204).send();
    },
  );

  // Confirmar de nuevo la identidad antes de una operación delicada (exportar, claves de API, roles, quitar miembros).
  app.post(
    '/v1/auth/step-up',
    {
      preValidation: session,
      config: { rateLimit: config.rateLimit.mfa },
      schema: { body: bodyOf({ password: { type: 'string', maxLength: 128 }, code: { type: 'string', maxLength: 32 } }, ['password']) },
    },
    async (request) =>
      auth.stepUp(request.cookies[config.cookieName], request.ctx.userId, request.body, { inTx: tx(request, 'auth.step_up', (r) => ({ userId: r.userId })) }),
  );

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
                  costCenter: { type: 'string', maxLength: 10 },
                  partyId: OBJECT_ID,
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
      // El tipo se normaliza antes de compararlo con los reservados: « fv » o «Fv» no pueden colarse por la comparación.
      const docType = normalizeDocType(request.body.docType);
      if (MODULE_DOC_TYPES.includes(docType)) {
        throw Object.assign(new Error(`el tipo ${docType} lo generan los documentos (facturas, cobros, compras…); usa otro tipo para un asiento manual`), { code: 'IMMUTABLE' });
      }
      // Los asientos de las cuentas que mantienen los documentos (cartera, proveedores, IVA y anticipos) los mueven esos documentos:
      // a mano dejarían la factura o la compra con un saldo que ya no cuadra con el libro.
      const control = await controlAccounts(request.ctx.tenantId);
      const touched = [...new Set(request.body.lines.map((l) => l.accountId.trim()).filter((code) => control.has(code)))];
      if (touched.length) {
        throw Object.assign(new Error(`la cuenta ${touched.join(', ')} la mueven los documentos (${[...new Set(touched.map((c) => control.get(c)))].join(', ')}): regístralo desde la factura, la compra, el recibo, el pago o el anticipo`), { code: 'CONTROL_ACCOUNT' });
      }
      // La clave lleva un prefijo propio: una clave manual nunca coincide con la de un documento (p. ej. la de una nómina o un cierre),
      // y repetirla con otro contenido es un error, no un reintento.
      const { journal, replayed } = await ledger.postJournal(
        request.ctx.tenantId,
        { ...request.body, docType, date: new Date(request.body.date), idempotencyKey: `manual:${request.headers['idempotency-key']}`, payloadHash: journalPayloadHash(request.body) },
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
          idempotencyKey: `manual-reverse:${request.headers['idempotency-key']}`,
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
            withholdings: {
              type: 'array',
              maxItems: 10,
              items: bodyOf({ name: { type: 'string', minLength: 1, maxLength: 60 }, accountId: { type: 'string', pattern: '^[0-9]{1,12}$' }, amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['name', 'accountId', 'amount']),
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
            kind: { type: 'string', enum: ['purchase', 'debit_note'] },
            relatedPurchaseId: OBJECT_ID,
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
                  costCenter: { type: 'string', maxLength: 10 },
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

  // ---- Punto de venta: cajas, turnos y ventas de mostrador ----
  const accountCode = { type: 'string', maxLength: 12 };
  const registerAccounts = bodyOf({ cash: accountCode, card: accountCode, transfer: accountCode, shortage: accountCode, surplus: accountCode });
  const posQuery = (extra = {}) => ({ type: 'object', additionalProperties: false, properties: { ...extra, ...pageQuery } });

  app.get(`${base}/pos/registers`, { preValidation: guard('pos:read'), schema: { params: tenantParams } }, async (request) => ({
    items: await pos.listRegisters(request.ctx.tenantId),
  }));

  app.post(
    `${base}/pos/registers`,
    {
      preValidation: guard('pos:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          { code: { type: 'string', minLength: 1, maxLength: 10 }, name: { type: 'string', minLength: 1, maxLength: 100 }, warehouseId: OBJECT_ID, costCenter: { type: 'string', maxLength: 10 }, accounts: registerAccounts },
          ['code', 'name', 'accounts'],
        ),
      },
    },
    async (request, reply) => {
      const created = await pos.createRegister(request.ctx.tenantId, request.body, { inTx: tx(request, 'pos.register_create', (r) => ({ target: r._id, details: { code: r.code } })) });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    `${base}/pos/registers/:id`,
    {
      preValidation: guard('pos:manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, active: { type: 'boolean' }, warehouseId: OBJECT_ID, costCenter: { type: 'string', maxLength: 10 }, accounts: registerAccounts },
        },
      },
    },
    async (request) => pos.updateRegister(request.ctx.tenantId, request.params.id, request.body, { inTx: tx(request, 'pos.register_update', () => ({ target: request.params.id })) }),
  );

  app.post(
    `${base}/pos/registers/:id/shifts`,
    { preValidation: guard('pos:sell'), schema: { params: idParams, body: bodyOf({ openingCash: money }) } },
    async (request, reply) => reply.status(201).send(await pos.openShift(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request))),
  );

  app.get(
    `${base}/pos/shifts`,
    { preValidation: guard('pos:read'), schema: { params: tenantParams, querystring: posQuery({ registerId: OBJECT_ID, status: { type: 'string', enum: ['open', 'closed'] } }) } },
    async (request) => pos.listShifts(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/pos/shifts/:id`, { preValidation: guard('pos:read'), schema: { params: idParams } }, async (request, reply) => {
    const shift = await pos.getShift(request.ctx.tenantId, request.params.id);
    return shift ?? reply.status(404).send({ error: 'NOT_FOUND', message: 'el turno no existe' });
  });

  app.post(
    `${base}/pos/shifts/:id/close`,
    {
      preValidation: guard('pos:sell'),
      schema: {
        params: idParams,
        body: bodyOf({ countedCash: money, counterAccount: { type: 'string', pattern: '^[0-9]{1,12}$' }, date: DAY, notes: { type: 'string', maxLength: 500 } }, ['countedCash', 'date']),
      },
    },
    async (request) => {
      // Elegir la cuenta de la diferencia es una decisión contable: el cajero usa la que trae la caja.
      if (request.body.counterAccount && !can(request.ctx.role, 'pos:manage')) {
        throw Object.assign(new Error('elegir la cuenta de la diferencia requiere permiso de gestión de cajas'), { code: 'FORBIDDEN' });
      }
      return pos.closeShift(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request));
    },
  );

  app.post(
    `${base}/pos/sales`,
    {
      preValidation: guard('pos:sell'),
      schema: {
        params: tenantParams,
        headers: idempotencyHeader,
        body: bodyOf(
          {
            registerId: OBJECT_ID,
            customerId: OBJECT_ID,
            date: DAY,
            notes: { type: 'string', maxLength: 500 },
            cashTendered: money,
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: bodyOf(
                {
                  description: { type: 'string', maxLength: 200 },
                  quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                  unitPrice: money,
                  discountBps: { type: 'integer', minimum: 0, maximum: 10_000 },
                  vatBps: { type: 'integer', minimum: 0, maximum: 10_000 },
                  accountId: { type: 'string', pattern: '^[0-9]{1,12}$' },
                  itemId: OBJECT_ID,
                },
                ['description', 'quantity', 'unitPrice'],
              ),
            },
            payments: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: bodyOf({ method: { type: 'string', maxLength: 10 }, amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['method', 'amount']),
            },
          },
          ['registerId', 'date', 'lines', 'payments'],
        ),
      },
    },
    async (request, reply) => {
      const { sale, replayed } = await pos.createSale(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(replayed ? 200 : 201).send({ replayed, sale });
    },
  );

  app.get(
    `${base}/pos/sales`,
    { preValidation: guard('pos:read'), schema: { params: tenantParams, querystring: posQuery({ shiftId: OBJECT_ID, registerId: OBJECT_ID, status: { type: 'string', enum: ['posted', 'void'] } }) } },
    async (request) => pos.listSales(request.ctx.tenantId, request.query),
  );

  app.get(`${base}/pos/sales/:id`, { preValidation: guard('pos:read'), schema: { params: idParams } }, async (request, reply) => {
    const sale = await pos.getSale(request.ctx.tenantId, request.params.id);
    return sale ?? reply.status(404).send({ error: 'NOT_FOUND', message: 'la venta no existe' });
  });

  app.post(
    `${base}/pos/sales/:id/void`,
    { preValidation: guard('pos:void'), schema: { params: idParams, body: bodyOf({ reason: { type: 'string', minLength: 1, maxLength: 200 }, date: DAY }, ['reason']) } },
    async (request) => pos.voidSale(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );

  // ---- Anticipos de clientes y a proveedores ----
  for (const [kind, path, perms] of [
    ['customer', 'customer-advances', { read: 'invoices:read', write: 'receipts:create', void: 'receipts:void' }],
    ['supplier', 'supplier-advances', { read: 'purchases:read', write: 'payments:create', void: 'payments:void' }],
  ]) {
    app.get(
      `${base}/${path}`,
      {
        preValidation: guard(perms.read),
        schema: { params: tenantParams, querystring: bodyOf({ partyId: OBJECT_ID, open: { type: 'string', enum: ['true', 'false'] }, status: { type: 'string', enum: ['posted', 'void'] }, ...pageQuery }) },
      },
      async (request) => advances.list(request.ctx.tenantId, kind, request.query),
    );
    app.get(`${base}/${path}/:id`, { preValidation: guard(perms.read), schema: { params: idParams } }, async (request, reply) => {
      const advance = await advances.get(request.ctx.tenantId, kind, request.params.id);
      return advance ?? reply.status(404).send({ error: 'NOT_FOUND', message: 'el anticipo no existe' });
    });
    app.post(
      `${base}/${path}`,
      {
        preValidation: guard(perms.write),
        schema: {
          params: tenantParams,
          headers: idempotencyHeader,
          body: bodyOf(
            { partyId: OBJECT_ID, date: DAY, amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, account: { type: 'string', pattern: '^[0-9]{1,12}$' }, currency: { type: 'string', minLength: 3, maxLength: 3 }, notes: { type: 'string', maxLength: 500 } },
            ['partyId', 'date', 'amount', 'account'],
          ),
        },
      },
      async (request, reply) => {
        const { advance, replayed } = await advances.create(request.ctx.tenantId, kind, request.body, invoicingContext(request));
        return reply.status(replayed ? 200 : 201).send({ replayed, advance });
      },
    );
    app.post(
      `${base}/${path}/:id/applications`,
      {
        preValidation: guard(perms.write),
        schema: {
          params: idParams,
          headers: idempotencyHeader,
          body: bodyOf(
            {
              date: DAY,
              allocations: {
                type: 'array',
                minItems: 1,
                maxItems: 200,
                items: bodyOf({ documentId: OBJECT_ID, amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ['documentId', 'amount']),
              },
            },
            ['date', 'allocations'],
          ),
        },
      },
      async (request, reply) => {
        const result = await advances.apply(request.ctx.tenantId, kind, request.params.id, request.body, invoicingContext(request));
        return reply.status(result.replayed ? 200 : 201).send(result);
      },
    );
    app.post(
      `${base}/${path}/:id/void`,
      { preValidation: [guard(perms.void), optionalBody], schema: { params: idParams, body: bodyOf({ date: DAY }) } },
      async (request) => advances.void(request.ctx.tenantId, kind, request.params.id, request.body, invoicingContext(request)),
    );
    app.post(
      `${base}/${path}/applications/:id/void`,
      { preValidation: [guard(perms.void), optionalBody], schema: { params: idParams, body: bodyOf({ date: DAY }) } },
      async (request) => advances.voidApplication(request.ctx.tenantId, kind, request.params.id, request.body, invoicingContext(request)),
    );
  }

  // ---- Conciliación bancaria ----
  const bankAccountField = { type: 'string', pattern: '^[0-9]{1,12}$' };
  const bankCurrency = { type: 'string', minLength: 3, maxLength: 3 };
  const lineIndexField = { type: 'integer', minimum: 0, maximum: 999 };
  const signedInt = { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
  app.get(
    `${base}/bank/lines`,
    { preValidation: guard('bank:read'), schema: { params: tenantParams, querystring: bodyOf({ account: bankAccountField, currency: bankCurrency, from: DAY, to: DAY, status: { type: 'string', enum: ['all', 'open', 'matched'] } }, ['account', 'from', 'to']) } },
    async (request) => bank.listLines(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/bank/lines`,
    {
      preValidation: guard('bank:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            account: bankAccountField,
            currency: bankCurrency,
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: bodyOf({ date: DAY, description: { type: 'string', minLength: 1, maxLength: 200 }, reference: { type: 'string', maxLength: 60 }, amount: signedInt }, ['date', 'description', 'amount']),
            },
          },
          ['account', 'lines'],
        ),
      },
    },
    async (request, reply) => reply.status(201).send(await bank.importLines(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.delete(`${base}/bank/lines/:id`, { preValidation: guard('bank:manage'), schema: { params: idParams } }, async (request) => bank.removeLine(request.ctx.tenantId, request.params.id, invoicingContext(request)));
  app.get(
    `${base}/bank/lines/:id/candidates`,
    { preValidation: guard('bank:read'), schema: { params: idParams, querystring: bodyOf({ days: { type: 'string', pattern: '^[0-9]{1,2}$' } }) } },
    async (request) => bank.candidates(request.ctx.tenantId, request.params.id, request.query.days === undefined ? {} : { days: Number(request.query.days) }),
  );
  app.post(
    `${base}/bank/lines/:id/book`,
    {
      preValidation: guard('bank:manage'),
      schema: { params: idParams, body: bodyOf({ counterAccount: bankAccountField, description: { type: 'string', maxLength: 200 }, costCenter: { type: 'string', maxLength: 10 }, partyId: OBJECT_ID }, ['counterAccount']) },
    },
    async (request, reply) => reply.status(201).send(await bank.bookLine(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request))),
  );
  app.post(
    `${base}/bank/matches`,
    { preValidation: guard('bank:manage'), schema: { params: tenantParams, body: bodyOf({ bankLineId: OBJECT_ID, journalId: OBJECT_ID, lineIndex: lineIndexField }, ['bankLineId', 'journalId', 'lineIndex']) } },
    async (request, reply) => reply.status(201).send(await bank.match(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.post(
    `${base}/bank/matches/manual`,
    {
      preValidation: guard('bank:manage'),
      schema: { params: tenantParams, body: bodyOf({ account: bankAccountField, currency: bankCurrency, journalId: OBJECT_ID, lineIndex: lineIndexField, reason: { type: 'string', minLength: 1, maxLength: 200 } }, ['account', 'journalId', 'lineIndex', 'reason']) },
    },
    async (request, reply) => reply.status(201).send(await bank.matchManual(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.post(
    `${base}/bank/matches/auto`,
    { preValidation: guard('bank:manage'), schema: { params: tenantParams, body: bodyOf({ account: bankAccountField, currency: bankCurrency, days: { type: 'integer', minimum: 0, maximum: 60 } }, ['account']) } },
    async (request) => bank.autoMatch(request.ctx.tenantId, request.body, invoicingContext(request)),
  );
  app.delete(`${base}/bank/matches/:id`, { preValidation: guard('bank:manage'), schema: { params: idParams } }, async (request) => bank.unmatch(request.ctx.tenantId, request.params.id, invoicingContext(request)));
  app.get(
    `${base}/bank/reconciliation`,
    {
      preValidation: guard('bank:read'),
      schema: { params: tenantParams, querystring: bodyOf({ account: bankAccountField, currency: bankCurrency, asOf: DAY, statementBalance: { type: 'string', pattern: '^-?[0-9]{1,16}$' } }, ['account', 'asOf', 'statementBalance']) },
    },
    async (request) => bank.reconciliation(request.ctx.tenantId, { ...request.query, statementBalance: Number(request.query.statementBalance) }),
  );
  app.get(
    `${base}/bank/reconciliations`,
    { preValidation: guard('bank:read'), schema: { params: tenantParams, querystring: bodyOf({ account: bankAccountField, currency: bankCurrency }, ['account']) } },
    async (request) => bank.listReconciliations(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/bank/reconciliations`,
    {
      preValidation: guard('bank:manage'),
      schema: { params: tenantParams, body: bodyOf({ account: bankAccountField, currency: bankCurrency, asOf: DAY, statementBalance: signedInt }, ['account', 'asOf', 'statementBalance']) },
    },
    async (request, reply) => reply.status(201).send(await bank.close(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.post(`${base}/bank/reconciliations/:id/reopen`, { preValidation: guard('bank:manage'), schema: { params: idParams } }, async (request) => bank.reopen(request.ctx.tenantId, request.params.id, invoicingContext(request)));

  // ---- Cotizaciones, órdenes de compra y facturas recurrentes ----
  const docLines = {
    type: 'array',
    minItems: 1,
    maxItems: 200,
    items: bodyOf(
      {
        description: { type: 'string', minLength: 1, maxLength: 200 },
        quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        unitPrice: money53,
        discountBps: { type: 'integer', minimum: 0, maximum: 10_000 },
        vatBps: { type: 'integer', minimum: 0, maximum: 10_000 },
        accountId: { type: 'string', pattern: '^[0-9]{1,12}$' },
        itemId: OBJECT_ID,
        warehouseId: OBJECT_ID,
        costCenter: { type: 'string', maxLength: 10 },
      },
      ['description', 'quantity', 'unitPrice'],
    ),
  };
  const notesField = { type: 'string', maxLength: 500 };
  const found = (doc, what) => doc ?? Promise.reject(Object.assign(new Error(`${what} no existe`), { code: 'NOT_FOUND' }));

  app.get(
    `${base}/quotes`,
    { preValidation: guard('invoices:read'), schema: { params: tenantParams, querystring: bodyOf({ customerId: OBJECT_ID, status: { type: 'string', enum: ['open', 'accepted', 'rejected', 'invoicing', 'invoiced', 'void'] }, ...pageQuery }) } },
    async (request) => commercial.listQuotes(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/quotes`,
    { preValidation: guard('invoices:issue'), schema: { params: tenantParams, body: bodyOf({ customerId: OBJECT_ID, issueDate: DAY, validUntil: DAY, notes: notesField, lines: docLines }, ['customerId', 'validUntil', 'lines']) } },
    async (request, reply) => reply.status(201).send(await commercial.createQuote(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(`${base}/quotes/:id`, { preValidation: guard('invoices:read'), schema: { params: idParams } }, async (request) => found(await commercial.getQuote(request.ctx.tenantId, request.params.id), 'la cotización'));
  for (const action of ['accept', 'reject', 'void']) {
    app.post(`${base}/quotes/:id/${action}`, { preValidation: guard('invoices:issue'), schema: { params: idParams } }, async (request) =>
      commercial.setQuoteStatus(request.ctx.tenantId, request.params.id, action, invoicingContext(request)),
    );
  }
  app.post(
    `${base}/quotes/:id/invoice`,
    { preValidation: guard('invoices:issue'), schema: { params: idParams, body: bodyOf({ paymentMethod: { type: 'string', enum: ['cash', 'credit'] }, issueDate: DAY, dueDate: DAY }, ['paymentMethod']) } },
    async (request, reply) => {
      const result = await commercial.invoiceQuote(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request));
      return reply.status(result.pending ? 202 : 201).send(result);
    },
  );

  app.get(
    `${base}/purchase-orders`,
    { preValidation: guard('purchases:read'), schema: { params: tenantParams, querystring: bodyOf({ supplierId: OBJECT_ID, status: { type: 'string', enum: ['open', 'receiving', 'received', 'void'] }, ...pageQuery }) } },
    async (request) => commercial.listOrders(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/purchase-orders`,
    { preValidation: guard('purchases:create'), schema: { params: tenantParams, body: bodyOf({ supplierId: OBJECT_ID, issueDate: DAY, expectedDate: DAY, notes: notesField, lines: docLines }, ['supplierId', 'lines']) } },
    async (request, reply) => reply.status(201).send(await commercial.createOrder(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(`${base}/purchase-orders/:id`, { preValidation: guard('purchases:read'), schema: { params: idParams } }, async (request) => found(await commercial.getOrder(request.ctx.tenantId, request.params.id), 'la orden'));
  app.post(`${base}/purchase-orders/:id/void`, { preValidation: guard('purchases:void'), schema: { params: idParams } }, async (request) => commercial.voidOrder(request.ctx.tenantId, request.params.id, invoicingContext(request)));
  app.post(
    `${base}/purchase-orders/:id/receive`,
    { preValidation: guard('purchases:create'), schema: { params: idParams, body: bodyOf({ supplierDocNumber: { type: 'string', minLength: 1, maxLength: 40 }, issueDate: DAY, dueDate: DAY }, ['supplierDocNumber']) } },
    async (request, reply) => reply.status(201).send(await commercial.receiveOrder(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request))),
  );

  app.get(
    `${base}/recurring-invoices`,
    { preValidation: guard('invoices:read'), schema: { params: tenantParams, querystring: bodyOf({ active: { type: 'string', enum: ['true', 'false'] }, ...pageQuery }) } },
    async (request) => commercial.listRecurring(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/recurring-invoices`,
    {
      preValidation: guard('invoices:issue'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            customerId: OBJECT_ID,
            frequency: { type: 'string', enum: ['weekly', 'monthly', 'quarterly', 'yearly'] },
            startDate: DAY,
            endDate: DAY,
            paymentMethod: { type: 'string', enum: ['cash', 'credit'] },
            dueDays: { type: 'integer', minimum: 0, maximum: 365 },
            notes: notesField,
            lines: docLines,
          },
          ['name', 'customerId', 'frequency', 'startDate', 'paymentMethod', 'lines'],
        ),
      },
    },
    async (request, reply) => reply.status(201).send(await commercial.createRecurring(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  // Va antes de «:id» por claridad; las rutas estáticas ya tienen prioridad sobre las de parámetro.
  app.post(
    `${base}/recurring-invoices/run`,
    { preValidation: [guard('invoices:issue'), optionalBody], schema: { params: tenantParams, body: bodyOf({ asOf: DAY, templateId: OBJECT_ID }) } },
    async (request) => commercial.runRecurring(request.ctx.tenantId, request.body ?? {}, invoicingContext(request)),
  );
  app.get(`${base}/recurring-invoices/:id`, { preValidation: guard('invoices:read'), schema: { params: idParams } }, async (request) => found(await commercial.getRecurring(request.ctx.tenantId, request.params.id), 'la plantilla'));
  app.patch(
    `${base}/recurring-invoices/:id`,
    { preValidation: guard('invoices:issue'), schema: { params: idParams, body: bodyOf({ active: { type: 'boolean' }, endDate: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' }, notes: { type: 'string', maxLength: 500 } }) } },
    async (request) => commercial.updateRecurring(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );
  app.post(`${base}/recurring-invoices/:id/skip`, { preValidation: guard('invoices:issue'), schema: { params: idParams } }, async (request) => commercial.skipRecurring(request.ctx.tenantId, request.params.id, invoicingContext(request)));

  // ---- Activos fijos y depreciación ----
  const assetAccount = { type: 'string', pattern: '^[0-9]{1,12}$' };
  app.get(
    `${base}/fixed-assets`,
    { preValidation: guard('assets:read'), schema: { params: tenantParams, querystring: bodyOf({ status: { type: 'string', enum: ['active', 'disposed'] }, ...pageQuery }) } },
    async (request) => fixedAssets.list(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/fixed-assets`,
    {
      preValidation: guard('assets:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            code: { type: 'string', minLength: 1, maxLength: 20 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            acquisitionDate: DAY,
            cost: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            salvageValue: money53,
            usefulLifeMonths: { type: 'integer', minimum: 1, maximum: 600 },
            depreciationStart: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}$' },
            costCenter: { type: 'string', maxLength: 10 },
            purchaseId: OBJECT_ID,
            accounts: bodyOf({ asset: assetAccount, accumulated: assetAccount, expense: assetAccount }, ['asset', 'accumulated', 'expense']),
          },
          ['code', 'name', 'acquisitionDate', 'cost', 'usefulLifeMonths', 'accounts'],
        ),
      },
    },
    async (request, reply) => reply.status(201).send(await fixedAssets.create(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(`${base}/fixed-assets/reconciliation`, { preValidation: guard('assets:read'), schema: { params: tenantParams, querystring: bodyOf({ currency: { type: 'string', minLength: 3, maxLength: 3 } }) } }, async (request) =>
    fixedAssets.reconciliation(request.ctx.tenantId, request.query),
  );
  app.get(`${base}/fixed-assets/depreciation-runs`, { preValidation: guard('assets:read'), schema: { params: tenantParams, querystring: bodyOf({ limit: { type: 'string', pattern: '^[0-9]{1,3}$' } }) } }, async (request) =>
    fixedAssets.listRuns(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/fixed-assets/depreciation`,
    { preValidation: guard('assets:manage'), schema: { params: tenantParams, body: bodyOf({ period: PERIOD }, ['period']) } },
    async (request, reply) => reply.status(201).send(await fixedAssets.depreciate(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(`${base}/fixed-assets/:id`, { preValidation: guard('assets:read'), schema: { params: idParams } }, async (request, reply) => {
    const asset = await fixedAssets.get(request.ctx.tenantId, request.params.id);
    return asset ?? reply.status(404).send({ error: 'NOT_FOUND', message: 'el activo no existe' });
  });
  app.patch(
    `${base}/fixed-assets/:id`,
    { preValidation: guard('assets:manage'), schema: { params: idParams, body: bodyOf({ name: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 500 }, costCenter: { type: 'string', maxLength: 10 } }) } },
    async (request) => fixedAssets.update(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );
  app.post(
    `${base}/fixed-assets/:id/dispose`,
    {
      preValidation: guard('assets:manage'),
      schema: { params: idParams, body: bodyOf({ date: DAY, proceeds: money53, proceedsAccount: assetAccount, gainAccount: assetAccount, lossAccount: assetAccount }, ['date']) },
    },
    async (request, reply) => reply.status(201).send(await fixedAssets.dispose(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request))),
  );

  // ---- Flujo de efectivo y presupuesto ----
  app.get(
    `${base}/reports/cash-flow`,
    {
      preValidation: guard('reports:read'),
      schema: {
        params: tenantParams,
        querystring: bodyOf({ from: DAY, to: DAY, currency: { type: 'string', minLength: 3, maxLength: 3 }, cash: { type: 'string', maxLength: 200 }, investing: { type: 'string', maxLength: 200 }, financing: { type: 'string', maxLength: 200 } }, ['from', 'to', 'currency']),
      },
    },
    async (request) => cashFlowReport.cashFlow(request.ctx.tenantId, request.query),
  );
  app.get(
    `${base}/reports/budget-execution`,
    {
      preValidation: guard('reports:read'),
      schema: { params: tenantParams, querystring: bodyOf({ from: PERIOD, to: PERIOD, currency: { type: 'string', minLength: 3, maxLength: 3 }, costCenter: { type: 'string', maxLength: 10 } }, ['from', 'to', 'currency']) },
    },
    async (request) => budgets.execution(request.ctx.tenantId, request.query),
  );
  const yearParams = { type: 'object', required: ['tenantId', 'year'], properties: { tenantId: OBJECT_ID, year: { type: 'string', pattern: '^[0-9]{4}$' } } };
  app.get(
    `${base}/budgets/:year`,
    { preValidation: guard('reports:read'), schema: { params: yearParams, querystring: bodyOf({ currency: { type: 'string', minLength: 3, maxLength: 3 } }) } },
    async (request) => budgets.list(request.ctx.tenantId, Number(request.params.year), request.query),
  );
  app.put(
    `${base}/budgets/:year`,
    {
      preValidation: guard('budgets:manage'),
      schema: {
        params: yearParams,
        body: bodyOf(
          {
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 300,
              items: bodyOf(
                { accountId: { type: 'string', pattern: '^[0-9]{1,12}$' }, costCenter: { type: 'string', maxLength: 10 }, months: { type: 'array', minItems: 12, maxItems: 12, items: money53 } },
                ['accountId', 'months'],
              ),
            },
          },
          ['lines'],
        ),
      },
    },
    async (request) => budgets.saveLines(request.ctx.tenantId, Number(request.params.year), request.body, invoicingContext(request)),
  );

  // ---- Nómina ----
  const payrollYear = { type: 'object', required: ['tenantId', 'year'], properties: { tenantId: OBJECT_ID, year: { type: 'string', pattern: '^[0-9]{4}$' } } };
  const rateField = { type: 'integer', minimum: 0, maximum: 10_000 };
  const novelty = bodyOf(
    {
      employeeId: OBJECT_ID,
      daysWorked: { type: 'integer', minimum: 0, maximum: 30 },
      salaryExtras: money53,
      nonSalaryExtras: money53,
      otherDeductions: money53,
      withholding: money53,
    },
    ['employeeId'],
  );
  const runBody = bodyOf({ period: PERIOD, novelties: { type: 'array', maxItems: 500, items: novelty } }, ['period']);
  app.get(`${base}/payroll/config`, { preValidation: guard('payroll:read'), schema: { params: tenantParams } }, async (request) => payroll.getConfig(request.ctx.tenantId));
  app.put(
    `${base}/payroll/config/accounts`,
    { preValidation: guard('payroll:manage'), schema: { params: tenantParams, body: bodyOf({ accounts: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9]{1,12}$' }, maxProperties: 40 } }, ['accounts']) } },
    async (request) => payroll.saveAccounts(request.ctx.tenantId, request.body, invoicingContext(request)),
  );
  app.put(
    `${base}/payroll/config/years/:year`,
    {
      preValidation: guard('payroll:manage'),
      schema: {
        params: payrollYear,
        body: bodyOf(
          {
            params: bodyOf(
              {
                smmlv: money53,
                transportAid: money53,
                uvt: money53,
                exonerated: { type: 'boolean' },
                withholding: { type: 'boolean' },
                aidLimitSmmlv: { type: 'integer', minimum: 1, maximum: 10 },
                ibcMaxSmmlv: { type: 'integer', minimum: 1, maximum: 100 },
                integralMinSmmlv: { type: 'integer', minimum: 1, maximum: 100 },
                rates: bodyOf({ employeeHealth: rateField, employeePension: rateField, employerHealth: rateField, employerPension: rateField, caja: rateField, sena: rateField, icbf: rateField, cesantias: rateField, cesantiasInterest: rateField, prima: rateField, vacations: rateField }),
                arl: { type: 'array', minItems: 5, maxItems: 5, items: { type: 'integer', minimum: 0, maximum: 100_000 } },
                solidarity: { type: 'array', maxItems: 12, items: bodyOf({ fromSmmlv: { type: 'integer', minimum: 1, maximum: 100 }, rateBps: rateField }, ['fromSmmlv', 'rateBps']) },
              },
              ['smmlv', 'transportAid', 'uvt'],
            ),
          },
          ['params'],
        ),
      },
    },
    async (request) => payroll.saveParams(request.ctx.tenantId, request.params.year, request.body, invoicingContext(request)),
  );
  const employeeFields = {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    baseSalary: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    salaryType: { type: 'string', enum: ['ordinary', 'integral'] },
    contractType: { type: 'string', enum: ['indefinite', 'fixed', 'service'] },
    transportAid: { type: 'boolean' },
    arlRiskLevel: { type: 'integer', minimum: 1, maximum: 5 },
    costCenter: { type: 'string', maxLength: 10 },
    position: { type: 'string', maxLength: 100 },
    email: { type: 'string', maxLength: 200 },
  };
  app.get(
    `${base}/payroll/employees`,
    { preValidation: guard('payroll:read'), schema: { params: tenantParams, querystring: bodyOf({ active: { type: 'string', enum: ['true', 'false'] }, ...pageQuery }) } },
    async (request) => payroll.listEmployees(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/payroll/employees`,
    {
      preValidation: guard('payroll:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf({ ...employeeFields, documentType: { type: 'string', enum: ['CC', 'CE', 'TI', 'PASSPORT', 'PEP', 'PPT'] }, documentNumber: { type: 'string', minLength: 1, maxLength: 20 }, hireDate: DAY, endDate: DAY }, ['documentType', 'documentNumber', 'name', 'hireDate', 'baseSalary']),
      },
    },
    async (request, reply) => reply.status(201).send(await payroll.createEmployee(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(`${base}/payroll/employees/:id`, { preValidation: guard('payroll:read'), schema: { params: idParams } }, async (request) => found(await payroll.getEmployee(request.ctx.tenantId, request.params.id), 'el empleado'));
  app.patch(
    `${base}/payroll/employees/:id`,
    {
      preValidation: guard('payroll:manage'),
      schema: { params: idParams, body: bodyOf({ ...employeeFields, active: { type: 'boolean' }, endDate: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' } }) },
    },
    async (request) => payroll.updateEmployee(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );
  app.post(`${base}/payroll/preview`, { preValidation: guard('payroll:read'), schema: { params: tenantParams, body: runBody } }, async (request) => payroll.preview(request.ctx.tenantId, request.body));
  app.get(
    `${base}/payroll/runs`,
    { preValidation: guard('payroll:read'), schema: { params: tenantParams, querystring: bodyOf({ ...pageQuery }) } },
    async (request) => payroll.listRuns(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/payroll/runs`,
    { preValidation: guard('payroll:manage'), schema: { params: tenantParams, headers: idempotencyHeader, body: runBody } },
    async (request, reply) => {
      const result = await payroll.createRun(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
  app.get(`${base}/payroll/runs/:id`, { preValidation: guard('payroll:read'), schema: { params: idParams } }, async (request) => found(await payroll.getRun(request.ctx.tenantId, request.params.id), 'la corrida'));
  app.post(`${base}/payroll/runs/:id/void`, { preValidation: guard('payroll:manage'), schema: { params: idParams } }, async (request) => payroll.voidRun(request.ctx.tenantId, request.params.id, invoicingContext(request)));
  for (const [path, method] of [['pay', 'pay'], ['pay-contributions', 'payContributions']]) {
    app.post(
      `${base}/payroll/runs/:id/${path}`,
      { preValidation: guard('payroll:manage'), schema: { params: idParams, body: bodyOf({ date: DAY, account: { type: 'string', pattern: '^[0-9]{1,12}$' } }, ['date', 'account']) } },
      async (request) => payroll[method](request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
    );
  }

  for (const [path, method] of [['void-payment', 'voidPayment'], ['void-contributions-payment', 'voidContributionsPayment']]) {
    app.post(`${base}/payroll/runs/:id/${path}`, { preValidation: guard('payroll:manage'), schema: { params: idParams } }, async (request) => payroll[method](request.ctx.tenantId, request.params.id, invoicingContext(request)));
  }

  // Prestaciones sociales: prima y cesantías.
  const benefitKind = { type: 'string', enum: ['prima', 'cesantias'] };
  const benefitLabel = { type: 'string', pattern: '^[0-9]{4}(-[12])?$' };
  app.post(
    `${base}/payroll/benefits/preview`,
    { preValidation: guard('payroll:read'), schema: { params: tenantParams, body: bodyOf({ kind: benefitKind, label: benefitLabel }, ['kind', 'label']) } },
    async (request) => benefits.preview(request.ctx.tenantId, request.body),
  );
  app.post(
    `${base}/payroll/benefits`,
    { preValidation: guard('payroll:manage'), schema: { params: tenantParams, body: bodyOf({ kind: benefitKind, label: benefitLabel }, ['kind', 'label']) } },
    async (request, reply) => reply.status(201).send(await benefits.settle(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(
    `${base}/payroll/benefits`,
    { preValidation: guard('payroll:read'), schema: { params: tenantParams, querystring: bodyOf({ limit: { type: 'string', pattern: '^[0-9]{1,3}$' } }) } },
    async (request) => benefits.list(request.ctx.tenantId, request.query),
  );
  app.get(`${base}/payroll/benefits/:id`, { preValidation: guard('payroll:read'), schema: { params: idParams } }, async (request) => found(await benefits.get(request.ctx.tenantId, request.params.id), 'la liquidación'));
  app.post(
    `${base}/payroll/benefits/:id/pay`,
    { preValidation: guard('payroll:manage'), schema: { params: idParams, body: bodyOf({ date: DAY, account: { type: 'string', pattern: '^[0-9]{1,12}$' } }, ['date', 'account']) } },
    async (request) => benefits.pay(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );

  app.post(`${base}/payroll/benefits/:id/void-payment`, { preValidation: guard('payroll:manage'), schema: { params: idParams } }, async (request) =>
    benefits.voidPayment(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  );
  app.post(`${base}/payroll/benefits/:id/void`, { preValidation: guard('payroll:manage'), schema: { params: idParams } }, async (request) =>
    benefits.void(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  );

  // Reportes de nómina.
  app.get(
    `${base}/payroll/reports/contributions`,
    { preValidation: guard('payroll:read'), schema: { params: tenantParams, querystring: bodyOf({ from: PERIOD, to: PERIOD }, ['from', 'to']) } },
    async (request) => payrollReports.contributions(request.ctx.tenantId, request.query),
  );
  app.get(`${base}/payroll/reports/provisions`, { preValidation: guard('payroll:read'), schema: { params: tenantParams } }, async (request) => payrollReports.provisions(request.ctx.tenantId));
  app.get(
    `${base}/payroll/runs/:id/payslips/:employeeId`,
    { preValidation: guard('payroll:read'), schema: { params: { type: 'object', required: ['tenantId', 'id', 'employeeId'], properties: { tenantId: OBJECT_ID, id: OBJECT_ID, employeeId: OBJECT_ID } } } },
    async (request) => payrollReports.payslip(request.ctx.tenantId, request.params.id, request.params.employeeId),
  );

  // Liquidación de contrato.
  const terminationBody = bodyOf(
    {
      employeeId: OBJECT_ID,
      endDate: DAY,
      vacationDaysPending: { type: 'number', minimum: 0, maximum: 400 },
      severance: money53,
      withholding: money53,
    },
    ['employeeId', 'endDate'],
  );
  app.post(`${base}/payroll/terminations/preview`, { preValidation: guard('payroll:read'), schema: { params: tenantParams, body: terminationBody } }, async (request) =>
    terminations.preview(request.ctx.tenantId, request.body),
  );
  app.post(
    `${base}/payroll/terminations`,
    { preValidation: guard('payroll:manage'), schema: { params: tenantParams, body: terminationBody } },
    async (request, reply) => reply.status(201).send(await terminations.settle(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.get(
    `${base}/payroll/terminations`,
    { preValidation: guard('payroll:read'), schema: { params: tenantParams, querystring: bodyOf({ limit: { type: 'string', pattern: '^[0-9]{1,3}$' } }) } },
    async (request) => terminations.list(request.ctx.tenantId, request.query),
  );
  app.get(`${base}/payroll/terminations/:id`, { preValidation: guard('payroll:read'), schema: { params: idParams } }, async (request) => found(await terminations.get(request.ctx.tenantId, request.params.id), 'la liquidación'));
  app.post(
    `${base}/payroll/terminations/:id/pay`,
    { preValidation: guard('payroll:manage'), schema: { params: idParams, body: bodyOf({ date: DAY, account: { type: 'string', pattern: '^[0-9]{1,12}$' } }, ['date', 'account']) } },
    async (request) => terminations.pay(request.ctx.tenantId, request.params.id, request.body, invoicingContext(request)),
  );
  app.post(`${base}/payroll/terminations/:id/void-payment`, { preValidation: guard('payroll:manage'), schema: { params: idParams } }, async (request) =>
    terminations.voidPayment(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  );
  app.post(`${base}/payroll/terminations/:id/void`, { preValidation: guard('payroll:manage'), schema: { params: idParams } }, async (request) =>
    terminations.void(request.ctx.tenantId, request.params.id, invoicingContext(request)),
  );

  // ---- Impuestos ----
  const taxRange = { from: DAY, to: DAY, currency: { type: 'string', minLength: 3, maxLength: 3 } };
  app.get(`${base}/reports/vat`, { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf(taxRange, ['from', 'to', 'currency']) } }, async (request) => taxes.vat(request.ctx.tenantId, request.query));
  app.get(
    `${base}/reports/exogena`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ year: { type: 'string', pattern: '^[0-9]{4}$' }, currency: { type: 'string', minLength: 3, maxLength: 3 }, minAmount: { type: 'string', pattern: '^[0-9]{1,15}$' } }, ['year', 'currency']) } },
    async (request) => taxes.exogena(request.ctx.tenantId, { ...request.query, minAmount: Number(request.query.minAmount ?? 0) }),
  );
  app.get(
    `${base}/reports/ica`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ ...taxRange, ratePpm: { type: 'string', pattern: '^[0-9]{1,6}$' }, excludeAccounts: { type: 'string', pattern: '^[0-9,]{0,200}$' } }, ['from', 'to', 'currency', 'ratePpm']) } },
    async (request) => {
      const { ratePpm, excludeAccounts, ...rest } = request.query;
      return taxes.ica(request.ctx.tenantId, { ...rest, ratePpm: Number(ratePpm), excludeAccounts: (excludeAccounts ?? '').split(',').filter(Boolean) });
    },
  );
  app.get(
    `${base}/reports/withholdings`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ ...taxRange, supplierId: OBJECT_ID }, ['from', 'to', 'currency']) } },
    async (request) => taxes.withholdings(request.ctx.tenantId, request.query),
  );
  app.get(
    `${base}/reports/withholdings-suffered`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ ...taxRange, customerId: OBJECT_ID }, ['from', 'to', 'currency']) } },
    async (request) => taxes.withholdingsSuffered(request.ctx.tenantId, request.query),
  );
  app.get(
    `${base}/reports/withholding-certificate`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ supplierId: OBJECT_ID, year: { type: 'string', pattern: '^[0-9]{4}$' }, currency: { type: 'string', minLength: 3, maxLength: 3 } }, ['supplierId', 'year', 'currency']) } },
    async (request) => taxes.certificate(request.ctx.tenantId, request.query),
  );
  app.get(`${base}/taxes/vat-close/preview`, { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf(taxRange, ['from', 'to', 'currency']) } }, async (request) => taxes.previewClose(request.ctx.tenantId, request.query));
  app.get(
    `${base}/taxes/vat-closes`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ limit: { type: 'string', pattern: '^[0-9]{1,3}$' } }) } },
    async (request) => taxes.listCloses(request.ctx.tenantId, request.query),
  );
  app.post(
    `${base}/taxes/vat-closes`,
    {
      preValidation: guard('taxes:manage'),
      schema: { params: tenantParams, body: bodyOf({ ...taxRange, dueAccount: { type: 'string', pattern: '^[0-9]{1,12}$' }, creditAccount: { type: 'string', pattern: '^[0-9]{1,12}$' } }, ['from', 'to', 'currency']) },
    },
    async (request, reply) => reply.status(201).send(await taxes.close(request.ctx.tenantId, request.body, invoicingContext(request))),
  );
  app.post(`${base}/taxes/vat-closes/:id/void`, { preValidation: guard('taxes:manage'), schema: { params: idParams } }, async (request) => taxes.voidClose(request.ctx.tenantId, request.params.id, invoicingContext(request)));

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

  // ---- Libros y estados de cuenta ----
  const bookQuery = (extra = {}, required = []) => bodyOf({ from: DAY, to: DAY, currency: { type: 'string', minLength: 3, maxLength: 3 }, ...extra }, ['from', 'to', 'currency', ...required]);
  for (const [path, run] of [
    ['sales-book', (q, tenantId) => books.salesBook(tenantId, q)],
    ['purchases-book', (q, tenantId) => books.purchasesBook(tenantId, q)],
  ]) {
    app.get(`${base}/reports/${path}`, { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bookQuery() } }, async (request) => run(request.query, request.ctx.tenantId));
  }
  app.get(
    `${base}/reports/customer-statement`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bookQuery({ partyId: OBJECT_ID }, ['partyId']) } },
    async (request) => books.customerStatement(request.ctx.tenantId, request.query),
  );
  app.get(
    `${base}/reports/supplier-statement`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bookQuery({ partyId: OBJECT_ID }, ['partyId']) } },
    async (request) => books.supplierStatement(request.ctx.tenantId, request.query),
  );
  app.get(
    `${base}/reports/sales-summary`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bookQuery({ by: { type: 'string', enum: ['customer', 'month'] } }, ['by']) } },
    async (request) => books.salesSummary(request.ctx.tenantId, request.query),
  );

  // ---- Reportes por dimensión: centro de costo y tercero ----
  app.get(
    `${base}/reports/cost-center-result`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ from: PERIOD, to: PERIOD, currency: { type: 'string', minLength: 3, maxLength: 3 } }, ['from', 'to', 'currency']) } },
    async (request) => dimensionReports.costCenterResult(request.ctx.tenantId, request.query),
  );
  app.get(
    `${base}/reports/party-ledger`,
    { preValidation: guard('reports:read'), schema: { params: tenantParams, querystring: bodyOf({ partyId: OBJECT_ID, from: PERIOD, to: PERIOD, currency: { type: 'string', minLength: 3, maxLength: 3 } }, ['partyId', 'from', 'to', 'currency']) } },
    async (request) => dimensionReports.partyLedger(request.ctx.tenantId, request.query),
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

  app.post(`${base}/periods/:period/reopen`, { preValidation: guard('periods:reopen'), schema: { params: periodParams } }, async (request) => {
    // Un período que cerró el cierre del ejercicio no se reabre suelto: se reabre el ejercicio.
    await yearEnd.assertPeriodReopenable(request.ctx.tenantId, request.params.period);
    return ledger.reopenPeriod(request.ctx.tenantId, request.params.period, request.ctx.userId, {
      inTx: tx(request, 'period.reopen', (r) => ({ target: r.period })),
    });
  });

  // ---- Cierre de ejercicio ----
  const yearBody = { year: { type: 'integer', minimum: 2000, maximum: 2100 }, currency: { type: 'string', minLength: 3, maxLength: 3 } };

  app.get(`${base}/year-end`, { preValidation: guard('reports:read'), schema: { params: tenantParams } }, async (request) => ({
    items: await yearEnd.list(request.ctx.tenantId),
  }));

  app.get(
    `${base}/year-end/preview`,
    {
      preValidation: guard('reports:read'),
      schema: { params: tenantParams, querystring: bodyOf({ year: { type: 'string', pattern: '^[0-9]{4}$' }, currency: yearBody.currency }, ['year', 'currency']) },
    },
    async (request) => yearEnd.preview(request.ctx.tenantId, { year: Number(request.query.year), currency: request.query.currency }),
  );

  app.post(
    `${base}/year-end/close`,
    {
      preValidation: guard('periods:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf({ ...yearBody, profitAccount: { type: 'string', pattern: '^[0-9]{1,12}$' }, lossAccount: { type: 'string', pattern: '^[0-9]{1,12}$' } }, ['year', 'currency', 'profitAccount']),
      },
    },
    async (request, reply) => {
      const result = await yearEnd.close(request.ctx.tenantId, request.body, invoicingContext(request));
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  app.post(
    `${base}/year-end/reopen`,
    { preValidation: guard('periods:reopen'), schema: { params: tenantParams, body: bodyOf(yearBody, ['year', 'currency']) } },
    async (request) => yearEnd.reopen(request.ctx.tenantId, request.body, invoicingContext(request)),
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
      preValidation: guard('users:manage', { stepUp: true }),
      schema: { params: memberParams, body: bodyOf({ role: { type: 'string', maxLength: 20 } }, ['role']) },
    },
    async (request, reply) => {
      await auth.changeRole(request.ctx, new ObjectId(request.params.userId), request.body.role, {
        inTx: tx(request, 'member.change_role', (r) => ({ target: r.userId, details: { role: r.role, revokedApiKeys: r.revokedApiKeys } })),
      });
      return reply.status(204).send();
    },
  );

  app.delete(`${base}/members/:userId`, { preValidation: guard('users:manage', { stepUp: true }), schema: { params: memberParams } }, async (request, reply) => {
    await auth.removeMember(request.ctx, new ObjectId(request.params.userId), {
      inTx: tx(request, 'member.remove', (r) => ({ target: r.userId, details: { revokedApiKeys: r.revokedApiKeys } })),
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
    `${base}/invoicing/withholding-presets`,
    {
      preValidation: guard('settings:manage'),
      schema: {
        params: tenantParams,
        body: bodyOf(
          {
            presets: {
              type: 'array',
              maxItems: 20,
              items: bodyOf(
                { name: { type: 'string', maxLength: 60 }, accountId: { type: 'string', maxLength: 12 }, basis: { type: 'string', maxLength: 10 }, rateBps: { type: 'integer', minimum: 1, maximum: 10000 } },
                ['name', 'accountId', 'basis', 'rateBps'],
              ),
            },
          },
          ['presets'],
        ),
      },
    },
    async (request) => ({
      presets: await settingsService.saveWithholdingPresets(request.ctx.tenantId, request.body.presets, { inTx: tx(request, 'invoicing.withholding_presets_update', (r) => r) }),
    }),
  );

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
              { receivable: { type: 'string', maxLength: 12 }, income: { type: 'string', maxLength: 12 }, vatPayable: { type: 'string', maxLength: 12 }, cash: { type: 'string', maxLength: 12 }, payable: { type: 'string', maxLength: 12 }, vatDeductible: { type: 'string', maxLength: 12 }, customerAdvance: { type: 'string', maxLength: 12 }, supplierAdvance: { type: 'string', maxLength: 12 } },
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
                  itemId: OBJECT_ID,
                  warehouseId: OBJECT_ID,
                  costCenter: { type: 'string', maxLength: 10 },
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

  // ---- Primeros pasos ----
  app.get(`${base}/onboarding`, { preValidation: guard('reports:read'), schema: { params: tenantParams } }, async (request) => onboarding.get(request.ctx.tenantId));

  // ---- Centros de costo ----
  app.get(
    `${base}/cost-centers`,
    { preValidation: guard('accounts:read'), schema: { params: tenantParams, querystring: bodyOf({ activeOnly: { type: 'string', enum: ['true', 'false'] } }) } },
    async (request) => ({ items: await costCenters.list(request.ctx.tenantId, { activeOnly: request.query.activeOnly === 'true' }) }),
  );
  app.post(
    `${base}/cost-centers`,
    {
      preValidation: guard('accounts:manage'),
      schema: { params: tenantParams, body: bodyOf({ code: { type: 'string', minLength: 1, maxLength: 10 }, name: { type: 'string', minLength: 1, maxLength: 100 } }, ['code', 'name']) },
    },
    async (request, reply) => reply.status(201).send(await costCenters.create(request.ctx.tenantId, request.body, { inTx: tx(request, 'cost_center.create', (c) => ({ target: c.code })) })),
  );
  app.patch(
    `${base}/cost-centers/:code`,
    {
      preValidation: guard('accounts:manage'),
      schema: {
        params: { type: 'object', required: ['tenantId', 'code'], properties: { tenantId: OBJECT_ID, code: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,9}$' } } },
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, active: { type: 'boolean' } } },
      },
    },
    async (request) => costCenters.update(request.ctx.tenantId, request.params.code, request.body, { inTx: tx(request, 'cost_center.update', () => ({ target: request.params.code })) }),
  );

  // ---- Claves de API ----
  app.get(`${base}/api-keys/scopes`, { preValidation: guard('apikeys:manage'), schema: { params: tenantParams } }, async (request) => ({
    scopes: GRANTABLE_SCOPES.filter((scope) => can(request.ctx.role, scope)),
  }));

  app.get(`${base}/api-keys`, { preValidation: guard('apikeys:manage'), schema: { params: tenantParams } }, async (request) => ({
    items: await apiKeys.list(request.ctx.tenantId),
  }));

  app.post(
    `${base}/api-keys`,
    {
      preValidation: guard('apikeys:manage', { stepUp: true }),
      schema: {
        params: tenantParams,
        body: bodyOf(
          { name: { type: 'string', minLength: 1, maxLength: 60 }, scopes: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string', maxLength: 40 } }, expiresAt: DAY },
          ['name', 'scopes'],
        ),
      },
    },
    async (request, reply) => {
      const created = await apiKeys.create(request.ctx, request.body, {
        inTx: tx(request, 'apikey.create', (k) => ({ target: k._id, details: { name: k.name, prefix: k.prefix } })),
      });
      return reply.status(201).send(created);
    },
  );

  app.post(`${base}/api-keys/:id/revoke`, { preValidation: guard('apikeys:manage'), schema: { params: idParams } }, async (request) => ({
    apiKey: await apiKeys.revoke(request.ctx.tenantId, request.params.id, {
      inTx: tx(request, 'apikey.revoke', (k) => ({ target: k._id, details: { name: k.name, prefix: k.prefix } })),
    }),
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

  // ---- Datos de la empresa ----
  // Solo el propietario (`tenant:manage`); las claves de API no pueden tener ese permiso. Queda en la auditoría.
  app.get(`${base}/export`, { preValidation: guard('tenant:manage', { stepUp: true }), schema: { params: tenantParams } }, async (request, reply) => {
    const { lines, release } = exporter.start(request.ctx.tenantId);
    try {
      await auditLog.record({ tenantId: request.ctx.tenantId, userId: request.ctx.userId, action: 'tenant.export', ip: request.ip, requestId: request.id });
    } catch (error) {
      release();
      throw error;
    }
    reply.raw.on('close', release);
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="lulubiz-${request.ctx.tenantId}-${day}.ndjson"`)
      .send(Readable.from(lines));
  });

  return app;
}
