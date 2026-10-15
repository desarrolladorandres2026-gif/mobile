import { lazy, Suspense, useState, type ComponentType } from 'react';
import { Check, MapPin, Navigation, Phone } from 'lucide-react';
import { BRAND_COLORS } from '../../lib/brandColors';
import type { LatLng } from '../../components/BusinessLocationField';
import DateRangeField from '../../components/DateRangeField';
import NumericInput from '../../components/NumericInput';
import ScheduleFields from '../../components/ScheduleFields';
import PromotionSimulation from '../../components/PromotionSimulation';
import Toggle from '../../components/Toggle';
import { Chip } from '../../components/promotion/ui';
import {
  DEFAULT_CLOSE, DEFAULT_OPEN, SCHEDULE_PRESETS, applyPreset, copyHoursToOpenDays, dayProblem, profileChecklist,
  type ChecklistItem,
} from '../../lib/businessSchedule';

// Leaflet (el mapa del punto de recogida) solo lo usa esta pestaña y pesa
// más que el resto del panel junto: se descarga al abrir Información.
const BusinessLocationField = lazy(() => import('../../components/BusinessLocationField'));

/**
 * Pestaña "Información" del perfil: ficha pública, ubicación, horario y
 * entregas, cada bloque con su título a la izquierda y sus campos a la
 * derecha para que se recorra de un vistazo.
 *
 * Todo lo de aquí lo paga o lo firma el negocio, y por eso lo decide el
 * negocio. Su comisión y su aprobación no están aquí: eso es el acuerdo con
 * ZIPP y se toca desde el panel de administración.
 *
 * El horario no es decorativo. El servidor decide con él si la tienda está
 * abierta, así que dejar mal un día cierra la tienda de verdad.
 *
 * Tiene dos modos. Por defecto se **lee**: el comercio ve su perfil como
 * datos, sin un solo campo abierto. "Editar perfil" (en `Profile`) lo pasa
 * a formulario; la barra de Cancelar / Guardar vive también en `Profile`.
 *
 * La portada y el logo no están aquí: se editan sobre la cabecera del
 * perfil, solo en modo edición, y se guardan solos al subirlos.
 */

export type DaySchedule = { open?: string; close?: string; isOpen?: boolean };
export type Schedule = Record<string, DaySchedule>;

const DAYS: Array<{ key: string; label: string }> = [
  { key: 'monday', label: 'Lunes' },
  { key: 'tuesday', label: 'Martes' },
  { key: 'wednesday', label: 'Miércoles' },
  { key: 'thursday', label: 'Jueves' },
  { key: 'friday', label: 'Viernes' },
  { key: 'saturday', label: 'Sábado' },
  { key: 'sunday', label: 'Domingo' },
];

const money = (value: number) => `$${value.toLocaleString('es-CO')}`;

const INPUT =
  'w-full px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] ' +
  'text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

const TIME_INPUT =
  'px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs ' +
  'text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

export interface FreeDeliveryWindow {
  validFrom: string; // yyyy-mm-dd, '' = siempre
  validUntil: string;
  validDays: number[]; // 0 = domingo
  validFromTime: string; // HH:mm, '' = todo el día
  validUntilTime: string;
}

interface Props {
  businessId: string;
  schedule: Schedule; setSchedule: (s: Schedule) => void;
  threshold: number; setThreshold: (v: number) => void;
  freeDeliveryWindow: FreeDeliveryWindow; setFreeDeliveryWindow: (v: FreeDeliveryWindow) => void;
  minOrder: number; setMinOrder: (v: number) => void;
  deliveryTime: number; setDeliveryTime: (v: number) => void;
  name: string; setName: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  address: string; setAddress: (v: string) => void;
  location: LatLng | null; setLocation: (v: LatLng | null) => void;
  phone: string; setPhone: (v: string) => void;
  brandColor: string | null; setBrandColor: (v: string | null) => void;
  showPromoBanner: boolean; setShowPromoBanner: (v: boolean) => void;
  editing: boolean;
  /** Solo lectura: se muestran pero no se cambian desde el perfil. */
  category: string;
  city: string;
  rating: number;
  totalReviews: number;
  /** Para el avance de la ficha: el logo y la portada se editan en la cabecera de `Profile`. */
  hasLogo: boolean;
  hasCover: boolean;
}

