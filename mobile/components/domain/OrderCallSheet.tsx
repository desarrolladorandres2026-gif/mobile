import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Sheet, Text, Icon, Button, IconButton } from '../ui';
import { useOrderFlow, useStartCall, useAnswerCall, useEndCall } from '../../hooks/useApi';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';
import type { OrderCallView } from '../../services/endpoints';

/** mm:ss a partir de segundos enteros. */
function clock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Sesión de llamada del pedido.
 *
 * IMPORTANTE — esto es una sesión, no todavía una llamada con voz: avisa a
 * la otra parte en tiempo real, dentro de la app, sin exponer el teléfono
 * de nadie, y deja un registro exacto de inicio y fin. El transporte de
 * audio (WebRTC o un puente telefónico) es la pieza que falta conectar —
 * el modelo, la autorización y la señalización ya están listos para
 * recibirla, así que activarla no toca nada de lo que hay aquí.
 *
 * Por eso la pantalla "conectado" no simula una llamada de voz en curso:
 * dice lo que es de verdad — que la otra persona ya lo sabe — y ofrece el
 * chat como el canal que sí lleva el mensaje.
 */
export function OrderCallSheet({
  visible,
  onClose,
  orderId,
  orderNumber,
  startOnOpen,
  onOpenChat,
}: {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  orderNumber: string;
  /** true cuando esta apertura viene de que YO pulsé "Llamar". */
  startOnOpen: boolean;
  onOpenChat: () => void;
}) {
  const { c } = useTheme();
  const myUserId = useAuthStore((s) => s.user?._id);

  const { data: flow } = useOrderFlow(visible ? orderId : undefined);
  const startCall = useStartCall(orderId);
  const answerCall = useAnswerCall(orderId);
  const endCall = useEndCall(orderId);

  const call = flow?.call.active ?? null;
  const hadCallRef = useRef(false);
  const [justEnded, setJustEnded] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const startedOnceRef = useRef(false);

  // Pide la sesión al abrir, solo cuando la apertura fue mía.
  useEffect(() => {
    if (visible && startOnOpen && !startedOnceRef.current) {
      startedOnceRef.current = true;
      startCall.mutate();
    }
    if (!visible) startedOnceRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, startOnOpen]);

  // Si había una llamada y desapareció (el servidor la cerró: contestada
  // en otro lado, colgada, o se dio por perdida), lo mostramos un
  // instante y cerramos solos — nadie se queda mirando una hoja vacía.
  useEffect(() => {
    if (call) {
      hadCallRef.current = true;
      setJustEnded(false);
    } else if (hadCallRef.current) {
      hadCallRef.current = false;
      setJustEnded(true);
      const t = setTimeout(() => { setJustEnded(false); onClose(); }, 1800);
      return () => clearTimeout(t);
    }
  }, [call]);

  // Cronómetro de la sesión activa. Es tiempo real de sesión —arranca
  // cuando se contesta—, no tiempo hablando: no hay audio que medir.
  useEffect(() => {
    if (call?.status !== 'active' || !call.answeredAt) { setSeconds(0); return; }
    const start = new Date(call.answeredAt).getTime();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [call?.status, call?.answeredAt]);

  if (!visible) return null;

  const iAmCaller = call?.caller.userId === myUserId;
  const other: OrderCallView['caller'] | undefined = call
    ? (iAmCaller ? call.receiver : call.caller)
    : undefined;

  const hangUp = (reason: string) => {
    tap('light');
    if (call) endCall.mutate({ callId: call.id, reason });
    else onClose();
  };

  return (
    <Sheet visible={visible} onClose={() => hangUp('cerrada')} title={`Pedido #${orderNumber}`} height={0.55} scroll={false}>
      <View style={styles.body}>
        {!call && !justEnded ? (
          <>
            <View style={[styles.avatar, { backgroundColor: c.primarySoft }]}>
              <Icon name="llamando" size="lg" color={c.primaryText} />
            </View>
            <Text v="titleM">Preparando la llamada…</Text>
          </>
        ) : justEnded ? (
          <>
            <View style={[styles.avatar, { backgroundColor: c.surfaceLight }]}>
              <Icon name="colgar" size="lg" color={c.textMuted} />
            </View>
            <Text v="titleM" tone="textMuted">Sesión finalizada</Text>
          </>
        ) : call!.status === 'ringing' && !iAmCaller ? (
          <IncomingCall
            name={other!.name}
            avatar={other!.avatar}
            onReject={() => hangUp('rechazada')}
            onAnswer={() => { tap('medium'); answerCall.mutate(call!.id); }}
          />
        ) : call!.status === 'ringing' ? (
          <>
            <PulsingAvatar name={other?.name} avatar={other?.avatar} />
            <Text v="titleM">Avisando a {other?.name ?? 'la otra persona'}…</Text>
            <Text v="bodyS" tone="textMuted" center>
              Le llegó un aviso en la app. Si no responde, escríbele por el chat.
            </Text>
            <Button title="Cancelar" variant="secondary" icon="colgar" onPress={() => hangUp('cancelada')} />
          </>
        ) : (
          <>
            <View style={[styles.avatar, { backgroundColor: c.limeSoft }]}>
              <Icon name="checkCirculo" size="lg" color={c.limeText} />
            </View>
            <Text v="titleM">{other?.name ?? 'Conectado'} ya lo sabe</Text>
            <Text v="dataM" tone="textMuted">{clock(seconds)}</Text>
            <View style={[styles.notice, { backgroundColor: c.warningSoft }]}>
              <Icon name="info" size="sm" color={c.warningText} />
              <Text v="bodyS" tone="warningText" style={styles.flex}>
                Esta versión avisa en la app; todavía no lleva voz. Usa el chat para
                coordinar los detalles.
              </Text>
            </View>
            <View style={styles.actions}>
              <Button title="Abrir chat" icon="chat" variant="secondary" onPress={onOpenChat} />
              <IconButton icon="colgar" label="Terminar" tone="danger" size={52} onPress={() => hangUp('finalizada')} />
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}

function IncomingCall({
  name, avatar, onAnswer, onReject,
}: { name: string; avatar: string | null; onAnswer: () => void; onReject: () => void }) {
  return (
    <>
      <PulsingAvatar name={name} avatar={avatar} />
      <Text v="titleM">{name} te está llamando</Text>
      <Text v="bodyS" tone="textMuted" center>Sobre este pedido. Contesta para avisarle que lo viste.</Text>
      <View style={styles.actions}>
        <IconButton icon="colgar" label="Rechazar" tone="danger" size={56} onPress={onReject} />
        <IconButton icon="llamar" label="Contestar" tone="lime" filled size={56} onPress={onAnswer} />
      </View>
    </>
  );
}

function PulsingAvatar({ name, avatar }: { name?: string; avatar?: string | null }) {
  const { c } = useTheme();
  const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={[styles.avatar, { backgroundColor: c.primary }]}>
      <Text v="displayM" color={c.textOnPrimary}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.xl },
  avatar: {
    width: 84, height: 84, borderRadius: 42,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xl, marginTop: Spacing.md },
  notice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    padding: Spacing.md, borderRadius: BorderRadius.lg, marginTop: Spacing.sm,
  },
});
