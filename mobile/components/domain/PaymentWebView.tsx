import { useState } from 'react';
import { Modal, View, StyleSheet, ActivityIndicator } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, Icon, IconButton } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';
import { PAYMENT_USER_AGENT } from '../../lib/browserInfo';

/**
 * La página del banco, **dentro** de Zipp.
 *
 * Dos cosas no se pueden resolver con un formulario propio: la
 * autorización de PSE (la hace el banco en su web) y el reto 3D Secure de
 * una tarjeta (lo pinta el emisor). Antes las dos sacaban a la persona al
 * navegador del sistema; aquí se quedan en un WebView de la app, con la
 * cabecera de Zipp encima para que nadie dude de dónde está.
 *
 * Lo que este WebView acepta cargar está acotado a propósito: solo https
 * (más `about:blank`, que es donde vive un reto 3DS pintado desde HTML).
 * Cualquier otro esquema se bloquea, y la dirección de regreso de la
 * pasarela no se carga: se intercepta y cierra la vista.
 *
 * El resultado del pago **no** se deduce de lo que pase aquí. Cerrar esta
 * vista solo significa que la persona terminó de interactuar; lo que vale
 * es lo que el backend confirme con Wompi.
 */
interface Props {
  visible: boolean;
  /** Una URL (PSE) o un documento HTML (reto 3DS). */
  source: { uri: string } | { html: string } | null;
  title: string;
  /** Prefijo de la dirección a la que la pasarela devuelve al terminar. */
  returnUrl?: string;
  /** La pasarela devolvió a la persona: hora de consultar el estado. */
  onReturned: () => void;
  /** La persona cerró la vista por su cuenta. */
  onClosed: () => void;
}

function isAllowed(url: string): boolean {
  return url.startsWith('https://') || url === 'about:blank' || url.startsWith('about:srcdoc');
}

export function PaymentWebView({ visible, source, title, returnUrl, onReturned, onClosed }: Props) {
  const { c } = useTheme();
  const [loading, setLoading] = useState(true);
  const [host, setHost] = useState<string | null>(null);

  const intercept = (request: WebViewNavigation): boolean => {
    const { url } = request;
    if ((returnUrl && url.startsWith(returnUrl)) || url.startsWith('zipp://')) {
      onReturned();
      return false;
    }
    return isAllowed(url);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClosed} presentationStyle="fullScreen">
      <SafeAreaView style={[styles.fill, { backgroundColor: c.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <IconButton icon="cerrar" onPress={onClosed} label="Cerrar y volver a Zipp" />
          <View style={styles.titleBox}>
            <Text v="strongS" numberOfLines={1}>{title}</Text>
            {host ? (
              <View style={styles.hostRow}>
                <Icon name="candado" size={12} color={c.successText} />
                <Text v="caption" tone="textMuted" numberOfLines={1}>{host}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {source ? (
          <WebView
            source={source}
            style={styles.fill}
            originWhitelist={['https://*', 'about:*']}
            onShouldStartLoadWithRequest={intercept}
            onNavigationStateChange={(nav) => {
              try {
                setHost(nav.url.startsWith('https://') ? new URL(nav.url).host : null);
              } catch {
                setHost(null);
              }
            }}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            javaScriptEnabled
            domStorageEnabled
            // El mismo que se declaró a 3D Secure: el emisor compara el
            // navegador que inició la autenticación con el que la termina.
            userAgent={PAYMENT_USER_AGENT}
            // Sin ventanas nuevas: un `target=_blank` del banco se abre en
            // esta misma vista en vez de escaparse al navegador.
            setSupportMultipleWindows={false}
            // La sesión del banco no sobrevive a esta vista.
            incognito
            // Nada de archivos locales ni de mezclar contenido http.
            allowFileAccess={false}
            mixedContentMode="never"
          />
        ) : null}

        {loading ? (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color={c.primary} />
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleBox: { flex: 1, gap: 2 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  loading: { position: 'absolute', top: 80, left: 0, right: 0, alignItems: 'center' },
});
