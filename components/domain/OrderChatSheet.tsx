import { useEffect, useRef, useState } from 'react';
import { View, FlatList, TextInput, StyleSheet, Alert } from 'react-native';
import { Sheet, Text, Icon, IconButton } from '../ui';
import { useOrderChat, useSendOrderMessage, useMarkOrderChatRead, useOrderFlow } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { apiMessage } from '../../lib/errors';
import { orderDate } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';
import type { OrderChatMessage } from '../../services/endpoints';

const MAX_LENGTH = 1000;

/**
 * El chat del pedido, como hoja modal.
 *
 * Vive dentro de la pantalla del pedido y no como una ruta propia: es una
 * conversación de acompañamiento, no un lugar al que se navega — igual que
 * el resto de hojas de la app (ver `Sheet` en `components/ui/Surface`).
 */
export function OrderChatSheet({
  visible,
  onClose,
  orderId,
}: {
  visible: boolean;
  onClose: () => void;
  orderId: string;
}) {
  const { c } = useTheme();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  const { data: flow } = useOrderFlow(orderId);
  const { data: messages, isLoading } = useOrderChat(visible ? orderId : undefined);
  const send = useSendOrderMessage(orderId);
  const markRead = useMarkOrderChatRead(orderId);

  const open = flow?.chat.available ?? true;
  const hasUnread = (flow?.chat.unread ?? 0) > 0;

  useEffect(() => {
    if (visible && hasUnread) markRead.mutate();
    // Solo al abrir y cuando hay algo pendiente: no hace falta reintentar
    // en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hasUnread]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    tap('light');
    setDraft('');
    send.mutate(text, {
      onSuccess: () => {
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      },
      onError: (error) => {
        tap('error');
        setDraft(text);
        Alert.alert('No se envió', apiMessage(error, 'Inténtalo de nuevo en un momento.'));
      },
    });
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Chat del pedido"
      height={0.85}
      scroll={false}
      footer={
        open ? (
          <View style={styles.composer}>
            <View style={[styles.field, { backgroundColor: c.surface, borderColor: c.border }]}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Escribe un mensaje…"
                placeholderTextColor={c.textMuted}
                style={[styles.input, { color: c.text }]}
                multiline
                maxLength={MAX_LENGTH}
                accessibilityLabel="Mensaje"
              />
            </View>
            <IconButton
              icon="enviar"
              label="Enviar mensaje"
              tone="primary"
              filled
              size={46}
              onPress={handleSend}
            />
          </View>
        ) : (
          <View style={[styles.closedNotice, { backgroundColor: c.surfaceLight }]}>
            <Icon name="candado" size="sm" color={c.textMuted} />
            <Text v="bodyS" tone="textMuted" style={styles.flex}>
              El chat de este pedido ya no está disponible.
            </Text>
          </View>
        )
      }
    >
      {isLoading ? (
        <View style={styles.center}>
          <Text v="bodyM" tone="textMuted">Cargando conversación…</Text>
        </View>
      ) : !messages?.length ? (
        <View style={styles.center}>
          <Icon name="chat" size="lg" color={c.textMuted} />
          <Text v="bodyM" tone="textMuted" center>
            Aún no hay mensajes. Coordina aquí la entrega.
          </Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => <Bubble message={item} />}
        />
      )}
    </Sheet>
  );
}

function Bubble({ message }: { message: OrderChatMessage }) {
  const { c } = useTheme();
  const mine = message.mine;

  return (
    <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
      <View
        style={[
          styles.bubble,
          mine
            ? { backgroundColor: c.primary, borderBottomRightRadius: 4 }
            : { backgroundColor: c.surfaceLight, borderBottomLeftRadius: 4 },
        ]}
      >
        <Text v="bodyM" color={mine ? c.textOnPrimary : c.text}>{message.message}</Text>
      </View>
      <View style={[styles.meta, mine && styles.metaMine]}>
        <Text v="caption" tone="textMuted">{orderDate(message.createdAt)}</Text>
        {mine ? (
          <Icon
            name={message.readAt ? 'checkCirculo' : 'check'}
            size="sm"
            color={message.readAt ? c.limeText : c.textMuted}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.xl },
  list: { padding: Spacing.xl, gap: Spacing.md },

  bubbleRow: { alignItems: 'flex-start', gap: 2, maxWidth: '84%' },
  bubbleRowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  bubble: {
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  metaMine: { flexDirection: 'row-reverse' },

  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm },
  field: {
    flex: 1,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    maxHeight: 120,
  },
  input: { fontSize: 15, maxHeight: 100, paddingVertical: 2 },

  closedNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
  },
});
