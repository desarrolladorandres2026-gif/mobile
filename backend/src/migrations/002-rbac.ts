import mongoose from 'mongoose';
import { User, Position, Role } from '../models';
import { UserRole } from '../types';
import { Permission, SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';

/**
 * Migración 002 — Seguridad y Acceso (Cargos, Roles, Permisos).
 *
 * Puramente aditiva: crea colecciones nuevas y, como mucho, AÑADE un
 * `positionId`/`roleIds` a la cuenta administrativa principal existente.
 * No borra, no reescribe `User.role` en nadie, no toca ningún otro dato.
 * Segura de ejecutar más de una vez — cada paso se salta lo que ya existe.
 *
 * "Cuenta principal" se resuelve como la cuenta `role: admin` más antigua
 * (por `createdAt`), no por email/teléfono fijo: así funciona igual sobre
 * cualquier base de datos real, no solo sobre los datos de `seed.ts`.
 */

export interface RbacMigrationReport {
  rolesCreated: string[];
  rolesAlreadyExisted: string[];
  positionsCreated: string[];
  positionsAlreadyExisted: string[];
  superAdminAssignedTo: string | null;
  warnings: string[];
}

// Roles base sugeridos por la especificación. Editables desde el panel una
// vez creados — esto solo siembra un punto de partida razonable.
const BASE_ROLES: Array<{ slug: string; name: string; description: string; permissions: Permission[] }> = [
  {
    slug: 'admin',
    name: 'Administrador',
    description: 'Gestión operativa completa: usuarios, negocios, pedidos, domiciliarios y seguridad.',
    permissions: [
      Permission.USERS_VIEW, Permission.USERS_CREATE, Permission.USERS_UPDATE, Permission.USERS_BLOCK, Permission.USERS_ROLE_CHANGE,
      Permission.ORDERS_VIEW_ALL, Permission.ORDERS_UPDATE, Permission.ORDERS_CANCEL, Permission.ORDERS_MODIFY, Permission.ORDERS_ASSIGN_DRIVER,
      Permission.BUSINESSES_VIEW, Permission.BUSINESSES_UPDATE_ALL, Permission.BUSINESSES_APPROVE,
      Permission.PRODUCTS_VIEW,
      Permission.DRIVERS_VIEW, Permission.DRIVERS_APPROVE, Permission.DRIVERS_SUSPEND, Permission.DRIVERS_TRACK,
      Permission.FINANCE_VIEW, Permission.COMMISSIONS_VIEW,
      Permission.ADMIN_PANEL, Permission.ADMIN_REPORTS, Permission.ADMIN_AUDIT_LOGS,
      Permission.SECURITY_VIEW, Permission.FRAUD_ALERTS_VIEW, Permission.FRAUD_ALERTS_MANAGE,
      Permission.NOTIFICATIONS_SEND, Permission.NOTIFICATIONS_VIEW,
      Permission.POSITIONS_VIEW, Permission.ROLES_VIEW, Permission.REPORTS_VIEW, Permission.REPORTS_EXPORT, Permission.SETTINGS_VIEW,
    ],
  },
  {
    slug: 'operador',
    name: 'Operador',
    description: 'Operación diaria: pedidos, domiciliarios y negocios, sin acceso financiero ni administrativo de cuentas.',
    permissions: [
      Permission.USERS_VIEW,
      Permission.ORDERS_VIEW_ALL, Permission.ORDERS_UPDATE, Permission.ORDERS_ASSIGN_DRIVER,
      Permission.BUSINESSES_VIEW, Permission.PRODUCTS_VIEW,
      Permission.DRIVERS_VIEW, Permission.DRIVERS_TRACK,
      Permission.ADMIN_PANEL, Permission.NOTIFICATIONS_VIEW, Permission.FRAUD_ALERTS_VIEW,
    ],
  },
  {
    slug: 'finanzas',
    name: 'Finanzas',
    description: 'Comisiones, liquidaciones y reportes financieros.',
    permissions: [
      Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE,
      Permission.COMMISSIONS_VIEW, Permission.COMMISSIONS_MANAGE, Permission.PAYOUTS_PROCESS,
      Permission.REPORTS_VIEW, Permission.REPORTS_EXPORT,
      Permission.ADMIN_PANEL,
    ],
  },
  {
    slug: 'soporte',
    name: 'Soporte técnico',
    description: 'Atención al usuario: consulta de cuentas y pedidos, sin permisos destructivos.',
    permissions: [
      Permission.USERS_VIEW,
      Permission.ORDERS_VIEW_ALL,
      Permission.BUSINESSES_VIEW, Permission.PRODUCTS_VIEW,
      Permission.DRIVERS_VIEW,
      Permission.NOTIFICATIONS_VIEW, Permission.NOTIFICATIONS_SEND,
      Permission.ADMIN_PANEL,
    ],
  },
  {
    slug: 'analista',
    name: 'Analista',
    description: 'Solo lectura: reportes y datos operativos/financieros, sin acción sobre ningún recurso.',
    permissions: [
      Permission.USERS_VIEW, Permission.ORDERS_VIEW_ALL, Permission.BUSINESSES_VIEW,
      Permission.DRIVERS_VIEW, Permission.FINANCE_VIEW, Permission.COMMISSIONS_VIEW,
      Permission.REPORTS_VIEW, Permission.REPORTS_EXPORT, Permission.ADMIN_PANEL,
    ],
  },
  {
    slug: 'auditor',
    name: 'Auditor',
    description: 'Auditoría y seguridad: solo lectura de logs, sesiones y alertas.',
    permissions: [
      Permission.ADMIN_AUDIT_LOGS, Permission.SECURITY_VIEW,
      Permission.FRAUD_ALERTS_VIEW, Permission.USERS_VIEW,
      Permission.ADMIN_PANEL,
    ],
  },
];

const BASE_POSITIONS: Array<{ slug: string; name: string; description: string; roleSlug: string | null }> = [
  { slug: 'superadministrador', name: 'Superadministrador', description: 'Cuenta principal de la plataforma. Acceso total.', roleSlug: SUPER_ADMIN_ROLE_SLUG },
  { slug: 'administrador', name: 'Administrador', description: 'Gestión operativa general.', roleSlug: 'admin' },
  { slug: 'operaciones', name: 'Operaciones', description: 'Seguimiento diario de pedidos y domiciliarios.', roleSlug: 'operador' },
  { slug: 'atencion_al_usuario', name: 'Atención al usuario', description: 'Soporte a clientes, negocios y domiciliarios.', roleSlug: 'soporte' },
  { slug: 'finanzas', name: 'Finanzas', description: 'Comisiones, liquidaciones y conciliación.', roleSlug: 'finanzas' },
  { slug: 'analista', name: 'Analista', description: 'Reportes y análisis de datos.', roleSlug: 'analista' },
  { slug: 'soporte_tecnico', name: 'Soporte técnico', description: 'Soporte técnico interno.', roleSlug: 'soporte' },
  { slug: 'auditor', name: 'Auditor', description: 'Auditoría y cumplimiento.', roleSlug: 'auditor' },
];

export async function migrateRbac(options: { dryRun?: boolean } = {}): Promise<RbacMigrationReport> {
  const report: RbacMigrationReport = {
    rolesCreated: [],
    rolesAlreadyExisted: [],
    positionsCreated: [],
    positionsAlreadyExisted: [],
    superAdminAssignedTo: null,
    warnings: [],
  };

  // ── 1. Rol de sistema SUPER_ADMIN: siempre todos los permisos ──
  let superAdminRole = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG });
  if (!superAdminRole) {
    if (!options.dryRun) {
      superAdminRole = await Role.create({
        name: 'Super Administrador',
        slug: SUPER_ADMIN_ROLE_SLUG,
        description: 'Rol de sistema con acceso total. No editable.',
        permissions: Object.values(Permission),
        isActive: true,
        isSystem: true,
      });
    }
    report.rolesCreated.push(SUPER_ADMIN_ROLE_SLUG);
  } else {
    // Se resincroniza con el enum actual: si el código agregó permisos
    // nuevos, el rol de sistema los recibe automáticamente sin necesidad
    // de otra migración.
    if (!options.dryRun) {
      superAdminRole.permissions = Object.values(Permission);
      superAdminRole.isSystem = true;
      superAdminRole.isActive = true;
      await superAdminRole.save();
    }
    report.rolesAlreadyExisted.push(SUPER_ADMIN_ROLE_SLUG);
  }

  // ── 2. Roles base ──
  const roleIdBySlug = new Map<string, mongoose.Types.ObjectId>();
  if (superAdminRole) roleIdBySlug.set(SUPER_ADMIN_ROLE_SLUG, superAdminRole._id);

  for (const def of BASE_ROLES) {
    const existing = await Role.findOne({ slug: def.slug });
    if (existing) {
      roleIdBySlug.set(def.slug, existing._id);
      report.rolesAlreadyExisted.push(def.slug);
      continue;
    }
    if (!options.dryRun) {
      const created = await Role.create({
        name: def.name,
        slug: def.slug,
        description: def.description,
        permissions: def.permissions,
        isActive: true,
        isSystem: false,
      });
      roleIdBySlug.set(def.slug, created._id);
    }
    report.rolesCreated.push(def.slug);
  }

  // ── 3. Cargos base, cada uno con su Rol asociado ──
  for (const def of BASE_POSITIONS) {
    const existing = await Position.findOne({ slug: def.slug });
    if (existing) {
      report.positionsAlreadyExisted.push(def.slug);
      continue;
    }
    const roleId = def.roleSlug ? roleIdBySlug.get(def.roleSlug) : undefined;
    if (def.roleSlug && !roleId) {
      report.warnings.push(`Cargo "${def.name}": no se encontró el rol "${def.roleSlug}" (ejecución en seco).`);
    }
    if (!options.dryRun) {
      await Position.create({
        name: def.name,
        slug: def.slug,
        description: def.description,
        roleIds: roleId ? [roleId] : [],
        isActive: true,
      });
    }
    report.positionsCreated.push(def.slug);
  }

  // ── 4. Cuenta principal → Superadministrador ──
  // La cuenta `role: admin` más antigua es la "cuenta principal" (ver
  // sección 10 de la spec). Solo se le AÑADE el rol/cargo si aún no lo
  // tiene; nunca se toca ninguna otra cuenta.
  const principal = await User.findOne({ role: UserRole.ADMIN }).sort({ createdAt: 1 });
  if (!principal) {
    report.warnings.push('No hay ninguna cuenta con role=admin todavía: no se asignó Super Administrador.');
  } else {
    const alreadyHasSuperAdmin =
      superAdminRole && principal.roleIds?.some((id) => id.equals(superAdminRole!._id));

    if (alreadyHasSuperAdmin) {
      report.superAdminAssignedTo = principal._id.toString();
    } else if (!options.dryRun && superAdminRole) {
      const superAdminPosition = await Position.findOne({ slug: 'superadministrador' });
      principal.roleIds = [...(principal.roleIds || []), superAdminRole._id];
      if (!principal.positionId && superAdminPosition) {
        principal.positionId = superAdminPosition._id;
      }
      await principal.save();
      report.superAdminAssignedTo = principal._id.toString();
    } else {
      report.superAdminAssignedTo = `${principal._id.toString()} (ejecución en seco)`;
    }
  }

  return report;
}

// ── CLI entry point ──────────────────────────────────────────────────
// Run with: npm run migrate:rbac [-- --dry-run]
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    const { config } = await import('../config');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 002 — Seguridad y Acceso${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migrateRbac({ dryRun });

      console.log(`  Roles creados          ${report.rolesCreated.join(', ') || '(ninguno)'}`);
      console.log(`  Roles ya existentes    ${report.rolesAlreadyExisted.join(', ') || '(ninguno)'}`);
      console.log(`  Cargos creados         ${report.positionsCreated.join(', ') || '(ninguno)'}`);
      console.log(`  Cargos ya existentes   ${report.positionsAlreadyExisted.join(', ') || '(ninguno)'}`);
      console.log(`  Super Admin asignado a ${report.superAdminAssignedTo || '(nadie — sin cuentas admin)'}`);

      if (report.warnings.length > 0) {
        console.log(`\n  Advertencias (${report.warnings.length}):`);
        for (const warning of report.warnings) console.log(`   • ${warning}`);
      }

      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
