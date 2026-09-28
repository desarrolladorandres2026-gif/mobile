import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, Pencil, Star, Store } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { qk } from '../lib/queryKeys';
import type { LatLng } from '../components/BusinessLocationField';
import BusinessImageField from '../components/BusinessImageField';
import ConfirmDialog from '../components/ConfirmDialog';
import InfoTab, { type Schedule, type FreeDeliveryWindow } from './profile/InfoTab';
import DocumentsTab from './profile/DocumentsTab';
import TeamTab from './profile/TeamTab';
import SecurityTab from './profile/SecurityTab';

/**
 * Perfil del negocio: cabecera tipo Facebook (portada + logo + nombre) y,
 * debajo, las cuatro pestañas que antes eran pantallas sueltas — Información,
 * Documentos y pagos, Equipo y Seguridad. Las cuatro cuelgan de rutas reales
 * (`/settings`, `/documents`, `/staff`, `/security`) para que la barra
 * lateral siga resaltando el ítem correcto y la URL se pueda compartir.
 *
 * La cabecera necesita portada/logo/descripción/calificación, que no están
 * en el `selectedBusiness` liviano del store de sesión — por eso esta
 * pantalla es la única dueña del fetch completo (`qk.settings`) y se lo
 * pasa a InfoTab por props en vez de que cada pestaña cargue lo suyo.
 */

const TABS = [
  { path: '/settings', label: 'Información' },
  { path: '/documents', label: 'Documentos y pagos' },
  { path: '/staff', label: 'Equipo' },
  { path: '/security', label: 'Seguridad' },
] as const;

/**
 * Una línea de orientación por pestaña — la pista barata que antes daba el
 * `<h1>` de cada pantalla suelta. Documentos y pagos no está aquí: su propia
 * pestaña ya pinta una línea con conteos en vivo (aprobados, datos fiscales,
 * cuenta de pago) en el mismo lugar.
 */
const TAB_SUBTITLES: Partial<Record<(typeof TABS)[number]['path'], string>> = {
  '/settings': 'Cómo se ve tu tienda, cuándo abre y cuándo regalas el domicilio.',
  '/staff': 'Cada persona entra con su propia cuenta. Nadie más necesita tu contraseña.',
  '/security': 'La verificación en dos pasos de tu cuenta y las sesiones que la tienen abierta.',
};

