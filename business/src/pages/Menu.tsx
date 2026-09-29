import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Plus, Edit, Trash2, ToggleLeft, ToggleRight, X, Tag, SquarePlus, ChevronDown, ChevronRight, Clock,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { apiMessage } from '../lib/apiError';
import { money } from '../lib/orderFlow';
import ConfirmDialog from '../components/ConfirmDialog';
import SmartImage from '../components/SmartImage';
import type { Product } from '../lib/catalog';
import ProductGalleryField from '../components/ProductGalleryField';
import ProductImageField, {
  type ImageCapabilities, type PendingProductImage,
} from '../components/ProductImageField';
import { isImageInProgress, productImageFileName } from '../lib/productImageStatus';
import ModifierGroupsEditor from '../components/ModifierGroupsEditor';
import NumericInput from '../components/NumericInput';
import { toDrafts, fromDrafts } from '../lib/modifierGroups';
import { fetchBusinessSettings } from '../lib/businessSettings';
import {
  EMPTY_PRODUCT_FORM, PREP_TIME_MAX, discountPercent, hasDraftContent, productChecklist,
  productProgress, rawDiscountPercent, readPricing, type PricingField, type ProductFormState,
} from '../lib/productForm';
import { productChecks, type PhotoState } from '../lib/productChecks';
import { clearDraft, isDraftWorthRestoring, loadDraft, saveDraft } from '../lib/productDraft';
import ProductPreview from '../components/product/ProductPreview';
import ProductProgress from '../components/product/ProductProgress';
import ProductRecommendations from '../components/product/ProductRecommendations';
import ProductSummary from '../components/product/ProductSummary';

interface Category {
  _id: string;
  name: string;
}

/** Id de cada campo que puede frenar el guardado, para llevar el foco allí. */
const PRICING_INPUT: Record<PricingField, string> = {
  price: 'product-price',
  discountPrice: 'product-discount',
  prepTimeMinutes: 'product-prep-time',
};

