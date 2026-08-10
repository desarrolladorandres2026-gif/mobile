import { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, Layout } from 'react-native-reanimated';
import { Text, Icon, Card, Button, Screen, Header } from '../../components/ui';
import { useActiveOrder } from '../../hooks/useRealtime';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { orderCode } from '../../lib/format';
import { tap } from '../../lib/haptics';

/** Número de soporte de Zipp en Garzón. */
const SUPPORT_PHONE = '3001234567';

interface Faq {
  question: string;
  answer: string;
}

/**
 * Las dudas que de verdad llegan a soporte, respondidas sin rodeos.
 *
 * Las tres primeras son las que más se preguntan en una app de domicilios de
 * pueblo, así que van arriba y no detrás de un buscador.
 */
const FAQS: Faq[] = [
  {
    question: '¿Cuánto cuesta el envío?',
    answer:
      'Depende de la distancia entre el negocio y tu dirección. Se calcula con una tarifa base más un valor por kilómetro, y siempre lo ves en el desglose antes de confirmar. Nunca cobramos un valor distinto al que te mostramos.',
  },
  {
    question: 'Mi pedido se está demorando',
    answer:
      'Primero mira en qué paso va desde Pedidos: si sigue en "Preparando", el local todavía lo tiene. Si ya está "En camino", puedes llamar al domiciliario desde la pantalla de seguimiento. Si pasaron más de 20 minutos del estimado, escríbenos.',
  },
  {
    question: 'Llegó algo equivocado o incompleto',
    answer:
      'Escríbenos con el número del pedido dentro de las siguientes 24 horas. Revisamos con el negocio y resolvemos: reponemos el producto o te devolvemos ese valor.',
  },
  {
    question: '¿Cómo uso un cupón?',
    answer:
      'Al confirmar el pedido hay un campo de cupón. Escribe el código y toca Aplicar. Si el cupón tiene condiciones —monto mínimo, un solo negocio, primer pedido— te lo decimos ahí mismo.',
  },
  {
    question: 'Pagué en línea y el pedido se canceló',
    answer:
      'La devolución sale automáticamente cuando se cancela un pedido pagado. Según tu banco puede tardar entre uno y cinco días hábiles en aparecer.',
  },
  {
    question: 'Quiero cambiar mi dirección',
    answer:
      'En Perfil → Mis direcciones puedes agregar, editar o eliminar. Recuerda confirmar el punto en el mapa: sin él no podemos calcular el envío ni el domiciliario te encuentra.',
  },
];

export default function HelpScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const [open, setOpen] = useState<number | null>(null);
  const activeOrder = useActiveOrder();

  const reference = activeOrder
    ? (activeOrder.orderNumber ?? orderCode(activeOrder._id))
    : null;

  const openWhatsApp = () => {
    tap('light');
    const text = reference
      ? `Hola, necesito ayuda con mi pedido ${reference} en Zipp.`
      : 'Hola, necesito ayuda con Zipp.';
    const url = `whatsapp://send?phone=57${SUPPORT_PHONE}&text=${encodeURIComponent(text)}`;

    // Si WhatsApp no está instalado, se cae a la llamada en vez de no hacer nada.
    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  return (
    <Screen>
      <Header title="Centro de ayuda" fallback="/(client)/(tabs)/profile" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Pedido en curso ── */}
        {activeOrder ? (
          <Card tone="accent" style={styles.active}>
            <View style={styles.activeTop}>
              <View style={[styles.activeIcon, { backgroundColor: c.primary }]}>
                <Icon name="paquete" size="md" color={c.textOnPrimary} />
              </View>
              <View style={styles.flex}>
                <Text v="caption" tone="textMuted">TU PEDIDO EN CURSO</Text>
                <Text v="titleM" numberOfLines={1}>
                  {activeOrder.businessId?.name ?? 'Pedido'} · {reference}
                </Text>
              </View>
            </View>
            <Button
              title="Ver el seguimiento"
              variant="secondary"
              full
              onPress={() =>
                router.push({ pathname: '/(client)/order-tracking', params: { id: activeOrder._id } })
              }
            />
          </Card>
        ) : null}

        {/* ── Contacto ── */}
        <View style={styles.group}>
          <Text v="titleL">Habla con nosotros</Text>
          <Text v="bodyM" tone="textSecondary">
            Atendemos todos los días de 8:00 a. m. a 10:00 p. m.
          </Text>

          <View style={styles.contacts}>
            <ContactCard
              icon="chat"
              title="WhatsApp"
              subtitle="Respuesta en minutos"
              onPress={openWhatsApp}
            />
            <ContactCard
              icon="llamar"
              title="Llamar"
              subtitle={SUPPORT_PHONE}
              onPress={() => {
                tap('light');
                Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
              }}
            />
          </View>
        </View>

        {/* ── Preguntas ── */}
        <View style={styles.group}>
          <Text v="titleL">Preguntas frecuentes</Text>

          {FAQS.map((faq, index) => {
            const expanded = open === index;
            return (
              <Animated.View key={faq.question} layout={Layout.springify().damping(20)}>
                <Card padded={false}>
                  <Pressable
                    onPress={() => { tap('light'); setOpen(expanded ? null : index); }}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={faq.question}
                    accessibilityHint={expanded ? 'Toca para cerrar' : 'Toca para ver la respuesta'}
                    style={styles.faqHead}
                  >
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
                      style={[styles.faqBody, { borderTopColor: c.border }]}
                    >
                      <Text v="bodyM" tone="textSecondary">{faq.answer}</Text>
                    </Animated.View>
                  ) : null}
                </Card>
              </Animated.View>
            );
          })}
        </View>
      </ScrollView>
    </Screen>
  );
}

function ContactCard({
  icon, title, subtitle, onPress,
}: {
  icon: 'chat' | 'llamar';
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const { c } = useTheme();

  return (
    <Card onPress={onPress} style={styles.contact} accessibilityLabel={`${title}. ${subtitle}`}>
      <View style={[styles.contactIcon, { backgroundColor: c.limeSoft }]}>
        <Icon name={icon} size="lg" color={c.limeText} />
      </View>
      <Text v="titleS">{title}</Text>
      <Text v="caption" tone="textMuted" center>{subtitle}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.xxl, paddingBottom: Spacing.huge },

  active: { gap: Spacing.md },
  activeTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  activeIcon: {
    width: 42, height: 42, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },

  group: { gap: Spacing.md },
  contacts: { flexDirection: 'row', gap: Spacing.md },
  contact: { flex: 1, alignItems: 'center', gap: Spacing.xs },
  contactIcon: {
    width: 48, height: 48, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.xs,
  },

  faqHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  faqBody: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
