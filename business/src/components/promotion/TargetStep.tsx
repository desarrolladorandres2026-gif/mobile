import ProductMultiSelect from '../ProductMultiSelect';
import { money } from '../../lib/orderFlow';
import { maxCost, type AutoForm, type CodeForm } from '../../lib/promotions';
import { suggestCode } from '../../lib/promotionTemplates';
import { AmountPicker, Chip, Choice, Field, inputClass, StepHeading } from './ui';

/**
 * Paso 4: a quién va y cuánto aguanta. El título, el código (o los productos),
 * el primer pedido y los topes. Los topes son lo que convierte «un descuento»
 * en «un gasto acotado»: la pantalla dice, con cifras, cuánto es lo máximo
 * que puede salir de la liquidación.
 */

interface Props {
  form: CodeForm | AutoForm;
  patch: (p: Partial<CodeForm & AutoForm>) => void;
  isCode: boolean;
  editing: boolean;
  businessId: string;
  coveredByOther: Map<string, { couponId: string; title: string; validUntil: string }>;
  /** Solo al crear: una promoción no cambia de forma después de guardada. */
  onSwitchMode?: (mode: 'code' | 'auto') => void;
}

const BUDGET_PRESETS = [50000, 100000, 200000, 500000];
const USAGE_PRESETS = [20, 50, 100, 200];
const MIN_ORDER_PRESETS = [10000, 15000, 20000, 30000];

export default function TargetStep({ form, patch, isCode, editing, businessId, coveredByOther, onSwitchMode }: Props) {
  const code = isCode ? (form as CodeForm) : null;
  const auto = isCode ? null : (form as AutoForm);
  const cost = maxCost(form);
  const suggestion = suggestCode(form.title, form.type, form.value);

  return (
    <div className="space-y-7">
      <StepHeading
        title={isCode ? 'Ponle nombre y código' : 'Ponle nombre y elige los productos'}
        hint={isCode ? 'El cliente escribe el código en el carrito.' : 'Sin código: se aplica sola cuando el carrito trae alguno de estos productos.'}
      />

      {onSwitchMode && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice selected={isCode} onClick={() => onSwitchMode('code')}>
            <span className="text-sm font-semibold">Con código</span>
            <span className="text-xs text-[var(--color-text-secondary)]">El cliente lo escribe. Sirve para repartirlo en redes o por WhatsApp.</span>
          </Choice>
          <Choice selected={!isCode} onClick={() => onSwitchMode('auto')}>
            <span className="text-sm font-semibold">Automática por productos</span>
            <span className="text-xs text-[var(--color-text-secondary)]">Se aplica sola cuando piden alguno de los productos elegidos.</span>
          </Choice>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Título" hint="Lo que verás en tu lista de promociones">
          <input
            value={form.title}
            onChange={(e) => patch({ title: e.target.value })}
            maxLength={80}
            placeholder={isCode ? '20% los martes' : '20% en hamburguesas'}
            className={inputClass}
          />
        </Field>
        {code && (
          <Field label="Código" hint="Lo que el cliente escribe. Entre 3 y 20 letras o números.">
            <input
              value={code.code}
              onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
              maxLength={20}
              placeholder="MARTES20"
              disabled={editing}
              className={`${inputClass} font-mono`}
            />
            {!editing && (
              <div className="pt-1">
                <Chip active={code.code === suggestion} onClick={() => patch({ code: suggestion })}>
                  Usar {suggestion}
                </Chip>
              </div>
            )}
          </Field>
        )}
      </div>

      {auto && (
        <Field label="Productos en promoción" hint="Un producto solo puede estar en una promoción automática a la vez">
          <ProductMultiSelect
            businessId={businessId}
            selected={auto.productIds}
            onChange={(ids) => patch({ productIds: ids })}
            coveredByOther={coveredByOther}
          />
        </Field>
      )}

      {code && (
        <AmountPicker
          label="Pedido mínimo"
          hint="Con un mínimo el descuento siempre te deja margen."
          value={code.minOrderAmount}
          onChange={(minOrderAmount) => patch({ minOrderAmount })}
          presets={MIN_ORDER_PRESETS}
          zeroLabel="Sin mínimo"
        />
      )}

      <Choice selected={form.firstOrderOnly} onClick={() => patch({ firstOrderOnly: !form.firstOrderOnly })}>
        <span className="text-sm font-semibold">Solo para el primer pedido</span>
        <span className="text-xs text-[var(--color-text-secondary)]">
          Se le da a quien nunca ha hecho un pedido en Zipp (los cancelados no cuentan) y solo una vez.
          {!isCode && ' Al ser automática, no aparece en tu carta: se aplica al pagar.'}
        </span>
      </Choice>

      <div className="space-y-5 border-t border-[var(--color-border)] pt-6">
        <StepHeading
          title="¿Hasta dónde la dejas correr?"
          hint="Cuando se acaba el presupuesto o los usos, la promoción deja de aplicarse sola."
        />
        <AmountPicker
          label="Presupuesto máximo"
          hint="Lo máximo que sale de tu liquidación."
          value={form.budgetLimit}
          onChange={(budgetLimit) => patch({ budgetLimit })}
          presets={BUDGET_PRESETS}
          zeroLabel="Sin tope"
        />
        <AmountPicker
          label="Usos totales"
          value={form.usageLimit}
          onChange={(usageLimit) => patch({ usageLimit })}
          presets={USAGE_PRESETS}
          zeroLabel="Ilimitados"
          format={(n) => `${n} usos`}
        />
        {code && !code.firstOrderOnly && (
          <AmountPicker
            label="Usos por cliente"
            value={code.perUserLimit}
            onChange={(perUserLimit) => patch({ perUserLimit })}
            presets={[1, 2, 5]}
            zeroLabel="Ilimitados"
            format={(n) => (n === 1 ? '1 vez' : `${n} veces`)}
          />
        )}

        {cost !== null ? (
          <p className="text-sm font-semibold tabular text-[var(--color-text-main)]">
            Como máximo te cuesta {money(cost)}.
          </p>
        ) : (
          <p className="text-xs font-semibold text-[var(--color-warning)]">
            Sin techo: el costo crece con cada pedido que la use. Pon un presupuesto
            {form.type === 'fixed' || form.maxDiscountAmount > 0 ? ' o un tope de usos' : ', o un tope del descuento y de usos,'} para acotarlo.
          </p>
        )}
      </div>
    </div>
  );
}
