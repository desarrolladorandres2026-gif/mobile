import { View, Pressable, StyleSheet } from 'react-native';
import { Text, Icon, Sheet, Button, Chip } from '../ui';
import type { SearchSort } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * Los filtros de la búsqueda.
 *
 * Solo hay campos que existen de verdad en el catálogo —calificación,
 * minutos de entrega, horario y distancia—. Nada de "envío gratis" ni
 * "promociones" mientras no haya un dato detrás: un filtro que no filtra
 * es peor que no tenerlo, porque el usuario cree haber acotado y no acotó.
 */
export interface SearchFilters {
  sort: SearchSort;
  openOnly: boolean;
  /** Cero significa sin mínimo, no "calificación cero". */
  minRating: number;
  /** Cero significa sin tope, en minutos. */
  maxDeliveryTime: number;
}

export const NO_FILTERS: SearchFilters = {
  sort: 'relevance',
  openOnly: false,
  minRating: 0,
  maxDeliveryTime: 0,
};

/** Cuántos filtros hay puestos, para decirlo sobre el botón del embudo. */
export function countActiveFilters(f: SearchFilters): number {
  return (
    (f.sort !== 'relevance' ? 1 : 0) +
    (f.openOnly ? 1 : 0) +
    (f.minRating > 0 ? 1 : 0) +
    (f.maxDeliveryTime > 0 ? 1 : 0)
  );
}

const SORTS: { key: SearchSort; label: string; icon: 'destello' | 'navegar' | 'calificacion' | 'minutos' }[] = [
  { key: 'relevance', label: 'Más relevante', icon: 'destello' },
  { key: 'distance', label: 'Más cerca', icon: 'navegar' },
  { key: 'rating', label: 'Mejor calificado', icon: 'calificacion' },
  { key: 'deliveryTime', label: 'Llega antes', icon: 'minutos' },
];

const RATINGS = [
  { value: 0, label: 'Cualquiera' },
  { value: 3.5, label: '3.5+' },
  { value: 4, label: '4+' },
  { value: 4.5, label: '4.5+' },
];

const TIMES = [
  { value: 0, label: 'Sin tope' },
  { value: 20, label: '20 min' },
  { value: 30, label: '30 min' },
  { value: 45, label: '45 min' },
];

/**
 * Qué está filtrado ahora mismo, en palabras, y cómo se quita cada cosa.
 *
 * Vive aquí y no en la pantalla porque las etiquetas ya están escritas arriba
 * —"Más cerca", "4.5+", "30 min"— y tenerlas dos veces es garantizar que un
 * día digan cosas distintas. Antes el resumen era un solo "2 filtros" que no
 * decía cuáles y solo sabía borrarlos todos.
 */
export function describeFilters(f: SearchFilters): { key: string; label: string; patch: Partial<SearchFilters> }[] {
  const rows: { key: string; label: string; patch: Partial<SearchFilters> }[] = [];

  if (f.sort !== 'relevance') {
    const sort = SORTS.find((option) => option.key === f.sort);
    if (sort) rows.push({ key: 'sort', label: sort.label, patch: { sort: 'relevance' } });
  }
  if (f.openOnly) {
    rows.push({ key: 'openOnly', label: 'Abiertos ahora', patch: { openOnly: false } });
  }
  if (f.minRating > 0) {
    rows.push({ key: 'minRating', label: `${f.minRating}+`, patch: { minRating: 0 } });
  }
  if (f.maxDeliveryTime > 0) {
    rows.push({
      key: 'maxDeliveryTime',
      label: `Hasta ${f.maxDeliveryTime} min`,
      patch: { maxDeliveryTime: 0 },
    });
  }

  return rows;
}

