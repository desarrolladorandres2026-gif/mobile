import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Edit, Trash2, ToggleLeft, ToggleRight, X, AlertCircle,
  UtensilsCrossed, RefreshCw, Store, Info,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { money } from '../lib/orderFlow';
import ConfirmDialog from '../components/ConfirmDialog';
import SmartImage from '../components/SmartImage';
import type { Product } from '../lib/catalog';
import ProductGalleryField from '../components/ProductGalleryField';
import ProductImageField, {
  type ImageCapabilities, type PendingProductImage,
} from '../components/ProductImageField';
import ModifierGroupsEditor from '../components/ModifierGroupsEditor';
import { toDrafts, fromDrafts, type GroupDraft } from '../lib/modifierGroups';

interface ExtraOption {
  name: string;
  price: number;
}

interface Category {
  _id: string;
  name: string;
}

const EMPTY_FORM = {
  name: '',
  description: '',
  price: '',
  discountPrice: '',
  categoryId: '',
  extras: [] as ExtraOption[],
  modifierGroups: [] as GroupDraft[],
};

export default function Menu() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [capabilities, setCapabilities] = useState<ImageCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productForm, setProductForm] = useState(EMPTY_FORM);
  /** Recorte hecho en el editor que todavía no tiene producto al que ir. */
  const [pendingImage, setPendingImage] = useState<PendingProductImage | null>(null);
  const [saving, setSaving] = useState(false);

  const [newExtra, setNewExtra] = useState({ name: '', price: '' });
  const [confirmDeleteCat, setConfirmDeleteCat] = useState<string | null>(null);
  const [confirmDeleteProd, setConfirmDeleteProd] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!businessId) return;
    try {
      setError('');
      const [resCats, resProds] = await Promise.all([
        api.get(`/categories/business/${businessId}`),
        api.get(`/products/business/${businessId}?includeUnavailable=true`),
      ]);
      setCategories(resCats.data.data);
      setProducts(resProds.data.data);
    } catch (err) {
      setError(apiMessage(err, 'No pudimos cargar la información del menú.'));
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { setLoading(true); fetchData(); }, [fetchData]);

  // Qué sabe hacer este entorno con las imágenes. Se pregunta una vez: sin
  // esto el panel pintaría botones —recorte de fondo, por ejemplo— que el
  // servidor no puede cumplir.
  useEffect(() => {
    api
      .get('/products/image-capabilities')
      .then(({ data }) => setCapabilities(data.data))
      .catch(() => setCapabilities(null));
  }, []);

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
        setEditingProduct(null);
        setPendingImage(null);
        setProductForm({ ...EMPTY_FORM, categoryId: created.data.data._id });
        setShowProductModal(true);
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

  const openProductModal = (product: Product | null = null) => {
    setPendingImage(null);
    setError('');

    if (product) {
      setEditingProduct(product);
      setProductForm({
        name: product.name,
        description: product.description || '',
        price: String(product.price),
        discountPrice: product.discountPrice ? String(product.discountPrice) : '',
        categoryId: product.categoryId,
        extras: product.extras || [],
        modifierGroups: toDrafts(product.modifierGroups),
      });
    } else {
      setEditingProduct(null);
      setProductForm({ ...EMPTY_FORM, categoryId: categories[0]?._id ?? '' });
    }
    setShowProductModal(true);
  };

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

    const price = Number(productForm.price);
    if (!Number.isFinite(price) || price <= 0) {
      setError('Escribe un precio válido.');
      return;
    }

    // Un 0 escrito en el campo es "sin descuento", no un descuento de cero:
    // enviarlo tal cual lo rechaza el validador, que exige un positivo.
    const rawDiscount = Number(productForm.discountPrice);
    const discount =
      productForm.discountPrice.trim() && Number.isFinite(rawDiscount) && rawDiscount > 0
        ? rawDiscount
        : null;

    if (discount !== null && discount >= price) {
      setError('El precio con descuento tiene que ser menor que el precio regular.');
      return;
    }

    const converted = fromDrafts(productForm.modifierGroups);
    if ('error' in converted) {
      setError(converted.error);
      return;
    }

    const payload = {
      businessId,
      categoryId: productForm.categoryId,
      name: productForm.name.trim(),
      description: productForm.description.trim() || undefined,
      price,
      discountPrice: discount,
      extras: productForm.extras,
      modifierGroups: converted.groups,
    };

    setSaving(true);
    setError('');
    try {
      const saved = editingProduct
        ? await api.put(`/products/${editingProduct._id}`, payload)
        : await api.post('/products', payload);

      const productId = saved.data.data._id as string;

      if (pendingImage) {
        try {
          const form = new FormData();
          form.append('businessId', businessId);
          form.append('image', pendingImage.blob, 'producto.jpg');
          if (pendingImage.removeBackground) form.append('removeBackground', 'true');
          await api.post(`/products/${productId}/image`, form);
        } catch (imageError) {
          setError(
            `Guardamos el producto, pero la foto no subió: ${apiMessage(imageError, 'inténtalo de nuevo desde "Editar".')}`
          );
          setPendingImage(null);
          await fetchData();
          setSaving(false);
          return;
        }
      }

      setShowProductModal(false);
      setPendingImage(null);
      await fetchData();
    } catch (err) {
      setError(apiMessage(err, 'No pudimos guardar el producto.'));
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

  if (!selectedBusiness) {
    return (
      <div className="py-20 text-center space-y-2">
        <Store className="w-8 h-8 text-[var(--color-primary)] mx-auto" />
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

  return (
    <div className="space-y-6 animate-fade-in">
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
            className="px-3.5 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-semibold text-[var(--color-text-main)] transition-colors cursor-pointer"
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
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-xs font-bold text-white transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            Nuevo producto
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 text-xs font-semibold text-[var(--color-danger)]">{error}</p>
        </div>
      )}

      {/*
        Sin categorías no hay dónde colgar un producto. El aviso lo explica
        y el botón lleva al mismo sitio que "Nuevo producto": antes, el
        desplegable llegaba vacío y el servidor devolvía un 500 genérico.
      */}
      {!loading && noCategories && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary-bg)] p-3.5">
          <Info className="w-4 h-4 text-[var(--color-primary)] shrink-0 mt-0.5" />
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
          <RefreshCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
          <p className="text-xs font-semibold text-[var(--color-text-secondary)]">
            Cargando catálogo…
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {categories.map((category) => {
            const items = products.filter((product) => product.categoryId === category._id);
            return (
              <section key={category._id} className="table-container">
                <header className="px-5 py-3.5 border-b border-[var(--color-border-light)] bg-[var(--color-bg)] flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <UtensilsCrossed className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
                    <h2 className="text-sm font-bold text-[var(--color-text-main)] truncate">
                      {category.name}
                    </h2>
                    <button
                      onClick={() => setConfirmDeleteCat(category._id)}
                      title="Eliminar categoría"
                      aria-label={`Eliminar la categoría ${category.name}`}
                      className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary)] px-2.5 py-0.5 rounded-md bg-[var(--color-primary-bg)] border border-[var(--color-primary)]/30 shrink-0">
                    {items.length} producto(s)
                  </span>
                </header>

                <ul className="divide-y divide-[var(--color-border-light)]">
                  {items.map((product) => (
                    <li
                      key={product._id}
                      className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-[var(--color-surface-hover)] transition-colors"
                    >
                      {/*
                        Tamaño fijo y cuadrado: es lo que impide que una foto
                        enorme rompa la fila, y el hueco está reservado antes
                        de que la imagen llegue.
                      */}
                      <SmartImage
                        images={product.images}
                        alt={product.name}
                        base="thumb"
                        sizes="56px"
                        className="w-14 h-14 rounded-xl shrink-0"
                      />

                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <h3 className="text-sm font-bold text-[var(--color-text-main)]">
                            {product.name}
                          </h3>
                          {!product.isAvailable && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-danger-bg)] text-[var(--color-danger)] border border-[var(--color-danger)]/30">
                              Agotado
                            </span>
                          )}
                          {!product.images && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[var(--color-warning-bg)] text-[var(--color-warning)] border border-[var(--color-warning)]/30">
                              Sin foto
                            </span>
                          )}
                          {/* Solo aparece si el negocio lleva la cuenta.
                              `null` es "no lo cuento" y no se muestra. */}
                          {typeof product.stock === 'number' && (
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                                product.stock === 0
                                  ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger)]/30'
                                  : product.stock <= (product.lowStockThreshold || 3)
                                    ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning)]/30'
                                    : 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)] border-[var(--color-border)]'
                              }`}
                            >
                              {product.stock === 0 ? 'Sin unidades' : `Quedan ${product.stock}`}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--color-text-secondary)] truncate">
                          {product.description || 'Sin descripción'}
                        </p>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-5 w-full sm:w-auto shrink-0">
                        <div className="text-left sm:text-right">
                          {product.discountPrice ? (
                            <>
                              <p className="text-[10px] text-[var(--color-text-muted)] line-through tabular">
                                {money(product.price)}
                              </p>
                              <p className="kpi-value text-sm text-[var(--color-primary)] tabular">
                                {money(product.discountPrice)}
                              </p>
                            </>
                          ) : (
                            <p className="kpi-value text-sm tabular">{money(product.price)}</p>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleProductToggle(product)}
                            title={product.isAvailable ? 'Marcar como agotado' : 'Volver a ofrecerlo'}
                            aria-label={`Cambiar disponibilidad de ${product.name}`}
                            className="cursor-pointer hover:scale-105 transition-transform"
                          >
                            {product.isAvailable ? (
                              <ToggleRight className="w-7 h-7 text-[var(--color-primary)]" />
                            ) : (
                              <ToggleLeft className="w-7 h-7 text-[var(--color-text-muted)]" />
                            )}
                          </button>
                          <button
                            onClick={() => openProductModal(product)}
                            aria-label={`Editar ${product.name}`}
                            className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors cursor-pointer"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteProd(product._id)}
                            aria-label={`Eliminar ${product.name}`}
                            className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}

                  {items.length === 0 && (
                    <li className="p-6 text-center text-xs font-medium text-[var(--color-text-muted)]">
                      No hay productos en esta categoría.
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}

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
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4 animate-fade-in">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-3">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">
                {editingProduct ? 'Editar producto' : 'Nuevo producto'}
              </h3>
              <button
                onClick={() => setShowProductModal(false)}
                aria-label="Cerrar"
                className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-4">
              <ProductImageField
                productId={editingProduct?._id ?? null}
                businessId={businessId!}
                images={editingProduct?.images ?? null}
                capabilities={capabilities}
                onPendingChange={setPendingImage}
                onUpdated={onProductImageUpdated}
              />

              {/* Solo al editar: una galería sin portada no tiene sentido
                  y el servidor la rechaza. */}
              {editingProduct ? (
                <ProductGalleryField
                  productId={editingProduct._id}
                  businessId={businessId!}
                  images={editingProduct.galleryImages ?? []}
                  publicIds={(editingProduct.gallery ?? []).map((g) => g.publicId)}
                  hasCover={Boolean(editingProduct.images)}
                  onUpdated={(updated) => onProductImageUpdated(updated as Product)}
                />
              ) : null}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 border-t border-[var(--color-border-light)] pt-4">
                <Field label="Nombre" htmlFor="product-name">
                  <input
                    id="product-name"
                    type="text"
                    required
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
              </div>

              <Field label="Descripción" htmlFor="product-description">
                <textarea
                  id="product-description"
                  value={productForm.description}
                  maxLength={300}
                  onChange={(event) =>
                    setProductForm({ ...productForm, description: event.target.value })
                  }
                  placeholder="Detalle del plato o preparación…"
                  className={`${inputClass} h-auto min-h-[60px] py-2.5 resize-y`}
                />
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <Field label="Precio regular" htmlFor="product-price">
                  <input
                    id="product-price"
                    type="number"
                    required
                    min={1}
                    step={1}
                    value={productForm.price}
                    onChange={(event) =>
                      setProductForm({ ...productForm, price: event.target.value })
                    }
                    placeholder="25000"
                    className={`${inputClass} tabular font-bold`}
                  />
                </Field>

                <Field label="Precio con descuento (opcional)" htmlFor="product-discount">
                  <input
                    id="product-discount"
                    type="number"
                    min={1}
                    step={1}
                    value={productForm.discountPrice}
                    onChange={(event) =>
                      setProductForm({ ...productForm, discountPrice: event.target.value })
                    }
                    placeholder="20000"
                    className={`${inputClass} tabular font-bold text-[var(--color-primary)]`}
                  />
                </Field>
              </div>

              <div className="border-t border-[var(--color-border-light)] pt-4 space-y-2">
                <span className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  Adiciones y extras
                </span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newExtra.name}
                    onChange={(event) => setNewExtra({ ...newExtra, name: event.target.value })}
                    placeholder="Nombre del extra (ej.: queso)"
                    aria-label="Nombre del extra"
                    className={`${inputClass} flex-1 h-9`}
                  />
                  <input
                    type="number"
                    min={0}
                    value={newExtra.price}
                    onChange={(event) => setNewExtra({ ...newExtra, price: event.target.value })}
                    placeholder="3000"
                    aria-label="Precio del extra"
                    className={`${inputClass} w-24 h-9 tabular font-bold text-[var(--color-primary)]`}
                  />
                  <button
                    type="button"
                    onClick={handleAddExtra}
                    aria-label="Añadir extra"
                    className="px-3 h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] text-xs font-bold text-[var(--color-text-main)] cursor-pointer transition-colors"
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
                          className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
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

              <button
                type="submit"
                disabled={saving}
                className="w-full h-11 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold text-xs uppercase tracking-wider cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {saving
                  ? 'Guardando…'
                  : editingProduct
                    ? 'Guardar cambios'
                    : 'Crear producto'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const inputClass =
  'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-semibold text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-primary)] transition-colors';

function Field({
  label, htmlFor, children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
