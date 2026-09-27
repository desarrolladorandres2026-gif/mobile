import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';
import { logSystemAudit, AuditAction, AuditSeverity } from '../security';
import { clearTwoFactor } from '../services/mfa.service';
import { issueTemporaryPassword } from '../services/admin.service';

/**
 * Salida de emergencia del 2FA, desde el servidor.
 *
 * El panel tiene "Restablecer 2FA", pero nadie puede usarlo sobre sí mismo:
 * si el único Super Administrador pierde el celular y sus códigos de
 * recuperación, el panel admin queda inaccesible (aprobaciones,
 * liquidaciones, SOS). Este script hace lo mismo que el botón —quita el
 * 2FA, rota la contraseña y cierra todas las sesiones— para quien tiene
 * acceso al servidor, y lo deja en la auditoría.
 *
 * Verifica la identidad ANTES de ejecutarlo: quien tiene la contraseña
 * temporal y entra primero es quien registra su autenticador.
 *
 *   EMAIL="admin@..." REASON="Perdió el celular; verificado en persona" \
 *   npm run emergency:reset-2fa
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`❌ Falta la variable ${name}.`);
    process.exit(1);
  }
  return value.trim();
}

const run = async () => {
  const email = required('EMAIL').toLowerCase();
  const reason = required('REASON');
  if (reason.length < 10 || reason.length > 500) {
    console.error('❌ REASON debe tener entre 10 y 500 caracteres.');
    process.exit(1);
  }

  await mongoose.connect(config.mongodb.uri);
  console.log(`🗄️  Conectado a MongoDB (${mongoose.connection.name})`);

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`❌ No hay ninguna cuenta con el correo ${email}.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!(await clearTwoFactor(user._id))) {
    console.error(`❌ ${user.name} no tiene la verificación en dos pasos activa. No se cambió nada.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const temporaryPassword = await issueTemporaryPassword(user);

  await logSystemAudit({
    action: AuditAction.TOTP_RESET_BY_ADMIN,
    entity: 'user',
    entityId: user._id.toString(),
    severity: AuditSeverity.CRITICAL,
    description: `Verificación en dos pasos y contraseña de ${user.name} restablecidas desde el servidor (script de emergencia): ${reason}`,
    metadata: { reason, targetRole: user.role, passwordRotated: true, via: 'emergency_script' },
  });

  await mongoose.disconnect();
  console.log(`\n✅ 2FA quitado y sesiones cerradas para ${user.name} (${user.role}).`);
  console.log(`🔑 Contraseña temporal (caduca en 24 h, no se vuelve a mostrar): ${temporaryPassword}`);
  console.log('   Entra de inmediato: si el 2FA es obligatorio para la cuenta, el panel pedirá activarlo de nuevo.\n');
};

run().catch(async (err) => {
  console.error('❌ El restablecimiento falló:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
