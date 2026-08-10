import { ScrollView, StyleSheet } from 'react-native';
import { Text, Screen, Header } from '../../components/ui';
import { AddressList } from '../../components/domain/AddressPicker';
import { Spacing } from '../../theme/tokens';

export default function AddressesScreen() {
  return (
    <Screen>
      <Header title="Mis direcciones" fallback="/(client)/(tabs)/profile" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text v="bodyM" tone="textSecondary">
          La dirección principal es la que aparece primero al confirmar un pedido.
        </Text>
        <AddressList manage />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },
});
