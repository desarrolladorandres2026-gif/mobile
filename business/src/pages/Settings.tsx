import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Clock, Store, Truck, Save, Image as ImageIcon } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { BRAND_COLORS } from '../lib/brandColors';
import BusinessImageField from '../components/BusinessImageField';
import BusinessLocationField, { type LatLng } from '../components/BusinessLocationField';

/**
 * Ajustes del comercio: cómo se ve su ficha, cuándo abre y cuándo regala el
 * domicilio.
 *
 * Todo lo de esta pantalla lo paga o lo firma el negocio, y por eso lo
 * decide el negocio. Su comisión y su aprobación no están aquí: eso es el
 * acuerdo con ZIPP y se toca desde el panel de administración.
 *
 * El horario no es decorativo. El servidor decide con él si la tienda está
 * abierta, así que dejar mal un día cierra la tienda de verdad — por eso se
 * avisa antes de guardar y no después.
 *
 * Las dos imágenes se guardan solas al subirlas; el resto espera al botón
 * de guardar. No es una inconsistencia: una foto es un cambio que se juzga
 * mirándolo, y tenerla en el limbo hasta que alguien pulse un botón es cómo
 * se acaba subiendo tres veces la misma.
 */

type DaySchedule = { open?: string; close?: string; isOpen?: boolean };
type Schedule = Record<string, DaySchedule>;

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

/** El mismo campo de texto que ya usan los ajustes de entrega, en un sitio. */
const INPUT =
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] ' +
  'text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

