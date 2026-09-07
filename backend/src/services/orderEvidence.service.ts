import crypto from 'crypto';
import { FilterQuery, Types } from 'mongoose';
import { cloudinary, config } from '../config';
import { AppError } from '../middlewares';
import { OrderEvidence, IOrderEvidence } from '../models';
import { OrderEvidenceType, OrderStatus, UserRole } from '../types';
import { OrderAccess, assertParticipant } from './orderAccess.service';

export const EVIDENCE_ERROR = {
  INVALID_FILE: 'EVIDENCE_INVALID_FILE',
  TOO_LARGE: 'EVIDENCE_TOO_LARGE',
  WRONG_STAGE: 'EVIDENCE_WRONG_STAGE',
  DUPLICATE: 'EVIDENCE_DUPLICATE',
  STORAGE: 'EVIDENCE_STORAGE_FAILED',
} as const;

/**
 * Firmas binarias de los formatos aceptados.
 *
 * El `Content-Type` de un multipart lo escribe el cliente, y la extensión
 * del nombre también: las dos se falsifican escribiendo texto. Lo único
 * que no se puede fingir sin cambiar el archivo son sus primeros bytes,
 * así que la comprobación real es esta. Es la defensa contra el clásico
 * `payload.php` renombrado a `foto.jpg` con `Content-Type: image/jpeg`.
 */
