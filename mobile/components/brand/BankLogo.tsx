import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { bankLogoKey, type BankLogoKey } from '../../lib/bankLogos';
import { NequiLogo } from './NequiLogo';

// Logos de Wikimedia Commons y de los sitios de cada entidad, recortados al
// borde de la tinta y sin eslogan. Los que se publican solo en blanco (Alianza,
// Ding, Iris, Powwi) van pasados a gris oscuro para leerse sobre fondo claro.
// `ratio` es ancho/alto del PNG: con él se calcula el tamaño sin esperar a que
// la imagen cargue.
const LOGOS: Record<Exclude<BankLogoKey, 'nequi'>, { source: number; ratio: number }> = {
  accion: { source: require('../../assets/banks/accion.png'), ratio: 2.238 },
  agrario: { source: require('../../assets/banks/agrario.png'), ratio: 3.616 },
  alianza: { source: require('../../assets/banks/alianza.png'), ratio: 4.475 },
  avvillas: { source: require('../../assets/banks/avvillas.png'), ratio: 7.135 },
  ban100: { source: require('../../assets/banks/ban100.png'), ratio: 4.4 },
  bancolombia: { source: require('../../assets/banks/bancolombia.png'), ratio: 4.258 },
  bancoomeva: { source: require('../../assets/banks/bancoomeva.png'), ratio: 3.259 },
  bbva: { source: require('../../assets/banks/bbva.png'), ratio: 3.342 },
  bogota: { source: require('../../assets/banks/bogota.png'), ratio: 5.077 },
  cajasocial: { source: require('../../assets/banks/cajasocial.png'), ratio: 4.475 },
  cfa: { source: require('../../assets/banks/cfa.png'), ratio: 2.762 },
  citibank: { source: require('../../assets/banks/citibank.png'), ratio: 1.548 },
  coink: { source: require('../../assets/banks/coink.png'), ratio: 4.0 },
  coltefinanciera: { source: require('../../assets/banks/coltefinanciera.png'), ratio: 4.19 },
  confiar: { source: require('../../assets/banks/confiar.png'), ratio: 2.5 },
  contactar: { source: require('../../assets/banks/contactar.png'), ratio: 9.103 },
  cotrafa: { source: require('../../assets/banks/cotrafa.png'), ratio: 4.0 },
  crezcamos: { source: require('../../assets/banks/crezcamos.png'), ratio: 5.176 },
  davibank: { source: require('../../assets/banks/davibank.png'), ratio: 6.14 },
  daviplata: { source: require('../../assets/banks/daviplata.png'), ratio: 1.214 },
  davivienda: { source: require('../../assets/banks/davivienda.png'), ratio: 12.0 },
  ding: { source: require('../../assets/banks/ding.png'), ratio: 2.31 },
  falabella: { source: require('../../assets/banks/falabella.png'), ratio: 6.6 },
  finandina: { source: require('../../assets/banks/finandina.png'), ratio: 3.181 },
  global66: { source: require('../../assets/banks/global66.png'), ratio: 2.667 },
  iris: { source: require('../../assets/banks/iris.png'), ratio: 2.536 },
  itau: { source: require('../../assets/banks/itau.png'), ratio: 0.988 },
  jfk: { source: require('../../assets/banks/jfk.png'), ratio: 3.52 },
  jpmorgan: { source: require('../../assets/banks/jpmorgan.png'), ratio: 4.889 },
  juriscoop: { source: require('../../assets/banks/juriscoop.png'), ratio: 6.6 },
  lulo: { source: require('../../assets/banks/lulo.png'), ratio: 1.0 },
  movii: { source: require('../../assets/banks/movii.png'), ratio: 2.976 },
  mundomujer: { source: require('../../assets/banks/mundomujer.png'), ratio: 3.259 },
  nu: { source: require('../../assets/banks/nu.png'), ratio: 1.81 },
  occidente: { source: require('../../assets/banks/occidente.png'), ratio: 2.798 },
  paycash: { source: require('../../assets/banks/paycash.png'), ratio: 1.762 },
  pichincha: { source: require('../../assets/banks/pichincha.png'), ratio: 4.714 },
  popular: { source: require('../../assets/banks/popular.png'), ratio: 6.769 },
  powwi: { source: require('../../assets/banks/powwi.png'), ratio: 3.385 },
  pse: { source: require('../../assets/banks/pse.png'), ratio: 1.0 },
  rappipay: { source: require('../../assets/banks/rappipay.png'), ratio: 1.0 },
  santander: { source: require('../../assets/banks/santander.png'), ratio: 5.739 },
  uala: { source: require('../../assets/banks/uala.png'), ratio: 4.328 },
};

const NEQUI_RATIO = 95 / 30;

const SLOT_W = 80;
const SLOT_H = 24;
/** Área que ocupa cada logo, en pt². Es lo que hace que "se vean iguales". */
const AREA = 1280;

/**
 * Tamaño por área equivalente, no por alto ni por ancho.
 *
 * Con el mismo alto, Davivienda (12:1) cruzaba la fila y el cuadrado de Itaú
 * se veía diminuto; con el mismo ancho pasaba al revés. Igualando el área,
 * todos pesan lo mismo a la vista, dentro de un hueco fijo que mantiene
 * alineados los nombres de la lista.
 */
function sizeFor(ratio: number) {
  let height = Math.sqrt(AREA / ratio);
  let width = height * ratio;
  const fit = Math.min(1, SLOT_W / width, SLOT_H / height);
  width *= fit;
  height *= fit;
  return { width, height };
}

/** Logo del banco en un hueco de ancho fijo; sin logo propio, el de PSE. */
export function BankLogo({ name }: { name: string }) {
  const key = bankLogoKey(name);

  return (
    <View style={styles.slot}>
      {key === 'nequi' ? (
        <NequiLogo height={sizeFor(NEQUI_RATIO).height} />
      ) : (
        <Image source={LOGOS[key].source} style={sizeFor(LOGOS[key].ratio)} contentFit="contain" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { width: SLOT_W, height: SLOT_H, alignItems: 'center', justifyContent: 'center' },
});
