import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text, Screen, Header } from '../../components/ui';
import { AddressList, NewAddressSheet } from '../../components/domain/AddressPicker';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

export default function AddressesScreen() {
  const { c, isDark } = useTheme();
  const [creating, setCreating] = useState(false);

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Mis direcciones" fallback="/(client)/(tabs)/profile" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View
          style={[
            styles.infoCard,
            {
              backgroundColor: c.surface,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            },
          ]}
        >
          <Text v="bodyM" tone="textSecondary">
            La dirección principal es la que aparece primero al confirmar tus pedidos.
          </Text>
        </View>
        <AddressList manage onAddPress={() => setCreating(true)} />
      </ScrollView>

      <NewAddressSheet
        visible={creating}
        onClose={() => setCreating(false)}
        onCreated={() => setCreating(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.huge },
  infoCard: {
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
  },
});
