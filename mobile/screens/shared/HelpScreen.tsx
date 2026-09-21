import { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, Layout } from 'react-native-reanimated';
import { Text, Icon, Button, Screen, Header } from '../../components/ui';
import { ContentIcon } from '../../components/illustrations';
import { useActiveOrder } from '../../hooks/useRealtime';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing, FontSize } from '../../theme/tokens';
import { orderCode } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../../constants/config';
import { IS_DRIVER_APP } from '../../constants/variant';
import { ROUTES } from '../../lib/routing';

interface Faq {
  question: string;
  answer: string;
}

/**
 * Las preguntas que de verdad llegan a soporte, contestadas aquí.
 *
 * Cada respuesta describe lo que la app hace hoy, no lo que nos gustaría que
 * hiciera: una sección de ayuda que promete algo que el código no cumple
 * genera más tickets de los que evita.
 *
 * Esta pantalla la comparten cliente y domiciliario —el enlace desde el
 * perfil del domiciliario ya apuntaba aquí antes de esta sesión—, y las
 * diez preguntas estaban escritas enteras desde el lado de quien paga: "la
 * propina le llega completa al domiciliario" hablando DE él, nunca A él.
 * Un domiciliario que entrara aquí veía las respuestas de otra persona.
 */
const CLIENT_FAQS: Faq[] = [
  {
    question: '¿Cómo puedo pagar?',
    answer:
      'En línea con tarjeta, o en efectivo al recibir. El efectivo tiene un tope por pedido, y si tu carrito lo pasa te lo decimos en el checkout antes de confirmar, no después.',
  },
  {
    question: '¿Puedo cancelar un pedido?',
    answer:
      'Sí. Mientras el local no haya empezado a prepararlo, lo cancelas tú desde la pantalla del pedido y no te cuesta nada. Si ya está en la cocina, el botón te lleva a hablar con nosotros: a esas alturas alguien ya puso comida y trabajo, y preferimos mirarlo caso por caso antes que dejar que lo pague quien no debe.',
  },
  {
    question: 'Ya pagué en línea y se canceló. ¿Y mi plata?',
    answer:
      'La devolución sale automáticamente, sin que tengas que pedirla. Llega a la misma tarjeta con la que pagaste y se demora unos días hábiles, según tu banco.',
  },
  {
    question: '¿Para qué es el código que me piden en la puerta?',
    answer:
      'Es la forma de saber que el pedido llegó a quien tenía que llegar. Se lo dices al domiciliario cuando te entrega, y solo entonces el pedido queda cerrado. No lo compartas antes de tenerlo en la mano.',
  },
  {
    question: '¿La propina le llega completa al domiciliario?',
    answer:
      'Completa, sin descuento de ninguna clase. Es opcional y la eliges en una pantalla propia antes de confirmar el pedido. Después de la entrega ya no se puede agregar.',
  },
  {
    question: '¿Cómo se calcula el envío?',
    answer:
      'Por la distancia real hasta tu dirección, no por zonas ni por un valor fijo. Ves el desglose antes de confirmar y nunca cobramos algo distinto a lo que te mostramos.',
  },
  {
    question: 'Necesito algo que no está en ninguna carta. ¿Qué hago?',
    answer:
      'Pide un mandado. En el Inicio, al final de las categorías, está "No está en carta": escribes qué necesitas y de dónde, y un domiciliario lo compra por ti y te lo lleva.',
  },
  {
    question: '¿Puedo pedir para otra persona, o para más tarde?',
    answer:
      'Las dos cosas. En el checkout puedes poner los datos de quien recibe —el domiciliario los ve antes de llamar— y también programar el pedido para más tarde.',
  },
  {
    question: 'No me llegan las notificaciones del pedido.',
    answer:
      'Revisa que Zipp tenga permiso para enviarte notificaciones en los ajustes de tu teléfono. Desde tu perfil, en "Notificaciones del sistema", llegas directo a esa pantalla.',
  },
];

