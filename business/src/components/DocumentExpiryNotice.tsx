import { useQuery } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { qk } from '../lib/queryKeys';

/**
 * Una línea arriba de cada página mientras haya un papel vencido o por vencer
 * en 30 días. El panel web no recibe push, así que esto es lo que ve el
 * dueño que no tiene la app; la push (`documentExpiry.service`) le llega a
 * quien sí la tiene.
 *
 * Solo el dueño puede listar los documentos: para el personal la consulta
 * responde 403 y aquí no se pinta nada.
 */

const LABELS: Record<string, string> = {
  rut: 'RUT',
  chamber_of_commerce: 'certificado de Cámara de Comercio',
  legal_rep_id: 'cédula del representante legal',
  bank_certificate: 'certificación bancaria',
  health_permit: 'concepto sanitario',
};

const DAY = 24 * 60 * 60 * 1000;

interface Doc {
  type: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt?: string;
}

const dayOf = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });

/** Vencidos y por vencer en 30 días, el más próximo primero. */
function classify(docs: Doc[], now: number) {
  const relevant = docs.filter((d) => d.expiresAt && (d.status === 'approved' || d.status === 'expired'));
  const expired = relevant.filter((d) => d.status === 'expired' || new Date(d.expiresAt!).getTime() <= now);
  const soon = relevant
    .filter((d) => !expired.includes(d) && new Date(d.expiresAt!).getTime() - now <= 30 * DAY)
    .sort((a, b) => new Date(a.expiresAt!).getTime() - new Date(b.expiresAt!).getTime());
  return { expired, soon };
}

export default function DocumentExpiryNotice({ businessId }: { businessId: string }) {
  const { data } = useQuery({
    queryKey: qk.documents(businessId),
    queryFn: async () => (await api.get(`/businesses/${businessId}/documents`)).data.data as Doc[],
    select: (docs) => classify(docs ?? [], Date.now()),
    retry: false,
    staleTime: 10 * 60_000,
  });

  if (!data) return null;
  const { expired, soon } = data;
  if (expired.length === 0 && soon.length === 0) return null;

  const message = expired.length > 0
    ? `Tu ${expired.map((d) => LABELS[d.type] ?? d.type).join(', ')} ${expired.length === 1 ? 'venció' : 'vencieron'}: no recibes pedidos hasta que ${expired.length === 1 ? 'lo subas' : 'los subas'} de nuevo.`
    : `Tu ${LABELS[soon[0].type] ?? soon[0].type} vence el ${dayOf(soon[0].expiresAt!)}${soon.length > 1 ? ` (y ${soon.length - 1} más este mes)` : ''}. Súbelo renovado para no dejar de recibir pedidos.`;

  return (
    <p className={`flex items-start gap-2 text-xs font-semibold ${expired.length > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]'}`}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {message}{' '}
        <Link to="/documents" className="underline underline-offset-2">Ir a Documentos</Link>
      </span>
    </p>
  );
}
