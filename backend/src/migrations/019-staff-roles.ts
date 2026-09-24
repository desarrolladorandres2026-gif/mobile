import mongoose, { Types } from 'mongoose';
import { User, Role } from '../models';
import { UserRole } from '../types';
import { Permission, STAFF_ROLE_PERMISSIONS, SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';
import { getEffectiveRoles, resolveAuthorization, RBAC_ENFORCE_FLAG } from '../services/authorization.service';

/**
 * Migración 019 — Roles del equipo (Fase 1 de permisos reales).
 *
 * Manual, fuera de `deploy.sh`. Idempotente. Nada destructivo: solo añade
 * roles (`$addToSet`), reescribe los permisos de roles de la plantilla que el
 * dueño no haya editado, y NO borra `isFinanceAdmin` ni toca cargos.
 *
 *   npm run migrate:staff-roles -- --dry-run
 *   npm run migrate:staff-roles -- --super-admins=uno@x.co,dos@x.co
 *   npm run migrate:staff-roles -- --force-roles     (sobrescribe roles editados a mano)
 *
 * Pasos: (1) resincroniza super_admin con el enum; (2) upsert de los 4 roles
 * de `STAFF_ROLE_PERMISSIONS`; (3) Super Administrador a los admins activos
 * (aborta con más de 2 salvo `--super-admins`); (4) `isFinanceAdmin` →
 * rol `finanzas`; (5) informe por persona.
 */

export interface StaffMigrationOptions {
  dryRun?: boolean;
  forceRoles?: boolean;
  /** Correos que reciben Super Administrador. Obligatorio si hay más de 2 admins activos. */
  superAdmins?: string[];
}

export interface RoleDiff {
  slug: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped_edited';
  added: string[];
  removed: string[];
}

export interface StaffPersonReport {
  email: string;
  roles: string[];
  /** legacyUnion − strict proyectado: lo que dejaría de poder hacer al activar el bloqueo. */
  loses: string[];
  legacyRoles: string[];
}

export interface StaffMigrationReport {
  dryRun: boolean;
  mode: 'observe' | 'enforce';
  roles: RoleDiff[];
  superAdminsAssigned: string[];
  financeRoleAssigned: string[];
  people: StaffPersonReport[];
  warnings: string[];
}

const LEGACY_ROLE_SLUGS = ['admin', 'operador', 'analista', 'auditor'];

export class StaffMigrationAbort extends Error {}

export async function migrateStaffRoles(options: StaffMigrationOptions = {}): Promise<StaffMigrationReport> {
  const { dryRun = false, forceRoles = false } = options;
  const report: StaffMigrationReport = {
    dryRun,
    mode: 'observe',
    roles: [],
    superAdminsAssigned: [],
    financeRoleAssigned: [],
    people: [],
    warnings: [],
  };
  const allPermissions = Object.values(Permission) as Permission[];
  const emails = (options.superAdmins ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);

  // ── Validación previa (antes de escribir nada) ──
  const activeAdmins = await User.find({ role: UserRole.ADMIN, isActive: true, isBlocked: { $ne: true } });
  let superAdminTargets = activeAdmins;
  if (emails.length > 0) {
    superAdminTargets = activeAdmins.filter((a) => a.email && emails.includes(a.email.toLowerCase()));
    const missing = emails.filter((e) => !superAdminTargets.some((a) => a.email?.toLowerCase() === e));
    if (missing.length > 0) {
      throw new StaffMigrationAbort(`--super-admins: no hay un admin activo con el correo ${missing.join(', ')}.`);
    }
  } else if (activeAdmins.length > 2) {
    throw new StaffMigrationAbort(
      `Hay ${activeAdmins.length} administradores activos (más de 2). Indica quién será Super Administrador con ` +
        '--super-admins=correo1,correo2. No se escribió nada.'
    );
  }

  // ── 1. super_admin resincronizado ──
  const existingSuper = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG }).lean();
  const superDiff = diffPermissions(existingSuper?.permissions ?? [], allPermissions);
  report.roles.push({
    slug: SUPER_ADMIN_ROLE_SLUG,
    action: !existingSuper ? 'created' : superDiff.added.length ? 'updated' : 'unchanged',
    ...superDiff,
  });
  let superRoleId: Types.ObjectId | undefined = existingSuper?._id as Types.ObjectId | undefined;
  if (!dryRun) {
    const doc = await Role.findOneAndUpdate(
      { slug: SUPER_ADMIN_ROLE_SLUG },
      {
        $set: { permissions: allPermissions, isActive: true, isSystem: true },
        $setOnInsert: { name: 'Super Administrador', description: 'Rol de sistema con acceso total. No editable.' },
      },
      { upsert: true, new: true }
    );
    superRoleId = doc._id as Types.ObjectId;
  }

  // ── 2. Los 4 roles de la plantilla ──
  const afterPerms = new Map<string, Permission[]>();
  afterPerms.set(SUPER_ADMIN_ROLE_SLUG, allPermissions);
  const roleIdBySlug = new Map<string, Types.ObjectId>();
  for (const [slug, def] of Object.entries(STAFF_ROLE_PERMISSIONS)) {
    const existing = await Role.findOne({ slug }).lean();
    const diff = diffPermissions(existing?.permissions ?? [], def.permissions);
    if (existing?.updatedBy && !forceRoles) {
      report.roles.push({ slug, action: 'skipped_edited', ...diff });
      report.warnings.push(
        `El rol "${slug}" fue editado a mano (updatedBy): NO se sobrescribe. Usa --force-roles si quieres la plantilla.`
      );
      afterPerms.set(slug, existing.permissions ?? []);
      roleIdBySlug.set(slug, existing._id as Types.ObjectId);
      continue;
    }
    report.roles.push({
      slug,
      action: !existing ? 'created' : diff.added.length || diff.removed.length ? 'updated' : 'unchanged',
      ...diff,
    });
    afterPerms.set(slug, def.permissions);
    if (existing) roleIdBySlug.set(slug, existing._id as Types.ObjectId);
    if (!dryRun) {
      const doc = await Role.findOneAndUpdate(
        { slug },
        {
          $set: { name: def.name, description: def.description, permissions: def.permissions, isActive: true },
          $setOnInsert: { isSystem: false },
        },
        { upsert: true, new: true }
      );
      roleIdBySlug.set(slug, doc._id as Types.ObjectId);
    }
  }

  // ── Estado previo de cada admin (para el informe) ──
  const staff = await User.find({ role: UserRole.ADMIN }).sort({ createdAt: 1 });
  const before = new Map<string, { slugs: string[]; perms: Map<string, Permission[]>; legacy: Permission[] }>();
  for (const u of staff) {
    const roles = await getEffectiveRoles(u);
    const authz = await resolveAuthorization(u);
    report.mode = authz.mode;
    before.set(u._id.toString(), {
      slugs: roles.map((r) => r.slug),
      perms: new Map(roles.map((r) => [r.slug, r.permissions || []])),
      legacy: authz.legacyUnion,
    });
  }

  // ── 3. Super Administrador ──
  const superIds = new Set<string>();
  for (const admin of superAdminTargets) {
    superIds.add(admin._id.toString());
    const already = superRoleId && admin.roleIds?.some((id) => id.equals(superRoleId!));
    if (already) continue;
    report.superAdminsAssigned.push(admin.email ?? admin._id.toString());
    if (!dryRun && superRoleId) {
      await User.updateOne({ _id: admin._id }, { $addToSet: { roleIds: superRoleId } });
    }
  }

  // ── 4. isFinanceAdmin → rol finanzas (el campo no se borra) ──
  const financeIds = new Set<string>();
  for (const u of staff) {
    if (u.isFinanceAdmin !== true) continue;
    const isSuper = superIds.has(u._id.toString()) || before.get(u._id.toString())!.slugs.includes(SUPER_ADMIN_ROLE_SLUG);
    if (isSuper) continue;
    financeIds.add(u._id.toString());
    const fid = roleIdBySlug.get('finanzas');
    if (fid && u.roleIds?.some((id) => id.equals(fid))) continue;
    report.financeRoleAssigned.push(u.email ?? u._id.toString());
    if (!dryRun && fid) await User.updateOne({ _id: u._id }, { $addToSet: { roleIds: fid } });
  }

  // ── 6. Informe por persona (estado proyectado tras la migración) ──
  for (const u of staff) {
    const b = before.get(u._id.toString())!;
    const slugs = new Set(b.slugs);
    if (superIds.has(u._id.toString())) slugs.add(SUPER_ADMIN_ROLE_SLUG);
    if (financeIds.has(u._id.toString())) slugs.add('finanzas');
    const strict = new Set<Permission>([Permission.ADMIN_PANEL]);
    for (const slug of slugs) {
      const perms = afterPerms.get(slug) ?? b.perms.get(slug) ?? [];
      for (const p of perms) strict.add(p);
    }
    const legacy = new Set<Permission>(b.legacy);
    if (slugs.has(SUPER_ADMIN_ROLE_SLUG)) allPermissions.forEach((p) => legacy.add(p));
    report.people.push({
      email: u.email ?? u._id.toString(),
      roles: Array.from(slugs).sort(),
      loses: Array.from(legacy).filter((p) => !strict.has(p)).sort(),
      legacyRoles: Array.from(slugs).filter((s) => LEGACY_ROLE_SLUGS.includes(s)),
    });
  }

  return report;
}

