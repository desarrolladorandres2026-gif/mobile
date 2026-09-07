import { Store, Bike, CheckCircle2 } from 'lucide-react';

export default function FluidPath() {
  return (
    <div className="relative py-16 sm:py-24 overflow-hidden">
      {/* Luz ambiental difusa */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-72 w-[600px] rounded-full bg-[#E5B242]/10 blur-[130px] pointer-events-none" />

      <div className="relative mx-auto max-w-5xl px-6">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E5B242]/30 bg-[#141B2A]/70 px-3.5 py-1 text-xs font-semibold uppercase tracking-wider text-[#E5B242]">
            El Trazo Continuo
          </span>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            Del fogón a tus manos en un solo movimiento
          </h2>
          <p className="mt-3 text-base text-[#7184A8]">
            Sin intermediarios que inflen precios. Cada paso del pedido se traza en tiempo real.
          </p>
        </div>

        {/* Ruta conectada sin cajas rígidas */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 sm:gap-12 relative">
          {/* Línea conectora de fondo para pantallas medianas+ */}
          <div className="hidden md:block absolute top-12 left-16 right-16 h-0.5 bg-gradient-to-r from-[#D69E26] via-[#E5B242] to-[#10B981] opacity-40 z-0" />

          {/* Paso 1: Comercio */}
          <div className="relative z-10 flex flex-col items-center text-center group">
            <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-[#E5B242]/40 bg-[#141B2A] text-[#E5B242] shadow-xl shadow-[#E5B242]/10 transition-transform duration-300 group-hover:scale-110">
              <Store className="h-8 w-8 text-[#E5B242]" />
              <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#E5B242] text-[11px] font-bold text-[#080B11]">
                1
              </span>
            </div>
            <h3 className="mt-5 text-lg font-bold text-white">1. Elige y Personaliza</h3>
            <p className="mt-2 text-sm leading-relaxed text-[#7184A8] max-w-xs">
              Explora menús directos de tus comercios locales favoritos con precios reales de carta.
            </p>
          </div>

          {/* Paso 2: Repartidor en ruta */}
          <div className="relative z-10 flex flex-col items-center text-center group">
            <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-[#E5B242]/60 bg-[#141B2A] text-white shadow-xl shadow-[#E5B242]/20 transition-transform duration-300 group-hover:scale-110">
              <Bike className="h-8 w-8 text-[#E5B242] animate-pulse" />
              <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#E5B242] text-[11px] font-bold text-[#080B11]">
                2
              </span>
            </div>
            <h3 className="mt-5 text-lg font-bold text-white">2. Rastreo Satelital</h3>
            <p className="mt-2 text-sm leading-relaxed text-[#7184A8] max-w-xs">
              Tu repartidor recoge de inmediato. Mira en el mapa en vivo exactamente dónde viene.
            </p>
          </div>

          {/* Paso 3: Entrega */}
          <div className="relative z-10 flex flex-col items-center text-center group">
            <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-[#10B981]/60 bg-[#141B2A] text-[#10B981] shadow-xl shadow-[#10B981]/20 transition-transform duration-300 group-hover:scale-110">
              <CheckCircle2 className="h-8 w-8 text-[#10B981]" />
              <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#10B981] text-[11px] font-bold text-[#080B11]">
                3
              </span>
            </div>
            <h3 className="mt-5 text-lg font-bold text-white">3. Entrega sin Sorpresas</h3>
            <p className="mt-2 text-sm leading-relaxed text-[#7184A8] max-w-xs">
              Recibe en tu puerta. El 100% de la propina va a manos de quien te atendió.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