export default function Profile() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const setSelectedBusiness = useAuthStore((s) => s.setSelectedBusiness);
  const businessId = selectedBusiness?._id;

  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [schedule, setSchedule] = useState<Schedule>({});
  const [threshold, setThreshold] = useState(0);
  const [freeDeliveryWindow, setFreeDeliveryWindow] = useState<FreeDeliveryWindow>({
    validFrom: '', validUntil: '', validDays: [], validFromTime: '', validUntilTime: '',
  });
  const [minOrder, setMinOrder] = useState(0);
  const [deliveryTime, setDeliveryTime] = useState(30);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [location_, setLocationPoint] = useState<LatLng | null>(null);
  const [phone, setPhone] = useState('');
  const [brandColor, setBrandColor] = useState<string | null>(null);
  const [showPromoBanner, setShowPromoBanner] = useState(true);
  const [logo, setLogo] = useState<string | null>(null);
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [totalReviews, setTotalReviews] = useState(0);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  // Cambios del formulario aún no guardados. Las imágenes no cuentan: se
  // guardan solas al subirlas.
  const [dirty, setDirty] = useState(false);
  // Pestaña a la que se quiso ir con cambios pendientes. Cada pestaña es
  // una ruta con su propio chunk, así que cambiar de pestaña desmonta esta
  // pantalla y los cambios se pierden sin avisar.
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  // Modo edición de Información. Por defecto el perfil se lee; "Editar
  // perfil" lo abre. Desde otra pestaña se llega con `state.edit`, porque
  // cada pestaña es una ruta y el estado local no sobrevive al cambio.
  const [editing, setEditing] = useState(
    () => (location.state as { edit?: boolean } | null)?.edit === true
  );
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = useCallback((business: any) => {
    setSchedule(business.schedule ?? {});
    setThreshold(business.freeDeliveryThreshold ?? 0);
    // El backend guarda "siempre" como un rango sin fin real (época a
    // 2999), no como vacío — se traduce aquí para que el formulario
    // muestre los campos en blanco y no un par de fechas sin sentido.
    const from = business.freeDeliveryValidFrom ? new Date(business.freeDeliveryValidFrom) : null;
    const until = business.freeDeliveryValidUntil ? new Date(business.freeDeliveryValidUntil) : null;
    setFreeDeliveryWindow({
      validFrom: from && from.getUTCFullYear() > 1971 ? from.toISOString().slice(0, 10) : '',
      validUntil: until && until.getUTCFullYear() < 2900 ? until.toISOString().slice(0, 10) : '',
      validDays: business.freeDeliveryValidDays ?? [],
      validFromTime: business.freeDeliveryValidFromTime ?? '',
      validUntilTime: business.freeDeliveryValidUntilTime ?? '',
    });
    setMinOrder(business.minOrder ?? 0);
    setDeliveryTime(business.deliveryTime ?? 30);

    setName(business.name ?? '');
    setDescription(business.description ?? '');
    setAddress(business.address ?? '');

    const coords = business.location?.coordinates;
    setLocationPoint(
      Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1])
        ? { lat: coords[1], lng: coords[0] }
        : null
    );

    setPhone(business.phone ?? '');
    setBrandColor(business.brandColor ?? null);
    setShowPromoBanner(business.showPromoBanner !== false);
    setLogo(business.logo ?? null);
    setCoverImage(business.coverImage ?? null);
    setRating(business.rating ?? 0);
    setTotalReviews(business.totalReviews ?? 0);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (!businessId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError('');
      const business = await queryClient.fetchQuery({
        queryKey: qk.settings(businessId),
        queryFn: async () => {
          const { data } = await api.get('/businesses/my/businesses');
          const found = (data.data as Array<{ _id: string }>).find((b) => b._id === businessId);
          if (!found) throw new Error('No tienes acceso al perfil de este negocio.');
          return found as typeof data.data;
        },
        staleTime: 30_000,
      });
      apply(business);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo cargar el perfil.'));
    } finally {
      setLoading(false);
    }
  }, [businessId, queryClient, apply]);

  useEffect(() => { load(); }, [load]);

  /**
   * Vuelve a lo último guardado. Sale de la caché y no de otra petición:
   * solo `save` invalida `qk.settings`, así que lo cacheado es justo lo que
   * hay en el servidor (las imágenes también: `setImage` la mantiene al día).
   */
  const discard = () => {
    if (!businessId) return;
    const key = qk.settings(businessId);
    const cached = queryClient.getQueryData(key);
    // Tras un guardado la caché queda invalidada pero sin recargar (nadie la
    // observa): ahí lo cacheado es anterior al guardado y hay que ir al servidor.
    if (cached && !queryClient.getQueryState(key)?.isInvalidated) apply(cached);
    else void load();
    setSaveError('');
  };

  const save = async () => {
    if (!businessId) return;
    // Sin cambios no hay nada que mandar: guardar solo cierra la edición.
    if (!dirty) { setEditing(false); return; }
    try {
      setSaveError('');
      setSaving(true);
      await api.put(`/businesses/${businessId}`, {
        schedule,
        freeDeliveryThreshold: threshold,
        // Vacío en el formulario significa "siempre" — se manda el rango
        // sin fin real que el backend ya usa por defecto, para poder
        // borrar una vigencia que se había puesto antes.
        freeDeliveryValidFrom: freeDeliveryWindow.validFrom || new Date(0).toISOString(),
        freeDeliveryValidUntil: freeDeliveryWindow.validUntil || new Date('2999-12-31').toISOString(),
        freeDeliveryValidDays: freeDeliveryWindow.validDays,
        freeDeliveryValidFromTime: freeDeliveryWindow.validFromTime,
        freeDeliveryValidUntilTime: freeDeliveryWindow.validUntilTime,
        minOrder,
        deliveryTime,
        name: name.trim(),
        description: description.trim(),
        address: address.trim(),
        phone: phone.trim(),
        brandColor,
        showPromoBanner,
        ...(location_ ? { longitude: location_.lng, latitude: location_.lat } : {}),
      });

      if (selectedBusiness && name.trim() !== selectedBusiness.name) {
        setSelectedBusiness({ ...selectedBusiness, name: name.trim() });
      }

      setDirty(false);
      setEditing(false);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
      void queryClient.invalidateQueries({ queryKey: qk.settings(businessId) });
    } catch (err) {
      setSaveError(apiMessage(err, 'No se pudieron guardar los cambios.'));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty) discard();
    setSaveError('');
    setEditing(false);
  };

  const startEditing = () => {
    if (activeTab === '/settings') setEditing(true);
    else navigate('/settings', { state: { edit: true } });
  };

  const markDirty = () => { setDirty(true); setSaved(false); };

  /**
   * Una imagen recién subida o quitada se escribe también en la caché: sin
   * esto, volver a esta pestaña antes de 30 s pintaba la foto anterior.
   */
  const setImage = (field: 'logo' | 'coverImage') => (url: string | null) => {
    (field === 'logo' ? setLogo : setCoverImage)(url);
    if (businessId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryClient.setQueryData(qk.settings(businessId), (old: any) => (old ? { ...old, [field]: url } : old));
    }
  };

  const activeTab = TABS.find((t) => t.path === location.pathname)?.path ?? '/settings';

  const goToTab = (path: string) => {
    if (path === activeTab) return;
    if (dirty) setPendingTab(path);
    else navigate(path);
  };

  if (!selectedBusiness) {
    return (
      <div className="py-20 text-center space-y-2">
        <Store className="w-8 h-8 text-[var(--color-primary)] mx-auto" />
        <p className="font-bold text-[var(--color-text-main)] text-base">
          Sin establecimiento seleccionado
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Elige un negocio en el menú lateral para ver su perfil.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in [--cols3-offset:33rem]">
      {/* Perfil de negocio: portada, identidad y navegación en una sola ficha. */}
      <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_8px_20px_rgba(20,20,20,0.055)]">
        <div className="relative h-40 sm:h-52 lg:h-32 bg-linear-to-br from-[#2e2e2e] via-[#505050] to-[#D69E26]">
          {coverImage ? (
            <img src={coverImage} alt={`Portada de ${selectedBusiness.name}`} className="h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_76%_18%,rgba(255,255,255,0.25),transparent_26%)]" />
          )}
          <div className="absolute inset-0 bg-linear-to-t from-black/25 to-transparent" />
          {editing && !loading && (
            <BusinessImageField
              businessId={selectedBusiness._id}
              slot="cover"
              value={coverImage}
              onChange={setImage('coverImage')}
              onError={setError}
              className="absolute right-4 top-4"
            />
          )}
        </div>

        <div className="relative px-5 pb-0 sm:px-8">
          <div className="absolute -top-14 left-5 sm:left-8">
            <div className="grid h-28 w-28 place-items-center overflow-hidden rounded-2xl border-4 border-white bg-[#f1f1f1] shadow-lg">
              {logo ? (
                <img src={logo} alt={`Logo de ${selectedBusiness.name}`} className="h-full w-full object-cover" />
              ) : (
              <span className="text-3xl font-bold text-[#9C6E0E]">{selectedBusiness.name.charAt(0)}</span>
              )}
            </div>
            {editing && !loading && (
              <BusinessImageField
                businessId={selectedBusiness._id}
                slot="logo"
                value={logo}
                onChange={setImage('logo')}
                onError={setError}
                className="absolute -bottom-1 -right-1"
              />
            )}
          </div>

          <div className="flex flex-col gap-4 pt-[4.5rem] pb-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-[-0.035em] text-[var(--color-text-main)]">{selectedBusiness.name}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-text-secondary)]">
                <span className="capitalize">{selectedBusiness.category?.replace(/_/g, ' ')}</span>
                {selectedBusiness.city && <><span>·</span><span>{selectedBusiness.city}</span></>}
                {totalReviews > 0 && <><span>·</span><span className="inline-flex items-center gap-1"><Star className="h-3.5 w-3.5 fill-current text-[var(--color-warning)]" />{rating.toFixed(1)} ({totalReviews})</span></>}
              </p>
            </div>
            {!editing && !loading && (
              <button
                type="button"
                onClick={startEditing}
                className="self-start flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer lg:self-auto"
              >
                <Pencil className="h-3.5 w-3.5" />
                Editar perfil
              </button>
            )}
          </div>

          <nav aria-label="Secciones del perfil" className="flex gap-5 overflow-x-auto border-t border-[var(--color-border-light)]">
            {TABS.map((tab) => (
              <button
                key={tab.path}
                type="button"
                onClick={() => goToTab(tab.path)}
                className={`shrink-0 py-4 -mb-px text-xs font-bold uppercase tracking-wider border-b-2 cursor-pointer transition-colors ${
                  activeTab === tab.path
                    ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
                    : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </section>

      {TAB_SUBTITLES[activeTab] && <p className="page-subtitle">{TAB_SUBTITLES[activeTab]}</p>}

      {error && (
        <div className="flex items-start gap-3 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
          Cargando perfil...
        </p>
      ) : (
        <>
          {activeTab === '/settings' && (
            <InfoTab
              businessId={businessId!}
              schedule={schedule} setSchedule={(s) => { markDirty(); setSchedule(s); }}
              threshold={threshold} setThreshold={(v) => { markDirty(); setThreshold(v); }}
              freeDeliveryWindow={freeDeliveryWindow}
              setFreeDeliveryWindow={(v) => { markDirty(); setFreeDeliveryWindow(v); }}
              minOrder={minOrder} setMinOrder={(v) => { markDirty(); setMinOrder(v); }}
              deliveryTime={deliveryTime} setDeliveryTime={(v) => { markDirty(); setDeliveryTime(v); }}
              name={name} setName={(v) => { markDirty(); setName(v); }}
              description={description} setDescription={(v) => { markDirty(); setDescription(v); }}
              address={address} setAddress={(v) => { markDirty(); setAddress(v); }}
              location={location_} setLocation={(v) => { markDirty(); setLocationPoint(v); }}
              phone={phone} setPhone={(v) => { markDirty(); setPhone(v); }}
              brandColor={brandColor} setBrandColor={(v) => { markDirty(); setBrandColor(v); }}
              showPromoBanner={showPromoBanner} setShowPromoBanner={(v) => { markDirty(); setShowPromoBanner(v); }}
              editing={editing}
              category={selectedBusiness.category ?? ''}
              city={selectedBusiness.city ?? ''}
              rating={rating}
              totalReviews={totalReviews}
            />
          )}
          {activeTab === '/documents' && <DocumentsTab />}
          {activeTab === '/staff' && <TeamTab />}
          {activeTab === '/security' && <SecurityTab />}
        </>
      )}

      {/* Barra de edición: flota abajo mientras se edita (y un momento
          después de guardar, para confirmarlo). Leyendo, no ocupa sitio. */}
      {((editing && activeTab === '/settings' && !loading) || saved) && (
        <div className="sticky bottom-4 z-30 animate-fade-in">
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-xl"
          >
            {editing ? (
              <>
                <div className="space-y-0.5">
                  <p className={`text-xs font-semibold ${saveError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
                    {saveError || (dirty ? 'Tienes cambios sin guardar.' : 'Estás editando tu perfil.')}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    La portada y el logo se guardan al subirlos; Cancelar no los deshace.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={cancel}
                    disabled={saving}
                    className="px-3 py-2 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] cursor-pointer disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[var(--color-primary-dark)] transition-all cursor-pointer disabled:opacity-70"
                  >
                    {saving ? 'Guardando…' : 'Guardar cambios'}
                  </button>
                </div>
              </>
            ) : (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-main)]">
                <Check className="h-4 w-4 text-[var(--color-primary)]" />
                Cambios guardados
              </p>
            )}
          </div>
        </div>
      )}

      {/* Portal: el `animate-fade-in` de la raíz deja un `transform` que
          encerraría a este `fixed` dentro de la página. */}
      {pendingTab && createPortal(
        <ConfirmDialog
          title="Tienes cambios sin guardar"
          message="Si cambias de pestaña ahora, se pierden. Guárdalos primero con la barra de abajo."
          confirmLabel="Salir sin guardar"
          cancelLabel="Seguir editando"
          variant="warning"
          onConfirm={() => { const to = pendingTab; setPendingTab(null); navigate(to); }}
          onCancel={() => setPendingTab(null)}
        />,
        document.body
      )}
    </div>
  );
}
