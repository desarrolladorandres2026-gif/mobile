import { Request } from 'express';
import { Order, Business, Driver, User, Coupon } from '../models';
import { Permission, logAudit, AuditAction, AuditSeverity, hashForSearch } from '../security';
import { can } from '../middlewares/auth';
import { escapeRegex, normalize } from '../utils/text';
import { normalizePhone } from '../utils/phone';
import { UserRole } from '../types';
import { maskPhoneOrNull, maskEmailKeepDomain } from './profileMasking';
import type { SearchType } from '../validators/adminSearch.validator';

/**
 * Búsqueda global del panel admin. La forma de `q` decide dónde se busca; nada
 * de totales, 5 por tipo, y un tipo sin permiso ni se consulta ni se menciona.
 * La cédula no se busca (D2).
 */
export const SEARCH_LIMIT = 5;
const NAME_MAX_TIME_MS = 1500;

const TYPE_PERMISSION: Record<SearchType, Permission> = {
  order: Permission.ORDERS_VIEW_ALL,
  user: Permission.USERS_VIEW,
  driver: Permission.DRIVERS_VIEW,
  business: Permission.BUSINESSES_VIEW,
  coupon: Permission.COUPONS_VIEW,
};

export type QueryShape =
  | { kind: 'order_number'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'plate'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'none'; value: string };

export function classifyQuery(raw: string): QueryShape {
  const q = raw.trim();
  if (/^\d{1,8}$/.test(q)) return { kind: 'order_number', value: q.padStart(6, '0') };
  const phone = normalizePhone(q);
  if (phone && /^3\d{9}$/.test(phone)) return { kind: 'phone', value: phone };
  if (q.includes('@')) return { kind: 'email', value: q.toLowerCase() };
  if (/^[A-Za-z]{3}[- ]?\d{2}[A-Za-z0-9]$/.test(q)) return { kind: 'plate', value: q.replace(/[- ]/g, '').toUpperCase() };
  if (q.length >= 3) return { kind: 'text', value: q };
  return { kind: 'none', value: q };
}

/** Huella para auditar un término personal sin guardarlo. `loose`: teléfono parcial (>=4 dígitos). */
export function sensitiveTermFingerprint(raw: string, loose = false) {
  const q = raw.trim();
  if (q.includes('@')) return { kind: 'email' as const, qHash: hashForSearch(q), last4: null };
  const shape = classifyQuery(q);
  if (shape.kind === 'phone') return { kind: 'phone' as const, qHash: hashForSearch(shape.value), last4: shape.value.slice(-4) };
  if (loose && /^\+?[\d\s().-]+$/.test(q)) {
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4) return { kind: 'phone' as const, qHash: hashForSearch(digits), last4: digits.slice(-4) };
  }
  return null;
}

/** Audita ADMIN_SEARCH si el término parece teléfono o correo. Nunca escribe el término ni la query string. */
export async function auditSensitiveSearch(req: Request, raw: string, route: string, loose = false): Promise<void> {
  const fp = sensitiveTermFingerprint(raw, loose);
  if (!fp) return;
  await logAudit(req, {
    action: AuditAction.ADMIN_SEARCH,
    entity: 'admin_search',
    severity: AuditSeverity.LOW,
    description: `Búsqueda por ${fp.kind === 'phone' ? 'teléfono' : 'correo'} en el panel admin`,
    metadata: fp,
    pathOverride: route,
  });
}

async function safe<T>(p: PromiseLike<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (e: any) {
    if (e?.code === 50 || /time limit/i.test(String(e?.message))) return [];
    throw e;
  }
}

export interface SearchResults {
  orders?: unknown[];
  users?: unknown[];
  businesses?: unknown[];
  drivers?: unknown[];
  coupons?: unknown[];
}

