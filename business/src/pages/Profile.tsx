import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, Pencil, Star, Store } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { qk } from '../lib/queryKeys';
import { fetchBusinessSettings } from '../lib/businessSettings';
import type { LatLng } from '../components/BusinessLocationField';
import BusinessImageField from '../components/BusinessImageField';
import ConfirmDialog from '../components/ConfirmDialog';
import InfoTab, { type Schedule, type FreeDeliveryWindow } from './profile/InfoTab';
import DocumentsTab from './profile/DocumentsTab';
import TeamTab from './profile/TeamTab';
import SecurityTab from './profile/SecurityTab';
import DesktopTab from './profile/DesktopTab';
import { isDesktop } from '../lib/desktop';
import { usePermissions } from '../hooks/usePermissions';
import { canSee } from '../lib/permissions';

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
  // Solo tiene sentido dentro de Zipp Negocios: `canSee` ya la esconde del
  // menú en el navegador (ver `lib/permissions.ts`), y la propia `DesktopTab`
  // tampoco muestra nada fuera de escritorio.
  { path: '/desktop', label: 'Este equipo' },
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
        queryFn: () => fetchBusinessSettings(businessId),
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
    // Los encabezados de las demás páginas leen la portada del store.
    if (field === 'coverImage' && selectedBusiness) setSelectedBusiness({ ...selectedBusiness, coverImage: url });
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
        <p className="font-semibold text-[var(--color-text-main)] text-base">
          Sin establecimiento seleccionado
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Elige un negocio en el menú lateral para ver su perfil.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 [--cols3-offset:19rem]">
      {/* Perfil de negocio: identidad, imágenes y pestañas, sin ficha ni portada
          a sangre. La portada se ve como una miniatura más: es un dato del
          negocio, no un decorado de esta pantalla. */}
      <section className="border-b border-[var(--color-border)]">
        <div className="flex flex-col gap-4 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative shrink-0">
              <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-md border border-dashed border-[var(--color-border)]">
                {logo ? (
                  <img src={logo} alt={`Logo de ${selectedBusiness.name}`} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-lg font-semibold text-[var(--color-text-secondary)]">{selectedBusiness.name.charAt(0)}</span>
                )}
              </div>
              {editing && !loading && (
                <BusinessImageField
                  businessId={selectedBusiness._id}
                  slot="logo"
                  value={logo}
                  onChange={setImage('logo')}
                  onError={setError}
                  className="absolute -bottom-2 -right-2"
                />
              )}
            </div>
            <div className="min-w-0">
              <h1 className="page-title truncate">{selectedBusiness.name}</h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-[var(--color-text-secondary)]">
                <span className="capitalize">{selectedBusiness.category?.replace(/_/g, ' ')}</span>
                {selectedBusiness.city && <><span>·</span><span>{selectedBusiness.city}</span></>}
                {totalReviews > 0 && <><span>·</span><span className="inline-flex items-center gap-1"><Star className="h-3.5 w-3.5 fill-current text-[var(--color-warning)]" />{rating.toFixed(1)} ({totalReviews})</span></>}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative h-14 w-32 shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
              {coverImage ? (
                <img src={coverImage} alt={`Portada de ${selectedBusiness.name}`} className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full place-items-center text-[11px] text-[var(--color-text-secondary)]">Sin portada</span>
              )}
              {editing && !loading && (
                <BusinessImageField
                  businessId={selectedBusiness._id}
                  slot="cover"
                  value={coverImage}
                  onChange={setImage('coverImage')}
                  onError={setError}
                  className="absolute right-1 top-1"
                />
              )}
            </div>
            {!editing && !loading && (
              <button
                type="button"
                onClick={startEditing}
                className="flex h-8 items-center gap-1.5 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                <Pencil className="h-3.5 w-3.5" />
                Editar perfil
              </button>
            )}
          </div>
        </div>

        <ProfileTabs businessId={businessId} activeTab={activeTab} onSelect={goToTab} />
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
          {activeTab === '/desktop' && <DesktopTab />}
        </>
      )}

      {/* Barra de edición: flota abajo mientras se edita (y un momento
          después de guardar, para confirmarlo). Leyendo, no ocupa sitio. */}
      {((editing && activeTab === '/settings' && !loading) || saved) && (
        <div className="sticky bottom-4 z-30">
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 shadow-md"
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
                    className="px-3 py-2 rounded-md text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] cursor-pointer disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="h-8 px-4 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] cursor-pointer disabled:opacity-70"
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

      {/* Portal: el diálogo es `fixed` y no debe depender de ningún
          `transform` de un contenedor de la página. */}
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

/**
 * Las pestañas del perfil, filtradas por papel. Seguridad es de la persona
 * (su 2FA, sus sesiones) y la usa también el personal; las demás son del
 * dueño (ver NAV_REQUIREMENT). Va en un componente aparte para no meter un
 * hook más en `Profile`, cuya memoización manual el compilador de React deja
 * de poder conservar en cuanto cambia el cuerpo.
 */
function ProfileTabs({
  businessId,
  activeTab,
  onSelect,
}: {
  businessId: string | undefined;
  activeTab: string;
  onSelect: (path: string) => void;
}) {
  const { access } = usePermissions(businessId);
  const visibleTabs = TABS.filter((tab) => (tab.path === '/desktop' ? isDesktop() : true) && canSee(tab.path, access));
  return (
    <nav aria-label="Secciones del perfil" className="flex gap-6 overflow-x-auto">
      {visibleTabs.map((tab) => (
        <button
          key={tab.path}
          type="button"
          onClick={() => onSelect(tab.path)}
          className={`shrink-0 pb-2 -mb-px text-[13px] border-b-2 cursor-pointer ${
            activeTab === tab.path
              ? 'border-[var(--color-primary)] text-[var(--color-text-main)] font-semibold'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