export default function Menu() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [showProductModal, setShowProductModal] = useState(false);

  // La carta del panel incluye lo no disponible: es la vista del comercio,
  // y el servidor la sirve siempre fresca, fuera de la caché compartida.
  const menuQuery = useQuery({
    queryKey: qk.menu(businessId),
    enabled: !!businessId,
    // Una foto recién subida se está recortando: la lista vuelve a pedirse
    // hasta que la miniatura cambie sola. Con el modal abierto no, porque
    // ahí ya pregunta el campo de la foto.
    refetchInterval: (query) =>
      !showProductModal && query.state.data?.products.some((product) => isImageInProgress(product))
        ? 5_000
        : false,
    queryFn: async () => {
      const [resCats, resProds] = await Promise.all([
        api.get(`/categories/business/${businessId}`),
        api.get(`/products/business/${businessId}?includeUnavailable=true`),
      ]);
      return {
        categories: resCats.data.data as Category[],
        products: resProds.data.data as Product[],
      };
    },
  });
  const categories = useMemo(() => menuQuery.data?.categories ?? [], [menuQuery.data]);
  const products = useMemo(() => menuQuery.data?.products ?? [], [menuQuery.data]);
  const loading = !!businessId && menuQuery.isPending;
  const loadError = menuQuery.isError
    ? apiMessage(menuQuery.error, 'No pudimos cargar la información del menú.')
    : '';

  /** Cambia la carta en caché sin esperar a volver a pedirla. */
  const setProducts = useCallback(
    (update: (previous: Product[]) => Product[]) => {
      queryClient.setQueryData<{ categories: Category[]; products: Product[] }>(qk.menu(businessId), (old) =>
        old ? { ...old, products: update(old.products) } : old
      );
    },
    [queryClient, businessId]
  );

  // Qué sabe hacer este entorno con las imágenes. Se pregunta una vez por
  // sesión: sin esto el panel pintaría botones —recorte de fondo, por
  // ejemplo— que el servidor no puede cumplir.
  const { data: capabilities = null } = useQuery({
    queryKey: ['product-image-capabilities'],
    queryFn: async () => (await api.get('/products/image-capabilities')).data.data as ImageCapabilities,
    staleTime: Infinity,
    retry: false,
  });

  /** Categoría filtrada en la lista; el producto nuevo nace en ella. */
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  /**
   * El comercio pulsó "Nuevo producto" sin tener categorías.
   *
   * Se recuerda para abrirle el formulario del producto en cuanto exista
   * la categoría: pulsó para crear un producto, y eso es lo que tiene que
   * acabar pasando.
   */
  const [categoryLeadsToProduct, setCategoryLeadsToProduct] = useState(false);

  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  /**
   * Errores al guardar el producto, dentro del modal. En la página quedaban
   * tapados por el propio modal y el comercio no sabía por qué no avanzaba.
   */
  const [modalError, setModalError] = useState('');
  const [productForm, setProductForm] = useState<ProductFormState>(EMPTY_PRODUCT_FORM);
  /** Recorte hecho en el editor que todavía no tiene producto al que ir. */
  const [pendingImage, setPendingImage] = useState<PendingProductImage | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * "Opciones avanzadas" desplegado. Solo decide qué se ve: plegarlo no
   * borra adiciones ni grupos, que se siguen guardando.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Sube al "Empezar de cero" para volver a montar el campo de la foto vacío. */
  const [photoFieldKey, setPhotoFieldKey] = useState(0);
  /** Borrador del alta en este navegador: cuándo se guardó y de cuándo era el recuperado. */
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftRestoredFrom, setDraftRestoredFrom] = useState<number | null>(null);
  /** Lo último escrito en el borrador, para no reescribirlo sin cambios. */
  const lastDraftRef = useRef<string | null>(null);
  /** El alta ya se creó: el autoguardado no vuelve a escribir hasta la próxima. */
  const draftClosedRef = useRef(false);

  // Para la vista previa: el tipo de negocio (la ilustración sin foto) y
  // el tiempo general que la app enseña en los platos sin tiempo propio.
  const { data: businessSettings } = useQuery({
    queryKey: qk.settings(businessId),
    queryFn: () => fetchBusinessSettings(businessId!),
    enabled: !!businessId && showProductModal,
    staleTime: 30_000,
  });

  const [newExtra, setNewExtra] = useState({ name: '', price: '' });
  const [confirmDeleteCat, setConfirmDeleteCat] = useState<string | null>(null);
  const [confirmDeleteProd, setConfirmDeleteProd] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setError('');
    await queryClient.invalidateQueries({ queryKey: qk.menu(businessId) });
  }, [queryClient, businessId]);

  // ── Categorías ──

  const handleCreateCategory = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!businessId || !newCategoryName.trim()) return;
    try {
      setError('');
      const created = await api.post('/categories', {
        businessId,
        name: newCategoryName.trim(),
      });
      setNewCategoryName('');
      setShowCategoryModal(false);
      await fetchData();

      // Venía a crear un producto: se le devuelve donde iba, con la
      // categoría recién hecha ya seleccionada.
      if (categoryLeadsToProduct) {
        setCategoryLeadsToProduct(false);
        openProductModal(null, created.data.data._id);
      }
    } catch (err) {
      setError(apiMessage(err, 'No pudimos crear la categoría.'));
    }
  };

  const handleDeleteCategory = async () => {
    if (!confirmDeleteCat) return;
    try {
      setError('');
      await api.delete(`/categories/${confirmDeleteCat}`, { data: { businessId } });
      setConfirmDeleteCat(null);
      fetchData();
    } catch (err) {
      setError(apiMessage(err, 'No pudimos eliminar la categoría.'));
      setConfirmDeleteCat(null);
    }
  };

  // ── Productos ──

  const handleProductToggle = async (product: Product) => {
    try {
      setError('');
      await api.put(`/products/${product._id}`, {
        businessId,
        isAvailable: !product.isAvailable,
      });
      setProducts((previous) =>
        previous.map((item) =>
          item._id === product._id ? { ...item, isAvailable: !item.isAvailable } : item
        )
      );
    } catch (err) {
      setError(apiMessage(err, 'No pudimos cambiar la disponibilidad.'));
    }
  };

  /**
   * "Nuevo producto": lleva al producto, o a la categoría que le falta.
   *
   * Todo producto cuelga de una categoría, así que sin ninguna no hay
   * formulario posible. En vez de bloquear, se pide lo que falta y se
   * continúa donde el comercio quería ir.
   */
  const startNewProduct = () => {
    if (categories.length === 0) {
      setCategoryLeadsToProduct(true);
      setShowCategoryModal(true);
      return;
    }
    openProductModal(null);
  };

  /** La categoría con la que nace un producto: la filtrada, o la primera. */
  const defaultCategoryId = () =>
    categories.find((category) => category._id === filterCategory)?._id ??
    categories[0]?._id ??
    '';

  /**
   * Abre el formulario: el producto a editar, o el alta.
   *
   * El alta recupera el borrador de este navegador si lo hay. La categoría
   * pedida (la que se acaba de crear para este producto) manda sobre la
   * del borrador; la del borrador, sobre la filtrada, salvo que ya no
   * exista.
   */
  const openProductModal = (product: Product | null = null, preferredCategoryId?: string) => {
    setPendingImage(null);
    setError('');
    setModalError('');
    setNewExtra({ name: '', price: '' });
    setDraftSavedAt(null);
    setDraftRestoredFrom(null);
    lastDraftRef.current = null;
    draftClosedRef.current = false;

    if (product) {
      setEditingProduct(product);
      setProductForm({
        name: product.name,
        description: product.description || '',
        price: String(product.price),
        discountPrice: product.discountPrice ? String(product.discountPrice) : '',
        prepTimeMinutes: product.prepTimeMinutes ? String(product.prepTimeMinutes) : '',
        requiresAgeVerification: !!product.requiresAgeVerification,
        categoryId: product.categoryId,
        extras: product.extras || [],
        modifierGroups: toDrafts(product.modifierGroups),
      });
      setAdvancedOpen(Boolean(product.extras?.length || product.modifierGroups?.length));
    } else {
      setEditingProduct(null);
      const draft = businessId ? loadDraft(businessId) : null;

      if (draft && isDraftWorthRestoring(draft, Date.now())) {
        const draftCategoryExists = categories.some((category) => category._id === draft.form.categoryId);
        const form = {
          ...draft.form,
          categoryId: preferredCategoryId ?? (draftCategoryExists ? draft.form.categoryId : defaultCategoryId()),
        };
        setProductForm(form);
        setAdvancedOpen(form.extras.length > 0 || form.modifierGroups.length > 0);
        setDraftRestoredFrom(draft.savedAt);
        setDraftSavedAt(draft.savedAt);
        lastDraftRef.current = JSON.stringify(form);
      } else {
        setProductForm({ ...EMPTY_PRODUCT_FORM, categoryId: preferredCategoryId ?? defaultCategoryId() });
        setAdvancedOpen(false);
      }
    }
    setShowProductModal(true);
  };

  const closeProductForm = () => setShowProductModal(false);

  /** "Empezar de cero": fuera el borrador y el formulario vuelve vacío, foto incluida. */
  const discardDraft = () => {
    if (businessId) clearDraft(businessId);
    lastDraftRef.current = null;
    setDraftRestoredFrom(null);
    setDraftSavedAt(null);
    setPendingImage(null);
    setPhotoFieldKey((key) => key + 1);
    setModalError('');
    setNewExtra({ name: '', price: '' });
    setAdvancedOpen(false);
    setProductForm({ ...EMPTY_PRODUCT_FORM, categoryId: defaultCategoryId() });
  };

  // Autoguardado del alta, medio segundo después de la última tecla. La
  // edición no se autoguarda: ver `lib/productDraft`.
  useEffect(() => {
    if (!showProductModal || editingProduct || !businessId) return;
    const timer = setTimeout(() => {
      if (draftClosedRef.current) return;
      const serialized = JSON.stringify(productForm);
      if (serialized === lastDraftRef.current) return;
      lastDraftRef.current = serialized;

      if (hasDraftContent(productForm)) {
        setDraftSavedAt(saveDraft(businessId, productForm));
      } else {
        clearDraft(businessId);
        setDraftSavedAt(null);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [productForm, showProductModal, editingProduct, businessId]);

  const handleAddExtra = () => {
    const price = Number(newExtra.price);
    if (!newExtra.name.trim() || !Number.isFinite(price)) return;
    setProductForm((previous) => ({
      ...previous,
      extras: [...previous.extras, { name: newExtra.name.trim(), price }],
    }));
    setNewExtra({ name: '', price: '' });
  };

  const handleRemoveExtra = (index: number) => {
    setProductForm((previous) => ({
      ...previous,
      extras: previous.extras.filter((_, position) => position !== index),
    }));
  };

  /**
   * Guarda el producto y, si hay foto pendiente, la sube después.
   *
   * Son dos peticiones porque la imagen necesita un producto que ya
   * exista. Si la segunda falla, el producto **queda creado** y se dice:
   * tirarlo abajo sería peor —el comercio ya escribió nombre, precio y
   * adiciones— y volver a intentar la foto es un clic.
   */
  const handleSaveProduct = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!businessId || saving) return;

    // El botón nunca se apaga: si falta algo, lleva al campo que lo pide.
    const pricing = readPricing(productForm);
    if (!pricing.ok) {
      setModalError(pricing.message);
      document.getElementById(PRICING_INPUT[pricing.field])?.focus();
      return;
    }

    const converted = fromDrafts(productForm.modifierGroups);
    if ('error' in converted) {
      // Plegadas, el comercio vería el error sin ver el grupo que lo causa.
      setAdvancedOpen(true);
      setModalError(converted.error);
      return;
    }

    const payload = {
      businessId,
      categoryId: productForm.categoryId,
      name: productForm.name.trim(),
      // Cadena vacía y no `undefined`: al editar, `undefined` es "no lo
      // toques" y borrar la descripción no se guardaba nunca.
      description: productForm.description.trim(),
      price: pricing.price,
      discountPrice: pricing.discountPrice,
      prepTimeMinutes: pricing.prepTimeMinutes,
      requiresAgeVerification: productForm.requiresAgeVerification,
      extras: productForm.extras,
      modifierGroups: converted.groups,
    };

    const creating = !editingProduct;
    setSaving(true);
    setModalError('');
    try {
      const saved = editingProduct
        ? await api.put(`/products/${editingProduct._id}`, payload)
        : await api.post('/products', payload);

      const savedProduct = saved.data.data as Product;

      // El alta ya está en el servidor: el borrador cumplió. La bandera va
      // antes de borrarlo porque un autoguardado pendiente podría dispararse
      // durante la subida de la foto y resucitarlo; al volver a "Nuevo
      // producto" aparecería otra vez y se crearía repetido.
      if (creating) {
        draftClosedRef.current = true;
        clearDraft(businessId);
      }

      if (pendingImage) {
        try {
          const form = new FormData();
          form.append('businessId', businessId);
          form.append('image', pendingImage.blob, productImageFileName(pendingImage.blob));
          if (pendingImage.removeBackground) form.append('removeBackground', 'true');
          // Sin esto axios manda el FormData como JSON — la instancia del
          // panel declara 'application/json' por defecto.
          await api.post(`/products/${savedProduct._id}/image`, form, {
            headers: { 'Content-Type': undefined },
          });
        } catch (imageError) {
          // El producto ya existe. El modal pasa a editarlo y conserva la
          // foto pendiente: otro "Guardar" reintenta la foto en vez de
          // crear un segundo producto, que es lo que pasaba antes.
          setEditingProduct(savedProduct);
          setModalError(
            `Guardamos el producto, pero la foto no subió: ${apiMessage(imageError, 'pulsa "Guardar cambios" para reintentarla.')}`
          );
          await fetchData();
          return;
        }
      }

      setShowProductModal(false);
      setPendingImage(null);
      await fetchData();
    } catch (err) {
      setModalError(apiMessage(err, 'No pudimos guardar el producto.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProduct = async () => {
    if (!confirmDeleteProd) return;
    try {
      setError('');
      await api.delete(`/products/${confirmDeleteProd}`, { data: { businessId } });
      setConfirmDeleteProd(null);
      fetchData();
    } catch (err) {
      setError(apiMessage(err, 'No pudimos eliminar el producto.'));
      setConfirmDeleteProd(null);
    }
  };

  /** Refleja el producto que devuelve el servidor tras tocar su imagen. */
  const onProductImageUpdated = (updated: Product) => {
    setProducts((previous) =>
      previous.map((item) => (item._id === updated._id ? { ...item, ...updated } : item))
    );
    setEditingProduct((current) =>
      current && current._id === updated._id ? { ...current, ...updated } : current
    );
  };

  /**
   * La lista del catálogo, memorizada.
   *
   * Vive en el mismo componente que el formulario del producto, así que
   * cada tecla en el formulario re-renderizaba todas las filas con sus
   * fotos. Ahora la lista solo se recalcula cuando cambian la carta o las
   * categorías; los botones llaman a las acciones a través de un `ref`,
   * así que siempre usan la versión vigente sin romper la memoria.
   */
  const actions = useRef({
    toggle: handleProductToggle,
    edit: openProductModal,
    deleteProduct: setConfirmDeleteProd,
    deleteCategory: setConfirmDeleteCat,
  });
  // Sin dependencias a propósito: el `ref` tiene que apuntar siempre a las
  // funciones del último render, que es justo lo que no puede saber una
  // lista de dependencias de funciones que se recrean en cada render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    actions.current = {
      toggle: handleProductToggle,
      edit: openProductModal,
      deleteProduct: setConfirmDeleteProd,
      deleteCategory: setConfirmDeleteCat,
    };
  });

  const catalogList = useMemo(() => {
    const categoryName = new Map(categories.map((category) => [category._id, category.name]));
    const order = new Map(categories.map((category, index) => [category._id, index]));
    // Si la categoría filtrada ya no existe (se eliminó), se muestra todo.
    const active = filterCategory && categoryName.has(filterCategory) ? filterCategory : null;
    const sorted = products
      .filter((product) => !active || product.categoryId === active)
      .sort((x, y) => (order.get(x.categoryId) ?? 0) - (order.get(y.categoryId) ?? 0));
    return (
      <div className="space-y-6">
        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-main)]">
            <button
              onClick={() => setFilterCategory(null)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors cursor-pointer ${
                active === null
                  ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
                  : 'border-[var(--color-border)] text-[var(--color-text-main)]'
              }`}
            >
              Todas
            </button>
            {categories.map((category) => (
              <span key={category._id} className="inline-flex items-center gap-0.5">
                <button
                  onClick={() => setFilterCategory(category._id)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors cursor-pointer ${
                    active === category._id
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
                      : 'border-[var(--color-border)] text-[var(--color-text-main)]'
                  }`}
                >
                  {category.name}
                </button>
                <button
                  onClick={() => actions.current.deleteCategory(category._id)}
                  title="Eliminar categoría"
                  aria-label={`Eliminar la categoría ${category.name}`}
                  className="p-1 rounded-md text-[var(--color-text-main)] hover:text-[var(--color-danger)] transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {sorted.length === 0 ? (
          <p className="py-10 text-center text-sm font-medium text-[var(--color-text-main)]">
            Aún no hay productos.
          </p>
        ) : (
          <ul className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-10">
            {sorted.map((product) => (
              <li
                key={product._id}
                className="flex items-center gap-4 py-4 border-b border-[var(--color-border)]"
              >
                <SmartImage
                  images={product.images}
                  alt={product.name}
                  base="thumb"
                  sizes="72px"
                  className="w-[72px] h-[72px] rounded-lg shrink-0"
                />

                <div className="flex-1 min-w-0 space-y-1">
                  <h3 className="text-sm font-bold text-[var(--color-text-main)] leading-snug">
                    {product.name}
                  </h3>
                  <p className="text-[11px] font-medium text-[var(--color-text-main)]">
                    {categoryName.get(product.categoryId) ?? 'Sin categoría'}
                    {product.prepTimeMinutes ? ` · ${product.prepTimeMinutes} min` : ''}
                    {product.requiresAgeVerification ? ' · +18' : ''}
                    {!product.images ? ' · Sin foto' : ''}
                  </p>
                  {product.description && (
                    <p className="text-xs leading-snug text-[var(--color-text-main)] line-clamp-2">
                      {product.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-bold">
                    {product.promotedBy && (
                      <a
                        href={`/promotions?productId=${product._id}`}
                        className="text-[var(--color-info)] flex items-center gap-1"
                      >
                        <Tag className="w-3 h-3" />
                        En promoción
                      </a>
                    )}
                    {!product.isAvailable && (
                      <span className="text-[var(--color-danger)]">Agotado</span>
                    )}
                    {/* Solo aparece si el negocio lleva la cuenta.
                        `null` es "no lo cuento" y no se muestra. */}
                    {typeof product.stock === 'number' && (
                      <span
                        className={
                          product.stock === 0
                            ? 'text-[var(--color-danger)]'
                            : product.stock <= (product.lowStockThreshold || 3)
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-text-main)]'
                        }
                      >
                        {product.stock === 0 ? 'Sin unidades' : `Quedan ${product.stock}`}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  {product.discountPrice ? (
                    <>
                      <p className="text-[11px] text-[var(--color-text-main)] line-through tabular">
                        {money(product.price)}
                      </p>
                      <p className="text-base font-bold text-[var(--color-primary)] tabular">
                        {money(product.discountPrice)}
                      </p>
                    </>
                  ) : (
                    <p className="text-base font-bold text-[var(--color-text-main)] tabular">
                      {money(product.price)}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => actions.current.toggle(product)}
                    title={product.isAvailable ? 'Marcar como agotado' : 'Volver a ofrecerlo'}
                    aria-label={`Cambiar disponibilidad de ${product.name}`}
                    className="p-1 cursor-pointer hover:scale-105 transition-transform"
                  >
                    {product.isAvailable ? (
                      <ToggleRight className="w-6 h-6 text-[var(--color-primary)]" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-[var(--color-text-main)]" />
                    )}
                  </button>
                  <button
                    onClick={() => actions.current.edit(product)}
                    aria-label={`Editar ${product.name}`}
                    className="p-2 rounded-md text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-colors cursor-pointer"
                  >
                    <Edit className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => actions.current.deleteProduct(product._id)}
                    aria-label={`Eliminar ${product.name}`}
                    className="p-2 rounded-md text-[var(--color-text-main)] hover:text-[var(--color-danger)] transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }, [categories, products, filterCategory]);

  if (!selectedBusiness) {
    return (
      <div className="py-20 text-center space-y-2">
        <p className="font-bold text-[var(--color-text-main)] text-base">
          Sin establecimiento seleccionado
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Elige un negocio en el menú lateral.
        </p>
      </div>
    );
  }

  const noCategories = categories.length === 0;

  // ── El formulario del producto, derivado de lo escrito ──
  const savedImages = editingProduct?.images ?? null;
  const hasPhoto = Boolean(pendingImage || savedImages);
  const price = Number(productForm.price) > 0 ? Number(productForm.price) : null;
  const rawOffer = Number(productForm.discountPrice);
  /** Solo una oferta que la app aceptaría: positiva y menor que el precio. */
  const offer = price && rawOffer > 0 && rawOffer < price ? rawOffer : null;
  const ownPrepMinutes = Number(productForm.prepTimeMinutes) > 0 ? Number(productForm.prepTimeMinutes) : null;
  const businessPrepMinutes =
    typeof businessSettings?.deliveryTime === 'number' ? businessSettings.deliveryTime : null;
  const photoState: PhotoState = pendingImage
    ? { kind: 'pending', sourcePixels: pendingImage.sourcePixels, removeBackground: pendingImage.removeBackground }
    : savedImages
      ? {
          kind: 'saved',
          width: savedImages.width,
          height: savedImages.height,
          backgroundRemoved: savedImages.backgroundRemoved,
        }
      : { kind: 'none' };
  const checks = productChecks(productForm, photoState, {
    minDimension: capabilities?.minDimension ?? 500,
    recommendedDimension: capabilities?.recommendedDimension ?? 1200,
    canRemoveBackground: Boolean(capabilities?.backgroundRemoval),
  });
  const advancedSummary = describeAdvanced(productForm.extras.length, productForm.modifierGroups.length);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Con el formulario abierto la lista se oculta (no se desmonta) y el
          formulario ocupa el área de contenido, junto a la barra lateral. */}
      <div className={showProductModal ? 'hidden' : 'space-y-6'}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Menú y productos</h1>
          <p className="page-subtitle">
            Platos, disponibilidad, precios y fotos de tu establecimiento
          </p>
        </div>
        <div className="flex items-center justify-center gap-2.5">
          <button
            onClick={() => setShowCategoryModal(true)}
            className="inline-flex items-center gap-1 px-1 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] transition-colors cursor-pointer"
          >
            + Nueva categoría
          </button>
          {/*
            El botón nunca se deshabilita.

            Deshabilitarlo cuando no hay categorías cambiaba un error del
            servidor por un callejón sin salida: el comercio pulsaba y no
            pasaba nada. Ahora pulsar siempre lleva al siguiente paso —
            si falta la categoría, se pide primero y después se abre el
            producto solo.
          */}
          <button
            onClick={startNewProduct}
            className="inline-flex h-11 min-w-48 items-center justify-between gap-8 rounded-[11px] bg-[#ff2851] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#e92147] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff2851] cursor-pointer"
          >
            <span className="inline-flex items-center gap-3">
              <SquarePlus className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
              Nuevo producto
            </span>
            <ChevronDown className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>

      {(error || loadError) && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
          <p className="text-xs font-semibold text-[var(--color-danger)]">{error || loadError}</p>
        </div>
      )}

      {/*
        Sin categorías no hay dónde colgar un producto. El aviso lo explica
        y el botón lleva al mismo sitio que "Nuevo producto": antes, el
        desplegable llegaba vacío y el servidor devolvía un 500 genérico.
      */}
      {!loading && noCategories && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary-bg)] p-3.5">
          <div className="flex-1">
            <p className="text-xs font-bold text-[var(--color-text-main)]">
              Empieza creando una categoría
            </p>
            <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
              Todo producto vive dentro de una categoría — "Hamburguesas",
              "Bebidas", "Postres". Crea la primera y podrás añadir productos.
            </p>
          </div>
          <button
            onClick={startNewProduct}
            className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-[11px] font-bold cursor-pointer shrink-0 hover:bg-[var(--color-primary-dark)] transition-colors"
          >
            Crear categoría
          </button>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center">
          <p className="text-xs font-semibold text-[var(--color-text-secondary)]">
            Cargando catálogo…
          </p>
        </div>
      ) : (
        catalogList
      )}
      </div>

      {confirmDeleteCat && (
        <ConfirmDialog
          title="Eliminar categoría"
          message="¿Confirmas eliminar esta categoría de tu menú?"
          confirmLabel="Eliminar categoría"
          onConfirm={handleDeleteCategory}
          onCancel={() => setConfirmDeleteCat(null)}
          variant="danger"
        />
      )}

      {confirmDeleteProd && (
        <ConfirmDialog
          title="Eliminar producto"
          message="Se eliminará del menú junto con su foto. No se puede deshacer."
          confirmLabel="Eliminar producto"
          onConfirm={handleDeleteProduct}
          onCancel={() => setConfirmDeleteProd(null)}
          variant="danger"
        />
      )}

      {/* ── Categoría ── */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-3">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">
                Nueva categoría
              </h3>
              <button
                onClick={() => {
                  setShowCategoryModal(false);
                  setCategoryLeadsToProduct(false);
                }}
                aria-label="Cerrar"
                className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {categoryLeadsToProduct && (
              <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">
                Todo producto vive dentro de una categoría. Crea la primera
                y seguimos con tu producto.
              </p>
            )}

            <form onSubmit={handleCreateCategory} className="space-y-4">
              <div>
                <label
                  htmlFor="category-name"
                  className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5"
                >
                  Nombre de la categoría
                </label>
                <input
                  id="category-name"
                  type="text"
                  required
                  autoFocus
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  placeholder="Ej.: Bebidas, Entradas, Postres"
                  className={inputClass}
                />
              </div>
              <button
                type="submit"
                className="w-full h-10 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold text-xs uppercase tracking-wider cursor-pointer transition-colors"
              >
                {categoryLeadsToProduct ? 'Crear y seguir con el producto' : 'Crear categoría'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Producto ── */}
      {showProductModal && (
        <form id="product-form" onSubmit={handleSaveProduct} className="animate-fade-in">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] pb-4">
            <div className="min-w-0">
              <nav aria-label="Ruta" className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
                <Link to="/" className="transition-colors hover:text-[var(--color-text-main)]">
                  Inicio
                </Link>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <button
                  type="button"
                  onClick={closeProductForm}
                  className="transition-colors hover:text-[var(--color-text-main)] cursor-pointer"
                >
                  Menú y productos
                </button>
              </nav>
              <h1 className="page-title mt-1">{editingProduct ? 'Editar producto' : 'Nuevo producto'}</h1>
            </div>
            <button
              type="button"
              onClick={closeProductForm}
              aria-label="Cerrar"
              className="p-2 rounded-lg text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/*
            Tres columnas con líneas finas entre ellas y sin tarjetas: foto,
            datos y lo que verá el cliente. Cada columna desplaza por dentro
            y la barra del botón queda siempre a la vista.
          */}
          <div className="cols3 mt-5 [--cols3-offset:20rem] [--cols3-template:minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
            {/* 1 · Foto */}
            <section aria-labelledby="product-photo-title" className="space-y-5">
              <h2 id="product-photo-title" className="col-title">Foto del producto</h2>

              <ProductImageField
                key={photoFieldKey}
                productId={editingProduct?._id ?? null}
                businessId={businessId!}
                images={savedImages}
                imageAsset={editingProduct?.imageAsset ?? null}
                capabilities={capabilities}
                onPendingChange={setPendingImage}
                onUpdated={onProductImageUpdated}
                variant="hero"
              />

              <div className="space-y-2.5 border-t border-[var(--color-border)] pt-4">
                <h3 className="text-sm font-bold text-[var(--color-text-main)]">Recomendaciones</h3>
                <ProductRecommendations checks={checks} />
              </div>

              {/* Solo al editar: una galería sin portada no tiene sentido
                  y el servidor la rechaza. */}
              {editingProduct ? (
                <div className="border-t border-[var(--color-border)] pt-4">
                  <ProductGalleryField
                    productId={editingProduct._id}
                    businessId={businessId!}
                    images={editingProduct.galleryImages ?? []}
                    publicIds={(editingProduct.gallery ?? []).map((g) => g.publicId)}
                    hasCover={Boolean(editingProduct.images)}
                    onUpdated={(updated) => onProductImageUpdated(updated as Product)}
                  />
                </div>
              ) : null}
            </section>

            {/* 2 · Datos */}
            <section aria-label="Datos del producto" className="space-y-6">
              <ProductProgress
                progress={productProgress(productForm, hasPhoto)}
                editing={Boolean(editingProduct)}
              />

              <div className="space-y-3">
                <h2 className="col-title">Información esencial</h2>

                <Field label="Nombre del producto" htmlFor="product-name">
                  <input
                    id="product-name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={100}
                    value={productForm.name}
                    onChange={(event) =>
                      setProductForm({ ...productForm, name: event.target.value })
                    }
                    placeholder="Ej.: Pizza especial"
                    className={inputClass}
                  />
                </Field>

                <Field label="Categoría" htmlFor="product-category">
                  <select
                    id="product-category"
                    required
                    value={productForm.categoryId}
                    onChange={(event) =>
                      setProductForm({ ...productForm, categoryId: event.target.value })
                    }
                    className={`${inputClass} cursor-pointer`}
                  >
                    {categories.map((category) => (
                      <option key={category._id} value={category._id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Descripción breve" htmlFor="product-description">
                  <textarea
                    id="product-description"
                    value={productForm.description}
                    maxLength={300}
                    onChange={(event) =>
                      setProductForm({ ...productForm, description: event.target.value })
                    }
                    placeholder="Detalle del plato o preparación…"
                    className={`${inputClass} h-auto min-h-[72px] py-2.5 resize-none`}
                  />
                </Field>
              </div>

              <div className="space-y-3">
                <h2 className="col-title">Precio y disponibilidad</h2>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Precio de venta regular" htmlFor="product-price">
                    <NumericInput
                      id="product-price"
                      required
                      value={productForm.price}
                      onValueChange={(digits) => setProductForm({ ...productForm, price: digits })}
                      placeholder="25.000"
                      className={`${inputClass} tabular font-bold`}
                    />
                  </Field>

                  <Field
                    label="Precio de oferta (opcional)"
                    htmlFor="product-discount"
                    hint={
                      editingProduct?.promotedBy
                        ? 'Bloqueado: hay una promoción automática vigente sobre este producto. Edítala en Promociones.'
                        : undefined
                    }
                  >
                    <NumericInput
                      id="product-discount"
                      value={productForm.discountPrice}
                      disabled={!!editingProduct?.promotedBy}
                      onValueChange={(digits) => setProductForm({ ...productForm, discountPrice: digits })}
                      placeholder="20.000"
                      className={`${inputClass} tabular font-bold text-[var(--color-primary-dark)] disabled:opacity-50`}
                    />
                  </Field>
                </div>

                <Field
                  label="Tiempo de preparación (opcional)"
                  htmlFor="product-prep-time"
                  hint={`Vacío usa el tiempo general del negocio${
                    businessPrepMinutes ? ` (~${businessPrepMinutes} min)` : ''
                  }.`}
                >
                  <div className="relative">
                    <input
                      id="product-prep-time"
                      type="number"
                      min={1}
                      max={PREP_TIME_MAX}
                      step={1}
                      value={productForm.prepTimeMinutes}
                      onChange={(event) =>
                        setProductForm({ ...productForm, prepTimeMinutes: event.target.value })
                      }
                      placeholder="Ej.: 40"
                      className={`${inputClass} pr-16 tabular font-bold`}
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                      min
                      <Clock className="h-4 w-4" aria-hidden />
                    </span>
                  </div>
                </Field>

                {/* Sin esta casilla el comercio no tenía cómo marcar sus
                    licores: el campo existía en el servidor y solo se podía
                    poner por API, así que la validación de edad nunca se
                    activaba. */}
                <fieldset>
                  <legend className="mb-1.5 text-xs font-semibold text-[var(--color-text-main)]">
                    Restricciones legales
                  </legend>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={productForm.requiresAgeVerification}
                      onChange={(event) =>
                        setProductForm({ ...productForm, requiresAgeVerification: event.target.checked })
                      }
                      className="mt-0.5 accent-[var(--color-primary)]"
                    />
                    <span className="text-xs text-[var(--color-text-main)]">
                      Solo mayores de 18{' '}
                      <span className="text-[var(--color-text-secondary)]">
                        (licor o cigarrillos; se pide la cédula al entregar)
                      </span>
                    </span>
                  </label>
                </fieldset>
              </div>

              <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id="advanced-options-title" className="text-sm font-bold text-[var(--color-text-main)]">
                      Opciones avanzadas
                    </h2>
                    <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                      Adiciones con precio y grupos de opciones para que el cliente elija.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={advancedOpen}
                    aria-labelledby="advanced-options-title"
                    onClick={() => setAdvancedOpen((open) => !open)}
                    className="shrink-0 p-1 cursor-pointer hover:scale-105 transition-transform"
                  >
                    {advancedOpen ? (
                      <ToggleRight className="h-8 w-8 text-[var(--color-primary)]" />
                    ) : (
                      <ToggleLeft className="h-8 w-8 text-[var(--color-text-muted)]" />
                    )}
                  </button>
                </div>

                {advancedOpen ? (
                  <>
                    <div className="space-y-2">
                      <span className="block text-xs font-semibold text-[var(--color-text-main)]">
                        Adiciones y extras
                      </span>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newExtra.name}
                          onChange={(event) => setNewExtra({ ...newExtra, name: event.target.value })}
                          placeholder="Nombre del extra (ej.: queso)"
                          aria-label="Nombre del extra"
                          className={`${inputBase} min-w-0 flex-1 h-9`}
                        />
                        <NumericInput
                          value={newExtra.price}
                          onValueChange={(digits) => setNewExtra({ ...newExtra, price: digits })}
                          placeholder="3.000"
                          aria-label="Precio del extra"
                          className={`${inputBase} w-28 shrink-0 h-9 tabular font-bold text-[var(--color-primary-dark)]`}
                        />
                        <button
                          type="button"
                          onClick={handleAddExtra}
                          aria-label="Añadir extra"
                          className="px-3 h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-bold text-[var(--color-text-main)] cursor-pointer transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>

                      {productForm.extras.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {productForm.extras.map((extra, index) => (
                            <span
                              key={`${extra.name}-${index}`}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-main)]"
                            >
                              {extra.name} (+{money(extra.price)})
                              <button
                                type="button"
                                onClick={() => handleRemoveExtra(index)}
                                aria-label={`Quitar ${extra.name}`}
                                className="text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <ModifierGroupsEditor
                      groups={productForm.modifierGroups}
                      onChange={(modifierGroups) => setProductForm((previous) => ({ ...previous, modifierGroups }))}
                    />
                  </>
                ) : advancedSummary ? (
                  <p className="text-xs text-[var(--color-text-secondary)]">{advancedSummary}</p>
                ) : null}
              </div>
            </section>

            {/* 3 · Lo que verá el cliente */}
            <aside aria-label="Vista previa y resumen" className="space-y-6">
              <div className="space-y-2">
                <h2 className="col-title">Vista previa</h2>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Así lo verá el cliente en la carta de tu negocio.
                </p>
                <ProductPreview
                  name={productForm.name}
                  description={productForm.description}
                  price={price}
                  discountPrice={offer}
                  discountPercent={price ? discountPercent(price, offer) : null}
                  prepMinutes={ownPrepMinutes ?? businessPrepMinutes}
                  imageSrc={pendingImage?.previewUrl ?? savedImages?.catalog ?? null}
                  businessCategory={businessSettings?.category}
                />
              </div>

              <ProductSummary
                name={productForm.name}
                categoryName={categories.find((category) => category._id === productForm.categoryId)?.name ?? ''}
                price={price}
                discountPrice={offer}
                discountPercent={price ? rawDiscountPercent(price, offer) : null}
                ownPrepMinutes={ownPrepMinutes}
                businessPrepMinutes={businessPrepMinutes}
                requiresAgeVerification={productForm.requiresAgeVerification}
                checklist={productChecklist(productForm, hasPhoto)}
                draft={
                  editingProduct
                    ? null
                    : {
                        savedAt: draftSavedAt,
                        restoredFrom: draftRestoredFrom,
                        hasPendingPhoto: Boolean(pendingImage),
                        onDiscard: discardDraft,
                      }
                }
              />
            </aside>
          </div>

          {/* Plana: mismo fondo que la página y una línea fina. El fondo solo
              importa en pantallas angostas, donde la página sí desplaza. */}
          <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] py-3">
            {modalError && (
              <p role="alert" className="max-w-md text-center text-xs font-semibold text-[var(--color-danger)]">
                {modalError}
              </p>
            )}
            <button
              type="submit"
              disabled={saving}
              className="h-11 min-w-56 rounded-lg bg-[var(--color-primary)] px-8 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[var(--color-primary-dark)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
            >
              {saving ? 'Guardando…' : editingProduct ? 'Guardar cambios' : 'Crear producto'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * El campo sin ancho. Va aparte porque `w-full` junto a `w-24` o `flex-1`
 * en la misma clase no se resuelve por orden de escritura: el precio del
 * extra se quedaba con toda la fila y el nombre, aplastado.
 */
const inputBase =
  'h-10 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-3.5 text-sm font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-primary)] transition-colors';

const inputClass = `w-full ${inputBase}`;

/** "Incluye 2 adiciones y 1 grupo de opciones…", o nada si no hay. */
function describeAdvanced(extras: number, groups: number): string | null {
  const parts = [
    extras ? `${extras} ${extras === 1 ? 'adición' : 'adiciones'}` : null,
    groups ? `${groups} ${groups === 1 ? 'grupo de opciones' : 'grupos de opciones'}` : null,
  ].filter(Boolean);
  return parts.length ? `Incluye ${parts.join(' y ')}. Se guardan igual aunque esta sección esté plegada.` : null;
}

function Field({
  label, htmlFor, children, hint, className,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-xs font-semibold text-[var(--color-text-main)]"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-secondary)]">{hint}</p>}
    </div>
  );
}