export default function InfoTab({
  businessId,
  schedule, setSchedule,
  threshold, setThreshold,
  freeDeliveryWindow, setFreeDeliveryWindow,
  minOrder, setMinOrder,
  deliveryTime, setDeliveryTime,
  name, setName,
  description, setDescription,
  address, setAddress,
  location, setLocation,
  phone, setPhone,
  brandColor, setBrandColor,
  showPromoBanner, setShowPromoBanner,
  editing, category, city, rating, totalReviews, hasLogo, hasCover,
}: Props) {
  const checklist = profileChecklist({
    description, phone, address, hasLocation: !!location, schedule, hasLogo, hasCover,
  });

  if (!editing) {
    return (
      <div className="space-y-6">
      <Completeness items={checklist} />
      <InfoView
        description={description}
        category={category}
        city={city}
        rating={rating}
        totalReviews={totalReviews}
        phone={phone}
        address={address}
        location={location}
        schedule={schedule}
        threshold={threshold}
        minOrder={minOrder}
        deliveryTime={deliveryTime}
      />
      </div>
    );
  }

  const setDay = (key: string, patch: DaySchedule) => {
    setSchedule({ ...schedule, [key]: { ...schedule[key], ...patch } });
  };

  const openDays = DAYS.filter((d) => schedule[d.key]?.isOpen).length;

  return (
    <div className="space-y-6">
    <Completeness items={checklist} />
    <div className="cols3">
      <Block
        title="Tu ficha"
        description="Lo que ve el cliente al entrar a tu tienda. La portada y el logo se cambian arriba, sobre la cabecera."
      >
        <dl>
          <Detail label="Categoría" value={formatCategory(category)} note="No se cambia desde aquí." />
          <Detail label="Ciudad" value={city || '—'} note="No se cambia desde aquí." />
          <Detail label="Calificación" value={formatRating(rating, totalReviews)} />
        </dl>

        <div>
          <Field label="Nombre del negocio">
            <input
              type="text"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              className={INPUT}
            />
          </Field>

          <Field label="Teléfono de contacto" hint="Solo para que Zipp te contacte. El cliente no lo ve.">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={INPUT}
            />
          </Field>
        </div>

        <Field
          label="Descripción"
          hint={`Va debajo de tu nombre y sirve para que te encuentren: di qué vendes con las palabras de quien te busca. ${description.length} de 500.`}
        >
          <textarea
            value={description}
            maxLength={500}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            className={`${INPUT} resize-y`}
          />
        </Field>

        <Field label="Color del encabezado" hint="Solo se ve cuando no tienes portada.">
          <div className="flex flex-wrap items-center gap-2">
            <ColorSwatch
              color={null}
              label="Automático"
              active={brandColor === null}
              onSelect={() => setBrandColor(null)}
            />
            {BRAND_COLORS.map((option) => (
              <ColorSwatch
                key={option.value}
                color={option.value}
                label={option.label}
                active={brandColor === option.value}
                onSelect={() => setBrandColor(option.value)}
              />
            ))}
          </div>
          <HeaderPreview color={brandColor} name={name} category={category} hasCover={hasCover} />
        </Field>

        <div className="flex items-start justify-between gap-4 py-3">
          <span className="space-y-0.5">
            <span className="block text-xs font-semibold text-[var(--color-text-main)]">
              Mostrar la franja de envío gratis
            </span>
            <span className="block text-xs text-[var(--color-text-secondary)]">
              Zipp arma el texto con tus datos. Si no tienes envío gratis activo, no aparece.
            </span>
          </span>
          <Toggle checked={showPromoBanner} onChange={setShowPromoBanner} label="Mostrar la franja de envío gratis" />
        </div>
      </Block>

      <Block
        title="Ubicación"
        description="Dónde recoge el domiciliario. El cliente no ve tu dirección en la ficha."
      >
        <Field label="Dirección">
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className={INPUT}
          />
        </Field>

        <Field label="Punto de recogida">
          <Suspense
            fallback={<div className="h-64 rounded-md bg-[var(--color-bg-alt)] animate-pulse" />}
          >
            <BusinessLocationField
              key={businessId}
              value={location}
              onChange={setLocation}
            />
          </Suspense>
        </Field>
      </Block>

      <Block
        title="Horario"
        description="Fuera de este horario tu tienda aparece cerrada y no recibe pedidos."
        warning={
          openDays === 0
            ? 'No tienes ningún día abierto: tu tienda aparece cerrada y nadie puede pedirte.'
            : undefined
        }
      >
        <div className="max-w-xl">
          <div className="flex flex-wrap items-center gap-2 pb-3" role="group" aria-label="Atajos de horario">
            {SCHEDULE_PRESETS.map((preset) => (
              <Chip key={preset.id} active={false} onClick={() => setSchedule(applyPreset(schedule, preset.id))}>
                {preset.label}
              </Chip>
            ))}
            {openDays > 1 && (
              <button
                type="button"
                onClick={() => setSchedule(copyHoursToOpenDays(schedule))}
                className="cursor-pointer text-xs font-semibold text-[var(--color-primary)] hover:underline"
              >
                Mismas horas en todos los días abiertos
              </button>
            )}
          </div>
          {DAYS.map((day) => {
            const value = schedule[day.key] ?? {};
            const isOpen = !!value.isOpen;
            const problem = dayProblem(value);

            return (
              <div
                key={day.key}
                className="flex flex-wrap items-center gap-3 min-h-11 border-b border-[var(--color-border-light)] py-1"
              >
                <div className="flex w-32 shrink-0 items-center gap-3">
                  <Toggle
                    checked={isOpen}
                    onChange={(checked) => setDay(day.key, { isOpen: checked })}
                    label={`${day.label}: ${isOpen ? 'abierto' : 'cerrado'}`}
                  />
                  <span className="text-xs font-semibold text-[var(--color-text-main)]">{day.label}</span>
                </div>

                {isOpen ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={value.open ?? DEFAULT_OPEN}
                      onChange={(e) => setDay(day.key, { open: e.target.value })}
                      aria-label={`${day.label}: abre`}
                      className={TIME_INPUT}
                    />
                    <span className="text-xs text-[var(--color-text-secondary)]">a</span>
                    <input
                      type="time"
                      value={value.close ?? DEFAULT_CLOSE}
                      onChange={(e) => setDay(day.key, { close: e.target.value })}
                      aria-label={`${day.label}: cierra`}
                      className={TIME_INPUT}
                    />
                    {problem && <span className="text-xs font-semibold text-[var(--color-warning)]">{problem}</span>}
                  </div>
                ) : (
                  <span className="text-xs text-[var(--color-text-secondary)] font-medium">Cerrado</span>
                )}
              </div>
            );
          })}
        </div>
      </Block>

      <Block
        title="Entregas"
        description="Envío gratis, pedido mínimo y cuánto tardas en preparar."
      >
        <div>
          <Field
            label="Envío gratis desde"
            hint={
              threshold > 0 ? (
                <>
                  Desde {money(threshold)} el cliente no paga domicilio.{' '}
                  <strong className="text-[var(--color-text-main)]">Ese costo se descuenta de tu liquidación.</strong>
                </>
              ) : (
                'En cero, el cliente siempre paga el domicilio.'
              )
            }
          >
            <QuickNumber value={threshold} onChange={setThreshold} presets={[20000, 30000, 50000]} zeroLabel="No ofrecer" />
          </Field>

          {threshold > 0 && (
            <div className="space-y-5 py-3 border-b border-[var(--color-border-light)]">
              <div className="space-y-3">
                <p className="text-xs font-semibold text-[var(--color-text-main)]">
                  Vigencia del envío gratis <span className="font-normal text-[var(--color-text-secondary)]">(opcional)</span>
                </p>
                <DateRangeField
                  from={freeDeliveryWindow.validFrom}
                  to={freeDeliveryWindow.validUntil}
                  onChangeFrom={(v) => setFreeDeliveryWindow({ ...freeDeliveryWindow, validFrom: v })}
                  onChangeTo={(v) => setFreeDeliveryWindow({ ...freeDeliveryWindow, validUntil: v })}
                  fromLabel="Desde (vacío: siempre)"
                  toLabel="Hasta (vacío: siempre)"
                />
                <ScheduleFields
                  value={freeDeliveryWindow}
                  onChange={(next) => setFreeDeliveryWindow({ ...freeDeliveryWindow, ...next })}
                  what="promoción de envío gratis"
                />
              </div>

              <p className="text-xs text-[var(--color-text-secondary)]">
                El envío gratis se mide sobre lo que el cliente paga por los productos después de los
                descuentos: con un umbral de {money(threshold)}, un pedido de {money(threshold)} al que una
                promoción le baja el precio no lo alcanza. Si en un pedido regalar el domicilio te
                dejara con un pago negativo, ese pedido paga su domicilio.
              </p>

              <PromotionSimulation
                businessId={businessId}
                draft={null}
                freeDeliveryThreshold={threshold}
              />
            </div>
          )}

          <Field label="Pedido mínimo" hint="Por debajo de este monto no se puede pedir.">
            <QuickNumber value={minOrder} onChange={setMinOrder} presets={[5000, 10000, 15000]} zeroLabel="Sin mínimo" />
          </Field>

          <Field label="Preparación (minutos)" hint="El estimado que ve el cliente. Prometer de menos genera reclamos.">
            <div className="space-y-3">
              <p className="text-3xl font-semibold leading-none tabular text-[var(--color-text-main)]" aria-live="polite">
                {deliveryTime} <span className="text-sm font-medium text-[var(--color-text-secondary)]">min</span>
              </p>
              <input
                type="range"
                min={5}
                max={120}
                step={5}
                value={Math.min(120, Math.max(5, deliveryTime))}
                onChange={(e) => setDeliveryTime(Number(e.target.value))}
                aria-label="Minutos de preparación"
                className="w-full cursor-pointer accent-[var(--color-primary)]"
              />
              <div className="flex flex-wrap gap-2" role="group" aria-label="Tiempos habituales">
                {[15, 20, 30, 45, 60].map((m) => (
                  <Chip key={m} active={deliveryTime === m} onClick={() => setDeliveryTime(m)}>{m} min</Chip>
                ))}
              </div>
            </div>
          </Field>
        </div>
      </Block>
    </div>
    </div>
  );
}

