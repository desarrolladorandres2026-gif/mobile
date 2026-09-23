import { useCallback, useMemo, useState } from 'react';
import { View, Pressable, ScrollView, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Text, EmptyState, ErrorState, CouponCardSkeleton, Skeleton,
} from '../../../components/ui';
import { PromoCarousel } from '../../../components/domain/PromoCarousel';
import { TicketCard } from '../../../components/domain/TicketCard';
import { OfferTile } from '../../../components/domain/OfferTile';
import { OfferBusinessRow } from '../../../components/domain/OfferBusinessRow';
import { OffersHero } from '../../../components/domain/OffersHero';
import { CouponSheet } from '../../../components/domain/CouponSheet';
import { useOffers, useDeliveryCoords, useCouponEligibility, useProStatus } from '../../../hooks/useApi';
import type { OfferBusiness, OfferCoupon, ProductSearchHit } from '../../../services/endpoints';
import { useAuthStore } from '../../../stores/authStore';
import { useCouponStore } from '../../../stores/couponStore';
import {
  pickSpotlightCoupon, isExpiringSoon, bigDiscountProducts, splitBusinessOffers,
  couponStatus, indexEligibility, isUsable, scheduledCoupons, windowLabel,
  withoutRedundantFreeDelivery, type CouponStatus,
} from '../../../lib/offers';
import { tap } from '../../../lib/haptics';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { Spacing } from '../../../theme/tokens';

/**
 * Todo lo que está en oferta, en un solo scroll.
 *
 * El rediseño parte de un diagnóstico simple: la pantalla se llama
 * Descuentos y el dato que alguien viene a buscar —cuánto ahorra— se
 * pintaba al mismo tamaño que el título del cupón, dentro de una tarjeta
 * idéntica a la del plato, a la del negocio y a la del saldo. Seis
 * secciones con la misma silueta sobre el mismo gris.
 *
 * Ahora cada cosa tiene su forma: el cupón es un tiquete con muescas, el
 * plato una baldosa con la etiqueta de precio montada encima, el negocio
 * una fila sin marco. Y la magnitud manda —"25%" a 32px— porque es la única
 * pregunta que esta pestaña tiene que contestar antes de que alguien
 * decida si sigue leyendo.
 */
