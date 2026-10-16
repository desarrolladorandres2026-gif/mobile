import { useEffect, useRef, useState } from 'react';
import { View, FlatList, TextInput, StyleSheet, Alert, Pressable } from 'react-native';
import { Sheet, Text, Icon, IconButton, CountBadge } from '../ui';
import { useOrderChat, useSendOrderMessage, useMarkOrderChatRead, useOrderFlow } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { apiMessage } from '../../lib/errors';
import { orderDate } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { IS_DRIVER_APP } from '../../constants/variant';
import { DEFAULT_CHAT_CHANNEL, initialChatChannel, unreadByChannel, type ChatChannel } from '../../lib/orderChat';
import type { OrderChatMessage } from '../../services/endpoints';

const MAX_LENGTH = 1000;

/** Lo que cambia entre los dos hilos del domiciliario. */
const THREADS: Record<ChatChannel, { tab: string; placeholder: string; empty: string; counterpart: string }> = {
  client_driver: {
    tab: 'Cliente',
    placeholder: 'Escribe un mensaje…',
    empty: 'Aún no hay mensajes. Coordina aquí la entrega.',
    counterpart: 'Cliente',
  },
  business_driver: {
    tab: 'Comercio',
    placeholder: 'Escríbele al comercio…',
    empty: 'Aún no hay mensajes con el comercio. Escríbele si necesitas coordinar la recogida.',
    counterpart: 'Comercio',
  },
};

const TAB_ORDER: ChatChannel[] = ['client_driver', 'business_driver'];

/**
 * El chat del pedido, como hoja modal.
 *
 * En la app del domiciliario tiene dos hilos —Cliente y Comercio— cada uno
 * con su contador de no leídos. En la del cliente es un solo hilo y no se
 * enseña nada de lo otro.
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
  const [channel, setChannel] = useState<ChatChannel>(DEFAULT_CHAT_CHANNEL);
  // Un borrador por hilo: cambiar de segmento no debe pisar lo que se escribía.
  const [drafts, setDrafts] = useState<Record<ChatChannel, string>>({
    client_driver: '',
    business_driver: '',
  });
  const listRef = useRef<FlatList>(null);

  // La pantalla que monta el chat ya sondea este mismo estado.
  const { data: flow } = useOrderFlow(orderId, { poll: false });
  const { data: messages, isLoading } = useOrderChat(visible ? orderId : undefined, channel);
  const send = useSendOrderMessage(orderId);
  const markRead = useMarkOrderChatRead(orderId);

  const unread = unreadByChannel(flow?.chat);
  const open = flow?.chat.available ?? true;
  const hasUnread = unread[channel] > 0;
  const draft = drafts[channel];
  const thread = THREADS[channel];

  // Al abrir, el segmento con novedades; en la app del cliente, siempre el suyo.
  useEffect(() => {
    if (!visible) return;
    setChannel(IS_DRIVER_APP ? initialChatChannel(flow?.chat) : DEFAULT_CHAT_CHANNEL);
    // Solo al abrir: si llega algo mientras está abierta no se cambia de hilo
    // debajo de los dedos de quien escribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Solo se marca el hilo que se está viendo.
  useEffect(() => {
    if (visible && hasUnread) markRead.mutate(channel);
    // Solo al abrir / cambiar de hilo y cuando hay algo pendiente: no hace
    // falta reintentar en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hasUnread, channel]);

  const setDraft = (value: string) => setDrafts((d) => ({ ...d, [channel]: value }));

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    const sentIn = channel;
    tap('light');
    setDrafts((d) => ({ ...d, [sentIn]: '' }));
    send.mutate({ message: text, channel: sentIn }, {
      onSuccess: () => {
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      },
      onError: (error) => {
        tap('error');
        setDrafts((d) => ({ ...d, [sentIn]: text }));
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
                placeholder={thread.placeholder}
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
      <View style={styles.flex}>
        {IS_DRIVER_APP ? (
          <ThreadTabs active={channel} unread={unread} onChange={setChannel} />
        ) : null}
        {isLoading ? (
          <View style={styles.center}>
            <Text v="bodyM" tone="textMuted">Cargando conversación…</Text>
          </View>
        ) : !messages?.length ? (
          <View style={styles.center}>
            <Icon name="chat" size="lg" color={c.textMuted} />
            <Text v="bodyM" tone="textMuted" center>
              {thread.empty}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item }) => (
              <Bubble message={item} senderLabel={IS_DRIVER_APP ? thread.counterpart : undefined} />
            )}
          />
        )}
      </View>
    </Sheet>
  );
}

/** Segmentos Cliente / Comercio con su contador. Sin cajas: texto y subrayado. */
function ThreadTabs({
  active,
  unread,
  onChange,
}: {
  active: ChatChannel;
  unread: Record<ChatChannel, number>;
  onChange: (channel: ChatChannel) => void;
}) {
  const { c } = useTheme();

  return (
    <View style={[styles.tabs, { borderBottomColor: c.border }]} accessibilityRole="tablist">
      {TAB_ORDER.map((key) => {
        const selected = key === active;
        return (
          <Pressable
            key={key}
            onPress={() => { if (!selected) { tap('select'); onChange(key); } }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              unread[key] > 0 ? `${THREADS[key].tab}, ${unread[key]} sin leer` : THREADS[key].tab
            }
            style={[styles.tab, selected && { borderBottomColor: c.primary }]}
          >
            <Text v={selected ? 'strongM' : 'bodyM'} tone={selected ? 'text' : 'textSecondary'}>
              {THREADS[key].tab}
            </Text>
            <CountBadge count={unread[key]} />
          </Pressable>
        );
      })}
    </View>
  );
}

function Bubble({ message, senderLabel }: { message: OrderChatMessage; senderLabel?: string }) {
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
        {!mine && senderLabel ? (
          <Text v="captionStrong" tone="textSecondary">{senderLabel}</Text>
        ) : null}
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

  tabs: {
    flexDirection: 'row',
    gap: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    borderBottomWidth: 1,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.sm + 2,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -1,
  },

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
