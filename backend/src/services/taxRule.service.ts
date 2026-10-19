import { Types } from 'mongoose';
import { TaxRule, ITaxRule, TaxConcept, TaxTreatment, TaxBase, TaxType, CHECKOUT_TAX_CONCEPTS, ALL_TAX_CONCEPTS } from '../models/TaxRule';
import { Order } from '../models/Order';
import { Payment } from '../models/Payment';
import { AdInvoice } from '../models/AdInvoice';
import { Refund } from '../models/Refund';
import { OrderStatus, PaymentStatus, PaymentType, RefundStatus } from '../types';
import { AppError } from '../middlewares';
import { applyBps } from '../utils/money';
import { electronicInvoicingService } from './electronicInvoicing.service';

/**
 * Reglas tributarias por concepto (M-014): el único lugar donde ZIPP pregunta
 * «¿este concepto lleva impuesto, cuánto y desde cuándo?».
 *
 * Ninguna tarifa viene de fábrica. Sin una regla VALIDADA y vigente, la respuesta
 * es «pendiente» y el cálculo no se presenta como definitivo (`TaxAssessment.status`).
 * Lo que valida una regla es una persona con un documento que la respalde; este
 * servicio solo impide que se use algo que nadie validó y que se reescriba el pasado.
 */

const DAY_MS = 86_400_000;

export interface TaxAssessment {
  concept: TaxConcept;
  /** `definitive`: hay una regla validada y vigente. `pending`: no la hay, el impuesto NO se calculó. */
  status: 'definitive' | 'pending';
  ruleId: string | null;
  treatment: TaxTreatment | null;
  rateBps: number | null;
  base: TaxBase | null;
  priceIncludesTax: boolean | null;
  /** Importe sobre el que se calculó. */
  baseAmount: number;
  /** Impuesto del concepto. 0 si está pendiente, o si el tratamiento no es gravado. */
  taxAmount: number;
  reason?: string;
}

/** Lo que el checkout necesita para calcular el impuesto de un pedido. */
export interface CheckoutTaxPlan {
  /**
   * `legacy`: la tasa global de `PlatformPricingConfig.taxBps` sobre los tres conceptos
   * (lo de siempre). `rules`: tasa y base por concepto, de reglas validadas.
   */
  mode: 'legacy' | 'rules';
  /**
   * `legacy`: reglas apagadas, sigue la tasa global sin validar. `definitive`: reglas
   * validadas por concepto. `provisional`: las reglas están encendidas pero falta
   * una vigente —se usó la tasa global y alguien tiene que mirarlo—.
   */
  status: 'legacy' | 'definitive' | 'provisional';
  rates: Partial<Record<TaxConcept, { bps: number; base: TaxBase; ruleId: string }>>;
  missing: TaxConcept[];
}

export interface TaxRuleInput {
  concept: TaxConcept;
  label?: string;
  treatment: TaxTreatment;
  taxType?: TaxType;
  rateBps?: number | null;
  base?: TaxBase;
  priceIncludesTax?: boolean;
  conditions?: string;
  validFrom: Date;
  changeReason?: string;
}

/** Qué consume hoy cada concepto: lo que se ve en el informe de pendientes. */
const CONSUMERS: Record<TaxConcept, string> = {
  [TaxConcept.PRODUCTS]: 'Checkout: impuesto del pedido (se suma al total del cliente).',
  [TaxConcept.DELIVERY]: 'Checkout: impuesto del pedido (se suma al total del cliente).',
  [TaxConcept.SERVICE_FEE]: 'Checkout: impuesto del pedido (se suma al total del cliente).',
  [TaxConcept.COMMISSION]: 'Pedido: la comisión queda con su evaluación tributaria (incluida en el precio; no cambia lo que se descuenta al comercio).',
  [TaxConcept.ADVERTISING]: 'Cobro de publicidad: se extrae del precio (informativo, no cambia lo que se cobra).',
  [TaxConcept.PRO_SUBSCRIPTION]: 'Cobro de Zipp Pro: queda con su evaluación tributaria (incluida en la cuota; no cambia lo que se cobra).',
  [TaxConcept.OTHER]: 'Sin integración: servicios futuros.',
};

