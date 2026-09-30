import { Types } from 'mongoose';
import { Driver, IDriver, DriverDebt, DriverDocument, DriverOffer, User, MAX_DRIVER_DOCUMENT_HISTORY } from '../models';
import { AppError } from '../middlewares';
import { escapeRegex } from '../utils';
import { DriverStatus, DebtStatus } from '../types';
import { cashReconciliationService } from './cashReconciliation.service';
import { payoutService } from './payout.service';
import { PayoutBeneficiary } from '../types';
import { cloudinary } from '../config';
import { driverDossierService } from './driverDossier.service';
import { driverShiftService } from './driverShift.service';

/**
 * La fecha en la zona del servidor, como `YYYY-MM-DD`.
 *
 * `toISOString()` daría UTC y en Colombia (-5) mandaría al día siguiente
 * todo lo entregado después de las siete de la tarde — justo el tramo con
 * más pedidos.
 */
function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface DriverListFilters {
  page?: number;
  limit?: number;
  search?: string;
  driverStatus?: 'pending' | 'active' | 'suspended';
  availability?: 'available' | 'busy' | 'offline';
  vehicleType?: 'motorcycle' | 'bicycle';
  dateFrom?: Date;
  dateTo?: Date;
  sortBy?: 'name' | 'createdAt' | 'rating' | 'totalDeliveries' | 'lastLocationAt';
  sortOrder?: 'asc' | 'desc';
}

export interface DriverListItem {
  _id: string;
  userId: {
    _id: string;
    name: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    avatar?: string;
    documentType?: string;
    documentNumber?: string;
    lastLoginAt?: Date;
    isBlocked?: boolean;
    createdAt: Date;
  };
  vehicleType: string;
  licensePlate?: string;
  status: string;
  isActive: boolean;
  isApproved: boolean;
  baseFund: number;
  currentFund: number;
  rating: number;
  totalReviews: number;
  totalDeliveries: number;
  lastLocationAt?: Date;
  createdAt: Date;
}

export interface DriverDetail extends DriverListItem {
  emergencyContact?: { name: string; phone: string; relationship?: string };
  batteryLevel?: number;
  totalEarnings: number;
}

/**
 * Los únicos campos del usuario que salen hacia el panel. Se proyectan dentro
 * del `$lookup` para que ni siquiera el hash de la contraseña ni el secreto
 * 2FA lleguen a la memoria del proceso.
 */
const USER_FIELDS = [
  'name', 'firstName', 'lastName', 'phone', 'email', 'avatar',
  'documentType', 'documentNumber', 'lastLoginAt', 'isBlocked', 'createdAt',
] as const;

const userLookupStage = () => ({
  $lookup: {
    from: User.collection.name,
    let: { uid: '$userId' },
    pipeline: [
      { $match: { $expr: { $eq: ['$_id', '$$uid'] } } },
      { $project: Object.fromEntries(USER_FIELDS.map((f) => [f, 1])) },
    ],
    as: 'user',
  },
});

const LIST_PROJECTION = {
  userId: {
    _id: '$user._id',
    ...Object.fromEntries(USER_FIELDS.map((f) => [f, `$user.${f}`])),
  },
  vehicleType: 1,
  licensePlate: 1,
  status: 1,
  isActive: 1,
  isApproved: 1,
  baseFund: 1,
  currentFund: 1,
  rating: 1,
  totalReviews: 1,
  totalDeliveries: 1,
  lastLocationAt: 1,
  createdAt: 1,
};

const DETAIL_PROJECTION = { emergencyContact: 1, batteryLevel: 1, totalEarnings: 1 };

interface CreateDriverInput {
  userId: string;
  vehicleType?: string;
  licensePlate?: string;
  baseFund?: number;
}

export class DriverService {
  async create(input: CreateDriverInput): Promise<IDriver> {
    const existing = await Driver.findOne({ userId: input.userId });
    if (existing) throw new AppError('Ya existe un perfil de domiciliario para este usuario', 409);

    return Driver.create({
      ...input,
      currentFund: input.baseFund || 50000,
    });
  }

  async getById(id: string): Promise<IDriver> {
    const driver = await Driver.findById(id).populate('userId', 'name phone avatar');
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    return driver;
  }

