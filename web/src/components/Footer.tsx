import { ZippWordmark } from './ZippMark';

const BUSINESS_URL = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';

export default function Footer() {
  return (
    <footer className="relative border-t border-white/10 bg-[#06080C] pt-20 pb-14 text-white">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-12 pb-16 border-b border-white/10">
          {/* Marca y Manifiesto */}
          <div className="md:col-span-6">
            <ZippWordmark size={30} dark />
            <p className="mt-5 max-w-md font-mono text-xs leading-relaxed text-zinc-400">
              Infraestructura de despacho y domicilios de alta fidelidad. Tarifa euclidiana por distancia satelital real. Reparto directo, comisiones no predatorias y 100% de propina íntegra para quien entrega.
            </p>
            <div className="mt-6 flex items-center gap-3 font-mono text-[11px] text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-[#10B981]" />
              <span className="tracking-wider uppercase">RED ZIPP OPERACIONAL // LATAM</span>
            </div>
          </div>

          {/* Navegación Plataforma */}
          <div className="md:col-span-3">
            <h4 className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#E5B242]">Plataforma</h4>
            <ul className="mt-5 space-y-3 font-mono text-xs text-zinc-400">
              <li>
                <a href="#simulador" className="transition-colors hover:text-white">Telemetría de Tarifas</a>
              </li>
              <li>
                <a href="#operaciones" className="transition-colors hover:text-white">Operaciones de Red</a>
              </li>
              <li>
                <a href="#descargar" className="transition-colors hover:text-white">App Móvil ZIPP</a>
              </li>
              <li>
                <a href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#E5B242]">
                  Portal Comercios →
                </a>
              </li>
            </ul>
          </div>

          {/* Manifiesto de Transparencia */}
          <div className="md:col-span-3">
            <h4 className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#E5B242]">Garantía ZIPP</h4>
            <div className="mt-5 space-y-4 font-mono text-xs text-zinc-400 leading-relaxed">
              <p>
                <strong className="text-white block mb-0.5">TARIFAS NO ESPECULATIVAS</strong>
                Ninguna fórmula algorítmica infla el precio por lluvia o demanda repentina.
              </p>
              <p>
                <strong className="text-white block mb-0.5">PROPINAS 100% PURAS</strong>
                Cada centavo de propina acreditado llega intacto a la billetera del repartidor.
              </p>
            </div>
          </div>
        </div>

        {/* Barra inferior */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-[11px] text-zinc-600">
          <p>© {new Date().getFullYear()} ZIPP SYSTEM ARCHITECTURE. TODOS LOS DERECHOS RESERVADOS.</p>
          <div className="flex items-center gap-6 text-zinc-500">
            <span className="hover:text-zinc-300 cursor-pointer">TÉRMINOS</span>
            <span className="hover:text-zinc-300 cursor-pointer">PRIVACIDAD</span>
            <span className="hover:text-zinc-300 cursor-pointer">SOPORTE 24/7</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