const MAGIC_NUMBERS: Array<{ format: string; test: (b: Buffer) => boolean }> = [
  {
    format: 'jpg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    format: 'png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    format: 'webp',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/** Qué evidencia corresponde a cada momento del pedido. */
const STAGE_FOR_TYPE: Record<OrderEvidenceType, OrderStatus> = {
  [OrderEvidenceType.PICKUP]: OrderStatus.READY,
  [OrderEvidenceType.DELIVERY]: OrderStatus.ON_WAY,
};

export interface EvidenceView {
  id: string;
  orderId: string;
  type: OrderEvidenceType;
  url: string;
  uploadedAt: Date;
  uploadedBy: string;
  uploadedByRole: UserRole;
  orderStatus: OrderStatus;
  location: { lat: number; lng: number } | null;
  metadata: IOrderEvidence['metadata'];
}

export class OrderEvidenceService {
  /**
   * Comprueba que el buffer recibido es de verdad una imagen permitida.
   *
   * Devuelve el formato deducido de los bytes, no el declarado: lo que se
   * guarda en la base es lo que el archivo es, no lo que dijo ser.
   */
  private inspect(buffer: Buffer, declaredMime: string): { format: string; checksum: string } {
    if (!buffer?.length) {
      throw new AppError('La imagen llegó vacía', 400, EVIDENCE_ERROR.INVALID_FILE);
    }
    if (buffer.length > config.orderFlow.evidence.maxBytes) {
      const mb = Math.round(config.orderFlow.evidence.maxBytes / (1024 * 1024));
      throw new AppError(`La imagen supera el máximo de ${mb} MB`, 413, EVIDENCE_ERROR.TOO_LARGE);
    }

    const match = MAGIC_NUMBERS.find((candidate) => candidate.test(buffer));
    if (!match) {
      throw new AppError(
        'El archivo no es una imagen válida. Usa JPG, PNG o WEBP.',
        400,
        EVIDENCE_ERROR.INVALID_FILE
      );
    }

    // Coherencia entre lo declarado y lo real. Un desajuste no es un error
    // del usuario —ninguna cámara lo produce— sino un intento de colar otra
    // cosa, así que se rechaza en vez de "corregirse" en silencio.
    const declared = (declaredMime || '').toLowerCase();
    const expected = match.format === 'jpg' ? 'image/jpeg' : `image/${match.format}`;
    if (declared && declared !== expected) {
      throw new AppError(
        'El archivo no coincide con su tipo declarado',
        400,
        EVIDENCE_ERROR.INVALID_FILE
      );
    }

    return {
      format: match.format,
      checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  /**
   * Sube la evidencia y la deja registrada contra el pedido.
   *
   * La imagen se guarda como `authenticated` en Cloudinary: a diferencia
   * de un banner o un logo, esto es la puerta de casa de alguien con su
   * pedido en la mano. Sin firma, la URL sería pública para cualquiera que
   * la tuviese, y las URLs se filtran en logs, capturas y reenvíos.
   */
  async upload(params: {
    access: OrderAccess;
    type: OrderEvidenceType;
    buffer: Buffer;
    mimetype: string;
    location?: { lat: number; lng: number } | null;
  }): Promise<EvidenceView> {
    const { access, type, buffer } = params;

    assertParticipant(access, ['driver'], 'subir evidencias');

    const order = access.order;
    if (order.status !== STAGE_FOR_TYPE[type]) {
      throw new AppError(
        type === OrderEvidenceType.PICKUP
          ? 'Solo puedes registrar la recogida cuando el pedido está listo'
          : 'Solo puedes registrar la entrega cuando vas en camino',
        409,
        EVIDENCE_ERROR.WRONG_STAGE
      );
    }

    const { format, checksum } = this.inspect(buffer, params.mimetype);

    // La misma foto no puede documentar dos traspasos distintos: subir la
    // del mostrador otra vez en la puerta del cliente sería "probar" una
    // entrega que nadie vio. El hash del binario lo detecta.
    const reused = await OrderEvidence.findOne({
      orderId: order._id,
      'metadata.checksum': checksum,
    }).select('type');
    if (reused && reused.type !== type) {
      throw new AppError(
        'Esa foto ya se usó como evidencia en otro momento del pedido',
        409,
        EVIDENCE_ERROR.DUPLICATE
      );
    }

    const uploaded = await this.store(buffer, order._id.toString(), type);

    const evidence = await OrderEvidence.create({
      orderId: order._id,
      type,
      storageKey: uploaded.publicId,
      imageUrl: uploaded.url,
      isPrivate: true,
      uploadedBy: new Types.ObjectId(access.userId),
      uploadedByRole: UserRole.DRIVER,
      driverId: order.driverId ?? null,
      businessId: order.businessId,
      customerId: order.clientId,
      orderStatus: order.status,
      location: params.location
        ? { type: 'Point', coordinates: [params.location.lng, params.location.lat] }
        : undefined,
      metadata: {
        bytes: buffer.length,
        format,
        width: uploaded.width,
        height: uploaded.height,
        checksum,
      },
    });

    return this.toView(evidence);
  }

  /** Envía el binario a Cloudinary. Aislado para poder sustituirlo en pruebas. */
  private store(
    buffer: Buffer,
    orderId: string,
    type: OrderEvidenceType
  ): Promise<{ publicId: string; url: string; width?: number; height?: number }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${config.orderFlow.evidence.folder}/${orderId}`,
          resource_type: 'image',
          // `authenticated` obliga a que toda entrega venga firmada con la
          // clave del servidor: la URL no se puede construir a mano.
          type: 'authenticated',
          // Sin `format` fijo, un nombre malicioso podría acabar sirviendo
          // otra cosa. Se recodifica siempre a JPG.
          format: 'jpg',
          tags: ['order-evidence', type],
          transformation: [
            { width: 1440, crop: 'limit' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error || !result) {
            reject(new AppError('No se pudo guardar la evidencia', 502, EVIDENCE_ERROR.STORAGE));
            return;
          }
          resolve({
            publicId: result.public_id,
            url: result.secure_url,
            width: result.width,
            height: result.height,
          });
        }
      );
      stream.end(buffer);
    });
  }

  /**
   * URL firmada para ver una evidencia.
   *
   * Se genera en cada lectura y solo para quien ya pasó el control de
   * acceso del pedido; nunca se persiste, para que un volcado de la base
   * de datos no contenga enlaces utilizables.
   */
  signedUrl(evidence: IOrderEvidence): string {
    if (!evidence.isPrivate) return evidence.imageUrl;
    return cloudinary.url(evidence.storageKey, {
      type: 'authenticated',
      resource_type: 'image',
      sign_url: true,
      secure: true,
    });
  }

  toView(evidence: IOrderEvidence): EvidenceView {
    const coords = evidence.location?.coordinates;
    // `search` popula `orderId` y `uploadedBy`; un `.toString()` directo
    // sobre un documento poblado devuelve su serialización, no el id.
    const idOf = (ref: any): string => String(ref?._id ?? ref ?? '');
    return {
      id: evidence._id.toString(),
      orderId: idOf(evidence.orderId),
      type: evidence.type,
      url: this.signedUrl(evidence),
      uploadedAt: evidence.uploadedAt,
      uploadedBy: idOf(evidence.uploadedBy),
      uploadedByRole: evidence.uploadedByRole,
      orderStatus: evidence.orderStatus,
      location: coords ? { lng: coords[0], lat: coords[1] } : null,
      metadata: evidence.metadata,
    };
  }

  /**
   * Evidencias de un pedido, para cualquiera de sus partes.
   *
   * El comercio ve la recogida —es su descargo de responsabilidad— pero no
   * la entrega: la puerta de casa del cliente no es asunto suyo.
   */
  async listForOrder(access: OrderAccess): Promise<EvidenceView[]> {
    const filter: FilterQuery<IOrderEvidence> = { orderId: access.order._id };
    if (access.participant === 'business') filter.type = OrderEvidenceType.PICKUP;

    const evidences = await OrderEvidence.find(filter).sort({ uploadedAt: 1 });
    return evidences.map((evidence) => this.toView(evidence));
  }

  /** Listado con filtros para el panel de administración. */
  async search(params: {
    orderId?: string;
    businessId?: string;
    driverId?: string;
    type?: OrderEvidenceType;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const filter: FilterQuery<IOrderEvidence> = {};
    if (params.orderId && Types.ObjectId.isValid(params.orderId)) filter.orderId = params.orderId;
    if (params.businessId && Types.ObjectId.isValid(params.businessId)) filter.businessId = params.businessId;
    if (params.driverId && Types.ObjectId.isValid(params.driverId)) filter.driverId = params.driverId;
    if (params.type) filter.type = params.type;
    if (params.from || params.to) {
      filter.uploadedAt = {};
      if (params.from) (filter.uploadedAt as any).$gte = new Date(params.from);
      if (params.to) (filter.uploadedAt as any).$lte = new Date(params.to);
    }

    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const [items, total] = await Promise.all([
      OrderEvidence.find(filter)
        .sort({ uploadedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('orderId', 'orderNumber status')
        .populate('businessId', 'name')
        .populate('uploadedBy', 'name phone'),
      OrderEvidence.countDocuments(filter),
    ]);

    return {
      evidences: items.map((evidence) => ({
        ...this.toView(evidence),
        order: evidence.orderId,
        business: evidence.businessId,
        uploader: evidence.uploadedBy,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}

export const orderEvidenceService = new OrderEvidenceService();
