import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, MailOpen, X } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { normalizeRole, ROLE_LABELS } from '../lib/permissions';

/**
 * Invitaciones al equipo de un negocio que esta cuenta no ha respondido.
 *
 * Una invitación no da ningún acceso hasta que la persona la acepta, así
 * que quien recién fue invitado entra al panel sin ningún local: sin esta
 * lista no tendría forma de saber por qué ni de entrar. Va arriba de cada
 * página porque no depende de ningún negocio seleccionado.
 */
interface Invitation {
  _id: string;
  role: string;
  createdAt: string;
  businessId?: { _id: string; name?: string } | null;
}

const INVITATIONS_KEY = ['account', 'invitations'] as const;

export default function PendingInvitations({ onAccepted }: { onAccepted: () => unknown }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const { data: invitations = [] } = useQuery({
    queryKey: INVITATIONS_KEY,
    queryFn: async () => (await api.get('/businesses/my/invitations')).data.data as Invitation[],
    staleTime: 60_000,
    retry: false,
  });

  if (invitations.length === 0) return null;

  const respond = async (invitation: Invitation, accept: boolean) => {
    setBusy(invitation._id);
    setError('');
    try {
      await api.post(`/businesses/my/invitations/${invitation._id}`, { accept });
      await queryClient.invalidateQueries({ queryKey: INVITATIONS_KEY });
      // Al aceptar, el local aparece en el selector sin recargar.
      if (accept) await onAccepted();
    } catch (err) {
      setError(apiMessage(err, 'No pudimos responder la invitación.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Invitaciones pendientes" className="space-y-2">
      {invitations.map((invitation) => {
        const role = normalizeRole(invitation.role);
        const businessName = invitation.businessId?.name ?? 'un negocio';
        return (
          <div key={invitation._id} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <MailOpen className="w-4 h-4 shrink-0 text-[var(--color-primary)]" />
            <p className="flex-1 min-w-48 text-[var(--color-text-main)]">
              Te invitaron a <strong>{businessName}</strong>
              {role ? <> como <strong>{ROLE_LABELS[role]}</strong></> : null}. Solo entras cuando aceptes.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => respond(invitation, true)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                <Check className="w-3.5 h-3.5" />
                {busy === invitation._id ? 'Guardando…' : 'Aceptar'}
              </button>
              <button
                onClick={() => respond(invitation, false)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                <X className="w-3.5 h-3.5" />
                Rechazar
              </button>
            </div>
          </div>
        );
      })}
      {error && <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
    </section>
  );
}
