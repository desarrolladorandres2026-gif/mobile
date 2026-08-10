import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, FontSize, BorderRadius } from '../../../constants';
import { useAvailableOrders, useDriverOrders, useDriverProfile, useAssignDriver, useUpdateOrderStatus } from '../../../hooks/useApi';
import { socketService } from '../../../services/socket';

export default function DriverOrdersScreen() {
  const [activeTab, setActiveTab] = useState<'available' | 'my_deliveries'>('available');
  
  // React query hooks
  const { data: driverProfile, isLoading: loadingProfile } = useDriverProfile();
  const { data: availableOrdersData, isLoading: loadingAvailable, refetch: refetchAvailable } = useAvailableOrders();
  const { data: driverOrdersData, isLoading: loadingDriverOrders, refetch: refetchMy } = useDriverOrders();

  const assignDriverMutation = useAssignDriver();
  const updateStatusMutation = useUpdateOrderStatus();

  // Socket connection
  useEffect(() => {
    socketService.connect();
    
    // Listen for new available orders
    socketService.onOrderAvailable(() => {
      console.log('⚡ New order available via socket');
      refetchAvailable();
    });

    return () => {
      socketService.removeAllListeners();
    };
  }, []);

  const handleRefresh = async () => {
    if (activeTab === 'available') {
      await refetchAvailable();
    } else {
      await refetchMy();
    }
  };

  const handleAcceptOrder = (orderId: string) => {
    if (!driverProfile) {
      Alert.alert('Error', 'No se encontró tu perfil de domiciliario');
      return;
    }

    assignDriverMutation.mutate(
      { orderId, driverId: driverProfile._id },
      {
        onSuccess: (updatedOrder: any) => {
          Alert.alert('Éxito', 'Has aceptado el pedido');
          refetchAvailable();
          refetchMy();
          
          // Emit socket update
          socketService.emitOrderStatusUpdate({
            orderId,
            status: 'ready',
            clientId: updatedOrder.clientId,
            driverId: driverProfile.userId?._id || driverProfile.userId
          });
        },
        onError: (error: any) => {
          Alert.alert('Error', error.response?.data?.message || 'No se pudo aceptar el pedido');
        }
      }
    );
  };

  const handleUpdateStatus = (order: any, nextStatus: string) => {
    updateStatusMutation.mutate(
      { id: order._id, status: nextStatus },
      {
        onSuccess: (updatedOrder: any) => {
          refetchMy();
          
          // Emit socket status update
          socketService.emitOrderStatusUpdate({
            orderId: order._id,
            status: nextStatus,
            clientId: order.clientId?._id || order.clientId,
            driverId: driverProfile?.userId?._id || driverProfile?.userId
          });
        },
        onError: (error: any) => {
          Alert.alert('Error', error.response?.data?.message || 'No se pudo actualizar el estado');
        }
      }
    );
  };

  const getStatusButtonConfig = (order: any) => {
    switch (order.status) {
      case 'ready':
        return { label: 'Recoger en local', status: 'picked_up', color: Colors.primary };
      case 'picked_up':
        return { label: 'Iniciar entrega', status: 'on_way', color: Colors.statusOnWay };
      case 'on_way':
        return { label: 'Entregado', status: 'delivered', color: Colors.success };
      default:
        return null;
    }
  };

  const loading = loadingProfile || loadingAvailable || loadingDriverOrders;
  const availableOrders = availableOrdersData || [];
  const activeDeliveries = (driverOrdersData || []).filter((o: any) => 
    ['ready', 'picked_up', 'on_way'].includes(o.status)
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Text style={styles.title}>Logística de Entregas</Text>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'available' && styles.tabActive]}
          onPress={() => setActiveTab('available')}
        >
          <Text style={[styles.tabText, activeTab === 'available' && styles.tabTextActive]}>
            Disponibles ({availableOrders.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'my_deliveries' && styles.tabActive]}
          onPress={() => setActiveTab('my_deliveries')}
        >
          <Text style={[styles.tabText, activeTab === 'my_deliveries' && styles.tabTextActive]}>
            Mis Rutas ({activeDeliveries.length})
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={activeTab === 'available' ? availableOrders : activeDeliveries}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={handleRefresh}
              tintColor={Colors.primary}
            />
          }
          renderItem={({ item }) => {
            const btnConfig = getStatusButtonConfig(item);
            return (
              <View style={styles.orderCard}>
                <View style={styles.cardHeader}>
                  <Text style={styles.businessName}>{item.businessId?.name}</Text>
                  <View style={[styles.paymentBadge, item.paymentMethod === 'online' ? styles.onlineBadge : styles.cashBadge]}>
                    <Text style={styles.paymentText}>{item.paymentMethod === 'online' ? '💳 Digital' : '💵 Contra entrega'}</Text>
                  </View>
                </View>
                <View style={styles.detailRow}>
                  <Ionicons name="location-outline" size={14} color={Colors.textMuted} />
                  <Text style={styles.detailText}>{item.deliveryAddress}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Ionicons name="person-outline" size={14} color={Colors.textMuted} />
                  <Text style={styles.detailText}>Cliente: {item.clientId?.name || 'Usuario'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Ionicons name="cash-outline" size={14} color={Colors.textMuted} />
                  <Text style={styles.detailText}>Valor del pedido: ${item.total?.toLocaleString()}</Text>
                </View>
                <View style={styles.cardFooter}>
                  <View>
                    <Text style={styles.feeLabel}>Tu ganancia</Text>
                    <Text style={styles.feeValue}>${item.deliveryFee?.toLocaleString()}</Text>
                  </View>
                  
                  {activeTab === 'available' ? (
                    <View style={styles.actions}>
                      <TouchableOpacity
                        style={[styles.acceptBtn, assignDriverMutation.isPending && { opacity: 0.7 }]}
                        onPress={() => handleAcceptOrder(item._id)}
                        disabled={assignDriverMutation.isPending}
                      >
                        <Text style={styles.acceptText}>Aceptar</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    btnConfig && (
                      <TouchableOpacity
                        style={[styles.statusUpdateBtn, { backgroundColor: btnConfig.color }, updateStatusMutation.isPending && { opacity: 0.7 }]}
                        onPress={() => handleUpdateStatus(item, btnConfig.status)}
                        disabled={updateStatusMutation.isPending}
                      >
                        <Text style={styles.statusUpdateText}>{btnConfig.label}</Text>
                      </TouchableOpacity>
                    )
                  )}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="bicycle-outline" size={64} color={Colors.border} />
              <Text style={styles.emptyTitle}>
                {activeTab === 'available' ? 'No hay pedidos disponibles' : 'No tienes entregas activas'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {activeTab === 'available' ? 'Vuelve a revisar en unos minutos.' : '¡Acepta un pedido para empezar!'}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: FontSize.xxxl, fontWeight: '800', color: Colors.text, paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
  tabContainer: { flexDirection: 'row', paddingHorizontal: Spacing.xl, marginTop: Spacing.lg, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tab: { flex: 1, paddingVertical: Spacing.md, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textMuted, fontWeight: '600' },
  tabTextActive: { color: Colors.primary, fontWeight: '700' },
  list: { padding: Spacing.xl, gap: Spacing.md, paddingBottom: 100 },
  orderCard: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg, borderWidth: 1, borderColor: Colors.border },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  businessName: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  paymentBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: BorderRadius.full },
  onlineBadge: { backgroundColor: `${Colors.statusAccepted}20` },
  cashBadge: { backgroundColor: `${Colors.warning}20` },
  paymentText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text },
  detailRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: 6 },
  detailText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: Spacing.lg },
  feeLabel: { fontSize: FontSize.xs, color: Colors.textMuted },
  feeValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.success },
  actions: { flexDirection: 'row', gap: Spacing.sm },
  acceptBtn: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.primary },
  acceptText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },
  statusUpdateBtn: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, borderRadius: BorderRadius.md },
  statusUpdateText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },
  emptyState: { alignItems: 'center', paddingTop: 100 },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.text, marginTop: Spacing.lg },
  emptySubtitle: { fontSize: FontSize.md, color: Colors.textMuted, marginTop: Spacing.xs },
});