export function SearchFiltersSheet({
  visible,
  onClose,
  filters,
  onChange,
  resultCount,
  hasAddress,
  onNeedAddress,
}: {
  visible: boolean;
  onClose: () => void;
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  resultCount: number;
  /** Sin dirección de entrega no hay desde dónde medir la cercanía. */
  hasAddress: boolean;
  onNeedAddress: () => void;
}) {
  const { c } = useTheme();
  const active = countActiveFilters(filters);

  const set = (patch: Partial<SearchFilters>) => {
    tap('select');
    onChange({ ...filters, ...patch });
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Filtros"
      height={0.75}
      footer={
        <View style={styles.footer}>
          {active > 0 ? (
            <Button
              title="Limpiar"
              variant="ghost"
              onPress={() => { tap('light'); onChange(NO_FILTERS); }}
            />
          ) : null}
          <Button
            title={`Ver ${resultCount} ${resultCount === 1 ? 'resultado' : 'resultados'}`}
            onPress={onClose}
            full={active === 0}
            style={active > 0 ? styles.flex : undefined}
          />
        </View>
      }
    >
      <View style={styles.body}>
        {/* ── Orden ── */}
        <View style={styles.group}>
          <Text v="strongS">Ordenar por</Text>
          <View style={styles.rows}>
            {SORTS.map((option) => {
              const selected = filters.sort === option.key;
              // "Más cerca" sin dirección no se apaga: se encadena al paso
              // que falta. Un botón gris es un callejón sin salida más
              // silencioso que un error.
              const needsAddress = option.key === 'distance' && !hasAddress;

              return (
                <Pressable
                  key={option.key}
                  onPress={() => {
                    if (needsAddress) { tap('light'); onNeedAddress(); return; }
                    set({ sort: option.key });
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={
                    needsAddress ? `${option.label}. Necesita una dirección de entrega` : option.label
                  }
                  style={[
                    styles.row,
                    {
                      backgroundColor: selected ? c.primarySoft : c.surface,
                      borderColor: selected ? c.primary : c.border,
                    },
                  ]}
                >
                  <Icon
                    name={option.icon}
                    size="sm"
                    color={selected ? c.primaryText : c.textMuted}
                  />
                  <View style={styles.flex}>
                    <Text v="bodyM" color={selected ? c.primaryText : undefined}>
                      {option.label}
                    </Text>
                    {needsAddress ? (
                      <Text v="caption" tone="textMuted">
                        Agrega una dirección para medir la distancia
                      </Text>
                    ) : null}
                  </View>
                  {selected ? <Icon name="check" size="sm" color={c.primaryText} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Horario ── */}
        <View style={styles.group}>
          <Text v="strongS">Disponibilidad</Text>
          <Pressable
            onPress={() => set({ openOnly: !filters.openOnly })}
            accessibilityRole="switch"
            accessibilityState={{ checked: filters.openOnly }}
            accessibilityLabel="Solo negocios abiertos ahora"
            style={[
              styles.row,
              {
                backgroundColor: filters.openOnly ? c.primarySoft : c.surface,
                borderColor: filters.openOnly ? c.primary : c.border,
              },
            ]}
          >
            <Icon
              name="reloj"
              size="sm"
              color={filters.openOnly ? c.primaryText : c.textMuted}
            />
            <View style={styles.flex}>
              <Text v="bodyM" color={filters.openOnly ? c.primaryText : undefined}>
                Solo abiertos ahora
              </Text>
              <Text v="caption" tone="textMuted">
                Esconde los que no pueden recibir el pedido todavía
              </Text>
            </View>
            {filters.openOnly ? <Icon name="check" size="sm" color={c.primaryText} /> : null}
          </Pressable>
        </View>

        {/* ── Calificación ── */}
        <View style={styles.group}>
          <Text v="strongS">Calificación mínima</Text>
          <View style={styles.chips}>
            {RATINGS.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                active={filters.minRating === option.value}
                onPress={() => set({ minRating: option.value })}
              />
            ))}
          </View>
        </View>

        {/* ── Tiempo ── */}
        <View style={styles.group}>
          <Text v="strongS">Tiempo de entrega</Text>
          <View style={styles.chips}>
            {TIMES.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                active={filters.maxDeliveryTime === option.value}
                onPress={() => set({ maxDeliveryTime: option.value })}
              />
            ))}
          </View>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.xl, paddingBottom: Spacing.lg },
  group: { gap: Spacing.md },
  rows: { gap: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  footer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  flex: { flex: 1 },
});