/**
 * Qué tan completa está la ficha: una barra y, debajo, lo que falta. Convierte
 * «llena tu perfil» en una meta que se ve avanzar; cada cosa que falta es algo
 * que le cuesta al comercio, no un adorno.
 */
function Completeness({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  const missing = items.filter((i) => !i.done);
  return (
    <section aria-label="Qué tan completa está tu ficha" className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-semibold text-[var(--color-text-main)]">
          {missing.length === 0 ? 'Tu ficha está completa' : `Tu ficha está al ${pct}%`}
        </p>
        <p className="text-xs tabular text-[var(--color-text-secondary)]">{done} de {items.length}</p>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-[var(--color-text-secondary)]">
        {missing.length === 0
          ? 'Tienes todo lo que un cliente y un domiciliario necesitan.'
          : `Te falta: ${missing.map((m) => m.label.toLowerCase()).join(', ')}.`}
      </p>
    </section>
  );
}

/** Cómo se ve el encabezado sin portada con el color elegido, antes de guardar. */
function HeaderPreview({
  color, name, category, hasCover,
}: {
  color: string | null;
  name: string;
  category: string;
  hasCover: boolean;
}) {
  return (
    <div className="space-y-1.5 pt-2">
      <div
        className={`flex h-16 items-center gap-3 rounded-md px-4 transition-colors ${color ? '' : 'border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-alt)]'}`}
        style={color ? { backgroundColor: color } : undefined}
      >
        <div className="min-w-0">
          <p className={`truncate text-sm font-semibold ${color ? 'text-white' : 'text-[var(--color-text-main)]'}`}>
            {name.trim() || 'Tu negocio'}
          </p>
          <p className={`truncate text-xs ${color ? 'text-white/75' : 'text-[var(--color-text-secondary)]'}`}>
            {color ? formatCategory(category) : 'Automático: Zipp elige el color'}
          </p>
        </div>
      </div>
      {hasCover && (
        <p className="text-xs text-[var(--color-text-secondary)]">Con tu portada puesta, este color no se ve.</p>
      )}
    </div>
  );
}

/** Un monto con atajos: fichas con las cifras habituales y el campo para cualquier otra. */
function QuickNumber({
  value, onChange, presets, zeroLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  presets: number[];
  zeroLabel: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Chip active={value === 0} onClick={() => onChange(0)}>{zeroLabel}</Chip>
        {presets.map((preset) => (
          <Chip key={preset} active={value === preset} onClick={() => onChange(preset)}>{money(preset)}</Chip>
        ))}
      </div>
      <NumericInput value={value} onValueChange={(d) => onChange(Number(d))} className={INPUT} />
    </div>
  );
}

/**
 * El perfil en modo lectura: los mismos bloques que el formulario, pero como
 * tarjetas con los datos a la vista. El nombre ya está en la cabecera, así que
 * aquí no se repite. Son de solo lectura, así que no se levantan al pasar el
 * cursor (`data-static`).
 */
function InfoView({
  description, category, city, rating, totalReviews,
  phone, address, location, schedule, threshold, minOrder, deliveryTime,
}: {
  description: string;
  category: string;
  city: string;
  rating: number;
  totalReviews: number;
  phone: string;
  address: string;
  location: LatLng | null;
  schedule: Schedule;
  threshold: number;
  minOrder: number;
  deliveryTime: number;
}) {
  // El día de hoy se fija al montar: leer el reloj en el render no es puro.
  const [today] = useState(() => DAYS[(new Date().getDay() + 6) % 7].key);
  const openDays = DAYS.filter((d) => schedule[d.key]?.isOpen).length;
  const lacksPickup = !location;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ViewCard title="Tu ficha" hint="Lo que ve el cliente al entrar a tu tienda." tone={description ? undefined : 'warning'}>
        <p className={`text-sm leading-relaxed ${description ? 'text-[var(--color-text-main)]' : 'text-[var(--color-warning)] font-semibold'}`}>
          {description || 'Aún no tienes descripción. Sin ella, cuesta más que te encuentren al buscar.'}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-text-secondary)]">
          <span>{formatCategory(category)}</span>
          {city && <><span>·</span><span>{city}</span></>}
          <span>·</span>
          <span>{formatRating(rating, totalReviews)}</span>
        </p>
      </ViewCard>

      <ViewCard title="Contacto y ubicación" hint="Cómo te contacta Zipp y dónde recoge el domiciliario." tone={lacksPickup ? 'warning' : undefined}>
        <ul className="space-y-2.5">
          <ViewRow Icon={Phone} muted={!phone} note="Solo lo ve Zipp.">{phone || 'Sin teléfono'}</ViewRow>
          <ViewRow Icon={MapPin} muted={!address} note="El cliente no la ve.">{address || 'Sin dirección'}</ViewRow>
          <ViewRow Icon={Navigation} warning={lacksPickup}>
            {lacksPickup
              ? 'Punto de recogida sin poner: el domiciliario no sabe por dónde recoger. Ponlo con Editar.'
              : 'Punto de recogida puesto en el mapa'}
          </ViewRow>
        </ul>
      </ViewCard>

      <ViewCard
        title="Horario"
        hint="Fuera de este horario tu tienda aparece cerrada y no recibe pedidos."
        tone={openDays === 0 ? 'danger' : undefined}
        wide
      >
        {openDays === 0 && (
          <p className="text-xs font-semibold text-[var(--color-warning)]">
            No tienes ningún día abierto: tu tienda aparece cerrada y nadie puede pedirte.
          </p>
        )}
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7" aria-label="Horario de la semana">
          {DAYS.map((day) => {
            const value = schedule[day.key];
            const isOpen = !!value?.isOpen;
            const isToday = day.key === today;
            return (
              <li
                key={day.key}
                aria-current={isToday ? 'date' : undefined}
                className={`rounded-lg border px-3 py-2 ${
                  isToday ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)]' : 'border-[var(--color-border)]'
                }`}
              >
                <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                  {day.label}{isToday ? ' · hoy' : ''}
                </p>
                {isOpen ? (
                  <p className="text-xs font-semibold tabular text-[var(--color-text-main)]">
                    {value?.open ?? '08:00'} – {value?.close ?? '20:00'}
                  </p>
                ) : (
                  <p className="text-xs text-[var(--color-text-secondary)]">Cerrado</p>
                )}
              </li>
            );
          })}
        </ol>
      </ViewCard>

      <ViewCard title="Entregas" hint="Envío gratis, pedido mínimo y cuánto tardas en preparar." wide>
        <dl className="grid gap-4 sm:grid-cols-3">
          <Stat label="Envío gratis" value={threshold > 0 ? `Desde ${money(threshold)}` : 'No lo ofreces'} note={threshold > 0 ? 'Se descuenta de tu liquidación.' : undefined} />
          <Stat label="Pedido mínimo" value={minOrder > 0 ? money(minOrder) : 'Sin mínimo'} />
          <Stat label="Preparación" value={`${deliveryTime} min`} />
        </dl>
      </ViewCard>
    </div>
  );
}

