import { lazy, Suspense } from 'react';
import { Check } from 'lucide-react';
import { BRAND_COLORS } from '../../lib/brandColors';
import type { LatLng } from '../../components/BusinessLocationField';
import DateRangeField from '../../components/DateRangeField';
import NumericInput from '../../components/NumericInput';

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
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] ' +
  'text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

const TIME_INPUT =
  'px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs ' +
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
  editing, category, city, rating, totalReviews,
}: Props) {
  if (!editing) {
    return (
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
    );
  }

  const setDay = (key: string, patch: DaySchedule) => {
    setSchedule({ ...schedule, [key]: { ...schedule[key], ...patch } });
  };

  const openDays = DAYS.filter((d) => schedule[d.key]?.isOpen).length;

  return (
    <div className="cols3">
      <Block
        title="Tu ficha"
        description="Lo que ve el cliente al entrar a tu tienda. La portada y el logo se cambian arriba, sobre la cabecera."
      >
        <dl className="grid gap-4 sm:grid-cols-3">
          <Detail label="Categoría" value={formatCategory(category)} note="No se cambia desde aquí." />
          <Detail label="Ciudad" value={city || '—'} note="No se cambia desde aquí." />
          <Detail label="Calificación" value={formatRating(rating, totalReviews)} />
        </dl>

        <div className="grid gap-4 sm:grid-cols-2">
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
          hint="Va debajo de tu nombre y sirve para que te encuentren: di qué vendes con las palabras de quien te busca."
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
        </Field>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={showPromoBanner}
            onChange={(e) => setShowPromoBanner(e.target.checked)}
            className="accent-[var(--color-primary)] cursor-pointer mt-0.5"
          />
          <span className="space-y-0.5">
            <span className="block text-xs font-bold text-[var(--color-text-main)]">
              Mostrar la franja de envío gratis
            </span>
            <span className="block text-xs text-[var(--color-text-secondary)]">
              Zipp arma el texto con tus datos. Si no tienes envío gratis activo, no aparece.
            </span>
          </span>
        </label>
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
            fallback={<div className="h-64 rounded-xl bg-[var(--color-bg-alt)] animate-pulse" />}
          >
            <BusinessLocationField
              key={businessId}
              value={location}
              onChange={setLocation}
            />
          </Suspense>
        </Field>
      </Block>

      <div>
      <Block
        title="Horario"
        description="Fuera de este horario tu tienda aparece cerrada y no recibe pedidos."
        warning={
          openDays === 0
            ? 'No tienes ningún día abierto: tu tienda aparece cerrada y nadie puede pedirte.'
            : undefined
        }
      >
        <div className="grid gap-x-10 sm:grid-cols-2">
          {DAYS.map((day) => {
            const value = schedule[day.key] ?? {};
            const isOpen = !!value.isOpen;

            return (
              <div
                key={day.key}
                className="flex items-center gap-3 min-h-11 border-b border-[var(--color-border-light)]"
              >
                <label className="flex items-center gap-2 w-28 shrink-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isOpen}
                    onChange={(e) => setDay(day.key, { isOpen: e.target.checked })}
                    className="accent-[var(--color-primary)] cursor-pointer"
                  />
                  <span className="text-xs font-bold text-[var(--color-text-main)]">{day.label}</span>
                </label>

                {isOpen ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={value.open ?? '08:00'}
                      onChange={(e) => setDay(day.key, { open: e.target.value })}
                      aria-label={`${day.label}: abre`}
                      className={TIME_INPUT}
                    />
                    <span className="text-xs text-[var(--color-text-muted)]">a</span>
                    <input
                      type="time"
                      value={value.close ?? '20:00'}
                      onChange={(e) => setDay(day.key, { close: e.target.value })}
                      aria-label={`${day.label}: cierra`}
                      className={TIME_INPUT}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)] font-medium">Cerrado</span>
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
        <div className="grid gap-5 sm:grid-cols-3">
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
            <NumericInput
              value={threshold}
              onValueChange={(d) => setThreshold(Number(d))}
              className={INPUT}
            />
          </Field>

          {threshold > 0 && (
            <div className="sm:col-span-3 space-y-3 pt-1">
              <p className="text-xs font-bold text-[var(--color-text-main)]">
                Vigencia del envío gratis <span className="font-normal text-[var(--color-text-muted)]">(opcional)</span>
              </p>
              <DateRangeField
                from={freeDeliveryWindow.validFrom}
                to={freeDeliveryWindow.validUntil}
                onChangeFrom={(v) => setFreeDeliveryWindow({ ...freeDeliveryWindow, validFrom: v })}
                onChangeTo={(v) => setFreeDeliveryWindow({ ...freeDeliveryWindow, validUntil: v })}
                fromLabel="Desde (vacío: siempre)"
                toLabel="Hasta (vacío: siempre)"
              />
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex gap-1">
                  {DAYS.map((day, index) => {
                    const active = freeDeliveryWindow.validDays.includes(index);
                    return (
                      <button
                        key={day.key}
                        type="button"
                        onClick={() =>
                          setFreeDeliveryWindow({
                            ...freeDeliveryWindow,
                            validDays: active
                              ? freeDeliveryWindow.validDays.filter((d) => d !== index)
                              : [...freeDeliveryWindow.validDays, index],
                          })
                        }
                        className={`w-7 h-7 rounded-full text-[10px] font-bold cursor-pointer transition-all ${
                          active
                            ? 'bg-[var(--color-primary)] text-white'
                            : 'bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)]'
                        }`}
                      >
                        {day.label.slice(0, 1)}
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs text-[var(--color-text-muted)]">Sin días marcados: todos</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={freeDeliveryWindow.validFromTime}
                  onChange={(e) => setFreeDeliveryWindow({ ...freeDeliveryWindow, validFromTime: e.target.value })}
                  className={TIME_INPUT}
                  aria-label="Envío gratis desde la hora"
                />
                <span className="text-xs text-[var(--color-text-muted)]">a</span>
                <input
                  type="time"
                  value={freeDeliveryWindow.validUntilTime}
                  onChange={(e) => setFreeDeliveryWindow({ ...freeDeliveryWindow, validUntilTime: e.target.value })}
                  className={TIME_INPUT}
                  aria-label="Envío gratis hasta la hora"
                />
                <span className="text-xs text-[var(--color-text-muted)]">Vacío: todo el día</span>
              </div>
            </div>
          )}

          <Field label="Pedido mínimo" hint="Por debajo de este monto no se puede pedir.">
            <NumericInput
              value={minOrder}
              onValueChange={(d) => setMinOrder(Number(d))}
              className={INPUT}
            />
          </Field>

          <Field label="Preparación (minutos)" hint="El estimado que ve el cliente. Prometer de menos genera reclamos.">
            <input
              type="number"
              min={5}
              max={120}
              value={deliveryTime}
              onChange={(e) => setDeliveryTime(Number(e.target.value))}
              className={INPUT}
            />
          </Field>
        </div>
      </Block>
      </div>
    </div>
  );
}

/**
 * El perfil en modo lectura: los mismos bloques que el formulario, pero
 * como datos. El nombre ya está en la cabecera, así que aquí no se repite.
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
  const openDays = DAYS.filter((d) => schedule[d.key]?.isOpen).length;

  return (
    <div className="cols3">
      <Block title="Tu ficha" description="Lo que ve el cliente al entrar a tu tienda.">
        <dl className="space-y-4">
          <Detail
            label="Descripción"
            value={description || 'Aún no tienes descripción. Sin ella, cuesta más que te encuentren al buscar.'}
            muted={!description}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Detail label="Categoría" value={formatCategory(category)} />
            <Detail label="Ciudad" value={city || '—'} />
            <Detail label="Calificación" value={formatRating(rating, totalReviews)} />
          </div>
        </dl>
      </Block>

      <Block title="Contacto y ubicación" description="Cómo te contacta Zipp y dónde recoge el domiciliario.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Detail label="Teléfono" value={phone || 'Sin teléfono'} muted={!phone} note="Solo lo ve Zipp." />
          <Detail label="Dirección" value={address || 'Sin dirección'} muted={!address} note="El cliente no la ve." />
          {location ? (
            <Detail label="Punto de recogida" value="Puesto en el mapa" />
          ) : (
            <Detail
              label="Punto de recogida"
              value="Sin poner: el domiciliario no sabe por dónde recoger. Ponlo en Editar perfil."
              warning
            />
          )}
        </dl>
      </Block>

      <div>
      <Block
        title="Horario"
        description="Fuera de este horario tu tienda aparece cerrada y no recibe pedidos."
        warning={
          openDays === 0
            ? 'No tienes ningún día abierto: tu tienda aparece cerrada y nadie puede pedirte.'
            : undefined
        }
      >
        <dl className="grid gap-x-6 grid-cols-2">
          {groupSchedule(schedule).map((row) => (
            <div
              key={row.days}
              className="flex items-center justify-between gap-4 min-h-10 border-b border-[var(--color-border-light)]"
            >
              <dt className="text-xs font-bold text-[var(--color-text-main)]">{row.days}</dt>
              <dd className={`text-xs ${row.hours ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-muted)]'}`}>
                {row.hours ?? 'Cerrado'}
              </dd>
            </div>
          ))}
        </dl>
      </Block>

      <Block title="Entregas" description="Envío gratis, pedido mínimo y cuánto tardas en preparar.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Detail
            label="Envío gratis"
            value={threshold > 0 ? `Desde ${money(threshold)}` : 'No lo ofreces'}
            note={threshold > 0 ? 'Se descuenta de tu liquidación.' : undefined}
          />
          <Detail label="Pedido mínimo" value={minOrder > 0 ? money(minOrder) : 'Sin mínimo'} />
          <Detail label="Preparación" value={`${deliveryTime} min`} />
        </dl>
      </Block>
      </div>
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
    <div className="min-w-0">
      <dt className="text-xs text-[var(--color-text-secondary)]">{label}</dt>
      <dd className={`mt-0.5 text-sm leading-relaxed break-words ${tone}`}>{value}</dd>
      {note && <dd className="mt-0.5 text-xs text-[var(--color-text-muted)]">{note}</dd>}
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
 * Junta los días seguidos con el mismo horario: "Lunes – Viernes" en una
 * línea en vez de cinco iguales. `hours` es null cuando están cerrados.
 */
function groupSchedule(schedule: Schedule): Array<{ days: string; hours: string | null }> {
  const hoursOf = (key: string) => {
    const day = schedule[key];
    return day?.isOpen ? `${day.open ?? '08:00'} – ${day.close ?? '20:00'}` : null;
  };

  const rows: Array<{ days: string; hours: string | null }> = [];
  let start = 0;
  for (let i = 1; i <= DAYS.length; i++) {
    if (i < DAYS.length && hoursOf(DAYS[i].key) === hoursOf(DAYS[start].key)) continue;
    const first = DAYS[start].label;
    const last = DAYS[i - 1].label;
    rows.push({ days: first === last ? first : `${first} – ${last}`, hours: hoursOf(DAYS[start].key) });
    start = i;
  }
  return rows;
}

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
    <section className="space-y-3 pb-6">
      <div className="space-y-1.5">
        <h2 className="text-sm font-bold text-[var(--color-text-main)]">{title}</h2>
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{description}</p>
        {warning && (
          <p className="text-xs font-semibold leading-relaxed text-[var(--color-warning)]">{warning}</p>
        )}
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
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
    <div className="space-y-1.5">
      <label className="text-xs font-bold text-[var(--color-text-main)]">{label}</label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{hint}</p>}
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
      className={`w-9 h-9 rounded-full cursor-pointer transition-all grid place-items-center ${
        active
          ? 'ring-2 ring-offset-2 ring-[var(--color-primary)] ring-offset-[var(--color-bg)]'
          : 'hover:scale-105'
      }`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {color ? (
        active && <Check className="w-4 h-4 text-white" />
      ) : (
        <span className="w-full h-full rounded-full border border-dashed border-[var(--color-border-strong)] grid place-items-center text-[10px] font-bold text-[var(--color-text-muted)]">
          {active ? <Check className="w-4 h-4 text-[var(--color-primary)]" /> : 'A'}
        </span>
      )}
    </button>
  );
}
