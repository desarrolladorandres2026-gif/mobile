import mongoose, { Schema, Document, Types } from 'mongoose';
export interface IPqrs extends Document { userId: Types.ObjectId; type: 'petition'|'complaint'|'claim'|'suggestion'; subject: string; detail: string; status: 'received'|'in_review'|'answered'|'closed'; evidence: Array<{ url: string; name: string; uploadedAt: Date }>; responses: Array<{ message: string; userId: Types.ObjectId; createdAt: Date }>;
  /**
   * Quién lo tiene asignado.
   *
   * Sin esto, una bandeja compartida acaba con todo el mundo mirando los
   * mismos tres casos fáciles y nadie tocando el difícil. Asignar no es
   * burocracia: es la diferencia entre "alguien lo verá" y "lo ve Ana".
   */
  assignedTo?: Types.ObjectId | null;
  assignedAt?: Date | null;
  /**
   * Quién abrió el caso: cliente, comercio o domiciliario. Se deriva del rol
   * de la cuenta en el servidor, nunca de lo que mande el cliente: es lo que
   * decide a quién se le exigió ser parte del pedido.
   */
  requesterRole: 'customer' | 'business' | 'driver';
  /** Alto para lo que involucra dinero o seguridad; normal para el resto. */
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** El pedido del que se queja, si se queja de uno. */
  orderId?: Types.ObjectId | null;
  /** El comercio del pedido, si lo trae. Se copia al crear para que soporte vea las partes sin poblar el pedido. */
  businessId?: Types.ObjectId | null;
  /** El domiciliario del pedido, si lo trae y ya tenía uno asignado. */
  driverId?: Types.ObjectId | null;
  /**
   * Cuándo hay que haber respondido.
   *
   * Se calcula al abrirlo según la prioridad. Un plazo que se fija después
   * es un plazo que se ajusta para no incumplirlo.
   */
  dueAt?: Date | null;
  /**
   * Plazo LEGAL de respuesta (distinto de `dueAt`, que es el SLA interno en
   * horas). Ley 1480 de 2011 / Ley 1755 de 2015 — confirmar con asesor
   * legal. Se calcula al crear la PQRS según `type`; `suggestion` no tiene
   * plazo legal y queda en null.
   */
  legalDueAt?: Date | null;
  /** Cuándo se respondió por primera vez. Es la métrica que mide soporte. */
  firstResponseAt?: Date | null;
  createdAt: Date; updatedAt: Date; }
const responseSchema = new Schema({ message: { type: String, required: true, maxlength: 4000 }, userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, createdAt: { type: Date, default: () => new Date() } }, { _id: false });
const evidenceSchema = new Schema({ url: { type: String, required: true, maxlength: 1000 }, name: { type: String, required: true, maxlength: 160 }, uploadedAt: { type: Date, default: () => new Date() } }, { _id: false });
const pqrsSchema = new Schema<IPqrs>({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, type: { type: String, enum: ['petition','complaint','claim','suggestion'], required: true }, subject: { type: String, required: true, trim: true, maxlength: 160 }, detail: { type: String, required: true, maxlength: 4000 }, status: { type: String, enum: ['received','in_review','answered','closed'], default: 'received' }, evidence: { type: [evidenceSchema], default: [] }, responses: { type: [responseSchema], default: [] },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  assignedAt: { type: Date, default: null },
  requesterRole: { type: String, enum: ['customer','business','driver'], default: 'customer' },
  priority: { type: String, enum: ['low','normal','high','urgent'], default: 'normal' },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
  driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
  dueAt: { type: Date, default: null },
  legalDueAt: { type: Date, default: null },
  firstResponseAt: { type: Date, default: null } }, { timestamps: true });
pqrsSchema.index({ userId: 1, createdAt: -1 }); pqrsSchema.index({ status: 1, createdAt: -1 });
// La cola de trabajo pregunta por lo abierto, ordenado por urgencia real:
// primero lo que vence antes, no lo que llegó antes.
pqrsSchema.index({ status: 1, dueAt: 1 });
pqrsSchema.index({ status: 1, legalDueAt: 1 });
pqrsSchema.index({ assignedTo: 1, status: 1 });
// Fichas del panel admin (pedido, comercio, domiciliario): lo reciente de cada uno.
pqrsSchema.index({ orderId: 1 });
pqrsSchema.index({ businessId: 1, createdAt: -1 });
pqrsSchema.index({ driverId: 1, createdAt: -1 });
export const Pqrs = mongoose.model<IPqrs>('Pqrs', pqrsSchema);
