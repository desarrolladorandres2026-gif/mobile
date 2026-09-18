import { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text, Icon, Button, Screen, ScreenFooter, Header } from '../../components/ui';
import { TipPicker } from '../../components/domain/TipPicker';
import { BorderRadius, Size, Spacing } from '../../theme/tokens';
import { money } from '../../lib/format';
import { TIP_ACCENT } from '../../lib/tip';
import { tap } from '../../lib/haptics';

/**
 * La propina, antes de confirmar el pedido.
 *
 * Es un paso propio y no una sección del checkout: ahí competía con la
 * dirección, el pago y el cupón, y se elegía sin pensar. Aquí es la única
 * pregunta de la pantalla.
 *
 * Nunca bloquea. "Ahora no" siempre está a la vista y sigue adelante con cero.
 * Esta es la única ocasión: no hay propina posterior a la entrega, porque un
 * cobro suelto después de cerrar el pedido descuadraría la contabilidad.
 *
 * El monto viaja al checkout por la URL: aquí no se cobra nada. Quien cobra,
 * y quien valida el tope, es el servidor al cotizar.
 */
export default function TipScreen() {
  const router = useRouter();
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  const [amount, setAmount] = useState<number | null>(null);

  const goToCheckout = (tip: number | null) => {
    router.push({
      pathname: '/(client)/checkout',
      params: { ...(businessId ? { businessId } : {}), ...(tip ? { tip: String(tip) } : {}) },
    });
  };

  return (
    <Screen>
      <Header title="Propina" fallback="/(client)/cart" />

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.badge, { backgroundColor: TIP_ACCENT }]}>
          <Icon name="domiciliario" size={28} color="#FFFFFF" />
        </View>

        <View style={styles.copy}>
          <Text v="titleL">¿Le dejas propina a quien te lo lleva?</Text>
          <Text v="bodyM" tone="textSecondary">
            Es opcional. Le llega completa y sale de tu bolsillo, no del pedido.
          </Text>
        </View>

        <TipPicker value={amount} onChange={setAmount} />
      </ScrollView>

      <ScreenFooter style={styles.footer}>
        {amount ? (
          <>
            <Pressable
              onPress={() => { tap('medium'); goToCheckout(amount); }}
              accessibilityRole="button"
              style={styles.cta}
            >
              <Text v="strongL" color="#FFFFFF">{`Agregar ${money(amount)} de propina`}</Text>
            </Pressable>
            <Button
              title="Ahora no"
              variant="ghost"
              full
              onPress={() => { tap('light'); goToCheckout(null); }}
            />
          </>
        ) : (
          <Button
            title="Ahora no"
            variant="secondary"
            size="lg"
            full
            iconRight="adelante"
            onPress={() => { tap('light'); goToCheckout(null); }}
          />
        )}
      </ScreenFooter>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: Spacing.xl, gap: Spacing.xl },
  badge: {
    width: 56,
    height: 56,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cta: {
    height: Size.buttonLg,
    borderRadius: BorderRadius.lg,
    backgroundColor: TIP_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { gap: Spacing.sm },
  footer: { gap: Spacing.xs },
});