function diffPermissions(current: string[], next: string[]): { added: string[]; removed: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  return {
    added: next.filter((p) => !cur.has(p)).sort(),
    removed: current.filter((p) => !nxt.has(p)).sort(),
  };
}

export function printStaffReport(report: StaffMigrationReport, log: (s: string) => void = console.log): void {
  log(`  Modo actual (${RBAC_ENFORCE_FLAG})  ${report.mode}`);
  log('\n  Roles:');
  for (const r of report.roles) {
    log(`   • ${r.slug}  [${r.action}]`);
    if (r.added.length) log(`       + ${r.added.join(', ')}`);
    if (r.removed.length) log(`       - ${r.removed.join(', ')}`);
  }
  log(`\n  Super Administrador nuevo   ${report.superAdminsAssigned.join(', ') || '(ninguno)'}`);
  log(`  Rol finanzas (isFinanceAdmin) ${report.financeRoleAssigned.join(', ') || '(ninguno)'}`);
  log('\n  Equipo (estado tras la migración):');
  for (const p of report.people) {
    log(`   • ${p.email}`);
    log(`       roles:   ${p.roles.join(', ') || '(ninguno: solo admin:panel)'}`);
    log(`       pierde:  ${p.loses.join(', ') || '(nada)'}`);
    if (p.legacyRoles.length) log(`       conserva roles viejos de la 002: ${p.legacyRoles.join(', ')}`);
  }
  if (report.warnings.length) {
    log(`\n  Advertencias (${report.warnings.length}):`);
    for (const w of report.warnings) log(`   • ${w}`);
  }
}

// ── CLI ──
if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const forceRoles = argv.includes('--force-roles');
  const sa = argv.find((a) => a.startsWith('--super-admins='));
  const superAdmins = sa ? sa.slice('--super-admins='.length).split(',') : undefined;

  (async () => {
    const { config } = await import('../config');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 019 — Roles del equipo${dryRun ? ' (ejecución en seco)' : ''}\n`);
    try {
      const report = await migrateStaffRoles({ dryRun, forceRoles, superAdmins });
      printStaffReport(report);
      console.log(dryRun ? '\n✔ En seco: no se escribió nada\n' : '\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración no se aplicó:', error instanceof StaffMigrationAbort ? error.message : error);
      process.exit(1);
    }
  })();
}