export default function Settings() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const setSelectedBusiness = useAuthStore((s) => s.setSelectedBusiness);
  const businessId = selectedBusiness?._id;

  const [schedule, setSchedule] = useState<Schedule>({});
  const [threshold, setThreshold] = useState(0);
  const [minOrder, setMinOrder] = useState(0);
  const [deliveryTime, setDeliveryTime] = useState(30);

  // ── Ficha pública ──
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [location, setLocation] = useState<LatLng | null>(null);
  const [phone, setPhone] = useState('');
  const [brandColor, setBrandColor] = useState<string | null>(null);
  const [showPromoBanner, setShowPromoBanner] = useState(true);
  const [logo, setLogo] = useState<string | null>(null);
  const [coverImage, setCoverImage] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    // Sin negocio no hay nada que pedir, pero la carga tiene que apagarse
    // igual: si se sale por aquí dejando `loading` en true, la pantalla se
    // queda en "Cargando ajustes..." para siempre y sin explicación.
    if (!businessId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get(`/businesses/${businessId}`);
      const business = data.data;

      setSchedule(business.schedule ?? {});
      setThreshold(business.freeDeliveryThreshold ?? 0);
      setMinOrder(business.minOrder ?? 0);
      setDeliveryTime(business.deliveryTime ?? 30);

      setName(business.name ?? '');
      setDescription(business.description ?? '');
      setAddress(business.address ?? '');

      // GeoJSON guarda [longitud, latitud]; el mapa habla en {lat, lng}.
      const coords = business.location?.coordinates;
      setLocation(
        Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1])
          ? { lat: coords[1], lng: coords[0] }
          : null
      );

      setPhone(business.phone ?? '');
      setBrandColor(business.brandColor ?? null);
      setShowPromoBanner(business.showPromoBanner !== false);
      setLogo(business.logo ?? null);
      setCoverImage(business.coverImage ?? null);
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar los ajustes.'));
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const setDay = (key: string, patch: DaySchedule) => {
    setSaved(false);
    setSchedule((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const save = async () => {
    if (!businessId) return;
    try {
      setError('');
      setSaving(true);
      await api.put(`/businesses/${businessId}`, {
        schedule,
        freeDeliveryThreshold: threshold,
        minOrder,
        deliveryTime,
        name: name.trim(),
        description: description.trim(),
        address: address.trim(),
        phone: phone.trim(),
        brandColor,
        showPromoBanner,
        // Solo van si el negocio de verdad tiene un punto puesto: mandar
        // el centro por defecto del mapa sería fijar cada negocio sin
        // ubicación en el mismo sitio.
        ...(location ? { longitude: location.lng, latitude: location.lat } : {}),
      });

      // El nombre sale en el menú lateral y en el selector de local: sin
      // esto, el comercio se renombra y sigue viendo el nombre viejo por
      // todo el panel hasta que vuelve a entrar.
      if (selectedBusiness && name.trim() !== selectedBusiness.name) {
        setSelectedBusiness({ ...selectedBusiness, name: name.trim() });
      }

      setSaved(true);
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron guardar los ajustes.'));
    } finally {
      setSaving(false);
    }
  };

  const openDays = DAYS.filter((d) => schedule[d.key]?.isOpen).length;

  if (!selectedBusiness) {
    return (
      <div className="py-20 text-center space-y-2">
        <Store className="w-8 h-8 text-[var(--color-primary)] mx-auto" />
        <p className="font-bold text-[var(--color-text-main)] text-base">
          Sin establecimiento seleccionado
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Elige un negocio en el menú lateral para ver sus ajustes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Ajustes</h1>
          <p className="page-subtitle">
            Cómo se ve tu tienda, cuándo abre y cuándo regalas el domicilio. Lo que decides aquí
            sale de tu bolsillo, no del de ZIPP
          </p>
        </div>

        <button
          onClick={save}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
        >
          {saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando…' : saved ? 'Guardado' : 'Guardar cambios'}
        </button>
      </div>

      {error && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {openDays === 0 && !loading && (
        <div className="bg-[var(--color-warning-bg)] text-[var(--color-warning)] text-xs p-4 rounded-xl flex items-start gap-3 font-semibold">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">
            No tienes ningún día abierto. Con este horario, tu tienda aparece cerrada
            y nadie puede pedirte.
          </p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando ajustes...
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ── Ficha pública ── */}
          <div className="zipp-card p-5 space-y-5 lg:col-span-2">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Tu ficha en la app</h2>
            </div>

            <p className="text-xs text-[var(--color-text-secondary)]">
              Es lo primero que ve un cliente al entrar a tu tienda, antes de mirar un solo
              producto.
            </p>

            <div className="grid gap-6 md:grid-cols-2">
              <BusinessImageField
                businessId={businessId!}
                slot="cover"
                label="Portada"
                hint="La foto grande del encabezado. Se recorta a 16:9 — lo que se vea dentro del marco es lo que sale en la app."
                value={coverImage}
                onChange={setCoverImage}
              />

              <BusinessImageField
                businessId={businessId!}
                slot="logo"
                label="Logo"
                hint="Va en el círculo sobre la portada. Se recorta cuadrado porque la app lo muestra redondo."
                value={logo}
                onChange={setLogo}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nombre del negocio">
                <input
                  type="text"
                  value={name}
                  maxLength={100}
                  onChange={(e) => { setSaved(false); setName(e.target.value); }}
                  className={INPUT}
                />
              </Field>

              <Field label="Teléfono de contacto">
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => { setSaved(false); setPhone(e.target.value); }}
                  className={INPUT}
                />
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Es el número al que llama el cliente desde tu ficha.
                </p>
              </Field>
            </div>

            <Field label="Descripción">
              <textarea
                value={description}
                maxLength={500}
                rows={2}
                onChange={(e) => { setSaved(false); setDescription(e.target.value); }}
                className={`${INPUT} resize-y`}
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                Una línea sobre la portada, debajo de tu nombre. Di qué vendes con las palabras
                que usaría quien te busca — también es lo que se usa para encontrarte.
              </p>
            </Field>

            <Field label="Dirección">
              <input
                type="text"
                value={address}
                onChange={(e) => { setSaved(false); setAddress(e.target.value); }}
                className={INPUT}
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                El texto que lee el cliente. El punto por el que pasa el domiciliario se ajusta
                aparte, abajo.
              </p>
            </Field>

            <Field label="Punto de recogida">
              {/* `key`: el mapa es imperativo (Leaflet vive fuera de React) y
                  se construye una sola vez al montar, así que solo sabe
                  seguir al negocio activo si se le obliga a remontar cuando
                  cambia. Hoy el bloque de "Cargando ajustes..." ya lo
                  desmonta en cada cambio de negocio del selector lateral;
                  esta key deja ese requisito escrito en vez de apoyado en
                  que nadie quite ese `if` más adelante. */}
              <BusinessLocationField
                key={businessId}
                value={location}
                onChange={(point) => { setSaved(false); setLocation(point); }}
              />
            </Field>

            <Field label="Color del encabezado">
              <div className="flex flex-wrap items-center gap-2">
                <ColorSwatch
                  color={null}
                  label="Automático"
                  active={brandColor === null}
                  onSelect={() => { setSaved(false); setBrandColor(null); }}
                />
                {BRAND_COLORS.map((option) => (
                  <ColorSwatch
                    key={option.value}
                    color={option.value}
                    label={option.label}
                    active={brandColor === option.value}
                    onSelect={() => { setSaved(false); setBrandColor(option.value); }}
                  />
                ))}
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Solo se ve cuando no tienes portada. Con foto puesta, el color queda debajo y no
                se aprecia.
              </p>
            </Field>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showPromoBanner}
                onChange={(e) => { setSaved(false); setShowPromoBanner(e.target.checked); }}
                className="accent-[var(--color-primary)] cursor-pointer mt-0.5"
              />
              <span className="space-y-1">
                <span className="block text-xs font-bold text-[var(--color-text-main)]">
                  Mostrar la franja de promoción
                </span>
                <span className="block text-xs text-[var(--color-text-secondary)]">
                  Anuncia tu envío gratis en el encabezado. El texto lo escribe ZIPP con tus
                  propios datos, así que nunca puede prometer algo que no esté activo. Si no
                  tienes envío gratis puesto, la franja no aparece aunque esto esté marcado.
                </span>
              </span>
            </label>
          </div>

          {/* ── Horario ── */}
          <div className="zipp-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Horario de atención</h2>
            </div>

            <p className="text-xs text-[var(--color-text-secondary)]">
              Fuera de este horario tu tienda se muestra cerrada y no recibe pedidos.
            </p>

            <div className="space-y-2">
              {DAYS.map((day) => {
                const value = schedule[day.key] ?? {};
                const isOpen = !!value.isOpen;

                return (
                  <div
                    key={day.key}
                    className="flex flex-wrap items-center gap-3 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]"
                  >
                    <label className="flex items-center gap-2 min-w-[110px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isOpen}
                        onChange={(e) => setDay(day.key, { isOpen: e.target.checked })}
                        className="accent-[var(--color-primary)] cursor-pointer"
                      />
                      <span className="text-xs font-bold text-[var(--color-text-main)]">
                        {day.label}
                      </span>
                    </label>

                    {isOpen ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={value.open ?? '08:00'}
                          onChange={(e) => setDay(day.key, { open: e.target.value })}
                          className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
                        />
                        <span className="text-xs text-[var(--color-text-muted)]">a</span>
                        <input
                          type="time"
                          value={value.close ?? '20:00'}
                          onChange={(e) => setDay(day.key, { close: e.target.value })}
                          className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)] font-medium">Cerrado</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Entregas ── */}
          <div className="zipp-card p-5 space-y-4 self-start">
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Entregas</h2>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--color-text-main)]">
                Envío gratis desde
              </label>
              <input
                type="number"
                min={0}
                step={1000}
                value={threshold}
                onChange={(e) => { setSaved(false); setThreshold(Number(e.target.value)); }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                {threshold > 0 ? (
                  <>
                    Los pedidos de {money(threshold)} o más no pagan domicilio.{' '}
                    <strong className="text-[var(--color-text-main)]">
                      Ese costo se descuenta de tu liquidación
                    </strong>{' '}
                    — el domiciliario cobra igual.
                  </>
                ) : (
                  'En cero, tus clientes pagan siempre el domicilio.'
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--color-text-main)]">
                Pedido mínimo
              </label>
              <input
                type="number"
                min={0}
                step={1000}
                value={minOrder}
                onChange={(e) => { setSaved(false); setMinOrder(Number(e.target.value)); }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                Por debajo de este monto no se puede completar un pedido tuyo.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--color-text-main)]">
                Tiempo de preparación (minutos)
              </label>
              <input
                type="number"
                min={5}
                max={120}
                value={deliveryTime}
                onChange={(e) => { setSaved(false); setDeliveryTime(Number(e.target.value)); }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                Es lo que el cliente ve como estimado. Prometer de menos genera reclamos.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-bold text-[var(--color-text-main)]">{label}</label>
      {children}
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
          ? 'ring-2 ring-offset-2 ring-[var(--color-primary)] ring-offset-[var(--color-surface)]'
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
