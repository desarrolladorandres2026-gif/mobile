import { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text, Button, Screen, ScreenFooter, Header } from '../../components/ui';
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
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const heroHeight = Math.round(height / 2);

  const goToCheckout = (tip: number | null) => {
    router.push({
      pathname: '/(client)/checkout',
      params: { ...(businessId ? { businessId } : {}), ...(tip ? { tip: String(tip) } : {}) },
    });
  };

  return (
    <Screen edges={[]}>
      {/* Fija: la imagen ocupa la mitad superior y solo se desplaza lo de abajo. */}
      <View style={{ height: heroHeight }}>
        <Image
          source={require('../../assets/tip-hero.jpg')}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          accessible={false}
        />
        <View style={{ paddingTop: insets.top }}>
          <Header fallback="/(client)/cart" bare />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.copy}>
          <Text v="displayS">Propina</Text>
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