const DRIVER_FAQS: Faq[] = [
  {
    question: '¿Cómo se calcula lo que gano por un domicilio?',
    answer:
      'La tarifa de reparto la fija Zipp antes de ofrecerte el pedido, y no baja aunque el cliente tenga un descuento: los cupones y promociones los paga el comercio o la plataforma, nunca de tu tarifa. La propina, si la hay, te llega completa, sin ningún descuento.',
  },
  {
    question: 'Cobré en efectivo. ¿Cuándo queda saldado?',
    answer:
      'No se salda solo con reportar la consignación: nosotros verificamos que el dinero entró antes de cerrar tu deuda. Repórtala apenas puedas, con la referencia de la transferencia, desde Ganancias.',
  },
  {
    question: '¿Por qué le pido un código al cliente o al negocio?',
    answer:
      'Es la prueba de que el traspaso fue con quien debía ser. Tú lo pides y lo escribes en la app; nosotros lo validamos del lado del servidor. No lo conoces de antemano ni lo puedes adivinar, así que si alguien te lo da mal, revisa con esa persona antes de forzarlo.',
  },
  {
    question: 'Acepté un pedido y ya no puedo hacerlo. ¿Qué hago?',
    answer:
      'Escríbenos apenas te des cuenta: entre más rápido avisemos, más rápido conseguimos a alguien más. Tú no tienes botón de cancelar dentro de la app —evita que un pedido quede en el aire sin que nadie se entere— así que este es el camino.',
  },
  {
    question: 'Un pedido pide cédula al entregar. ¿Qué hago si el cliente no la tiene?',
    answer:
      'No se entrega. La app te avisa en la pantalla del pedido cuando lleva productos con restricción de edad, y la verificación se hace en la puerta, que es donde de verdad se puede comprobar.',
  },
  {
    question: '¿Para qué es el botón de emergencia?',
    answer:
      'Mantenlo presionado si te sientes en riesgo. Avisa al equipo de Zipp de inmediato y, si guardaste un contacto de emergencia en tu perfil, también le avisamos a esa persona.',
  },
  {
    question: 'Subí mis documentos. ¿Cuánto tardan en revisarlos?',
    answer:
      'Los revisamos antes de dejarte tomar pedidos, normalmente el mismo día. Si alguno se rechaza, el motivo queda en la pantalla de Mis documentos y puedes volver a enviarlo.',
  },
  {
    question: 'No me llegan las ofertas de pedidos.',
    answer:
      'Revisa que Zipp tenga permiso para enviarte notificaciones: con la app en segundo plano, es la única forma de enterarte de una oferta nueva. Desde tu perfil, en "Notificaciones del sistema", llegas directo a esa pantalla.',
  },
];

