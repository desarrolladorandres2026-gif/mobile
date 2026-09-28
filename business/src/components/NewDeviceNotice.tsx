import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { usePreferencesStore } from '../stores/preferencesStore';
import { playNotificationSound } from '../lib/notificationSound';

/**
 * Una línea arriba de cada página cuando se abrió la cuenta desde un
 * dispositivo que no se había visto. El aviso lo guarda el servidor al
 * iniciar sesión (`securityEvent.service.ts`) como notificación, así que
 * también lo ve quien no tenía el panel abierto en ese momento.
 *
 * "Fui yo" lo marca como leído. Si no fue la persona, el enlace la lleva a
 * sus sesiones activas para cerrar la que no reconozca.
 */

interface NotificationItem {
  _id: string;
  body: string;
  isRead: boolean;
  createdAt: string;
  data?: { kind?: string };
}

export default function NewDeviceNotice() {
  const queryClient = useQueryClient();
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled);
  const { data: notice } = useQuery({
    queryKey: qk.accountNotifications(),
    queryFn: async () => (await api.get('/notifications', { params: { limit: 20 } })).data.data as NotificationItem[],
    select: (items) => items.find((n) => !n.isRead && n.data?.kind === 'new_device') ?? null,
    retry: false,
    staleTime: 60_000,
  });

  const acknowledge = useMutation({
    mutationFn: async (id: string) => api.patch(`/notifications/${id}/read`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.accountNotifications() }),
  });

  useEffect(() => {
    if (!notice || !soundEnabled) return;
    const key = `business_notification_sound:${notice._id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, 'played');
    } catch {
      // Si el navegador bloquea storage, el sonido sigue siendo opcional.
    }
    playNotificationSound('attention');
  }, [notice, soundEnabled]);

  if (!notice) return null;

  const when = new Date(notice.createdAt).toLocaleString('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

  return (
    <p role="status" className="flex items-start gap-2 text-xs font-semibold text-[var(--color-warning)]">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {notice.body} <span className="text-[var(--color-text-muted)] font-medium">({when})</span>{' '}
        <Link to="/settings#sesiones" className="underline underline-offset-2">Revisar sesiones</Link>
        {' · '}
        <button
          type="button"
          onClick={() => acknowledge.mutate(notice._id)}
          className="underline underline-offset-2 text-[var(--color-text-secondary)]"
        >
          Fui yo
        </button>
      </span>
    </p>
  );
}
