import { View, ScrollView, StyleSheet, Share } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import {
  Text, Card, DetailRow, Screen, Header, LoadingScreen, ErrorState, IconButton,
} from '../../components/ui';
import { useReceipt } from '../../hooks/useApi';
import { money, orderDate, orderCode } from '../../lib/format';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * El comprobante de un pedido.
 *
 * El endpoint existía desde siempre (`GET /orders/:id/receipt`) y ninguna
 * pantalla lo pedía: un pedido entregado no tenía forma de mostrar su
 * comprobante. Al conectarlo apareció además un fallo real — el
 * controlador enseñaba la comisión interna de ZIPP y el subsidio del
 * comercio a **cualquier cliente** que abriera su propio recibo, que se
 * corrigió en el servidor antes de construir esta pantalla.
 */
export default function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: receipt, isLoading, isError, refetch } = useReceipt(id);

  const share = async () => {
    if (!receipt) return;
    tap('light');
    try {
      await Share.share({
        message:
          `Comprobante Zipp ${receipt.orderNumber ?? orderCode(id)}\n` +
          `${receipt.business?.name ?? ''}\n` +
          `Total: ${money(receipt.totalPagado)}`,
      });
    } catch {
      // Cancelar la hoja de compartir no es un error.
    }
  };

  if (isLoading) return <LoadingScreen message="Buscando tu comprobante…" />;

  if (isError || !receipt) {
    return (
      <Screen>
        <Header title="Comprobante" fallback="/(client)/orders" />
        <ErrorState
          title="No encontramos este comprobante"
          message="Puede que el pedido no exista o no sea tuyo."
          onRetry={refetch}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="Comprobante"
        subtitle={receipt.orderNumber ?? orderCode(id)}
        fallback="/(client)/orders"
        right={<IconButton icon="compartir" label="Compartir el comprobante" onPress={share} />}
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Card style={styles.header}>
          <Text v="titleM" center>{receipt.business?.name ?? 'Zipp'}</Text>
          <Text v="bodyS" tone="textMuted" center>{orderDate(receipt.createdAt)}</Text>
        </Card>

        <Card style={styles.breakdown}>
          <Text v="label" tone="textMuted">Productos</Text>
          {receipt.items?.map((item: any, index: number) => (
            <DetailRow
              key={`${item.productId ?? index}`}
              label={`${item.quantity}× ${item.productName ?? item.name ?? ''}`}
              value={money(item.totalPrice ?? item.unitPrice * item.quantity)}
            />
          ))}

          <View style={styles.divider} />

          <DetailRow label="Subtotal" value={money(receipt.valorProductos)} />
          {receipt.valorDomicilio ? (
            <DetailRow label="Envío" value={money(receipt.valorDomicilio)} />
          ) : null}
          {receipt.descuentos ? (
            <DetailRow label="Descuento" value={`−${money(receipt.descuentos)}`} tone="successText" />
          ) : null}
          {receipt.propina ? <DetailRow label="Propina" value={money(receipt.propina)} /> : null}
          {receipt.impuestos ? <DetailRow label="Impuestos" value={money(receipt.impuestos)} /> : null}

          <View style={styles.divider} />
          <DetailRow label="Total pagado" value={money(receipt.totalPagado)} strong />
        </Card>

        <Text v="caption" tone="textMuted" center>
          Comprobante de {receipt.orderNumber ?? orderCode(id)} · {receipt.paymentStatus === 'paid' ? 'Pagado' : receipt.paymentStatus}
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },
  header: { alignItems: 'center', gap: Spacing.xs },
  breakdown: { gap: Spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(128,128,128,0.2)', marginVertical: Spacing.xs },
});