export default function HelpScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const [open, setOpen] = useState<number | null>(null);
  const activeOrder = useActiveOrder();

  // Pantalla compartida por las dos apps (cada una la monta dentro de su
  // propio grupo de rutas, ver app/(client)/help.tsx y app/(driver)/help.tsx).
  // `activeOrder` sale de `/orders/my`, que solo devuelve pedidos donde el
  // usuario es el cliente -- en la app de domiciliarios da siempre vacío,
  // así que la tarjeta de "pedido en curso" se oculta sola.
  const faqs = IS_DRIVER_APP ? DRIVER_FAQS : CLIENT_FAQS;

  const reference = activeOrder
    ? (activeOrder.orderNumber ?? orderCode(activeOrder._id))
    : null;

  const openWhatsApp = () => {
    tap('light');
    const text = reference
      ? `Hola, necesito ayuda con mi pedido ${reference} en Zipp.`
      : 'Hola, necesito ayuda con Zipp.';
    const url = supportWhatsAppUrl(text);

    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header
        title="Centro de ayuda"
        fallback={ROUTES.profile}
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Pedido en curso ── */}
        {activeOrder ? (
          <View
            style={[
              styles.activeCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(98, 104, 160, 0.40)' : 'rgba(98, 104, 160, 0.25)',
              },
            ]}
          >
            <View style={styles.activeTop}>
              <View style={styles.cleanIcon}>
                <ContentIcon name="paquete" size={30} />
              </View>
              <View style={styles.flex}>
                <Text v="captionStrong" color="#6268A0">TU PEDIDO EN CURSO</Text>
                <Text v="strongL" numberOfLines={1}>
                  {activeOrder.businessId?.name ?? 'Pedido'} · {reference}
                </Text>
              </View>
            </View>
            <Button
              title="Ver seguimiento en vivo"
              variant="secondary"
              full
              onPress={() =>
                router.push({ pathname: '/(client)/order-tracking', params: { id: activeOrder._id } })
              }
            />
          </View>
        ) : null}

        {/* ── Contacto (One UI Contact Cards) ── */}
        <View style={styles.sectionBlock}>
          <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
            HABLA CON NOSOTROS
          </Text>

          <View style={styles.contactsGrid}>
            <Pressable
              onPress={openWhatsApp}
              accessibilityRole="button"
              accessibilityLabel="Contactar por WhatsApp"
              style={({ pressed }) => [
                styles.contactCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
                pressed && { transform: [{ scale: 0.98 }] },
              ]}
            >
              <View style={styles.contactCleanIcon}>
                <Icon name="chat" size={28} color="#6268A0" />
              </View>
              <Text v="strongM">WhatsApp</Text>
              <Text v="caption" tone="textMuted" center>Respuesta en minutos</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                tap('light');
                Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
              }}
              accessibilityRole="button"
              accessibilityLabel={`Llamar a ${SUPPORT_PHONE_DISPLAY}`}
              style={({ pressed }) => [
                styles.contactCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
                pressed && { transform: [{ scale: 0.98 }] },
              ]}
            >
              <View style={styles.contactCleanIcon}>
                <Icon name="llamar" size={28} color="#6268A0" />
              </View>
              <Text v="strongM">Llamada</Text>
              <Text v="caption" tone="textMuted" center>{SUPPORT_PHONE_DISPLAY}</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Preguntas Frecuentes (One UI Island) ── */}
        <View style={styles.sectionBlock}>
          <Text v="captionStrong" tone="textMuted" style={styles.sectionTitle}>
            PREGUNTAS FRECUENTES
          </Text>

          <View
            style={[
              styles.oneUiIsland,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            {faqs.map((faq, index) => {
              const expanded = open === index;
              return (
                <View key={faq.question} style={styles.faqWrapper}>
                  <Pressable
                    onPress={() => {
                      tap('light');
                      setOpen(expanded ? null : index);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={faq.question}
                    style={({ pressed }) => [
                      styles.faqHead,
                      pressed && {
                        backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                      },
                    ]}
                  >
                    <View style={styles.cleanIcon}>
                      <Icon name="ayuda" size="sm" color="#6268A0" />
                    </View>
                    <Text v="strongM" style={styles.flex}>{faq.question}</Text>
                    <Icon
                      name={expanded ? 'plegar' : 'desplegar'}
                      size="md"
                      color={c.textMuted}
                    />
                  </Pressable>

                  {expanded ? (
                    <Animated.View
                      entering={FadeIn.duration(180)}
                      style={[
                        styles.faqBody,
                        {
                          backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                        },
                      ]}
                    >
                      <Text v="bodyM" tone="textSecondary">{faq.answer}</Text>
                    </Animated.View>
                  ) : null}

                  {index < faqs.length - 1 ? (
                    <View
                      style={[
                        styles.indentedDivider,
                        { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' },
                      ]}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.huge,
    gap: Spacing.lg,
  },

  activeCard: {
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    gap: Spacing.md,
  },
  activeTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  cleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  sectionBlock: {
    gap: 8,
  },
  sectionTitle: {
    marginLeft: Spacing.md,
    letterSpacing: 0.8,
    fontSize: 11,
  },

  contactsGrid: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  contactCard: {
    flex: 1,
    padding: Spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  contactCleanIcon: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },

  oneUiIsland: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
  },
  faqWrapper: {
    width: '100%',
  },
  faqHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 16,
  },
  faqBody: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingLeft: 56,
  },
  indentedDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
    marginRight: Spacing.lg,
  },
});
