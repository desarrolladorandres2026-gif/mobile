import { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, Layout } from 'react-native-reanimated';
import { Text, Icon, Button, Screen, Header } from '../../components/ui';
import { useActiveOrder } from '../../hooks/useRealtime';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing, FontSize } from '../../theme/tokens';
import { orderCode } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { SUPPORT_PHONE } from '../../constants/config';

interface Faq {
  question: string;
  answer: string;
}

const FAQS: Faq[] = [];

export default function HelpScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
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

    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Centro de ayuda" fallback="/(client)/(tabs)/profile" />

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
                <Icon name="paquete" size="md" color="#6268A0" />
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
              accessibilityLabel={`Llamar a ${SUPPORT_PHONE}`}
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
              <Text v="caption" tone="textMuted" center>{SUPPORT_PHONE}</Text>
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
            {FAQS.map((faq, index) => {
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

                  {index < FAQS.length - 1 ? (
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
