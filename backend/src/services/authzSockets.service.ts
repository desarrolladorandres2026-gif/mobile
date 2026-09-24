import { Types } from 'mongoose';
import { Position, User } from '../models';
import { UserRole } from '../types';
import { getIO } from '../sockets/emitter';

/**
 * Las salas de socket de un admin (`admin:orders`, `admin:fleet`, `admin:sos`)
 * se calculan al CONECTAR (ver `authenticateSocket`). Si cambia lo que fija
 * esas salas —el flag `rbac_enforce`, un Rol o un Cargo— hay que cortar los
 * sockets afectados para que reconecten y las recalculen; si no, conservan
 * hasta horas eventos que ya no les corresponden.
 *
 * Módulo aparte y sin importar `authorization.service`: `featureFlag.service`
 * lo necesita y `authorization.service` importa a `featureFlag.service`.
 * Sin `io` (pruebas, scripts) no hace nada, y nunca lanza: un fallo aquí no
 * debe deshacer el cambio de permisos que ya se guardó.
 */
function disconnectUsers(userIds: Array<Types.ObjectId | string>): void {
  const io = getIO();
  if (!io || userIds.length === 0) return;
  io.in(userIds.map((id) => `user:${id.toString()}`)).disconnectSockets(true);
}

/** Todos los sockets de cuentas admin (cambio del flag `rbac_enforce`). */
export async function disconnectAllAdminSockets(): Promise<void> {
  try {
    if (!getIO()) return;
    const admins = await User.find({ role: UserRole.ADMIN }).select('_id').lean();
    disconnectUsers(admins.map((a) => a._id));
  } catch (error) {
    console.error('[AUTHZ_SOCKETS] No se pudieron desconectar los sockets admin', error);
  }
}

/** Usuarios que tienen ese Rol directo o a través de un Cargo que lo incluye. */
export async function disconnectSocketsOfRole(roleId: Types.ObjectId | string): Promise<void> {
  try {
    if (!getIO()) return;
    const positions = await Position.find({ roleIds: roleId }).select('_id').lean();
    const users = await User.find({
      $or: [{ roleIds: roleId }, { positionId: { $in: positions.map((p) => p._id) } }],
    })
      .select('_id')
      .lean();
    disconnectUsers(users.map((u) => u._id));
  } catch (error) {
    console.error('[AUTHZ_SOCKETS] No se pudieron desconectar los sockets del rol', error);
  }
}

/** Usuarios que tienen ese Cargo. */
export async function disconnectSocketsOfPosition(positionId: Types.ObjectId | string): Promise<void> {
  try {
    if (!getIO()) return;
    const users = await User.find({ positionId }).select('_id').lean();
    disconnectUsers(users.map((u) => u._id));
  } catch (error) {
    console.error('[AUTHZ_SOCKETS] No se pudieron desconectar los sockets del cargo', error);
  }
}