/**
 * Cómo se conecta cada concepto con el dinero (Auditoría 2026-10-19). Son HECHOS
 * del código, no criterio tributario: quién presta el servicio, quién recibe el
 * ingreso, sobre qué importe se calcularía y en qué momento queda registrado.
 * Lo que NO se sabe va en `openQuestions`, para el responsable contable: ZIPP no
 * decide qué grava la ley.
 *
 *  · `checkout`: el impuesto se SUMA al total del cliente y se asienta en el libro
 *    (`taxPayable`) en el pedido. Solo con las reglas encendidas y validadas.
 *  · `snapshot`: la evaluación se guarda con el hecho (pedido, cobro) para
 *    conciliar. El tratamiento es «incluido en el precio»: NO cambia el importe
 *    cobrado ni lo que se paga a nadie; solo separa cuánto de lo cobrado es impuesto.
 *  · `none`: sin integración todavía.
 */
export type TaxIntegration = 'checkout' | 'snapshot' | 'none';

export interface TaxConceptProfile {
  integration: TaxIntegration;
  provider: string;
  recipient: string;
  base: string;
  recordedIn: string;
  openQuestions: string[];
}

export const CONCEPT_PROFILES: Record<TaxConcept, TaxConceptProfile> = {
  [TaxConcept.PRODUCTS]: {
    integration: 'checkout',
    provider: 'El comercio (vende el producto).',
    recipient: 'El comercio; ZIPP recauda en su nombre y se lo liquida.',
    base: 'Subtotal de productos, tras descuentos (o bruto, según la regla).',
    recordedIn: 'Pedido (`finance.taxBreakdown`) y libro (`taxPayable`).',
    openQuestions: [
      '¿Quién declara y paga el impuesto de los productos: el comercio o ZIPP? Hoy el libro lo registra como pasivo de ZIPP.',
      '¿Cambia según el régimen del comercio (responsable o no de IVA)?',
    ],
  },
  [TaxConcept.DELIVERY]: {
    integration: 'checkout',
    provider: 'ZIPP con su red de domiciliarios (por confirmar).',
    recipient: 'ZIPP (margen) y el domiciliario (su pago).',
    base: 'Domicilio que paga el cliente, tras descuentos.',
    recordedIn: 'Pedido (`finance.taxBreakdown`) y libro (`taxPayable`).',
    openQuestions: [
      '¿Quién presta el servicio de transporte: ZIPP o el domiciliario como independiente? Define quién factura y quién declara.',
    ],
  },
  [TaxConcept.SERVICE_FEE]: {
    integration: 'checkout',
    provider: 'ZIPP.',
    recipient: 'ZIPP.',
    base: 'Tarifa de servicio cobrada al cliente, tras descuentos.',
    recordedIn: 'Pedido (`finance.taxBreakdown`) y libro (`taxPayable`).',
    openQuestions: [],
  },
  [TaxConcept.COMMISSION]: {
    integration: 'snapshot',
    provider: 'ZIPP (servicio de plataforma al comercio).',
    recipient: 'ZIPP.',
    base: 'Comisión del pedido, ya descontados los descuentos que paga el comercio.',
    recordedIn: 'Pedido (`finance.commissionTax`), al crearlo.',
    openQuestions: [
      '¿La comisión lleva impuesto? Si sí, ¿va incluido en la comisión o se cobra encima al comercio? Hoy solo se admite «incluido»: cobrarlo encima cambia la liquidación del comercio.',
      'El comercio necesita un documento válido para descontar el impuesto: depende de la facturación electrónica (no integrada).',
    ],
  },
  [TaxConcept.ADVERTISING]: {
    integration: 'snapshot',
    provider: 'ZIPP.',
    recipient: 'ZIPP.',
    base: 'Importe cobrado al cerrar la campaña (`AdInvoice.amount`).',
    recordedIn: 'Cobro de publicidad (`AdInvoice.taxAssessment`), al cerrar la campaña.',
    openQuestions: [
      '¿Incluido o encima? Hoy solo «incluido». El cobro de publicidad es interno: no es factura electrónica.',
    ],
  },
  [TaxConcept.PRO_SUBSCRIPTION]: {
    integration: 'snapshot',
    provider: 'ZIPP.',
    recipient: 'ZIPP.',
    base: 'Cuota cobrada (`Payment.amount`).',
    recordedIn: 'Cobro de la membresía (`Payment.metadata.taxAssessment`), al aprobarse.',
    openQuestions: [
      '¿Incluido o encima? Hoy solo «incluido». El cliente final también necesita su documento (facturación electrónica no integrada).',
    ],
  },
  [TaxConcept.OTHER]: {
    integration: 'none',
    provider: 'Por definir.',
    recipient: 'Por definir.',
    base: 'Por definir.',
    recordedIn: 'No se registra: servicios futuros.',
    openQuestions: ['Cada servicio nuevo necesita su propio análisis antes de cobrarse.'],
  },
};