export async function search(req: Request, rawQ: string, requested?: SearchType[]): Promise<{ results: SearchResults }> {
  const shape = classifyQuery(rawQ);
  const allowed = new Set<SearchType>(
    (Object.keys(TYPE_PERMISSION) as SearchType[]).filter(
      (t) => (!requested || requested.includes(t)) && can(req, TYPE_PERMISSION[t])
    )
  );
  const canDrivers = can(req, Permission.DRIVERS_VIEW);
  const results: SearchResults = {};

  if (shape.kind === 'phone' || shape.kind === 'email') {
    await auditSensitiveSearch(req, rawQ, '/api/v1/admin/search');
  }

  const userHit = (u: any) => ({
    _id: String(u._id),
    name: u.name,
    role: u.role,
    phoneMasked: maskPhoneOrNull(u.phone),
    emailMasked: maskEmailKeepDomain(u.email),
    isActive: u.isActive,
  });

  if (shape.kind === 'order_number' && allowed.has('order')) {
    const orders = await Order.find({ orderNumber: shape.value }).select('orderNumber status kind createdAt businessId').limit(SEARCH_LIMIT).lean();
    const ids = orders.map((o: any) => o.businessId).filter(Boolean);
    const names = new Map((await Business.find({ _id: { $in: ids } }).select('name').lean()).map((b: any) => [String(b._id), b.name]));
    results.orders = orders.map((o: any) => ({
      _id: String(o._id),
      orderNumber: o.orderNumber,
      status: o.status,
      kind: o.kind,
      createdAt: o.createdAt,
      businessName: o.businessId ? names.get(String(o.businessId)) : undefined,
    }));
  }

  if (shape.kind === 'phone' || shape.kind === 'email') {
    const filter = shape.kind === 'phone' ? { phone: shape.value } : { email: shape.value };
    const found: any = await User.findOne(filter).select('name role phone email isActive').lean();
    const isDriverRole = found?.role === UserRole.DRIVER;
    if (allowed.has('user')) {
      results.users = found && (!isDriverRole || canDrivers) ? [userHit(found)] : [];
    }
    if (allowed.has('driver')) {
      const d: any = found && isDriverRole ? await Driver.findOne({ userId: found._id }).select('licensePlate status isApproved').lean() : null;
      results.drivers = d ? [{ _id: String(d._id), name: found.name, licensePlate: d.licensePlate, status: d.status, isApproved: d.isApproved }] : [];
    }
  }

  if (shape.kind === 'plate' && allowed.has('driver')) {
    const m = shape.value.match(/^([A-Z]{3})(.{3})$/)!;
    const pattern = `^${escapeRegex(m[1])}[- ]?${escapeRegex(m[2])}$`;
    const drivers: any[] = await Driver.find({ licensePlate: { $regex: pattern } }).select('userId licensePlate status isApproved').limit(SEARCH_LIMIT).lean();
    const names = new Map((await User.find({ _id: { $in: drivers.map((d) => d.userId) } }).select('name').lean()).map((u: any) => [String(u._id), u.name]));
    results.drivers = drivers.map((d) => ({
      _id: String(d._id),
      name: names.get(String(d.userId)) ?? '',
      licensePlate: d.licensePlate,
      status: d.status,
      isApproved: d.isApproved,
    }));
  }

  if (shape.kind === 'text') {
    const jobs: Promise<void>[] = [];
    if (allowed.has('business')) {
      const n = normalize(shape.value);
      jobs.push(
        (async () => {
          const rows: any[] =
            n.length >= 3
              ? await Business.find({ searchName: { $regex: `^${escapeRegex(n)}` } })
                  .select('name city isApproved isSuspended isArchived')
                  .sort({ searchName: 1 })
                  .limit(SEARCH_LIMIT)
                  .lean()
              : [];
          results.businesses = rows.map((b) => ({
            _id: String(b._id), name: b.name, city: b.city, isApproved: b.isApproved, isSuspended: b.isSuspended, isArchived: b.isArchived,
          }));
        })()
      );
    }
    if (allowed.has('user')) {
      const filter: Record<string, unknown> = { name: { $regex: `^${escapeRegex(shape.value)}`, $options: 'i' } };
      if (!canDrivers) filter.role = { $ne: UserRole.DRIVER };
      jobs.push(
        (async () => {
          const rows: any[] = await safe(
            User.find(filter).select('name role phone email isActive').limit(SEARCH_LIMIT).maxTimeMS(NAME_MAX_TIME_MS).lean() as any
          );
          results.users = rows.map(userHit);
        })()
      );
    }
    if (allowed.has('coupon')) {
      jobs.push(
        (async () => {
          const rows: any[] = await Coupon.find({ code: { $regex: `^${escapeRegex(shape.value.toUpperCase())}` } })
            .select('code isActive validUntil businessId')
            .sort({ code: 1 })
            .limit(SEARCH_LIMIT)
            .lean();
          results.coupons = rows.map((c) => ({
            _id: String(c._id), code: c.code, isActive: c.isActive, validUntil: c.validUntil, businessId: c.businessId ? String(c.businessId) : null,
          }));
        })()
      );
    }
    await Promise.all(jobs);
  }

  return { results };
}

export const adminSearchService = { search, classifyQuery };
