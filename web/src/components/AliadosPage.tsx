import { useEffect, useState } from 'react';
import { PartnerForm } from './PartnerForm';
import { BUSINESS_URL } from '../lib/config';
import { setPageMeta } from '../lib/meta';
import { listCities, type PartnerType } from '../lib/publicApi';

const COPY: Record<PartnerType, {
  title: string;
  description: string;
  path: string;
  intro: string;
  steps: string[];
}> = {
  business: {
    title: 'Vende en ZIPP',
    description: 'Registra tu comercio en ZIPP: recibe pedidos en tu panel y despacha con repartidores cerca de tu local.',
    path: '/unete-comercio',
    intro:
      'Recibe los pedidos en tu panel de cocina, con aviso sonoro apenas entran, y despacha con los repartidores disponibles más cerca de tu local.',
    steps: [
      'Envías esta solicitud y confirmas tu celular.',
      'Te contactamos por WhatsApp para validar los datos del negocio.',
      'Entras al portal de comercios y subes los documentos: RUT, certificado bancario, cédula del representante legal y Cámara de Comercio si eres empresa.',
      'Cargas tu menú con foto, descripción y precio de cada producto.',
      'Administración revisa y activa tu comercio.',
    ],
  },
  driver: {
    title: 'Reparte con ZIPP',
    description: 'Solicita ser repartidor de ZIPP. Ves el valor de la carrera y la propina antes de aceptar.',
    path: '/repartidores',
    intro:
      'Ves el valor de la carrera y la propina antes de aceptar. La propina llega completa a quien entrega, sin comisión.',
    steps: [
      'Envías esta solicitud y confirmas tu celular.',
      'Te contactamos por WhatsApp.',
      'Te registras como cliente en la app con ese mismo celular y subes tus documentos: cédula, licencia y papeles del vehículo si aplica.',
      'Verificamos tu identidad y tus documentos.',
      'Cuando te aprobamos, recibes pedidos cerca de ti.',
    ],
  },
};

export function AliadosPage({ type }: { type: PartnerType }) {
  const copy = COPY[type];
  const [cities, setCities] = useState<string[]>([]);

  useEffect(() => {
    setPageMeta({ title: `${copy.title} | ZIPP`, description: copy.description, path: copy.path });
  }, [copy]);

  useEffect(() => {
    let cancelled = false;
    listCities().then((c) => { if (!cancelled) setCities(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">{copy.title}</h1>
      <p className="mt-3 text-base text-text-secondary">{copy.intro}</p>

      <h2 className="mt-8 text-xl font-semibold text-text-main">Cómo funciona</h2>
      <ol className="mt-2 list-decimal pl-6 text-base text-text-main">
        {copy.steps.map((s) => <li key={s} className="py-1">{s}</li>)}
      </ol>

      {type === 'business' && (
        <p className="mt-6 text-base text-text-secondary">
          ¿Ya tienes cuenta de comercio?{' '}
          <a href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary-text underline underline-offset-4">
            Entra al portal
          </a>
          .
        </p>
      )}

      <PartnerForm type={type} cities={cities} />
    </div>
  );
}