/** La evaluación tributaria de un cobro, tal como se guarda junto a él. */
export interface TaxSnapshot {
  status: 'definitive' | 'pending';
  ruleId: string | null;
  treatment: TaxTreatment | null;
  rateBps: number | null;
  /** Importe sobre el que se evaluó. */
  baseAmount: number;
  /** Cuánto de lo cobrado es impuesto (extraído, «incluido»). 0 si está pendiente, exento o excluido. */
  taxIncluded: number;
  assessedAt: Date;
}

const REQUIRED_FROM_ACCOUNTANT = [
  'Tratamiento tributario del concepto (gravado, exento, excluido o no aplica).',
  'Tarifa, si es gravado, y qué impuesto es (IVA, consumo u otro).',
  'Base gravable: lo que paga el cliente tras descuentos, o el valor bruto.',
  'Si el impuesto viene dentro del precio o se suma encima.',
  'Condiciones de aplicación (p. ej. según el régimen del comercio).',
  'Fecha desde la que rige y el documento que lo respalda.',
];

export const taxRuleService = {
  // ── Escritura ───────────────────────────────────────────────────────────

  /** Crea una regla en borrador. Un borrador no se usa para nada. */
  async createDraft(input: TaxRuleInput, userId: string): Promise<ITaxRule> {
    this.assertCoherent(input);
    return TaxRule.create({
      concept: input.concept,
      label: input.concept === TaxConcept.OTHER ? (input.label ?? '').trim() : '',
      treatment: input.treatment,
      taxType: input.taxType ?? 'iva',
      rateBps: input.treatment === TaxTreatment.TAXED ? input.rateBps ?? null : null,
      base: input.base ?? 'net_of_discounts',
      priceIncludesTax: input.priceIncludesTax ?? !CHECKOUT_TAX_CONCEPTS.includes(input.concept),
      conditions: input.conditions ?? '',
      validFrom: input.validFrom,
      status: 'draft',
      createdBy: new Types.ObjectId(userId),
      changeReason: input.changeReason ?? '',
    });
  },

  /** Solo un borrador se edita: una regla validada es historia. */
  async updateDraft(id: string, patch: Partial<TaxRuleInput>, userId: string): Promise<ITaxRule> {
    const rule = await this.mustFind(id);
    if (rule.status !== 'draft') throw new AppError('Una regla validada no se edita: publica una nueva con su vigencia.', 409, 'TAX_RULE_IMMUTABLE');
    const merged: TaxRuleInput = {
      concept: rule.concept,
      label: rule.label,
      treatment: rule.treatment,
      taxType: rule.taxType,
      rateBps: rule.rateBps,
      base: rule.base,
      priceIncludesTax: rule.priceIncludesTax,
      conditions: rule.conditions,
      validFrom: rule.validFrom,
      ...patch,
    };
    this.assertCoherent(merged);
    Object.assign(rule, {
      label: merged.concept === TaxConcept.OTHER ? (merged.label ?? '').trim() : '',
      treatment: merged.treatment,
      taxType: merged.taxType,
      rateBps: merged.treatment === TaxTreatment.TAXED ? merged.rateBps ?? null : null,
      base: merged.base,
      priceIncludesTax: merged.priceIncludesTax,
      conditions: merged.conditions ?? '',
      validFrom: merged.validFrom,
      changeReason: patch.changeReason ?? rule.changeReason,
    });
    // Quien edita deja de poder aprobar: lo que se aprueba no lo escribió quien lo aprueba.
    rule.lastEditedBy = new Types.ObjectId(userId);
    await rule.save();
    return rule;
  },

  async removeDraft(id: string): Promise<void> {
    const deleted = await TaxRule.deleteOne({ _id: id, status: 'draft' });
    if (deleted.deletedCount === 0) throw new AppError('Solo se borra un borrador.', 409, 'TAX_RULE_IMMUTABLE');
  },

  /**
   * Valida (aprueba) una regla: desde ese momento la usan los cálculos.
   *
   * Doble aprobación (Auditoría 2026-10-19): una persona propone —crea o edita el
   * borrador— y OTRA lo aprueba. Quien creó o tocó el borrador no puede aprobarlo,
   * ni siquiera con el permiso `tax:approve`. La ruta exige ese permiso, aparte del
   * de configuración; aquí queda la regla que no depende de ningún permiso.
   *
   * Quien valida deja el documento que respalda la decisión (`validationRef`);
   * sin él no hay validación. No se valida hacia el pasado —un pedido ya cobrado
   * conserva la regla con la que se cobró—: si el borrador pedía empezar antes de
   * este instante, la regla rige desde este instante (`proposedValidFrom` guarda lo
   * pedido). La regla anterior del concepto se cierra en el mismo instante en que
   * empieza la nueva, sin hueco ni solape, y esta queda enlazada a ella con sus
   * valores previos.
   */
  async validate(id: string, userId: string, input: { validationRef: string; note?: string }): Promise<ITaxRule> {
    const ref = (input.validationRef ?? '').trim();
    if (ref.length < 5) {
      throw new AppError('Indica el documento que respalda la regla (concepto del contador, circular, radicado).', 422, 'TAX_RULE_NEEDS_REFERENCE');
    }
    const rule = await this.mustFind(id);
    if (rule.status !== 'draft') throw new AppError('Esa regla ya fue validada.', 409, 'TAX_RULE_IMMUTABLE');
    this.assertCoherent(rule);

    if (
      String(rule.createdBy) === String(userId) ||
      (rule.lastEditedBy && String(rule.lastEditedBy) === String(userId))
    ) {
      throw new AppError(
        'No puedes aprobar una regla que tú propusiste o editaste: la aprueba otra persona.',
        403,
        'TAX_RULE_SELF_APPROVAL'
      );
    }

    // Inicio del día de hoy en Colombia (UTC−5, sin horario de verano), expresado en UTC.
    const COLOMBIA_OFFSET_MS = 5 * 3_600_000;
    const startOfToday = new Date(Math.floor((Date.now() - COLOMBIA_OFFSET_MS) / DAY_MS) * DAY_MS + COLOMBIA_OFFSET_MS);
    if (rule.validFrom < startOfToday) {
      throw new AppError('Una regla validada no puede empezar en el pasado: no se reescriben los pedidos ya cobrados.', 422, 'TAX_RULE_RETROACTIVE');
    }

    // Hoy, pero antes de este instante: tampoco. Un pedido de hace dos horas ya se cobró con
    // lo que regía entonces; la regla empieza ahora y la fecha pedida queda anotada.
    const now = new Date();
    const requestedFrom = rule.validFrom;
    const effectiveFrom = requestedFrom < now ? now : requestedFrom;
    rule.validFrom = effectiveFrom;

    // Una regla futura ya validada para el concepto bloquea otra anterior a ella.
    const later = await TaxRule.findOne({ concept: rule.concept, status: 'validated', validFrom: { $gt: rule.validFrom } }).lean();
    if (later) {
      throw new AppError('Ya hay una regla validada que empieza después. Cámbiala primero.', 409, 'TAX_RULE_OVERLAP');
    }

    // La regla que esta reemplaza, con sus valores, antes de cerrarla.
    const previous = await TaxRule.findOne({
      concept: rule.concept, status: 'validated', validFrom: { $lte: rule.validFrom },
      $or: [{ validTo: null }, { validTo: { $gt: rule.validFrom } }],
    }).sort({ validFrom: -1 }).lean();

    const validated = await TaxRule.findOneAndUpdate(
      { _id: rule._id, status: 'draft', updatedAt: rule.updatedAt },
      {
        $set: {
          status: 'validated',
          validatedBy: new Types.ObjectId(userId),
          validatedAt: new Date(),
          validationRef: ref,
          validationNote: (input.note ?? '').trim().slice(0, 500),
          validFrom: effectiveFrom,
          proposedValidFrom: effectiveFrom.getTime() !== requestedFrom.getTime() ? requestedFrom : null,
          supersedes: previous?._id ?? null,
          previousValues: previous
            ? {
                treatment: previous.treatment, rateBps: previous.rateBps ?? null, base: previous.base,
                priceIncludesTax: previous.priceIncludesTax, validFrom: previous.validFrom,
                validTo: previous.validTo ?? null, validationRef: previous.validationRef,
              }
            : null,
        },
      },
      { new: true }
    );
    if (!validated) throw new AppError('Esa regla cambió mientras se validaba. Revísala e inténtalo de nuevo.', 409);

    // Cierra la vigente: queda terminada justo cuando empieza esta. Va DESPUÉS de reclamar el
    // borrador: si alguien lo editó mientras se aprobaba, el reclamo falla y la regla vigente
    // no se queda cerrada sin reemplazo. Condicionado dentro del filtro, así dos validaciones
    // simultáneas del mismo concepto no se pisan.
    await TaxRule.updateMany(
      { _id: { $ne: validated._id }, concept: rule.concept, status: 'validated', validFrom: { $lt: effectiveFrom }, $or: [{ validTo: null }, { validTo: { $gt: effectiveFrom } }] },
      { $set: { validTo: effectiveFrom } }
    );

    // Dos validaciones simultáneas del mismo concepto pueden haber cerrado cada
    // una lo que veía y no lo que la otra acababa de escribir. Esto lo deja
    // consistente pase lo que pase: cada regla termina donde empieza la siguiente.
    await this.normalizeValidity(rule.concept);
    return validated;
  },

  /** Cada regla validada del concepto termina justo donde empieza la siguiente: sin solapes. Idempotente. */
  async normalizeValidity(concept: TaxConcept): Promise<void> {
    const rules = await TaxRule.find({ concept, status: 'validated' }).sort({ validFrom: 1 });
    for (let i = 0; i < rules.length - 1; i += 1) {
      const next = rules[i + 1];
      if (!rules[i].validTo || rules[i].validTo! > next.validFrom) {
        await TaxRule.updateOne({ _id: rules[i]._id }, { $set: { validTo: next.validFrom } });
      }
    }
  },

  // ── Lectura ─────────────────────────────────────────────────────────────

  async list(filter: { concept?: TaxConcept; status?: string } = {}) {
    const q: Record<string, unknown> = {};
    if (filter.concept) q.concept = filter.concept;
    if (filter.status) q.status = filter.status;
    return TaxRule.find(q).sort({ concept: 1, validFrom: -1 }).lean();
  },

  /** La regla validada que rige para `concept` en `at`; `null` = pendiente de configuración. */
  async resolve(concept: TaxConcept, at: Date = new Date()): Promise<ITaxRule | null> {
    return TaxRule.findOne({
      concept,
      status: 'validated',
      validFrom: { $lte: at },
      $or: [{ validTo: null }, { validTo: { $gt: at } }],
    }).sort({ validFrom: -1 });
  },

  /**
   * El impuesto de un importe, con la misma lógica en todos los consumidores.
   * Sin regla validada y vigente devuelve `pending` y 0: nunca una tarifa supuesta.
   */
  async assess(concept: TaxConcept, amount: number, at: Date = new Date()): Promise<TaxAssessment> {
    const rule = await this.resolve(concept, at);
    if (!rule) {
      return {
        concept, status: 'pending', ruleId: null, treatment: null, rateBps: null, base: null,
        priceIncludesTax: null, baseAmount: amount, taxAmount: 0,
        reason: 'Sin regla tributaria validada y vigente para este concepto: el impuesto no se calculó.',
      };
    }
    return this.assessWith(rule, amount);
  },

  /**
   * La evaluación que se guarda con un cobro de un concepto «incluido en el precio»
   * (comisión, publicidad, Zipp Pro). Una sola implementación para los tres: un
   * cambio de criterio no puede dejar a uno con la regla vieja.
   *
   * No cambia ningún importe: separa cuánto de lo ya cobrado es impuesto. Sin regla
   * validada y vigente en `at` queda `pending` y 0: nunca una tarifa supuesta. Una
   * regla «encima» (que `assertCoherent` impide para estos conceptos) no se extrae.
   */
  async snapshot(concept: TaxConcept, amount: number, at: Date = new Date()): Promise<TaxSnapshot> {
    const assessment = await this.assess(concept, amount, at);
    return {
      status: assessment.status,
      ruleId: assessment.ruleId,
      treatment: assessment.treatment,
      rateBps: assessment.rateBps,
      baseAmount: amount,
      taxIncluded: assessment.status === 'definitive' && assessment.priceIncludesTax ? assessment.taxAmount : 0,
      assessedAt: at,
    };
  },

  /**
   * Conciliación tributaria por concepto de un periodo: cuántos hechos hubo, sobre
   * qué base, cuánto impuesto quedó definido y cuántos siguen PENDIENTES (sin regla
   * validada al momento del hecho). Lee lo que cada hecho guardó; NO recalcula con
   * las reglas de hoy, así que un cambio de vigencia no reescribe el pasado.
   *
   * No es una declaración: mientras haya hechos pendientes o pedidos con la tasa
   * global sin validar, `definitive` es falso y el informe lo dice.
   */
  async reconciliation(range: { from: Date; to: Date }) {
    const createdAt = { $gte: range.from, $lte: range.to };
    const empty = () => ({ events: 0, baseTotal: 0, taxTotal: 0, pendingEvents: 0, pendingBase: 0, notAssessed: 0 });
    const rows: Record<string, ReturnType<typeof empty>> = {};
    for (const c of ALL_TAX_CONCEPTS) rows[c] = empty();

    // Checkout: lo que el pedido congeló. Los pedidos con tasa global (`legacy`/`provisional`) no tienen
    // concepto ni regla: se cuentan aparte, sin validar.
    const orders = await Order.aggregate([
      { $match: { createdAt, status: { $ne: OrderStatus.CANCELLED }, 'finance.customerTotal': { $gt: 0 } } },
      {
        $group: {
          _id: { $ifNull: ['$finance.taxStatus', 'legacy'] },
          orders: { $sum: 1 },
          taxPayable: { $sum: '$finance.taxPayable' },
        },
      },
    ]);
    const unvalidatedTax = { orders: 0, taxPayable: 0 };
    let definitiveOrders = 0;
    for (const r of orders) {
      if (r._id === 'definitive') definitiveOrders += r.orders;
      else { unvalidatedTax.orders += r.orders; unvalidatedTax.taxPayable += r.taxPayable; }
    }
    const lines = await Order.aggregate([
      { $match: { createdAt, status: { $ne: OrderStatus.CANCELLED }, 'finance.taxStatus': 'definitive' } },
      { $unwind: '$finance.taxBreakdown' },
      {
        $group: {
          _id: '$finance.taxBreakdown.concept',
          events: { $sum: 1 },
          baseTotal: { $sum: '$finance.taxBreakdown.baseAmount' },
          taxTotal: { $sum: '$finance.taxBreakdown.amount' },
        },
      },
    ]);
    for (const l of lines) if (rows[l._id]) Object.assign(rows[l._id], { events: l.events, baseTotal: l.baseTotal, taxTotal: l.taxTotal });

    // Comisión: evaluación guardada en el pedido. Los pedidos anteriores a este registro no la tienen.
    const commission = await Order.aggregate([
      { $match: { createdAt, status: { $ne: OrderStatus.CANCELLED }, 'finance.merchantCommission': { $gt: 0 } } },
      {
        $group: {
          _id: { $ifNull: ['$finance.commissionTax.status', 'none'] },
          events: { $sum: 1 },
          base: { $sum: { $ifNull: ['$finance.commissionTax.baseAmount', '$finance.merchantCommission'] } },
          tax: { $sum: { $ifNull: ['$finance.commissionTax.taxIncluded', 0] } },
        },
      },
    ]);
    for (const c of commission) this.fold(rows[TaxConcept.COMMISSION], c._id, c.events, c.base, c.tax);

    // Publicidad: cobro al cerrar la campaña.
    const ads = await AdInvoice.aggregate([
      { $match: { createdAt } },
      {
        $group: {
          _id: { $ifNull: ['$taxAssessment.status', 'none'] },
          events: { $sum: 1 },
          base: { $sum: '$amount' },
          tax: { $sum: { $ifNull: ['$taxAssessment.taxIncluded', 0] } },
        },
      },
    ]);
    for (const a of ads) this.fold(rows[TaxConcept.ADVERTISING], a._id, a.events, a.base, a.tax);

    // Zipp Pro: cobros de membresía aprobados.
    const pro = await Payment.aggregate([
      { $match: { createdAt, type: PaymentType.PRO_SUBSCRIPTION, status: PaymentStatus.PAID } },
      {
        $group: {
          _id: { $ifNull: ['$metadata.taxAssessment.status', 'none'] },
          events: { $sum: 1 },
          base: { $sum: '$amount' },
          tax: { $sum: { $ifNull: ['$metadata.taxAssessment.taxIncluded', 0] } },
        },
      },
    ]);
    for (const x of pro) this.fold(rows[TaxConcept.PRO_SUBSCRIPTION], x._id, x.events, x.base, x.tax);

    // Impuesto del checkout que se devolvió al cliente en reembolsos del periodo (no se mezcla con lo cobrado).
    const [refunded] = await Refund.aggregate([
      { $match: { createdAt, status: RefundStatus.COMPLETED } },
      { $group: { _id: null, tax: { $sum: '$allocation.fromTax' }, commission: { $sum: '$allocation.fromCommission' } } },
    ]);

    const concepts = ALL_TAX_CONCEPTS.map((concept) => ({ concept, integration: CONCEPT_PROFILES[concept].integration, ...rows[concept] }));
    const pending = concepts.reduce((n, c) => n + c.pendingEvents + c.notAssessed, 0) + unvalidatedTax.orders;
    return {
      range,
      concepts,
      checkout: { definitiveOrders, unvalidatedGlobalRate: unvalidatedTax },
      refunds: { checkoutTaxReturned: refunded?.tax ?? 0, commissionReturned: refunded?.commission ?? 0 },
      // Falso mientras algo del periodo se haya cobrado sin regla validada: el informe no se puede presentar como cifra fiscal.
      definitive: pending === 0,
      note:
        'Conciliación de lo que cada hecho guardó al ocurrir; no es una declaración tributaria. ' +
        'Los hechos «pendientes» se cobraron sin una regla validada y vigente en ese momento: el impuesto no se calculó.',
    };
  },

  /** Suma un grupo de la agregación a la fila del concepto según el estado guardado. */
  fold(row: { events: number; baseTotal: number; taxTotal: number; pendingEvents: number; pendingBase: number; notAssessed: number }, status: string, events: number, base: number, tax: number) {
    if (status === 'definitive') { row.events += events; row.baseTotal += base; row.taxTotal += tax; }
    else if (status === 'pending') { row.pendingEvents += events; row.pendingBase += base; }
    else { row.notAssessed += events; }
  },

  /** El cálculo de una regla ya resuelta (pura). */
  assessWith(rule: Pick<ITaxRule, '_id' | 'concept' | 'treatment' | 'rateBps' | 'base' | 'priceIncludesTax'>, amount: number): TaxAssessment {
    const taxed = rule.treatment === TaxTreatment.TAXED && (rule.rateBps ?? 0) > 0;
    let taxAmount = 0;
    if (taxed) {
      taxAmount = rule.priceIncludesTax
        ? amount - Math.round((amount * 10_000) / (10_000 + (rule.rateBps as number))) // extrae lo que ya iba dentro
        : applyBps(amount, rule.rateBps as number);
    }
    return {
      concept: rule.concept, status: 'definitive', ruleId: String(rule._id), treatment: rule.treatment,
      rateBps: rule.rateBps ?? 0, base: rule.base, priceIncludesTax: rule.priceIncludesTax, baseAmount: amount, taxAmount,
    };
  },

  /**
   * Cómo calcula el checkout el impuesto de un pedido hoy.
   *
   * Con las reglas apagadas (`taxRulesEnabled` en falso) todo sigue como estaba. Con
   * ellas encendidas, solo se usan si los tres conceptos del checkout tienen regla
   * validada y vigente; si falta alguna, el pedido sale con la tasa global y queda
   * marcado `provisional` para que se vea, en vez de cobrar un impuesto supuesto o
   * dejar de vender.
   */
  async checkoutPlan(cfg: { taxRulesEnabled?: boolean }, at: Date = new Date()): Promise<CheckoutTaxPlan> {
    if (!cfg.taxRulesEnabled) return { mode: 'legacy', status: 'legacy', rates: {}, missing: [] };

    const rates: CheckoutTaxPlan['rates'] = {};
    const missing: TaxConcept[] = [];
    for (const concept of CHECKOUT_TAX_CONCEPTS) {
      const rule = await this.resolve(concept, at);
      if (!rule) { missing.push(concept); continue; }
      rates[concept] = {
        bps: rule.treatment === TaxTreatment.TAXED ? rule.rateBps ?? 0 : 0,
        base: rule.base,
        ruleId: String(rule._id),
      };
    }
    if (missing.length > 0) {
      console.error('[TAX] Reglas tributarias encendidas pero sin regla vigente para', missing.join(', '), '— se usa la tasa global');
      return { mode: 'legacy', status: 'provisional', rates: {}, missing };
    }
    return { mode: 'rules', status: 'definitive', rates, missing: [] };
  },

  /**
   * ¿Se pueden encender las reglas en el checkout? Solo si los tres conceptos tienen
   * regla validada y vigente HOY. `pricingConfigService.update` lo exige.
   */
  async assertCanEnableCheckoutRules(at: Date = new Date()): Promise<void> {
    const missing: TaxConcept[] = [];
    for (const concept of CHECKOUT_TAX_CONCEPTS) if (!(await this.resolve(concept, at))) missing.push(concept);
    if (missing.length) {
      throw new AppError(
        `No se pueden encender las reglas tributarias: falta una regla validada y vigente para ${missing.join(', ')}.`,
        422,
        'TAX_RULES_INCOMPLETE'
      );
    }
  },

  /**
   * Qué falta para dar los cálculos tributarios por definitivos, concepto por
   * concepto, y lo que el responsable contable debe validar. Es lo que el panel
   * enseña antes de habilitar la facturación definitiva.
   */
  async readiness(cfg: { taxRulesEnabled?: boolean; taxBps?: number }, at: Date = new Date()) {
    const concepts = [];
    for (const concept of ALL_TAX_CONCEPTS) {
      const [active, drafts, upcoming] = await Promise.all([
        this.resolve(concept, at),
        TaxRule.countDocuments({ concept, status: 'draft' }),
        TaxRule.findOne({ concept, status: 'validated', validFrom: { $gt: at } }).sort({ validFrom: 1 }).lean(),
      ]);
      concepts.push({
        concept,
        state: active ? 'validated' : drafts > 0 ? 'draft_only' : 'missing',
        activeRule: active
          ? {
              id: String(active._id), treatment: active.treatment, rateBps: active.rateBps, base: active.base,
              priceIncludesTax: active.priceIncludesTax, validFrom: active.validFrom, validTo: active.validTo,
              validationRef: active.validationRef,
            }
          : null,
        upcomingFrom: upcoming?.validFrom ?? null,
        drafts,
        consumer: CONSUMERS[concept],
        profile: CONCEPT_PROFILES[concept],
        pending: active ? [] : REQUIRED_FROM_ACCOUNTANT,
      });
    }
    const blockers = concepts
      .filter((c) => CHECKOUT_TAX_CONCEPTS.includes(c.concept) && c.state !== 'validated')
      .map((c) => c.concept);
    return {
      mode: cfg.taxRulesEnabled ? 'rules' : 'legacy',
      legacyTaxBps: cfg.taxBps ?? 0,
      /** Mientras esté en `legacy`, el impuesto del pedido es la tasa global, sin validar. */
      definitive: !!cfg.taxRulesEnabled && blockers.length === 0,
      canEnableCheckoutRules: blockers.length === 0,
      blockers,
      concepts,
      electronicInvoicing: {
        note:
          'ZIPP no tiene facturación electrónica integrada: los comprobantes INT- son internos, no son facturas. ' +
          'Antes de habilitar facturación definitiva, el responsable contable y tributario debe validar cada concepto de esta lista.',
        ...(await electronicInvoicingService.status()),
      },
    };
  },

  // ── Interno ─────────────────────────────────────────────────────────────

  async mustFind(id: string): Promise<ITaxRule> {
    if (!Types.ObjectId.isValid(id)) throw new AppError('Regla no encontrada', 404);
    const rule = await TaxRule.findById(id);
    if (!rule) throw new AppError('Regla no encontrada', 404);
    return rule;
  },

  /** Lo que ninguna regla puede incumplir, se cree quien se cree que sabe. */
  assertCoherent(input: Pick<TaxRuleInput, 'concept' | 'treatment' | 'rateBps' | 'priceIncludesTax' | 'validFrom' | 'label'>): void {
    if (!ALL_TAX_CONCEPTS.includes(input.concept)) throw new AppError('Concepto desconocido', 422);
    if (input.treatment === TaxTreatment.TAXED) {
      if (input.rateBps == null || !Number.isInteger(input.rateBps) || input.rateBps <= 0 || input.rateBps > 10_000) {
        throw new AppError('Un concepto gravado necesita una tarifa mayor que cero (en puntos básicos, 1900 = 19 %).', 422, 'TAX_RATE_REQUIRED');
      }
      const checkout = CHECKOUT_TAX_CONCEPTS.includes(input.concept);
      if (checkout && input.priceIncludesTax) {
        throw new AppError(
          'En el checkout el impuesto se suma encima del precio: «incluido en el precio» todavía no está soportado para este concepto.',
          422,
          'TAX_INCLUDED_NOT_SUPPORTED'
        );
      }
      if (!checkout && input.priceIncludesTax === false) {
        throw new AppError(
          'Este cobro no tiene una línea donde sumar el impuesto: hoy solo se admite «incluido en el precio». ' +
            'Cobrarlo aparte exige cambiar la liquidación.',
          422,
          'TAX_ON_TOP_NOT_SUPPORTED'
        );
      }
    } else if (input.rateBps != null && input.rateBps !== 0) {
      throw new AppError('Solo un concepto gravado lleva tarifa.', 422);
    }
    if (input.concept === TaxConcept.OTHER && !(input.label ?? '').trim()) {
      throw new AppError('Indica de qué servicio se trata.', 422);
    }
    if (!(input.validFrom instanceof Date) || Number.isNaN(input.validFrom.getTime())) {
      throw new AppError('Indica desde qué fecha rige.', 422);
    }
  },
};
