import { Types } from 'mongoose';
import { TaxRule, ITaxRule, TaxConcept, TaxTreatment, TaxBase, TaxType, CHECKOUT_TAX_CONCEPTS, ALL_TAX_CONCEPTS } from '../models/TaxRule';
import { AppError } from '../middlewares';
import { applyBps } from '../utils/money';

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
  [TaxConcept.COMMISSION]: 'Sin integración: la comisión se descuenta al comercio sin línea de impuesto. Solo queda la regla.',
  [TaxConcept.ADVERTISING]: 'Factura de publicidad: se extrae del precio (informativo, no cambia lo que se cobra).',
  [TaxConcept.PRO_SUBSCRIPTION]: 'Sin integración: la cuota de Zipp Pro se cobra sin línea de impuesto. Solo queda la regla.',
  [TaxConcept.OTHER]: 'Sin integración: servicios futuros.',
};

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
    void userId;
    await rule.save();
    return rule;
  },

  async removeDraft(id: string): Promise<void> {
    const deleted = await TaxRule.deleteOne({ _id: id, status: 'draft' });
    if (deleted.deletedCount === 0) throw new AppError('Solo se borra un borrador.', 409, 'TAX_RULE_IMMUTABLE');
  },

  /**
   * Valida una regla: desde ese momento la usan los cálculos.
   *
   * Quien valida deja el documento que respalda la decisión (`validationRef`);
   * sin él no hay validación. No se valida hacia el pasado —un pedido ya cobrado
   * conserva la regla con la que se cobró— y la regla anterior del concepto se
   * cierra en el mismo instante en que empieza la nueva, sin hueco ni solape.
   */
  async validate(id: string, userId: string, input: { validationRef: string; note?: string }): Promise<ITaxRule> {
    const ref = (input.validationRef ?? '').trim();
    if (ref.length < 5) {
      throw new AppError('Indica el documento que respalda la regla (concepto del contador, circular, radicado).', 422, 'TAX_RULE_NEEDS_REFERENCE');
    }
    const rule = await this.mustFind(id);
    if (rule.status !== 'draft') throw new AppError('Esa regla ya fue validada.', 409, 'TAX_RULE_IMMUTABLE');
    this.assertCoherent(rule);

    // Inicio del día de hoy en Colombia (UTC−5, sin horario de verano), expresado en UTC.
    const COLOMBIA_OFFSET_MS = 5 * 3_600_000;
    const startOfToday = new Date(Math.floor((Date.now() - COLOMBIA_OFFSET_MS) / DAY_MS) * DAY_MS + COLOMBIA_OFFSET_MS);
    if (rule.validFrom < startOfToday) {
      throw new AppError('Una regla validada no puede empezar en el pasado: no se reescriben los pedidos ya cobrados.', 422, 'TAX_RULE_RETROACTIVE');
    }

    // Una regla futura ya validada para el concepto bloquea otra anterior a ella.
    const later = await TaxRule.findOne({ concept: rule.concept, status: 'validated', validFrom: { $gt: rule.validFrom } }).lean();
    if (later) {
      throw new AppError('Ya hay una regla validada que empieza después. Cámbiala primero.', 409, 'TAX_RULE_OVERLAP');
    }

    // Cierra la vigente: queda terminada justo cuando empieza esta. Condicionado
    // a `validTo: null` (o posterior) dentro del filtro, así dos validaciones
    // simultáneas del mismo concepto no se pisan.
    await TaxRule.updateMany(
      { concept: rule.concept, status: 'validated', $or: [{ validTo: null }, { validTo: { $gt: rule.validFrom } }] },
      { $set: { validTo: rule.validFrom } }
    );

    const validated = await TaxRule.findOneAndUpdate(
      { _id: rule._id, status: 'draft' },
      {
        $set: {
          status: 'validated',
          validatedBy: new Types.ObjectId(userId),
          validatedAt: new Date(),
          validationRef: ref,
          validationNote: (input.note ?? '').trim().slice(0, 500),
        },
      },
      { new: true }
    );
    if (!validated) throw new AppError('Esa regla cambió mientras se validaba. Revísala e inténtalo de nuevo.', 409);

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
        integrated: false,
        note:
          'ZIPP no tiene facturación electrónica integrada: los comprobantes INT- son internos, no son facturas. ' +
          'Antes de habilitar facturación definitiva, el responsable contable y tributario debe validar cada concepto de esta lista.',
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
