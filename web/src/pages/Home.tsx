import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import DeliverySimulator from '../components/DeliverySimulator';
import { LinkButton } from '../components/Button';
import { CustomerLogo, StoreLogo, DeliveryLogo } from '../components/logos';
import { supportWhatsAppUrl } from '../lib/contact';

const BUSINESS_URL = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';

type RoleTab = 'clientes' | 'comercios' | 'domiciliarios';

const ROLES: Record<RoleTab, {
  label: string;
  Illustration: typeof CustomerLogo;
  title: string;
  body: string;
  facts: [string, string][];
  cta: { label: string; href: string; external?: boolean };
}> = {
  clientes: {
    label: 'Clientes',
    Illustration: CustomerLogo,
    title: 'Sin sorpresas cuando llega la cuenta',
    body: 'Cada pedido muestra la distancia real entre el comercio y tu dirección. Si llueve o es hora pico, tu tarifa no cambia por eso.',
    facts: [
      ['Seguimiento', 'Ves al domiciliario en el mapa desde que sale'],
      ['Propina', '100% llega a quien te la trae'],
    ],
    cta: { label: 'Obtener la app', href: '#descargar' },
  },
  comercios: {
    label: 'Comercios',
    Illustration: StoreLogo,
    title: 'Vende a domicilio sin regalar tu margen',
    body: 'Las plataformas grandes descuentan hasta el 30% por pedido. Zipp cobra menos, despacha rápido y te avisa al instante en tu panel de cocina.',
    facts: [
      ['Alertas', 'Suenan apenas entra el pedido'],
      ['Repartidores', 'Los más cercanos, ya disponibles'],
    ],
    cta: { label: 'Acceder al portal de comercios', href: BUSINESS_URL, external: true },
  },
  domiciliarios: {
    label: 'Domiciliarios',
    Illustration: DeliveryLogo,
    title: 'Tu kilometraje vale y la propina es tuya',
    body: 'Ves el valor de la carrera y la propina antes de aceptar. Rutas directas, sin penalizaciones raras y sin que nadie te descuente de la propina.',
    facts: [
      ['Propina', '0% de comisión, la recibes completa'],
      ['Pagos', 'Liquidación clara de cada carrera'],
    ],
    cta: { label: 'Quiero repartir con Zipp', href: supportWhatsAppUrl('Hola, quiero repartir con Zipp. ¿Cómo empiezo?'), external: true },
  },
};

const ROLE_ORDER: RoleTab[] = ['clientes', 'comercios', 'domiciliarios'];

export default function Home() {
  const [activeTab, setActiveTab] = useState<RoleTab>('clientes');
  const role = ROLES[activeTab];
  const reduceMotion = useReducedMotion();

  return (
    <div className="bg-bg text-text-main selection:bg-primary selection:text-bg">
      {/* ── HERO ── */}
      {/* El hero se pinta ya, sin fundido: arrancaba invisible y no aparecía
          hasta que cargaba y corría el JavaScript de la animación, que es
          justo lo primero que alguien ve al entrar. El resto de secciones
          conserva sus animaciones. */}
      <section id="inicio" className="px-6 sm:px-10 pt-16 pb-20 sm:pt-24 sm:pb-28">
        <div className="mx-auto max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-14 items-center">
          <div className="lg:col-span-7 min-w-0">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1] text-text-main max-w-xl">
              Pide en tus negocios de siempre. Paga justo por el domicilio.
            </h1>

            <p className="mt-6 text-lg text-text-secondary max-w-md leading-relaxed">
              La tarifa se calcula por distancia real — sin recargos por lluvia ni por demanda.
              El 100% de la propina llega a quien te lo trae.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <LinkButton href="#descargar" variant="primary">
                Obtener la app
              </LinkButton>
              <LinkButton href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" variant="secondary">
                Portal de comercios
              </LinkButton>
            </div>
          </div>

          <div className="lg:col-span-5 min-w-0">
            <img
              src="/zipp-phone-mockup.webp"
              alt="La app de Zipp en un teléfono"
              width={900}
              height={900}
              fetchPriority="high"
              className="w-full h-auto rounded-lg"
            />
          </div>
        </div>
      </section>

      {/* ── CALCULADORA DE TARIFA ── */}
      <section id="simulador" className="bg-bg-alt px-6 sm:px-10 py-20 sm:py-24">
        <DeliverySimulator />
      </section>

      {/* ── ROLES ── */}
      <section id="operaciones" className="px-6 sm:px-10 py-20 sm:py-24">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-main max-w-lg">
            Hecho para clientes, comercios y domiciliarios
          </h2>

          <div className="mt-10 flex gap-8 border-b border-border">
            {ROLE_ORDER.map((tab) => {
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`pb-4 -mb-px text-sm font-medium border-b-2 transition-colors ${
                    active
                      ? 'border-primary text-text-main'
                      : 'border-transparent text-text-secondary hover:text-text-main'
                  }`}
                >
                  {ROLES[tab].label}
                </button>
              );
            })}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] as const }}
              className="mt-14 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center"
            >
              <div className="lg:col-span-4 flex justify-center lg:justify-start">
                <role.Illustration size={140} />
              </div>

              <div className="lg:col-span-8">
                <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-text-main">{role.title}</h3>
                <p className="mt-3 text-[15px] text-text-secondary leading-relaxed max-w-xl">
                  {role.body}
                </p>

                <div className="mt-8 pt-6 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-xl">
                  {role.facts.map(([label, value]) => (
                    <div key={label}>
                      <span className="text-xs text-text-muted block mb-1">{label}</span>
                      <span className="text-text-main text-sm font-medium">{value}</span>
                    </div>
                  ))}
                </div>

                <LinkButton
                  href={role.cta.href}
                  {...(role.cta.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  variant="primary"
                  className="mt-8"
                >
                  {role.cta.label}
                </LinkButton>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      {/* ── DESCARGA ── */}
      <section id="descargar" className="bg-bg-alt px-6 sm:px-10 py-20 sm:py-24">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-end sm:justify-between gap-8">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-main">
              ZIPP está en fase piloto
            </h2>
            <p className="mt-3 text-[15px] text-text-secondary leading-relaxed max-w-md">
              Todavía no está publicada en App Store ni Google Play. Escríbenos y te avisamos
              apenas esté disponible para descargar.
            </p>
          </div>
          <LinkButton
            href={supportWhatsAppUrl('Hola, quiero que me avisen cuando la app de Zipp esté disponible.')}
            target="_blank"
            rel="noopener noreferrer"
            variant="primary"
            className="shrink-0"
          >
            Avísenme cuando esté disponible
          </LinkButton>
        </div>
      </section>
    </div>
  );
}
