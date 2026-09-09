import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text, Screen, ScreenFooter, Header } from '../../components/ui';
import {
  AddressList, AddressFormSheet, AddAddressButton, type Address,
} from '../../components/domain/AddressPicker';
import { Spacing } from '../../theme/tokens';
import { useAddresses } from '../../hooks/useApi';

export default function AddressesScreen() {
  const [creating, setCreating] = useState(false);
  /**
   * La dirección que se está editando, o `null` si se está creando una.
   *
   * Va aparte de `creating` y no como un solo estado con tres valores
   * porque son dos preguntas distintas: si la hoja está abierta, y sobre
   * qué. Fundirlas obligaría a inventar un valor para "abierta y vacía".
   */
  const [editing, setEditing] = useState<Address | null>(null);
  const { data: addresses = [] } = useAddresses() as { data: Address[] };

  const defaultAddress = addresses.find((a) => a.isDefault);
  const count = addresses.length;

  return (
    <Screen>
      <Header title="Mis direcciones" fallback="/(client)/(tabs)/profile" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/*
          Encabezado en texto plano. Antes esto era una tarjeta con degradado
          y su propia ilustración enmarcada; en una pantalla que ya no tiene
          cajas, un bloque con borde arriba del todo compite con la lista en
          vez de presentarla.
        */}
        {count > 0 ? (
          <View style={styles.intro}>
            <Text v="bodyM" tone="textSecondary" style={styles.introText}>
              La principal se elige sola en tus pedidos.
            </Text>

            {defaultAddress ? (
              <View style={styles.introTag}>
                <View style={styles.activeDot} />
                <Text v="strongS" color="#10B981" style={styles.statTagBold} numberOfLines={1}>
                  {defaultAddress.label}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <AddressList manage onEditPress={(address) => setEditing(address)} />
      </ScrollView>

      {/*
        Anclado al pie y fuera del ScrollView: con varias direcciones
        guardadas, un botón al final de la lista queda debajo del scroll y
        hay que ir a buscarlo.

        `ScreenFooter` y no un `View` propio porque suma el inset real del
        dispositivo: era lo que faltaba para que el botón no quedara pegado
        a la barra de navegación del teléfono.
      */}
      <ScreenFooter>
        {/*
          El margen va aquí y no en el `paddingBottom` del pie: ese lo
          calcula `ScreenFooter` con el inset del dispositivo, y pisarlo
          desde fuera devolvería el botón a la barra del sistema en los
          teléfonos con gesto.
        */}
        <View style={styles.footerLift}>
          <AddAddressButton onPress={() => setCreating(true)} />
        </View>
      </ScreenFooter>

      {/*
        Una sola hoja para crear y editar. React Native no tolera dos
        modales nativos a la vez, así que montar una hoja por cada caso
        sería pedir que en algún camino se abran las dos.
      */}
      <AddressFormSheet
        visible={creating || !!editing}
        address={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={() => { setCreating(false); setEditing(null); }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
  },
  footerLift: {
    marginBottom: Spacing.sm,
  },
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  introText: {
    flex: 1,
    lineHeight: 20,
  },
  introTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statTagBold: {
    fontWeight: '700',
  },
  activeDot: {
    width: 6.5,
    height: 6.5,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
});
