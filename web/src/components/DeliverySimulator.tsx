import { useState } from 'react';

export default function DeliverySimulator() {
  const [distanceKm, setDistanceKm] = useState(3.4);
  const [tip, setTip] = useState(2000);

  const baseRate = 3500;
  const perKm = 800;
  const deliveryFee = Math.round(baseRate + Math.max(0, distanceKm - 1) * perKm);
  const estimatedMins = Math.round(10 + distanceKm * 3.1);
  const totalCharge = deliveryFee + tip;

  return (
    <div className="w-full max-w-5xl mx-auto">
      {/* Encabezado editorial */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8 border-b border-white/10">
        <div>
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#E5B242]">
            Telemetría y Algoritmo ZIPP
          </span>
          <h2 className="mt-2 text-3xl sm:text-5xl font-black tracking-tight text-white uppercase">
            Tarifa Por Distancia Real
          </h2>
        </div>
        <div className="font-mono text-xs text-zinc-400 max-w-xs text-left md:text-right">
          Cálculo satelital euclidiano de punto a punto. Cero recargos dinámicos por clima o congestión.
        </div>
      </div>

      {/* Consola de Control Físico / HUD */}
      <div className="mt-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Panel Izquierdo: Control de Distancia y Ruta */}
        <div className="lg:col-span-7 bg-zinc-950/80 border border-white/10 p-8 rounded-none sm:rounded-lg">
          {/* Lectura de Coordenadas */}
          <div className="flex items-center justify-between pb-6 border-b border-white/5 font-mono text-xs">
            <div className="text-zinc-400">
              <span className="text-zinc-600">ORIGEN // </span>COCINA LOCAL
            </div>
            <div className="text-[#E5B242] tracking-wider font-semibold">
              ● RUTA ACTIVA
            </div>
            <div className="text-zinc-400 text-right">
              <span className="text-zinc-600">DESTINO // </span>TU PUERTA
            </div>
          </div>

          {/* Selector de Kilometraje */}
          <div className="py-8">
            <div className="flex items-baseline justify-between mb-4">
              <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">
                Radio de Despacho
              </span>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-4xl sm:text-5xl font-black text-white tabular-nums tracking-tight">
                  {distanceKm.toFixed(1)}
                </span>
                <span className="font-mono text-sm text-[#E5B242] uppercase font-bold">km</span>
              </div>
            </div>

            {/* Slider de precisión */}
            <input
              type="range"
              min="0.8"
              max="12.0"
              step="0.1"
              value={distanceKm}
              onChange={(e) => setDistanceKm(parseFloat(e.target.value))}
              className="w-full h-1 bg-zinc-800 appearance-none cursor-pointer accent-[#E5B242]"
            />

            {/* Escala graduada */}
            <div className="flex justify-between font-mono text-[10px] text-zinc-600 mt-2 tracking-wider">
              <span>0.8 KM</span>
              <span>3.0 KM</span>
              <span>6.0 KM</span>
              <span>9.0 KM</span>
              <span>12.0 KM</span>
            </div>
          </div>

          {/* Desglose de Fórmula Matemática */}
          <div className="pt-6 border-t border-white/5 grid grid-cols-2 sm:grid-cols-3 gap-4 font-mono text-xs">
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase">Base Fija (1er km)</span>
              <span className="text-white font-bold">${baseRate.toLocaleString('es-CO')}</span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase">Tarifa por Km Extra</span>
              <span className="text-white font-bold">${perKm} / km</span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase">Multiplicador Oculto</span>
              <span className="text-[#10B981] font-bold">0.00x (Ninguno)</span>
            </div>
          </div>
        </div>

        {/* Panel Derecho: Desglose Financiero y Tiempo */}
        <div className="lg:col-span-5 bg-[#0D121D] border-l-2 border-[#E5B242] p-8">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400 block mb-6">
            Liquidación en Tiempo Real
          </span>

          {/* Gran Total */}
          <div className="mb-6">
            <span className="text-xs text-zinc-400 uppercase tracking-wider block">Costo Final del Envío</span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="font-mono text-5xl font-black text-white tracking-tight tabular-nums">
                ${totalCharge.toLocaleString('es-CO')}
              </span>
              <span className="font-mono text-xs text-[#E5B242] font-bold uppercase">COP</span>
            </div>
          </div>

          {/* Tiempo y Propina */}
          <div className="space-y-4 py-6 border-y border-white/10 font-mono text-xs">
            <div className="flex justify-between items-center">
              <span className="text-zinc-400">TIEMPO ESTIMADO</span>
              <span className="text-white font-bold text-sm tabular-nums">{estimatedMins} MINUTOS</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-zinc-400">TARIFA DE ENVÍO</span>
              <span className="text-white font-bold tabular-nums">${deliveryFee.toLocaleString('es-CO')}</span>
            </div>
            <div className="flex justify-between items-center pt-2">
              <span className="text-zinc-400">PROPINA DIRECTA</span>
              <div className="flex gap-2">
                {[0, 2000, 4000].map((val) => (
                  <button
                    key={val}
                    onClick={() => setTip(val)}
                    className={`px-2.5 py-1 text-[11px] font-mono transition-colors ${
                      tip === val
                        ? 'bg-[#E5B242] text-black font-bold'
                        : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                    }`}
                  >
                    ${val === 0 ? '0' : `${val / 1000}k`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Protocolo de Garantía */}
          <div className="mt-6 font-mono text-[11px] text-zinc-400 leading-relaxed">
            <span className="text-[#10B981] font-bold block mb-1">✓ 100% DE PROPINA GARANTIZADA</span>
            Los repartidores ZIPP reciben el monto íntegro asignado por el usuario sin comisión administrativa.
          </div>
        </div>
      </div>
    </div>
  );
}
