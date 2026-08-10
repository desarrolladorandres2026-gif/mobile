import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, FontSize, BorderRadius } from '../../../constants';
import { useAuthStore } from '../../../stores/authStore';

export default function DriverProfileScreen() {
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    Alert.alert('Cerrar sesión', '¿Estás seguro?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', style: 'destructive', onPress: () => { logout(); router.replace('/(auth)/login'); } },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView>
        <Text style={styles.title}>Mi Perfil</Text>
        <View style={styles.card}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{user?.name?.charAt(0)?.toUpperCase() || 'D'}</Text>
          </View>
          <Text style={styles.name}>{user?.name}</Text>
          <Text style={styles.phone}>{user?.phone}</Text>
          <View style={styles.ratingRow}>
            <Ionicons name="star" size={18} color={Colors.warning} />
            <Text style={styles.ratingText}>4.9</Text>
            <Text style={styles.ratingCount}>(128 entregas)</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color={Colors.error} />
          <Text style={styles.logoutText}>Cerrar sesión</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, paddingHorizontal: Spacing.xl },
  title: { fontSize: FontSize.xxxl, fontWeight: '800', color: Colors.text, marginTop: Spacing.md },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.xxl,
    alignItems: 'center', marginTop: Spacing.xl, borderWidth: 1, borderColor: Colors.border,
  },
  avatar: {
    width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.primary,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { fontSize: 32, fontWeight: '700', color: Colors.white },
  name: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  phone: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 4 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: 6 },
  ratingText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  ratingCount: { fontSize: FontSize.sm, color: Colors.textMuted },
  logoutBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: `${Colors.error}10`, borderRadius: BorderRadius.md,
    padding: Spacing.lg, marginTop: Spacing.xxl,
  },
  logoutText: { color: Colors.error, fontSize: FontSize.md, fontWeight: '600' },
});