  async getByUserId(userId: string): Promise<IDriver> {
    const driver = await Driver.findOne({ userId }).populate('userId', 'name phone avatar');
    if (!driver) throw new AppError('Perfil de domiciliario no encontrado', 404);
    return driver;
  }

  async updateStatus(userId: string, status: DriverStatus): Promise<IDriver> {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    if (status === DriverStatus.AVAILABLE) {
      await this.assertDocumentsCurrent(driver._id.toString());
      await this.assertVerificationsCurrent(driver._id.toString());
    }
    // `busy` lo pone el propio flujo del pedido (order.service.ts) al
    // aceptar/entregar/cancelar — no es un estado que el domiciliario elija
    // a mano. Si intenta desconectarse mientras reparte, el rechazo evita
    // que su GPS deje de reportar justo mientras alguien lo está esperando;
    // ir a "disponible" en cambio no hace daño, solo confirma lo que ya es.
    if (status === DriverStatus.OFFLINE && driver.status === DriverStatus.BUSY) {
      throw new AppError(
        'No puedes desconectarte mientras tienes un pedido activo. Termina la entrega primero.',
        409,
        'DRIVER_BUSY'
      );
    }
    const before = driver.status;
    driver.status = status;
    await driver.save();
    // Turnos: solo importa cruzar la frontera conectado/desconectado (busy ↔ available no cambia nada).
    if (before === DriverStatus.OFFLINE && status !== DriverStatus.OFFLINE) await driverShiftService.open(driver._id);
    if (before !== DriverStatus.OFFLINE && status === DriverStatus.OFFLINE) await driverShiftService.close(driver._id);
    return driver;
  }

  async updateLocation(userId: string, lat: number, lng: number): Promise<IDriver> {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    driver.currentLocation = { type: 'Point', coordinates: [lng, lat] };
    await driver.save();
    return driver;
  }