export default function OffersScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);

  // La distancia se mide desde la dirección de entrega, no desde el GPS,
  // igual que en el inicio: es donde el pedido va a llegar.
  const { coords, ready: coordsReady } = useDeliveryCoords();
  const { data, isLoading: loadingOffers, isError, refetch, isRefetching } = useOffers(coords, coordsReady);
  // Mientras llegan las direcciones la consulta espera: eso también es "cargando".
  const isLoading = loadingOffers || !coordsReady;

  // La mitad personal del cupón. Va por separado porque `/offers` se sirve
  // desde una caché que comparte todo el barrio y no puede saber si tú ya
  // gastaste alguno; quien no ha entrado no tiene nada que preguntar.
  const isAuthenticated = useAuthStore((s) => !!s.user);
  const { data: eligibilityRows } = useCouponEligibility(isAuthenticated);
  const eligibility = useMemo(() => indexEligibility(eligibilityRows), [eligibilityRows]);

  const saveCoupon = useCouponStore((s) => s.save);
  const savedCode = useCouponStore((s) => s.code);
  const clearCoupon = useCouponStore((s) => s.clear);

  // A un socio Pro con envío gratis no se le ofrecen cupones de envío gratis:
  // no le ahorran nada.
  const { data: pro } = useProStatus(isAuthenticated);
  const proFreeDelivery = !!pro?.member && !!pro.plan.benefits.freeDelivery.enabled;

  const [sheetCoupon, setSheetCoupon] = useState<OfferCoupon | null>(null);

  const allCoupons = data?.coupons;
  const coupons = useMemo(
    () => withoutRedundantFreeDelivery(allCoupons ?? [], proFreeDelivery),
    [allCoupons, proFreeDelivery]
  );
  const products = data?.products ?? [];
  const businesses = data?.businesses ?? [];
  const isEmpty = !coupons.length && !products.length && !businesses.length;
  // `useCallback` para que el `memo` de las tarjetas sirva de algo: sin
  // esto la funcion se recreaba en cada render y todas las filas se
  // volvian a renderizar.
  const openBusiness = useCallback(
    (id: string) => router.push(`/(client)/business/${id}`),
    [router]
  );

  // Un plato rebajado abre el plato, no la puerta del negocio. La ficha ya
  // sabía recibir `?productId=` desde la tira del Inicio; llegar al menú y
  // tener que buscar a mano el plato que acababas de ver era pedirle al
  // cliente que repitiera el trabajo.
  const openProduct = useCallback(
    (product: ProductSearchHit) =>
      router.push(`/(client)/business/${product.businessId}?productId=${product._id}`),
    [router]
  );

  const statusOf = useCallback(
    (coupon: OfferCoupon): CouponStatus => couponStatus(coupon, eligibility),
    [eligibility]
  );

  /**
   * Guardar el cupón y llevar a donde se pueda gastar.
   *
   * El código queda esperando en el checkout, pero **el descuento lo sigue
   * decidiendo la cotización**: esto no promete dinero, solo evita tener
   * que acordarse de ocho caracteres entre una pantalla y otra.
   */
  const useCoupon = useCallback(
    (coupon: OfferCoupon) => {
      saveCoupon(coupon.code, coupon.businessId ?? null);
      setSheetCoupon(null);
      if (coupon.businessId) router.push(`/(client)/business/${coupon.businessId}`);
      else router.push('/(client)/(tabs)/search');
    },
    [router, saveCoupon]
  );

  /** Refresca todo lo que se ve, no solo el feed. */
  const refreshAll = useCallback(() => {
    // Antes el gesto solo tocaba `['offers']`, así que los banners y el
    // estado personal de los cupones (`['coupons', 'eligibility']`, que
    // decide "ya lo usaste") seguían mostrando la respuesta vieja después de
    // un tirón hacia abajo — justo el gesto con el que se pide lo contrario.
    queryClient.invalidateQueries({ queryKey: ['banners'] });
    queryClient.invalidateQueries({ queryKey: ['coupons'] });
    refetch();
  }, [queryClient, refetch]);

  // El cupón de la franja no vuelve a aparecer abajo — repetirlo se
  // sentiría como un error, no como énfasis. Y solo puede destacarse uno
  // que de verdad se pueda usar: poner arriba, sobre obsidiana, algo que ya
  // gastaste es prometer y retirar.
  const usableCoupons = useMemo(
    () => coupons.filter((cp) => isUsable(statusOf(cp))),
    [coupons, statusOf]
  );
  const heroCoupon = useMemo(() => pickSpotlightCoupon(usableCoupons), [usableCoupons]);

  // Los de franja horaria tienen su propio sitio: son la promesa de "vuelve
  // a esta hora", que se pierde mezclada entre cupones sin horario.
  const timed = useMemo(() => scheduledCoupons(coupons), [coupons]);
  const timedIds = useMemo(() => new Set(timed.map((cp) => cp._id)), [timed]);

  const restCoupons = useMemo(
    () => coupons.filter((cp) => cp._id !== heroCoupon?._id && !timedIds.has(cp._id)),
    [coupons, heroCoupon, timedIds]
  );

  const expiringCoupons = useMemo(() => restCoupons.filter(isExpiringSoon), [restCoupons]);
  const remainingCoupons = useMemo(
    () => restCoupons.filter((cp) => !expiringCoupons.some((e) => e._id === cp._id)),
    [restCoupons, expiringCoupons]
  );

  // Mismo criterio con los platos: los de mayor rebaja se adelantan a "Se
  // acaban hoy" y no se repiten después en "Platos rebajados".
  const urgentProducts = useMemo(() => bigDiscountProducts(products), [products]);
  const urgentProductIds = useMemo(
    () => new Set(urgentProducts.map((p) => p._id)),
    [urgentProducts]
  );
  const remainingProducts = useMemo(
    () => products.filter((p) => !urgentProductIds.has(p._id)),
    [products, urgentProductIds]
  );

  const urgentItems = useMemo(
    () => [
      ...expiringCoupons.map((item) => ({ kind: 'coupon' as const, item })),
      ...urgentProducts.map((item) => ({ kind: 'product' as const, item })),
    ],
    [expiringCoupons, urgentProducts]
  );

  /**
   * El horario que anuncia la sección de Horas Zipp.
   *
   * Solo se escribe cuando todos los cupones comparten la misma franja. Con
   * dos horarios distintos, poner el del primero sería anunciar una hora
   * que la mitad de las tarjetas no cumple.
   */
  const timedLabel = useMemo(() => {
    const labels = new Set(timed.map((cp) => windowLabel(cp.availability?.window)));
    return labels.size === 1 ? [...labels][0] : '';
  }, [timed]);

  // Envío gratis y descuento en la carta son promesas distintas: juntarlas
  // bajo un solo título obligaba a leer cada tarjeta para saber cuál era.
  const { freeDelivery, discounted } = useMemo(
    () => splitBusinessOffers(businesses),
    [businesses]
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomSpace }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refreshAll}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        }
      >
        <OffersHero
          coupon={heroCoupon}
          status={heroCoupon ? statusOf(heroCoupon) : undefined}
          topInset={insets.top}
          onPressCoupon={heroCoupon ? () => setSheetCoupon(heroCoupon) : undefined}
          onExpire={refetch}
        />

        {/* El cupón que espera en el pago. Solo hay uno: sin esta línea
            nada decía qué se llevaba, ni cómo soltarlo. */}
        {savedCode ? (
          <View style={styles.carrying}>
            <Text v="bodyS" tone="textSecondary" style={styles.flex}>
              {`Llevas ${savedCode} al pago`}
            </Text>
            <Pressable
              onPress={() => { tap('light'); clearCoupon(); }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={`Quitar el cupón ${savedCode}`}
            >
              <Text v="strongS" tone="primaryText">Quitar</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Se dibuja solo si el servidor mandó banners vigentes para esta
            pantalla; si no, la sección siguiente sube y no queda hueco. */}
        <PromoCarousel placement="offers" />

        {isError ? (
          <Section>
            <View style={styles.padded}>
              <ErrorState onRetry={refetch} />
            </View>
          </Section>
        ) : isLoading ? (
          <Loading />
        ) : (
          <>
            {isEmpty ? (
              <Section>
                <View style={styles.padded}>
                  <EmptyState
                    icon="descuento"
                    title="Sin descuentos por ahora"
                    message="Cuando haya cupones, platos rebajados o negocios en oferta cerca de ti, van a aparecer aquí."
                  />
                </View>
              </Section>
            ) : (
              <>
                {timed.length > 0 ? (
                  <Section>
                    <Heading title="Horas Zipp" note={timedLabel} />
                    <Rail
                      data={timed}
                      keyOf={(item) => item._id}
                      render={(item) => (
                        <TicketCard
                          coupon={item}
                          notchColor={c.background}
                          status={statusOf(item)}
                          onPress={() => setSheetCoupon(item)}
                        />
                      )}
                    />
                  </Section>
                ) : null}

                {urgentItems.length > 0 ? (
                  <Section>
                    <Heading title="Se acaban hoy" />
                    <UrgentRail
                      data={urgentItems}
                      keyOf={(row) => `${row.kind}-${row.item._id}`}
                      render={(row) =>
                        row.kind === 'coupon' ? (
                          <TicketCard
                            coupon={row.item}
                            notchColor={c.background}
                            status={statusOf(row.item)}
                            onExpire={refetch}
                            onPress={() => setSheetCoupon(row.item)}
                          />
                        ) : (
                          <OfferTile product={row.item} onPress={() => openProduct(row.item)} />
                        )
                      }
                    />
                  </Section>
                ) : null}

                {remainingCoupons.length > 0 ? (
                  <Section>
                    <Heading
                      title="Cupones"
                      action="Ver todo"
                      onAction={() => router.push('/(client)/offers-all?kind=coupons')}
                    />
                    <Rail
                      data={remainingCoupons}
                      keyOf={(item) => item._id}
                      render={(item) => (
                        <TicketCard
                          coupon={item}
                          notchColor={c.background}
                          status={statusOf(item)}
                          // Faltaba aquí: un cupón que vencía en este riel
                          // se quedaba en pantalla hasta el siguiente
                          // refresco, a diferencia de los otros dos.
                          onExpire={refetch}
                          onPress={() => setSheetCoupon(item)}
                        />
                      )}
                    />
                  </Section>
                ) : null}

                {remainingProducts.length > 0 ? (
                  <Section>
                    <Heading
                      title="Platos rebajados"
                      action="Ver todo"
                      onAction={() => router.push('/(client)/offers-all?kind=products')}
                    />
                    <Rail
                      data={remainingProducts}
                      keyOf={(item: ProductSearchHit) => item._id}
                      render={(item) => (
                        <OfferTile product={item} onPress={() => openProduct(item)} />
                      )}
                    />
                  </Section>
                ) : null}

                {freeDelivery.length > 0 ? (
                  <Section>
                    <Heading title="Envío gratis" />
                    <View style={styles.rows}>
                      {freeDelivery.map((item: OfferBusiness) => (
                        <OfferBusinessRow key={item._id} business={item} onPress={openBusiness} />
                      ))}
                    </View>
                  </Section>
                ) : null}

                {discounted.length > 0 ? (
                  <Section>
                    <Heading
                      title="Negocios en oferta"
                      action="Ver todo"
                      onAction={() => router.push('/(client)/offers-all?kind=businesses')}
                    />
                    <View style={styles.rows}>
                      {discounted.map((item: OfferBusiness) => (
                        <OfferBusinessRow key={item._id} business={item} onPress={openBusiness} />
                      ))}
                    </View>
                  </Section>
                ) : null}
              </>
            )}

          </>
        )}
      </ScrollView>

      <CouponSheet
        coupon={sheetCoupon}
        status={sheetCoupon ? statusOf(sheetCoupon) : { kind: 'active' }}
        visible={!!sheetCoupon}
        onClose={() => setSheetCoupon(null)}
        onUse={useCoupon}
      />
    </View>
  );
}