/** Una tarjeta del perfil en lectura. Es la superficie `.promo-card`, sin levantarse. */
function ViewCard({
  title, hint, tone, wide, children,
}: {
  title: string;
  hint: string;
  tone?: 'warning' | 'danger';
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`promo-card ${wide ? 'lg:col-span-2' : ''}`} data-static data-tone={tone}>
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
        <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function ViewRow({
  Icon, muted, warning, note, children,
}: {
  Icon: ComponentType<{ className?: string }>;
  muted?: boolean;
  warning?: boolean;
  note?: string;
  children: React.ReactNode;
}) {
  const tone = warning
    ? 'text-[var(--color-warning)] font-semibold'
    : muted
      ? 'text-[var(--color-text-secondary)]'
      : 'text-[var(--color-text-main)]';
  return (
    <li className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />
      <div className="min-w-0">
        <p className={`break-words text-sm leading-relaxed ${tone}`}>{children}</p>
        {note && <p className="text-xs text-[var(--color-text-secondary)]">{note}</p>}
      </div>
    </li>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="text-xl font-semibold tabular text-[var(--color-text-main)]">{value}</dd>
      {note && <dd className="text-xs text-[var(--color-text-secondary)]">{note}</dd>}
    </div>
  );
}

/** Un dato en modo lectura: etiqueta chica arriba, valor debajo. */
function Detail({
  label, value, note, muted, warning,
}: {
  label: string;
  value: string;
  note?: string;
  muted?: boolean;
  warning?: boolean;
}) {
  const tone = warning
    ? 'text-[var(--color-warning)] font-semibold'
    : muted
      ? 'text-[var(--color-text-muted)]'
      : 'text-[var(--color-text-main)]';
  return (
    <div className="min-w-0 py-3 border-b border-[var(--color-border-light)] sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-xs font-semibold text-[var(--color-text-secondary)] sm:pt-0.5">{label}</dt>
      <div className="min-w-0">
        <dd className={`text-sm leading-relaxed break-words ${tone}`}>{value}</dd>
        {note && <dd className="mt-0.5 text-xs text-[var(--color-text-muted)]">{note}</dd>}
      </div>
    </div>
  );
}

const formatCategory = (category: string) => {
  const text = category?.replace(/_/g, ' ') ?? '';
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '—';
};

const formatRating = (rating: number, totalReviews: number) =>
  totalReviews > 0
    ? `${rating.toFixed(1)} de 5 · ${totalReviews} ${totalReviews === 1 ? 'reseña' : 'reseñas'}`
    : 'Sin reseñas todavía';

/**
 * Un bloque del formulario: título y para qué sirve a la izquierda, campos a
 * la derecha. Los separa una línea fina, no una caja (regla "sin cajas").
 */
function Block({
  title, description, warning, children,
}: {
  title: string;
  description: string;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 pb-6 xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-8 xl:space-y-0">
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{description}</p>
        {warning && (
          <p className="text-xs font-semibold leading-relaxed text-[var(--color-warning)]">{warning}</p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Field({
  label, hint, children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 py-3 border-b border-[var(--color-border-light)] sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6 sm:space-y-0">
      <label className="block text-xs font-semibold text-[var(--color-text-secondary)] sm:pt-2">{label}</label>
      <div className="min-w-0 max-w-xl space-y-1.5">
        {children}
        {hint && <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * Un color de la paleta, o el automático.
 *
 * El nombre va en `title` y en `aria-label` y no debajo de la muestra: ocho
 * etiquetas de texto convierten una fila de colores en una lista, y lo que
 * el comercio compara aquí es el color, no cómo se llama.
 */
function ColorSwatch({
  color, label, active, onSelect,
}: {
  color: string | null;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`w-9 h-9 rounded-full cursor-pointer transition-colors grid place-items-center ${
        active
          ? 'ring-2 ring-offset-2 ring-[var(--color-primary)] ring-offset-[var(--color-bg)]'
          : ''
      }`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {color ? (
        active && <Check className="w-4 h-4 text-white" />
      ) : (
        <span className="w-full h-full rounded-full border border-dashed border-[var(--color-border-strong)] grid place-items-center text-[10px] font-semibold text-[var(--color-text-muted)]">
          {active ? <Check className="w-4 h-4 text-[var(--color-primary)]" /> : 'A'}
        </span>
      )}
    </button>
  );
}
