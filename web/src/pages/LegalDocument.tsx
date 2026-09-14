import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getLegalDocuments, type LegalDocument as LegalDocumentType } from '../lib/api';
import { supportWhatsAppUrl } from '../lib/contact';
import { LinkButton } from '../components/Button';

const KIND_TITLE: Record<string, string> = {
  terms: 'Términos y condiciones',
  privacy: 'Política de privacidad',
  habeas_data: 'Autorización de tratamiento de datos',
};

/**
 * Igual que `mobile/app/(client)/legal-document.tsx`: si el documento existe
 * se muestra tal cual lo publicó Zipp; si no, se dice así y se ofrece pedirlo
 * por WhatsApp. Nunca se inventa contenido legal ni un texto de relleno.
 */
export default function LegalDocument() {
  const { kind = '' } = useParams<{ kind: string }>();
  const [documents, setDocuments] = useState<LegalDocumentType[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getLegalDocuments()
      .then((docs) => { if (!cancelled) setDocuments(docs); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  const title = KIND_TITLE[kind] ?? 'Documento legal';
  const document = documents?.find((d) => d.kind === kind);

  return (
    <div className="bg-bg text-text-main px-6 sm:px-10 py-20 sm:py-24 min-h-[60vh]">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{title}</h1>

        {documents === null && !error && (
          <p className="mt-8 text-sm text-text-secondary">Cargando…</p>
        )}

        {error && (
          <p className="mt-8 text-sm text-text-secondary">
            No pudimos cargar el documento. Revisa tu conexión e inténtalo de nuevo.
          </p>
        )}

        {document && (
          <div className="mt-10 pt-8 border-t border-border">
            <p className="text-xs text-text-muted">
              Versión {document.version} · vigente desde{' '}
              {new Date(document.effectiveAt).toLocaleDateString('es-CO')}
            </p>
            <p className="mt-6 text-[15px] text-text-secondary leading-relaxed whitespace-pre-line">
              {document.content}
            </p>
          </div>
        )}

        {documents && !document && (
          <div className="mt-10 pt-8 border-t border-border">
            <p className="text-sm font-medium text-text-main">
              Este documento aún no está publicado
            </p>
            <p className="mt-2 text-sm text-text-secondary max-w-sm">
              Todavía no hay una versión vigente. Escríbenos y te la hacemos llegar.
            </p>
            <LinkButton
              href={supportWhatsAppUrl(`Hola, quiero consultar el documento "${title}" de Zipp.`)}
              target="_blank"
              rel="noopener noreferrer"
              variant="primary"
              className="mt-6"
            >
              Pedirlo por WhatsApp
            </LinkButton>
          </div>
        )}
      </div>
    </div>
  );
}
