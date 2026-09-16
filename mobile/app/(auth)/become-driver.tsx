import { View, ScrollView, StyleSheet, Linking } from 'react-native';
import { Text, Button, Screen, Header, Icon } from '../../components/ui';
import { ContentIcon } from '../../components/illustrations';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../../constants/config';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * Lo que hay que tener para repartir. Es la misma lista que después se
 * sube en `(driver)/documents`, dicha antes de que la persona escriba.
 *
 * TODO(negocio): confirmar si hace falta algo más (moto propia vs. prestada,
 * edad mínima, antecedentes) antes de publicar la app.
 */
const REQUIREMENTS = [
  { icon: 'documento', text: 'Cédula de ciudadanía' },
  { icon: 'documento', text: 'Licencia de conducción vigente' },
  { icon: 'documento', text: 'SOAT y tecnomecánica al día' },
  { icon: 'documento', text: 'Tarjeta de propiedad de la moto' },
  { icon: 'celular', text: 'Celular Android con datos y GPS' },
] as const;

/**
 * "Quiero ser domiciliario".
 *
 * La app de domiciliarios no tiene registro: las cuentas las crea admin
 * cuando la persona ya envió sus documentos. Esta pantalla es el puente
 * entre "descargué la app" y "me crearon la cuenta": dice qué hace falta y
 * abre la conversación por WhatsApp con el mensaje ya escrito.
 *
 * Se llega desde el login (enlace "Quiero ser domiciliario") y desde el
 * error de "no hay una cuenta con este número".
 */
export default function BecomeDriverScreen() {
  const { c } = useTheme();
  const bottomInset = useBottomInset();

  const openWhatsApp = () => {
    tap('medium');
    const url = supportWhatsAppUrl('Hola, quiero empezar a repartir con Zipp.');
    // Sin WhatsApp instalado `openURL` rechaza; se ofrece la llamada como plan B.
    Linking.openURL(url).catch(() => {
      Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => {});
    });
  };

  return (
    <Screen>
      <Header title="Reparte con Zipp" fallback="/(auth)/login" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <ContentIcon name="domiciliario" size={88} />
          <Text v="displayL" center>Quiero ser domiciliario</Text>
          <Text v="bodyL" tone="textSecondary" center>
            Postúlate por WhatsApp. Revisamos tus documentos y te creamos la
            cuenta para que entres aquí con tu celular.
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text v="captionStrong" tone="textMuted">LO QUE NECESITAS</Text>
          {REQUIREMENTS.map((item) => (
            <View key={item.text} style={styles.row}>
              <Icon name={item.icon} size="sm" color={c.primary} />
              <Text v="bodyM" style={styles.rowText}>{item.text}</Text>
            </View>
          ))}
        </View>

        <Text v="caption" tone="textMuted" center>
          También puedes llamarnos al {SUPPORT_PHONE_DISPLAY}.
        </Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: bottomInset + Spacing.md }]}>
        <Button
          title="Postularme por WhatsApp"
          icon="chat"
          size="lg"
          full
          pill
          onPress={openWhatsApp}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: Spacing.xl,
  },
  hero: { alignItems: 'center', gap: Spacing.md },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  rowText: { flex: 1 },
  footer: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
  },
});
