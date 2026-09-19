import { View, Pressable, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * Una casilla de consentimiento con el documento al lado.
 *
 * Wompi exige aceptación explícita de sus términos en cada cobro, y de su
 * política de datos para guardar una tarjeta. Una casilla que no enlaza a
 * lo que se acepta no es un consentimiento, es un trámite; por eso el
 * enlace va en la misma línea y no escondido en un pie de página.
 *
 * El documento se abre en la pestaña del navegador **dentro** de la app
 * (`openBrowserAsync`): es un PDF, que un WebView de Android no pinta, y
 * leerlo no debería sacar a nadie de su pedido.
 */
interface Props {
  checked: boolean;
  onToggle: (next: boolean) => void;
  /** Texto antes del enlace: "Acepto los". */
  lead: string;
  /** El enlace: "términos de Wompi". */
  linkText: string;
  url?: string;
  /** Aviso bajo la casilla cuando se intentó seguir sin marcarla. */
  error?: string;
}

export function PaymentConsent({ checked, onToggle, lead, linkText, url, error }: Props) {
  const { c } = useTheme();

  const openDocument = () => {
    if (!url) return;
    tap('light');
    WebBrowser.openBrowserAsync(url).catch(() => {});
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => { tap('select'); onToggle(!checked); }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={`${lead} ${linkText}`}
        style={styles.row}
        hitSlop={6}
      >
        <View
          style={[
            styles.box,
            {
              borderColor: error ? c.error : checked ? c.primary : c.borderStrong,
              backgroundColor: checked ? c.primary : c.surface,
            },
          ]}
        >
          {checked ? <Icon name="check" size="sm" color={c.textOnPrimary} /> : null}
        </View>
        <Text v="bodyS" tone="text" style={styles.flex}>
          {lead}{' '}
          <Text
            v="bodyS"
            tone="primaryText"
            onPress={url ? openDocument : undefined}
            accessibilityRole="link"
            style={url ? styles.link : undefined}
          >
            {linkText}
          </Text>
        </Text>
      </Pressable>
      {error ? (
        <Text v="caption" tone="errorText" style={styles.error}>{error}</Text>
      ) : null}
    </View>
  );
}

/**
 * Los términos de Wompi como aviso, sin casilla.
 *
 * Wompi pide que quien paga vea los términos antes de cobrar. Una frase
 * junto al botón, con el enlace al documento, lo cumple sin un paso más:
 * pulsar el botón es la aceptación.
 */
export function PaymentTermsNotice({ url }: { url?: string }) {
  const openDocument = () => {
    if (!url) return;
    tap('light');
    WebBrowser.openBrowserAsync(url).catch(() => {});
  };

  return (
    <Text v="caption" tone="textMuted" center>
      Al continuar aceptas los{' '}
      <Text
        v="caption"
        tone="primaryText"
        onPress={url ? openDocument : undefined}
        accessibilityRole="link"
        style={url ? styles.link : undefined}
      >
        términos de Wompi
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 44 },
  box: {
    width: 22,
    height: 22,
    borderRadius: BorderRadius.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  link: { textDecorationLine: 'underline' },
  error: { marginLeft: 22 + Spacing.sm },
});