// ── Piezas de la propia pantalla ──

function Section({ children }: { children: React.ReactNode }) {
  return <View style={styles.section}>{children}</View>;
}

/**
 * El encabezado de una sección.
 *
 * Antes cada uno llevaba título, subtítulo explicativo y a veces una
 * acción: tres líneas de chrome repetidas seis veces, contando cosas que
 * las propias tarjetas ya dicen ("Del mejor descuento al más pequeño" sobre
 * una fila ordenada por descuento). Queda el nombre, y a la derecha o bien
 * un dato real —el horario de la franja— o bien la salida a la lista larga.
 */
function Heading({
  title, note, action, onAction,
}: { title: string; note?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.heading}>
      <Text v="titleL">{title}</Text>
      {note ? (
        <Text v="bodyS" tone="textMuted">{note}</Text>
      ) : action && onAction ? (
        <Pressable onPress={() => { tap('light'); onAction(); }} hitSlop={12} accessibilityRole="button">
          <Text v="strongS" tone="primaryText">{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Un riel horizontal. Todos comparten separación y sangrado. */
function Rail<T>({
  data, keyOf, render,
}: { data: T[]; keyOf: (item: T) => string; render: (item: T) => React.ReactElement }) {
  return (
    <FlatList
      horizontal
      data={data}
      keyExtractor={keyOf}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rail}
      removeClippedSubviews
      renderItem={({ item }) => render(item)}
    />
  );
}

/**
 * El riel de "Se acaban hoy": desparramado, no alineado.
 *
 * Es la única fila de la app que rota y desplaza sus tarjetas en zigzag —
 * en ningún otro riel (Inicio, Explorar, el resto de Descuentos) pasa esto.
 * La irregularidad es la seña de "esto no va a esperar a que lo ordenes",
 * algo que un riel prolijo no puede decir por sí solo. `removeClippedSubviews`
 * va apagado: con transform, la virtualización recorta tarjetas que sí están
 * a la vista.
 */
function UrgentRail<T>({
  data, keyOf, render,
}: { data: T[]; keyOf: (item: T) => string; render: (item: T) => React.ReactElement }) {
  return (
    <FlatList
      horizontal
      data={data}
      keyExtractor={keyOf}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.urgentRail}
      removeClippedSubviews={false}
      renderItem={({ item, index }) => (
        <View style={index % 2 === 0 ? styles.urgentEven : styles.urgentOdd}>
          {render(item)}
        </View>
      )}
    />
  );
}

/**
 * La carga, con la silueta de lo que viene.
 *
 * Antes eran tres fantasmas de tarjeta de negocio en vertical para un feed
 * que empieza con tiquetes en horizontal: al llegar los datos la pantalla
 * entera se reorganizaba.
 */
function Loading() {
  return (
    <>
      <View style={[styles.section, styles.padded]}>
        <Skeleton width="40%" height={22} />
      </View>
      <FlatList
        horizontal
        data={[0, 1, 2]}
        keyExtractor={(n) => String(n)}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
        renderItem={() => <CouponCardSkeleton width={244} />}
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },

  flex: { flex: 1 },
  carrying: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.md,
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },

  // Sin padding horizontal: si la sección lo llevara, el riel no podría
  // sangrar hasta el borde y las tarjetas se cortarían antes de tiempo.
  // Lo pone cada pieza: el encabezado, las filas y el propio riel.
  section: { marginTop: Spacing.xxxl },
  padded: { paddingHorizontal: Spacing.xl },
  heading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },
  rail: { gap: Spacing.md, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm },
  rows: { gap: Spacing.xs, paddingHorizontal: Spacing.xl },

  // Espacio extra arriba/abajo para que la rotación no corte contra el
  // borde del riel; el gap sube porque el giro ya acerca visualmente las
  // tarjetas más que en un riel plano.
  urgentRail: { gap: Spacing.lg, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg },
  urgentEven: { transform: [{ rotate: '-3deg' }, { translateY: -6 }] },
  urgentOdd: { transform: [{ rotate: '3deg' }, { translateY: 6 }] },
});