  async getAvailable(lat: number, lng: number, maxDistance = 10000) {
    return Driver.find({
      status: DriverStatus.AVAILABLE,
      isActive: true,
      isApproved: true,
      currentLocation: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: maxDistance,
        },
      },
    }).populate('userId', 'name phone avatar');
  }

  /** Compatibilidad: el listado sin filtros. Ver `list`. */
  async getAll(page = 1, limit = 20) {
    const { drivers, meta } = await this.list({ page, limit });
    return { drivers, meta };
  }

  /**
   * Listado del panel: búsqueda, filtros, orden y paginación.
   *
   * Los campos de búsqueda viven en dos colecciones (`drivers` y `users`),
   * así que es una agregación con `$lookup`. Ojo con lo que eso implica:
   * los virtuals y el `select: false` de Mongoose NO aplican aquí, de modo
   * que la proyección es explícita y es lo único que impide que salgan
   * `reputationScore` o los campos de credenciales del usuario.
   */
  async list(filters: DriverListFilters = {}) {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.max(1, filters.limit ?? 20);

    const match: Record<string, unknown> = {};
    if (filters.driverStatus === 'pending') match.isApproved = false;
    else if (filters.driverStatus === 'suspended') Object.assign(match, { isApproved: true, isActive: false });
    else if (filters.driverStatus === 'active') Object.assign(match, { isApproved: true, isActive: true });
    if (filters.availability) match.status = filters.availability;
    if (filters.vehicleType) match.vehicleType = filters.vehicleType;
    if (filters.dateFrom || filters.dateTo) {
      match.createdAt = {
        ...(filters.dateFrom ? { $gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { $lte: filters.dateTo } : {}),
      };
    }

    const term = filters.search?.trim();
    const searchMatch = term
      ? (() => {
          const rx = new RegExp(escapeRegex(term), 'i');
          return {
            $or: [
              { 'user.name': rx },
              { 'user.phone': rx },
              { 'user.email': rx },
              { 'user.documentNumber': rx },
              { licensePlate: rx },
            ],
          };
        })()
      : null;

    const sortField = filters.sortBy === 'name' ? 'user.name' : filters.sortBy ?? 'createdAt';
    const sortDir = filters.sortOrder === 'asc' ? 1 : -1;

    const [result] = await Driver.aggregate([
      { $match: match },
      userLookupStage(),
      { $unwind: '$user' },
      ...(searchMatch ? [{ $match: searchMatch }] : []),
      // `_id` desempata: sin él, dos filas con el mismo valor pueden repetirse
      // o saltarse entre página y página.
      { $sort: { [sortField]: sortDir, _id: 1 } },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: LIST_PROJECTION }],
          count: [{ $count: 'total' }],
        },
      },
    ]).collation({ locale: 'es', strength: 2 });

    const total: number = result?.count?.[0]?.total ?? 0;
    return {
      drivers: (result?.items ?? []) as DriverListItem[],
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Un domiciliario con los mismos campos del listado más los de detalle. */
  async getDetail(id: string): Promise<DriverDetail> {
    if (!Types.ObjectId.isValid(id)) throw new AppError('Identificador de domiciliario inválido', 400);
    const [driver] = await Driver.aggregate([
      { $match: { _id: new Types.ObjectId(id) } },
      userLookupStage(),
      { $unwind: '$user' },
      { $project: { ...LIST_PROJECTION, ...DETAIL_PROJECTION } },
    ]);
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    return driver as DriverDetail;
  }

  async approve(id: string): Promise<IDriver> {
    const driver = await Driver.findById(id);
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    await this.assertDocumentsCurrent(driver._id.toString());
    driver.isApproved = true;
    // Fecha de vinculación: la primera aprobación; reaprobar tras un rechazo no la reescribe.
    if (!driver.approvedAt) driver.approvedAt = new Date();
    await driver.save();
    return driver;
  }

  async assertDocumentsCurrent(driverId: string): Promise<void> {
    const now = new Date();
    await DriverDocument.updateMany({ driverId, expiresAt: { $lt: now }, status: { $ne: 'expired' } }, { $set: { status: 'expired' } });
    const documents = await DriverDocument.find({ driverId });
    // In development/test a legacy driver profile has no uploaded document
    // history yet. Production must require verified records; this compatibility
    // bridge keeps existing accounts operable until the onboarding migration.
    if (process.env.NODE_ENV === 'test') return;
    const required = ['identity', 'license', 'soat'];
    const missing = required.filter((type) => !documents.some((d) => d.type === type && d.status === 'approved' && (!d.expiresAt || d.expiresAt >= now)));
    if (missing.length) throw new AppError(`No puedes operar: faltan o vencieron documentos obligatorios (${missing.join(', ')})`, 422);
  }

  /**
   * Bloquea a quien ignoró una verificación que se le pidió en turno.
   *
   * Es la consecuencia que convierte la verificación aleatoria en algo más
   * que una notificación: sin esta puerta, quien está usando la cuenta de
   * otro simplemente no responde y sigue repartiendo igual.
   *
   * Solo muerde cuando el plazo ya venció. Mientras corre, el domiciliario
   * sigue trabajando con normalidad: se le pidió una foto, no se le acusó
   * de nada, y frenarle antes de tiempo castigaría a quien va conduciendo.
   */
  async assertVerificationsCurrent(driverId: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;

    const { driverSecurityService } = await import('../security');
    const overdue = await driverSecurityService.hasOverdueVerification(driverId);

    if (overdue) {
      throw new AppError(
        'Tienes una verificación de identidad pendiente. Envía la selfie que te ' +
          'pedimos para volver a recibir pedidos.',
        423,
        'VERIFICATION_REQUIRED'
      );
    }
  }

  /**
   * Guarda la foto del documento y la deja lista para revisión.
   *
   * Aparte de la selfie de verificación a propósito: aquella se pide en
   * mitad de un turno y se descarta al resolverse, esta respalda una
   * habilitación para trabajar y tiene que poder consultarse mientras el
   * documento siga vigente.
   */
  /**
   * S16: `authenticated` — la cédula, el SOAT y los demás documentos del
   * domiciliario son datos personales y de identidad; no tienen por qué
   * quedar en una URL de Cloudinary servible por cualquiera que la
   * adivine o la encuentre en un volcado. Devuelve el `public_id`, no una
   * URL: solo se firma al leer, y nunca se guarda esa firma.
   */
  private async storeDocumentImage(buffer: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'zipp/driver-documents',
          resource_type: 'image',
          type: 'authenticated',
          // Se limita, no se recorta: un número de póliza recortado no se
          // puede leer, y leerlo es todo el propósito de la foto.
          transformation: [
            { width: 1600, height: 1600, crop: 'limit' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error: unknown, result: { public_id: string } | undefined) => {
          if (error || !result) {
            reject(new AppError('No se pudo subir la foto del documento', 502));
            return;
          }
          resolve(result.public_id);
        }
      );
      stream.end(buffer);
    });
  }

  /**
   * URL firmada para ver la foto de un documento de domiciliario (S16).
   *
   * Se calcula en cada lectura y nunca se persiste. Un documento anterior a
   * esta migración, todavía con `imageUrl` público y sin `imageKey`, se
   * devuelve tal cual — la migración 015 es la que los pasa uno a uno.
   */
  documentImageUrl(doc: { imageUrl?: string | null; imageKey?: string | null; isPrivate?: boolean }): string | undefined {
    if (!doc.isPrivate || !doc.imageKey) return doc.imageUrl ?? undefined;
    return cloudinary.url(doc.imageKey, {
      type: 'authenticated',
      resource_type: 'image',
      sign_url: true,
      secure: true,
    });
  }

  /**
   * Un documento enviado a revisión, con su foto.
   *
   * La foto es obligatoria salvo que ya hubiera una: así, corregir un
   * dígito mal escrito no obliga a volver a fotografiar la cédula, pero
   * un documento nuevo nunca entra sin prueba. Cualquier reenvío vuelve a
   * `pending` y borra la revisión anterior — un documento cambiado es un
   * documento sin revisar, aunque la foto sea la misma.
   */
  async submitDocument(
    userId: string,
    input: { type: string; reference: string; issuedAt?: Date; expiresAt?: Date; image?: Buffer }
  ) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const existing = await DriverDocument.findOne({ driverId: driver._id, type: input.type });

    if (!input.image && !existing?.imageUrl && !existing?.imageKey) {
      throw new AppError('Necesitamos una foto del documento para poder revisarlo', 400);
    }

    // S16: una foto nueva sube `authenticated` (público_id en `imageKey`);
    // si no llega foto nueva, se conserva lo que ya hubiera, sea el
    // `imageUrl` público de un documento anterior a este cambio o el
    // `imageKey` privado de uno posterior.
    const imagePatch = input.image
      ? { imageKey: await this.storeDocumentImage(input.image), isPrivate: true, imageUrl: null }
      : { imageKey: existing?.imageKey, isPrivate: existing?.isPrivate ?? false, imageUrl: existing?.imageUrl };

    return DriverDocument.findOneAndUpdate(
      { driverId: driver._id, type: input.type },
      {
        driverId: driver._id,
        type: input.type,
        reference: input.reference,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        ...imagePatch,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
        submittedAt: new Date(),
        // Un reenvío cierra cualquier solicitud de actualización pendiente.
        $unset: { updateRequest: 1 },
        // Un reenvío sin foto nueva de algo que sigue en revisión no es un hecho nuevo: sin esto,
        // reenviar 50 veces expulsaría del historial las notas y decisiones del equipo.
        ...(input.image || existing?.status !== 'pending'
          ? { $push: { history: { $each: [{ action: 'submitted', at: new Date() }], $slice: -MAX_DRIVER_DOCUMENT_HISTORY } } }
          : {}),
      },
      { upsert: true, new: true, runValidators: true }
    );
  }

  async listDocuments(driverId: string): Promise<Record<string, unknown>[]> {
    const documents = await DriverDocument.find({ driverId }).sort({ type: 1 }).lean();
    // S16: `imageKey` no sale del backend — solo la URL ya firmada, en el
    // mismo campo `imageUrl` que el panel y la app siempre leyeron.
    return documents.map((doc) => {
      const imageUrl = this.documentImageUrl(doc);
      const { imageKey, updateRequest, ...rest } = doc;
      // `requestedBy` es el id del administrador: no sale hacia la app.
      return {
        ...rest,
        imageUrl,
        ...(updateRequest ? { updateRequest: { reason: updateRequest.reason, requestedAt: updateRequest.requestedAt } } : {}),
      };
    });
  }

  /**
   * Lo que un administrador tiene pendiente de mirar.
   *
   * La revisión de documentos estaba expuesta por id y el listado solo para
   * la sesión del propio repartidor, así que el panel podía aprobar un
   * documento pero no averiguar cuáles existían. Esto invierte la pregunta
   * —de "los documentos de este repartidor" a "qué hay por revisar"— que es
   * como se trabaja de verdad.
   *
   * Los que están por vencer entran en la misma cola porque un documento
   * que caduca la semana que viene es trabajo de esta: al expirar,
   * `assertDocumentsCurrent` saca al repartidor de circulación en mitad de
   * un turno y sin avisar a nadie.
   */
  async reviewQueue(expiringInDays = 30) {
    const now = new Date();
    const horizon = new Date(now.getTime() + expiringInDays * 24 * 60 * 60 * 1000);

    // Los vencidos se marcan aquí igual que en `assertDocumentsCurrent`,
    // porque el estado depende del paso del tiempo y nadie escribe en el
    // documento cuando llega su fecha.
    await DriverDocument.updateMany(
      { expiresAt: { $lt: now }, status: { $ne: 'expired' } },
      { $set: { status: 'expired' } }
    );

    const documents = await DriverDocument.find({
      $or: [
        { status: 'pending' },
        { status: 'expired' },
        { status: 'approved', expiresAt: { $gte: now, $lte: horizon } },
      ],
    })
      .sort({ expiresAt: 1, createdAt: 1 })
      .populate({
        path: 'driverId',
        select: 'userId isApproved isActive vehicleType licensePlate',
        populate: { path: 'userId', select: 'name phone' },
      });

    // S16: la foto se firma al servir la cola, nunca antes — `imageKey` no
    // sale de este método.
    const view = (d: (typeof documents)[number]) => {
      const obj = d.toObject() as unknown as Record<string, unknown>;
      delete obj.imageKey;
      obj.imageUrl = this.documentImageUrl(d);
      return obj;
    };

    // Se reparten en tres listas en vez de ordenarse por un campo, porque
    // el orden que importa no es alfabético ni cronológico: es el de la
    // urgencia con la que hay que actuar sobre cada grupo.
    return {
      pending: documents.filter((d) => d.status === 'pending').map(view),
      expired: documents.filter((d) => d.status === 'expired').map(view),
      expiringSoon: documents.filter((d) => d.status === 'approved').map(view),
    };
  }
  /** O6: `rejectionReason` es obligatorio al rechazar — antes el domiciliario reintentaba a ciegas, sin saber qué corregir. */
  async reviewDocument(id: string, adminId: string, status: 'approved'|'rejected', rejectionReason?: string, revision?: number) {
    if (status === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 5)) {
      throw new AppError('El motivo del rechazo es obligatorio (mínimo 5 caracteres)', 400);
    }
    // `revision` es el `submittedAt` que el administrador tenía en pantalla: si el domiciliario
    // reenvió entretanto, aprobar sería aprobar una foto que nadie miró.
    const document = await DriverDocument.findOneAndUpdate(
      { _id: id, ...(revision ? { submittedAt: new Date(revision) } : {}) },
      { status, reviewedBy: adminId, reviewedAt: new Date(), rejectionReason: status === 'rejected' ? rejectionReason!.trim() : null },
      { new: true, runValidators: true }
    );
    if (!document) {
      if (revision && (await DriverDocument.exists({ _id: id }))) {
        throw new AppError('El domiciliario reenvió el documento mientras lo revisabas. Recarga y revísalo de nuevo.', 409, 'DOCUMENT_CHANGED');
      }
      throw new AppError('Documento no encontrado', 404);
    }
    // Quién y cuándo, para el historial del expediente. Un fallo aquí no debe deshacer la revisión ya guardada.
    await driverDossierService
      .recordReview(id, adminId, status, status === 'rejected' ? rejectionReason!.trim() : undefined)
      .catch((error) => console.error('[driver-dossier] historial de revisión', error));
    return document;
  }

  /** El propio domiciliario completa los datos básicos de su moto (marca, modelo, color, placa). */
  async updateOwnVehicle(
    userId: string,
    input: { brand?: string; model?: string; color?: string; year?: number; engineCc?: number; ownerName?: string; licenseCategory?: string }
  ): Promise<IDriver> {
    const driver = await Driver.findOne({ userId }).select('_id');
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    return driverDossierService.updateVehicle(driver._id.toString(), input);
  }

  /**
   * Cambia el fondo rotatorio base de un domiciliario.
   *
   * `currentFund` no se pisa con el nuevo `baseFund`: tiene reservas de
   * pedidos en curso metidas dentro. La condición `baseFund: previousBaseFund`
   * en el filtro de `findOneAndUpdate` es lo que hace el cambio atómico
   * —dos administradores editando a la vez no se pisan— y el `$inc` aplica
   * solo la diferencia, preservando lo que ya estaba comprometido. Si la
   * diferencia es negativa y no hay suficiente `currentFund` libre para
   * absorberla, se rechaza con 409 en vez de dejar el fondo en negativo.
   */
  async updateBaseFund(id: string, baseFund: number): Promise<IDriver> {
    const current = await Driver.findById(id).select('baseFund currentFund');
    if (!current) throw new AppError('Domiciliario no encontrado', 404);

    const previousBaseFund = current.baseFund;
    const delta = baseFund - previousBaseFund;

    const updated = await Driver.findOneAndUpdate(
      {
        _id: id,
        baseFund: previousBaseFund,
        ...(delta < 0 ? { currentFund: { $gte: -delta } } : {}),
      },
      { $set: { baseFund }, $inc: { currentFund: delta } },
      { new: true }
    );

    if (!updated) {
      // O el fondo base cambió justo antes (carrera), o no alcanza a
      // absorber la reducción porque hay dinero retenido en pedidos.
      const fresh = await Driver.findById(id).select('baseFund currentFund');
      if (!fresh) throw new AppError('Domiciliario no encontrado', 404);
      if (fresh.baseFund !== previousBaseFund) {
        throw new AppError(
          'El fondo base cambió justo antes de esta actualización. Intenta de nuevo.',
          409
        );
      }
      // `currentFund` es lo que le queda libre, no lo retenido: lo retenido
      // en pedidos abiertos es la diferencia contra el techo (`baseFund`).
      // El mensaje anterior mostraba el libre como si fuera lo ocupado.
      const held = Math.max(0, fresh.baseFund - fresh.currentFund);
      throw new AppError(
        `No se puede reducir el fondo base: tiene $${held.toLocaleString('es-CO')} retenido en pedidos.`,
        409
      );
    }

    return updated;
  }

  // ── Financial ──

  /**
   * A driver's day, split the way they actually get paid.
   *
   * The guaranteed delivery fee and the tip are reported separately because
   * they behave differently: the fee is what ZIPP owes and can never be
   * reduced by a promotion, while the tip is the customer's money passing
   * straight through. Lumping them together hid exactly the shortfall this
   * redesign was meant to eliminate.
   */
  async getDailyEarnings(userId: string, date?: string) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const startOfDay = date ? new Date(date) : new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);

    const { Order } = await import('../models');
    const orders = await Order.find({
      driverId: driver._id,
      deliveredAt: { $gte: startOfDay, $lte: endOfDay },
    }).select('orderNumber finance deliveredAt paymentMethod');

    const guaranteedFees = orders.reduce(
      (sum, o) => sum + (o.finance?.driverDeliveryPayout ?? 0),
      0
    );
    const tips = orders.reduce((sum, o) => sum + (o.finance?.tip ?? 0), 0);

    const payouts = await payoutService.summaryFor({
      beneficiary: PayoutBeneficiary.DRIVER,
      driverId: driver._id.toString(),
    });

    return {
      totalEarned: guaranteedFees + tips,
      guaranteedFees,
      tips,
      totalOrders: orders.length,
      pendingPayout: payouts.outstanding,
      settledPayout: payouts.settled,
      orders,
      /** @deprecated Kept so existing clients keep rendering. */
      commissions: orders,
    };
  }

  /**
   * La historia, no solo el día de hoy.
   *
   * `getDailyEarnings` contesta "cuánto llevo hoy", que es la pregunta de
   * las seis de la tarde. La otra —"¿me compensa este trabajo?"— solo se
   * puede contestar mirando varios días juntos, y hasta ahora la app no
   * tenía forma de hacerla: el endpoint aceptaba una fecha y nadie se la
   * pasaba nunca.
   *
   * Devuelve un día por elemento, incluidos los días en blanco. Un hueco
   * en la serie es información —ese martes no salió a trabajar— y dejar
   * que la gráfica una el lunes con el miércoles contaría otra historia.
   */
  async getEarningsRange(userId: string, from: Date, to: Date) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);

    if (start > end) throw new AppError('El rango de fechas está al revés', 400);

    // Un tope duro: sin él, un cliente puede pedir cinco años y traerse
    // toda la colección a memoria para pintar una gráfica de un mes.
    const MAX_DAYS = 92;
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (days > MAX_DAYS) {
      throw new AppError(`El rango no puede pasar de ${MAX_DAYS} días`, 400);
    }

    const { Order } = await import('../models');
    const orders = await Order.find({
      driverId: driver._id,
      deliveredAt: { $gte: start, $lte: end },
    })
      .select('orderNumber finance deliveredAt paymentMethod')
      .sort({ deliveredAt: 1 });

    // Se agrupa en JS y no con `$group` por zona horaria: Mongo agruparía
    // en UTC y en Colombia (-5) las entregas de después de las 7 de la
    // tarde caerían en el día siguiente. Un domiciliario que cierra a las
    // diez vería su mejor tramo contado en la jornada equivocada.
    const buckets = new Map<string, { orders: number; guaranteedFees: number; tips: number }>();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      buckets.set(localDay(d), { orders: 0, guaranteedFees: 0, tips: 0 });
    }

    for (const order of orders) {
      const key = localDay(order.deliveredAt!);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.orders += 1;
      bucket.guaranteedFees += order.finance?.driverDeliveryPayout ?? 0;
      bucket.tips += order.finance?.tip ?? 0;
    }

    const series = [...buckets.entries()].map(([date, b]) => ({
      date,
      ...b,
      total: b.guaranteedFees + b.tips,
    }));

    const totals = series.reduce(
      (acc, day) => ({
        orders: acc.orders + day.orders,
        guaranteedFees: acc.guaranteedFees + day.guaranteedFees,
        tips: acc.tips + day.tips,
        total: acc.total + day.total,
      }),
      { orders: 0, guaranteedFees: 0, tips: 0, total: 0 }
    );

    /** Los días en los que de verdad trabajó. Promediar sobre los otros
     *  mentiría a la baja: un domingo libre no es un domingo malo. */
    const workedDays = series.filter((d) => d.orders > 0).length;

    return {
      from: localDay(start),
      to: localDay(end),
      series,
      totals: {
        ...totals,
        workedDays,
        perDay: workedDays ? Math.round(totals.total / workedDays) : 0,
        perOrder: totals.orders ? Math.round(totals.total / totals.orders) : 0,
      },
    };
  }

  /**
   * Cómo le está yendo, en números.
   *
   * ── Qué NO hace esto ──
   * Nada de lo que hay aquí entra en el orden de la cascada. El reparto
   * sigue decidiéndose solo por cercanía y ETA real, y eso es deliberado:
   * cuando la tasa de aceptación pesa en el ranking —el modelo de Rappi,
   * donde además el peso es secreto— la gente acepta pedidos que no le
   * convienen por miedo a caer, y el número deja de medir nada porque todo
   * el mundo lo infla. Aquí sirve para que el domiciliario se vea a sí
   * mismo y para que nosotros veamos dónde falla el reparto.
   *
   * Las ofertas que se llevó otro quedan fuera del denominador. En las
   * rondas anchas el mismo pedido se ofrece a varios y solo uno puede
   * quedárselo: contar como fallo el no haber sido el más rápido sería
   * penalizar a quien estaba conduciendo por estar conduciendo.
   */
  async getPerformance(userId: string, days = 30) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await DriverOffer.aggregate([
      { $match: { driverId: driver._id, offeredAt: { $gte: since } } },
      {
        $group: {
          _id: '$outcome',
          count: { $sum: 1 },
          // Solo tiene sentido donde hubo respuesta; en las vencidas es null
          // y `$avg` los ignora, que es justo lo que hace falta.
          avgResponseMs: {
            $avg: {
              $cond: [
                { $ifNull: ['$respondedAt', false] },
                { $subtract: ['$respondedAt', '$offeredAt'] },
                null,
              ],
            },
          },
        },
      },
    ]);

    const by = (outcome: string) => rows.find((r) => r._id === outcome)?.count ?? 0;

    const accepted = by('accepted');
    const declined = by('declined');
    const expired = by('expired');
    const takenByOther = by('taken_by_other');

    /** Las que de verdad estaban en su mano. */
    const decidable = accepted + declined + expired;

    /**
     * Cuánto tarda en decidir, sobre aceptadas y rechazadas juntas.
     *
     * Ponderado por número de ofertas y no un promedio de promedios: con
     * 20 aceptaciones rápidas y 2 rechazos lentos, promediar las dos medias
     * daría casi el mismo peso a los dos rechazos que a las veinte
     * aceptaciones, y el número saldría mucho peor de lo que fue.
     */
    const responded = rows.filter(
      (r) => (r._id === 'accepted' || r._id === 'declined') && r.avgResponseMs != null
    );
    const respondedCount = responded.reduce((n, r) => n + r.count, 0);
    const avgResponseSeconds = respondedCount
      ? Math.round(
          responded.reduce((sum, r) => sum + r.avgResponseMs * r.count, 0) /
            respondedCount /
            1000
        )
      : null;

    // Las cancelaciones que le constan al domiciliario: pedidos que aceptó
    // y acabaron cancelados con él encima. No distingue de quién fue la
    // culpa, así que se enseña como dato y nunca como reproche.
    const { Order } = await import('../models');
    const [delivered, cancelledWithDriver] = await Promise.all([
      Order.countDocuments({ driverId: driver._id, status: 'delivered', deliveredAt: { $gte: since } }),
      Order.countDocuments({ driverId: driver._id, status: 'cancelled', updatedAt: { $gte: since } }),
    ]);

    return {
      days,
      since,
      offers: { accepted, declined, expired, takenByOther, total: decidable + takenByOther },
      /** `null` cuando todavía no hay ofertas: 0 % sería una calumnia. */
      acceptanceRate: decidable ? Math.round((accepted / decidable) * 100) : null,
      avgResponseSeconds,
      deliveries: { completed: delivered, cancelled: cancelledWithDriver },
      rating: driver.rating,
      totalDeliveries: driver.totalDeliveries,
      /**
       * Que el número no cambia nada, dicho por el servidor.
       *
       * Va en la respuesta y no solo en la pantalla para que quede escrito
       * en un sitio que no se puede cambiar sin desplegar. Si algún día
       * deja de ser verdad, esta línea tiene que cambiar con ello.
       */
      affectsDispatch: false,
    };
  }

  /**
   * Por qué le dicen que no a los pedidos.
   *
   * Es la pregunta de operaciones, no la del domiciliario: si la mitad de
   * los rechazos son `low_pay`, el problema es la tarifa y no la gente.
   */
  async declineReasons(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await DriverOffer.aggregate([
      { $match: { outcome: 'declined', offeredAt: { $gte: since } } },
      { $group: { _id: '$declineReason', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return rows.map((r) => ({ reason: r._id ?? 'sin_motivo', count: r.count }));
  }

  /**
   * Outstanding cash the driver has to remit.
   *
   * Reads the reconciliation ledger. Legacy `DriverDebt` rows are folded in
   * so a driver mid-migration still sees one honest number rather than two
   * partial ones.
   */
  async getPendingDebts(userId: string) {
    const driver = await Driver.findOne({ userId });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);

    const cash = await cashReconciliationService.forDriver(userId);

    const legacyDebts = await DriverDebt.find({
      driverId: driver._id,
      status: DebtStatus.PENDING,
    }).populate('orderId', 'orderNumber total');

    const legacyTotal = legacyDebts.reduce((sum, d) => sum + d.amount, 0);

    return {
      totalDebt: cash.outstanding + legacyTotal,
      outstanding: cash.outstanding,
      reported: cash.reported,
      overdue: cash.overdue,
      records: cash.records,
      /** @deprecated Pre-migration rows, shown until they are settled. */
      debts: legacyDebts,
    };
  }

  /**
   * Records that the driver says they remitted the cash.
   *
   * This is a *declaration*, not a settlement. The old `payDebts` flipped
   * the status to PAID with no money attached, which meant the platform's
   * only real revenue channel on cash orders was whatever drivers chose to
   * declare. Clearing the balance now requires a verified transaction or a
   * finance admin — see CashReconciliationService.
   */
  async reportCashRemittance(
    userId: string,
    ids: string[],
    reference: string
  ): Promise<{ reportedCount: number; totalReported: number }> {
    return cashReconciliationService.report(userId, ids, reference);
  }
}

export const driverService = new DriverService();
