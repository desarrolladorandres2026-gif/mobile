import { MongoClient, ObjectId } from 'mongodb';
import { deleteTenantData } from './deleteTenant.js';

/**
 * Borrado definitivo de una empresa. Es IRREVERSIBLE: sin copia de seguridad no hay vuelta atrás. Se corre con
 * credenciales de administración (la aplicación no puede borrar el libro ni la auditoría).
 *   MONGODB_ADMIN_URI   conexión de un usuario administrador (obligatoria)
 *   MONGODB_DB          base de datos (por defecto lulubiz)
 *   TENANT_ID           empresa a borrar (obligatoria)
 * Sin más, solo cuenta lo que borraría. Para borrar de verdad, además:
 *   APPLY=yes           ejecuta el borrado
 *   CONFIRM_NAME        nombre exacto de la empresa
 *   EXPORT_DELIVERED=yes   confirmas que el cliente recibió su exportación
 */
const { MONGODB_ADMIN_URI, MONGODB_DB = 'lulubiz', TENANT_ID, APPLY, CONFIRM_NAME, EXPORT_DELIVERED } = process.env;

if (!MONGODB_ADMIN_URI || !TENANT_ID || !ObjectId.isValid(TENANT_ID)) {
  console.error('Faltan MONGODB_ADMIN_URI y un TENANT_ID válido.');
  process.exit(1);
}

const client = await MongoClient.connect(MONGODB_ADMIN_URI);
try {
  const result = await deleteTenantData(client.db(MONGODB_DB), new ObjectId(TENANT_ID), {
    apply: APPLY === 'yes',
    confirmName: CONFIRM_NAME,
    exportDelivered: EXPORT_DELIVERED === 'yes',
  });
  const rows = Object.entries(result.counts).filter(([, n]) => n > 0);
  console.log(`\nEmpresa ${result.name} (${result.tenantId})`);
  for (const [name, n] of rows) console.log(`  ${name.padEnd(22)} ${n}`);
  if (result.orphanUsers.length) console.log(`\nCuentas que quedan sin ninguna empresa (no se borran): ${result.orphanUsers.join(', ')}`);
  if (result.deleted) console.log(`\nBORRADA el ${new Date().toISOString()}. Deja constancia en tu registro de operación.`);
  else console.log('\nSolo se contó. Para borrar: APPLY=yes CONFIRM_NAME="<nombre exacto>" EXPORT_DELIVERED=yes');
} catch (error) {
  console.error(`No se borró nada: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
