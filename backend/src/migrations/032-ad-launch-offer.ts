import mongoose from 'mongoose';
import { config } from '../config';
import { PlatformPricingConfig, AD_LAUNCH_OFFER } from '../models';

/**
 * Migración 032 — oferta de publicidad de lanzamiento.
 *
 * El 2026-10-19 el dueño fijó los valores iniciales: CPC $100–$1.000, tope por
 * campaña $10.000–$500.000, duración 1–30 días, ubicación `explore`. Las bases
 * nuevas ya nacen con ellos (`AD_LAUNCH_OFFER`); esto los aplica a la
 * configuración que ya existe, **solo en los campos que nadie había
 * configurado** (0 o lista vacía). Un valor que ZIPP ya puso a mano no se toca.
 *
 * No enciende nada: `adSelfServiceEnabled`, `adBillingEnabled` y `adCpcEnabled`
 * siguen como estén. Tener la oferta definida no abre la compra.
 *
 * Publica una versión nueva de `PlatformPricingConfig` (la anterior queda como
 * historia, igual que `pricingConfigService.update`); no modifica ningún pedido
 * ni campaña. Idempotente: la segunda vez no encuentra nada sin configurar.
 * Manual, fuera de deploy.sh.
 */
export async function migrateAdLaunchOffer(): Promise<{ applied: string[]; version: number | null }> {
  const current = await PlatformPricingConfig.findOne({ isCurrent: true }).sort({ version: -1 });
  if (!current) return { applied: [], version: null }; // base vacía: el bootstrap ya usa los defaults

  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(AD_LAUNCH_OFFER)) {
    const actual = (current as unknown as Record<string, unknown>)[field];
    const sinConfigurar = Array.isArray(actual) ? actual.length === 0 : !actual;
    if (sinConfigurar) patch[field] = value;
  }
  if (Object.keys(patch).length === 0) return { applied: [], version: current.version };

  const draft = {
    ...current.toObject(),
    ...patch,
    _id: undefined,
    version: current.version + 1,
    isCurrent: true,
    createdBy: null,
    changeReason: 'Oferta de publicidad de lanzamiento (migración 032)',
    createdAt: undefined,
    updatedAt: undefined,
  };
  const created = await PlatformPricingConfig.create(draft);
  await PlatformPricingConfig.updateMany(
    { _id: { $ne: created._id }, isCurrent: true },
    { $set: { isCurrent: false } }
  );
  return { applied: Object.keys(patch), version: created.version };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 032 — oferta de publicidad de lanzamiento\n');

    try {
      const { applied, version } = await migrateAdLaunchOffer();
      console.log(applied.length
        ? `  Versión ${version} publicada con: ${applied.join(', ')}`
        : '  Nada que aplicar: ya estaba configurado.');
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
