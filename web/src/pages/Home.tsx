import { useState } from 'react';
import DeliverySimulator from '../components/DeliverySimulator';
import { PeopleIllustration, StoreIllustration, DeliveryIllustration } from '../components/illustrations';

const BUSINESS_URL = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';

type RoleTab = 'clientes' | 'comercios' | 'domiciliarios';

export default function Home() {
  const [activeTab, setActiveTab] = useState<RoleTab>('clientes');

  return (
    <div className="relative min-h-screen bg-[#06080C] text-white selection:bg-[#E5B242] selection:text-black">
      {/* ── HERO CINEMÁTICO DE ALTO IMPACTO (FOTOGRAFÍA REAL & PROFUNDIDAD) ── */}
      <section id="inicio" className="relative min-h-[92vh] flex flex-col justify-between overflow-hidden border-b border-white/10">
        {/* Capa de fondo con la escena cinematográfica nocturna de delivery */}
        <div className="absolute inset-0 z-0">
          <img
            src="/zipp-delivery-night.jpg"
            alt="ZIPP Delivery Nocturno de Alta Gama"
            className="w-full h-full object-cover object-center opacity-40 filter brightness-[0.75] contrast-125 scale-105 transition-transform duration-1000"
          />
          {/* Degradado para fundir con la interfaz */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#06080C] via-[#06080C]/70 to-[#06080C]/40" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#06080C] via-transparent to-[#06080C]/80" />
        </div>

        {/* Barra superior de estado de red */}
        <div className="relative z-10 mx-auto w-full max-w-7xl px-6 sm:px-10 pt-10">
          <div className="flex flex-wrap items-center justify-between gap-4 font-mono text-xs border-b border-white/10 pb-4">
            <div className="flex items-center gap-3 text-zinc-400">
              <span className="h-2 w-2 rounded-full bg-[#10B981]" />
              <span className="tracking-widest uppercase">DISPATCH PROTOCOL // SISTEMA ACTIVO</span>
            </div>
            <div className="text-zinc-500 hidden sm:block">
              LAT 04°38'N • LON 74°05'W • VELOCIDAD DE DESPACHO DIRECTO
            </div>
          </div>
        </div>

        {/* Contenido Central Hero */}
        <div className="relative z-10 mx-auto w-full max-w-7xl px-6 sm:px-10 py-16 sm:py-24 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          {/* Columna Texto Editorial */}
          <div className="lg:col-span-7">
            <span className="font-mono text-xs uppercase tracking-[0.3em] text-[#E5B242] block mb-4">
              Arquitectura de Domicilios de Alta Gama
            </span>
            <h1 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tighter uppercase leading-[0.95]">
              Velocidad pura.{' '}
              <span className="text-zinc-400 block">
                Cero especulación.
              </span>
            </h1>

            <p className="mt-8 text-base sm:text-lg text-zinc-300 max-w-xl font-normal leading-relaxed">
              ZIPP conecta comercios locales con sus clientes mediante cálculo métrico de distancia satelital. Sin tarifas dinámicas por lluvia, sin recargos arbitrarios y con el 100% de la propina directamente en manos de quien realiza la entrega.
            </p>

            {/* Disparadores de Acción */}
            <div className="mt-10 flex flex-wrap items-center gap-5 font-mono">
              <a
                href="#descargar"
                className="px-8 py-4 text-xs font-bold uppercase tracking-widest text-black bg-[#E5B242] transition-all hover:bg-white shadow-[0_10px_30px_rgba(229,178,66,0.2)]"
              >
                Obtener App Móvil
              </a>

              <a
                href={BUSINESS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="px-8 py-4 text-xs font-bold uppercase tracking-widest text-white border border-white/20 bg-black/40 backdrop-blur-md transition-all hover:border-[#E5B242] hover:text-[#E5B242]"
              >
                Portal de Comercios ↗
              </a>

              <a
                href="#simulador"
                className="text-xs uppercase tracking-widest text-zinc-400 hover:text-white transition-colors"
              >
                [ Probar Telemetría de Tarifas ↓ ]
              </a>
            </div>
          </div>

          {/* Columna Vitrina de Dispositivo (Mockup 3D Espacial) */}
          <div className="lg:col-span-5 flex justify-center">
            <div className="relative w-full max-w-md">
              {/* Marco metálico y render 3D */}
              <div className="relative border border-white/20 bg-black/60 shadow-[0_20px_60px_rgba(0,0,0,0.9)] p-2">
                <img
                  src="/zipp-phone-mockup.jpg"
                  alt="App ZIPP en Smartphone Titanio"
                  className="w-full h-auto object-cover"
                />

                {/* Microetiqueta de telemetría sobre el dispositivo */}
                <div className="absolute bottom-6 left-6 right-6 border border-white/10 bg-black/90 p-3 font-mono text-[11px] backdrop-blur-md">
                  <div className="flex justify-between text-zinc-400">
                    <span>DISPATCH ID // #4829</span>
                    <span className="text-[#10B981] font-bold">EN TRÁNSITO</span>
                  </div>
                  <div className="mt-1 text-white font-semibold">
                    Alexander S. • Yamaha R3 Zipp
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Franja de Especificaciones Rápidas */}
        <div className="relative z-10 border-t border-white/10 bg-black/80 font-mono text-xs py-4 px-6 sm:px-10">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-6 text-zinc-400">
            <div>FÓRMULA: BASE FIJA + $800 COP/KM</div>
            <div>SEGUIMIENTO: GPS TELEMETRÍA 1HZ</div>
            <div>RETENCIÓN DE PROPINAS: 0.00%</div>
            <div>TIEMPO MEDIO DE PREPARACIÓN: 14 MIN</div>
          </div>
        </div>
      </section>

      {/* ── SECCIÓN TELEMETRÍA DE TARIFAS (SIN CONTENEDORES PLANOS) ── */}
      <section id="simulador" className="py-24 px-6 sm:px-10 border-b border-white/10">
        <DeliverySimulator />
      </section>

      {/* ── SECCIÓN OPERACIONES TRIPARTITAS (ARQUITECTURA EDITORIAL) ── */}
      <section id="operaciones" className="py-28 px-6 sm:px-10 border-b border-white/10 max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-12 border-b border-white/10">
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#E5B242]">
              Ecosistema Operacional
            </span>
            <h2 className="mt-2 text-3xl sm:text-6xl font-black tracking-tight text-white uppercase">
              Tres Roles. Una Infraestructura.
            </h2>
          </div>

          {/* Selectores de Rol tipo Conmutador Físico */}
          <div className="flex font-mono text-xs border border-white/20 p-1 bg-black self-start">
            <button
              onClick={() => setActiveTab('clientes')}
              className={`px-5 py-2.5 uppercase tracking-wider transition-all ${
                activeTab === 'clientes'
                  ? 'bg-[#E5B242] text-black font-bold'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              01 // Clientes
            </button>
            <button
              onClick={() => setActiveTab('comercios')}
              className={`px-5 py-2.5 uppercase tracking-wider transition-all ${
                activeTab === 'comercios'
                  ? 'bg-[#E5B242] text-black font-bold'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              02 // Comercios
            </button>
            <button
              onClick={() => setActiveTab('domiciliarios')}
              className={`px-5 py-2.5 uppercase tracking-wider transition-all ${
                activeTab === 'domiciliarios'
                  ? 'bg-[#E5B242] text-black font-bold'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              03 // Repartidores
            </button>
          </div>
        </div>

        {/* Vista Desplegada por Rol con Escultura 3D Pin */}
        <div className="mt-16 grid grid-cols-1 lg:grid-cols-12 gap-16 items-center">
          {/* Lado Izquierdo: La escultura 3D de localización dorada */}
          <div className="lg:col-span-5 flex justify-center">
            <div className="relative border border-white/10 bg-zinc-950 p-4 max-w-md w-full shadow-2xl">
              <img
                src="/zipp-logo-pin.jpg"
                alt="ZIPP Geolocation Pin Esculpido"
                className="w-full h-auto object-cover"
              />
              <div className="mt-4 font-mono text-[10px] text-zinc-500 uppercase tracking-widest text-center">
                PRECISIÓN GEODÉSICA // RED LOCAL ZIPP
              </div>
            </div>
          </div>

          {/* Lado Derecho: Especificaciones del Rol */}
          <div className="lg:col-span-7 font-mono">
            {activeTab === 'clientes' && (
              <div className="space-y-6">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg overflow-hidden border border-white/10 bg-white/[0.03] flex items-center justify-center shrink-0">
                    <PeopleIllustration size={26} />
                  </div>
                  <div className="text-xs uppercase tracking-[0.2em] text-[#E5B242]">
                    PROTOCOLO DE USUARIO FINAL
                  </div>
                </div>
                <h3 className="text-3xl sm:text-4xl font-black text-white uppercase tracking-tight">
                  Tus platos favoritos con desglose honesto antes de pagar
                </h3>
                <p className="text-sm text-zinc-300 font-sans leading-relaxed">
                  Sin sorpresas en la pasarela. Cada pedido muestra la distancia métrica exacta entre el comercio y tu destino. Si llueve, si es hora pico o si hay alta afluencia, tu tarifa no se multiplica arbitrariamente.
                </p>

                <div className="pt-6 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs">
                  <div>
                    <span className="text-zinc-500 block uppercase mb-1">RASTREO DE PEDIDO</span>
                    <span className="text-white font-bold">Mapa satelital continuo sin recarga</span>
                  </div>
                  <div>
                    <span className="text-zinc-500 block uppercase mb-1">DESTINO DE PROPINAS</span>
                    <span className="text-[#10B981] font-bold">100% íntegro al domiciliario</span>
                  </div>
                </div>

                <div className="pt-4">
                  <a
                    href="#descargar"
                    className="inline-block px-7 py-3 text-xs font-bold uppercase tracking-wider text-black bg-[#E5B242] hover:bg-white transition-colors"
                  >
                    Instalar App ZIPP
                  </a>
                </div>
              </div>
            )}

            {activeTab === 'comercios' && (
              <div className="space-y-6">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg overflow-hidden border border-white/10 bg-white/[0.03] flex items-center justify-center shrink-0">
                    <StoreIllustration size={26} />
                  </div>
                  <div className="text-xs uppercase tracking-[0.2em] text-[#E5B242]">
                    PROTOCOLO DE ESTABLECIMIENTOS
                  </div>
                </div>
                <h3 className="text-3xl sm:text-4xl font-black text-white uppercase tracking-tight">
                  Vende a domicilio sin entregar tus utilidades operativas
                </h3>
                <p className="text-sm text-zinc-300 font-sans leading-relaxed">
                  Las plataformas tradicionales descuentan comisiones de hasta el 30% a los restaurantes. ZIPP ofrece una estructura no depredadora con despacho inmediato y panel de cocina en tiempo real.
                </p>

                <div className="pt-6 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs">
                  <div>
                    <span className="text-zinc-500 block uppercase mb-1">ALERTAS DE COMANDAS</span>
                    <span className="text-white font-bold">Sonoras y visuales al instante</span>
                  </div>
                  <div>
                    <span className="text-zinc-500 block uppercase mb-1">ASIGNACIÓN DE FLOTA</span>
                    <span className="text-[#E5B242] font-bold">Repartidores cercanos en espera</span>
                  </div>
                </div>

                <div className="pt-4">
                  <a
                    href={BUSINESS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-7 py-3 text-xs font-bold uppercase tracking-wider text-black bg-[#E5B242] hover:bg-white transition-colors"
                  >
                    Acceder al Portal de Comercios ↗
                  </a>
                </div>
              </div>
            )}

            {activeTab === 'domiciliarios' && (
              <div className="space-y-6">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg overflow-hidden border border-white/10 bg-white/[0.03] flex items-center justify-center shrink-0">
                    <DeliveryIllustration size={26} />
                  </div>
                  <div className="text-xs uppercase tracking-[0.2em] text-[#E5B242]">
                    PROTOCOLO DE REPARTIDORES
                  </div>
                </div>
                <h3 className="text-3xl sm:text-4xl font-black text-white uppercase tracking-tight">
                  Tus kilómetros valen. Tu propina es completamente tuya.
                </h3>
                <p className="text-sm text-zinc-300 font-sans leading-relaxed">
                  Visualiza el valor exacto de la carrera y la propina antes de aceptar el envío. Sin penalizaciones injustas, sin retención de propinas por pasarelas de pago y con rutas directas sin rodeos.
                </p>

                <div className="pt-6 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs">
                  <div>
                    <span className="text-zinc-500 block uppercase mb-1">RETENCIÓN DE PROPINAS</span>
                    <span className="text-[#10B981] font-bold">0.00% (Recibes el total)</span>
                  </div>
                  <div>
                    <span className="text-zinc-500 block uppercase mb-1">COBRO TRANSPARENTE</span>
                    <span className="text-white font-bold">Liquidación directa a billetera</span>
                  </div>
                </div>

                <div className="pt-4">
                  <a
                    href="#descargar"
                    className="inline-block px-7 py-3 text-xs font-bold uppercase tracking-wider text-black bg-[#E5B242] hover:bg-white transition-colors"
                  >
                    Registrarme como Repartidor
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── SECCIÓN MÉTRICAS MASIVAS DE RENDIMIENTO ── */}
      <section id="metricas" className="py-24 px-6 sm:px-10 border-b border-white/10 bg-[#080B11]">
        <div className="max-w-7xl mx-auto">
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-[#E5B242] mb-8">
            TELEMETRÍA AGREGADA DE RED // AUDITORÍA ABIERTA
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-12 font-mono">
            <div className="border-t-2 border-[#E5B242] pt-6">
              <span className="text-5xl sm:text-7xl font-black text-white tracking-tighter block tabular-nums">
                99.4%
              </span>
              <span className="text-xs uppercase tracking-widest text-zinc-400 mt-2 block">
                Cumplimiento de Horario
              </span>
            </div>

            <div className="border-t-2 border-white/20 pt-6">
              <span className="text-5xl sm:text-7xl font-black text-white tracking-tighter block tabular-nums">
                100%
              </span>
              <span className="text-xs uppercase tracking-widest text-zinc-400 mt-2 block">
                Propinas Directas
              </span>
            </div>

            <div className="border-t-2 border-white/20 pt-6">
              <span className="text-5xl sm:text-7xl font-black text-white tracking-tighter block tabular-nums">
                &lt; 24M
              </span>
              <span className="text-xs uppercase tracking-widest text-zinc-400 mt-2 block">
                Tiempo Medio de Envío
              </span>
            </div>

            <div className="border-t-2 border-white/20 pt-6">
              <span className="text-5xl sm:text-7xl font-black text-white tracking-tighter block tabular-nums">
                $0 COP
              </span>
              <span className="text-xs uppercase tracking-widest text-zinc-400 mt-2 block">
                Recargo por Clima o Demanda
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECCIÓN DESCARGA DE LA APP & CÓDIGO QR TÉCNICO ── */}
      <section id="descargar" className="py-28 px-6 sm:px-10 max-w-7xl mx-auto font-mono">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center border border-white/10 bg-[#0A0E17] p-8 sm:p-16">
          <div className="lg:col-span-7">
            <span className="text-[11px] uppercase tracking-[0.25em] text-[#E5B242] block mb-3">
              Despliegue Multiplataforma
            </span>
            <h2 className="text-4xl sm:text-6xl font-black text-white uppercase tracking-tight">
              Instala ZIPP en tu dispositivo
            </h2>
            <p className="mt-6 text-sm text-zinc-300 font-sans leading-relaxed max-w-lg">
              Disponible para terminales móviles iOS y Android, así como en versión Web App Progresiva sin necesidad de descarga de tiendas.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row gap-4">
              <div className="border border-white/20 px-6 py-4 bg-black">
                <span className="text-[10px] text-zinc-500 uppercase block">CANAL 01</span>
                <span className="text-sm font-bold text-white uppercase">App Store (iOS)</span>
              </div>
              <div className="border border-white/20 px-6 py-4 bg-black">
                <span className="text-[10px] text-zinc-500 uppercase block">CANAL 02</span>
                <span className="text-sm font-bold text-white uppercase">Google Play (Android)</span>
              </div>
              <div className="border border-white/20 px-6 py-4 bg-black">
                <span className="text-[10px] text-zinc-500 uppercase block">CANAL 03</span>
                <span className="text-sm font-bold text-white uppercase">PWA Web Instant</span>
              </div>
            </div>
          </div>

          {/* Tarjeta de Código QR de Alta Definición */}
          <div className="lg:col-span-5 flex flex-col items-center justify-center">
            <div className="border-2 border-[#E5B242] bg-black p-8 text-center max-w-xs w-full shadow-2xl">
              <div className="bg-white p-4 inline-block">
                {/* SVG de Código QR limpio y nítido */}
                <svg viewBox="0 0 100 100" className="w-36 h-36" fill="black">
                  <rect width="30" height="30" />
                  <rect x="5" y="5" width="20" height="20" fill="white" />
                  <rect x="10" y="10" width="10" height="10" />

                  <rect x="70" width="30" height="30" />
                  <rect x="75" y="5" width="20" height="20" fill="white" />
                  <rect x="80" y="10" width="10" height="10" />

                  <rect y="70" width="30" height="30" />
                  <rect x="5" y="75" width="20" height="20" fill="white" />
                  <rect x="10" y="80" width="10" height="10" />

                  <rect x="36" y="5" width="6" height="6" />
                  <rect x="48" y="5" width="12" height="6" />
                  <rect x="36" y="16" width="16" height="6" />
                  <rect x="44" y="26" width="16" height="6" />

                  <rect x="5" y="38" width="8" height="8" />
                  <rect x="18" y="44" width="8" height="8" />
                  <rect x="5" y="56" width="16" height="6" />

                  <rect x="36" y="38" width="28" height="28" />
                  <rect x="42" y="44" width="16" height="16" fill="white" />

                  <rect x="72" y="38" width="10" height="10" />
                  <rect x="86" y="44" width="10" height="10" />
                  <rect x="72" y="54" width="18" height="6" />

                  <rect x="38" y="74" width="12" height="12" />
                  <rect x="54" y="82" width="12" height="12" />
                  <rect x="72" y="74" width="24" height="6" />
                  <rect x="72" y="86" width="10" height="10" />
                </svg>
              </div>
              <p className="mt-4 text-xs font-bold uppercase tracking-widest text-white">
                ESCANEAR PARA DESCARGAR
              </p>
              <p className="text-[10px] text-zinc-500 mt-1">
                COMPATIBLE CON CUALQUIER CÁMARA MÓVIL
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
