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
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-main max-w-lg">
        Así se calcula tu envío
      </h2>
      <p className="mt-3 text-[15px] text-text-secondary max-w-lg">
        Base fija por el primer kilómetro, más una tarifa por cada kilómetro extra. Nada más.
      </p>

      <div className="mt-12 grid grid-cols-1 lg:grid-cols-12 gap-12">
        <div className="lg:col-span-7">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-text-secondary">Distancia hasta tu dirección</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-4xl font-bold tabular-nums tracking-tight text-text-main">
                {distanceKm.toFixed(1)}
              </span>
              <span className="text-sm text-primary font-medium">km</span>
            </div>
          </div>

          <input
            type="range"
            min="0.8"
            max="12.0"
            step="0.1"
            value={distanceKm}
            onChange={(e) => setDistanceKm(parseFloat(e.target.value))}
            className="w-full h-px bg-border appearance-none cursor-pointer accent-primary mt-5"
          />
          <div className="flex justify-between text-xs text-text-muted mt-2">
            <span>0.8 km</span>
            <span>12 km</span>
          </div>

          <div className="mt-10 pt-6 border-t border-border grid grid-cols-2 gap-6 max-w-sm">
            <div>
              <span className="text-xs text-text-muted block mb-1">Base (primer km)</span>
              <span className="text-text-main text-sm font-medium">${baseRate.toLocaleString('es-CO')}</span>
            </div>
            <div>
              <span className="text-xs text-text-muted block mb-1">Cada km extra</span>
              <span className="text-text-main text-sm font-medium">${perKm.toLocaleString('es-CO')}</span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 lg:border-l lg:border-border lg:pl-12">
          <span className="text-xs text-text-muted">Total a pagar por el envío</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-4xl font-bold tracking-tight tabular-nums text-text-main">
              ${totalCharge.toLocaleString('es-CO')}
            </span>
            <span className="text-xs text-primary font-medium">COP</span>
          </div>

          <div className="mt-8 space-y-4">
            <div className="flex justify-between items-center text-sm">
              <span className="text-text-secondary">Tiempo estimado</span>
              <span className="font-medium tabular-nums text-text-main">{estimatedMins} min</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-text-secondary">Tarifa de envío</span>
              <span className="font-medium tabular-nums text-text-main">${deliveryFee.toLocaleString('es-CO')}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-text-secondary">Propina</span>
              <div className="flex gap-1">
                {[0, 2000, 4000].map((val) => (
                  <button
                    key={val}
                    onClick={() => setTip(val)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${
                      tip === val
                        ? 'bg-primary text-bg'
                        : 'text-text-secondary hover:text-text-main'
                    }`}
                  >
                    {val === 0 ? '$0' : `$${val / 1000}k`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-8 text-xs text-text-muted leading-relaxed">
            La propina que elijas llega completa al domiciliario, sin descuentos.
          </p>
        </div>
      </div>
    </div>
  );
}
