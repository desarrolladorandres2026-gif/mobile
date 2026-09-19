import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { CardBrandLogo } from './CardBrandLogo';
import { NequiLogo } from './NequiLogo';

/**
 * Marca de "pago en efectivo": un billete. No existe un logotipo de marca para
 * el efectivo, así que es un símbolo dibujado a mano con el color del tema.
 */
export function CashLogo({ color, size = 34 }: { color: string; size?: number }) {
  return (
    <Svg
      width={(size * 40) / 24}
      height={size}
      viewBox="0 0 40 24"
      accessibilityLabel="Efectivo"
    >
      <Rect x={1} y={1} width={38} height={22} rx={4} fill="none" stroke={color} strokeWidth={2} />
      <Circle cx={20} cy={12} r={5.5} fill="none" stroke={color} strokeWidth={2} />
      <Path d="M20 9.2v5.6M18.2 10.6h2.9a1.2 1.2 0 010 2.4h-2.2a1.2 1.2 0 000 2.4h2.9" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round" />
      <Circle cx={7} cy={12} r={1.6} fill={color} />
      <Circle cx={33} cy={12} r={1.6} fill={color} />
    </Svg>
  );
}

/**
 * Las redes con las que se paga en línea: Visa, Mastercard, Nequi y PSE.
 * Es la misma lista que ofrece la hoja de métodos, así que lo que se ve en la
 * opción es lo que se encuentra al tocarla.
 */
export function DigitalPaymentLogos({ ink, height = 14 }: { ink: string; height?: number }) {
  return (
    <View style={styles.row} accessibilityLabel="Visa, Mastercard, Nequi y PSE">
      <CardBrandLogo brand="VISA" height={height * 0.75} ink={ink} />
      <CardBrandLogo brand="MASTERCARD" height={height} />
      <NequiLogo height={height} />
      <Image
        source={require('../../assets/banks/pse.png')}
        style={{ width: height, height }}
        contentFit="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});

/**
 * Mapbox, el proveedor del mapa y de las direcciones. Es el ícono oficial
 * (vector de simple-icons): el círculo con la estrella de cuatro puntas, en
 * el color que se le pase para que siga el tema.
 */
export function MapboxLogo({ size = 30, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="Mapbox">
      <Path fill={color} d={MAPBOX} />
    </Svg>
  );
}

const MAPBOX =
  'M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm5.696 14.943c-4.103 4.103-11.433 2.794-11.433 2.794S4.94 10.421 9.057 6.304c2.281-2.281 6.061-2.187 8.45.189s2.471 6.168.189 8.45zm-4.319-7.91l-1.174 2.416-2.416 1.174 2.416 1.174 1.174 2.416 1.174-2.416 2.416-1.174-2.416-1.174-1.174-2.416z';

/** Verde de marca de WhatsApp. */
export const WHATSAPP_GREEN = '#25D366';

/**
 * WhatsApp, el canal por el que llegan las postulaciones de aliados y
 * domiciliarios. Ícono oficial (vector de simple-icons) en su verde de marca.
 */
export function WhatsAppLogo({ size = 30, color = WHATSAPP_GREEN }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="WhatsApp">
      <Path fill={color} d={WHATSAPP} />
    </Svg>
  );
}

const WHATSAPP =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z';
