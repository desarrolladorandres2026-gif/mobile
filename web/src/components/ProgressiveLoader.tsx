import { useState, useEffect } from 'react';

interface ProgressiveLoaderProps {
  onComplete?: () => void;
}

export default function ProgressiveLoader({ onComplete }: ProgressiveLoaderProps) {
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Iniciando sistema ZIPP...');
  const [isDone, setIsDone] = useState(false);
  const [isHidden, setIsHidden] = useState(false);

  useEffect(() => {
    // Precargar las imágenes clave para que la landing se vea instantánea
    const imagesToPreload = [
      '/zipp-phone-mockup.jpg',
      '/zipp-logo-pin.jpg',
      '/zipp-crown-logo.png',
      '/zipp-crown-splash.png',
    ];

    imagesToPreload.forEach((src) => {
      const img = new Image();
      img.src = src;
    });

    // Simulación de carga progresiva fluida de alta velocidad
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          return 100;
        }
        const step = Math.floor(Math.random() * 12) + 6;
        const next = Math.min(prev + step, 100);

        if (next < 35) {
          setStatusText('Conectando red de comercios locales...');
        } else if (next < 70) {
          setStatusText('Sincronizando rutas y repartidores en vivo...');
        } else if (next < 95) {
          setStatusText('Calibrando tarifas transparentes...');
        } else {
          setStatusText('Todo listo. Bienvenido a ZIPP.');
        }

        return next;
      });
    }, 85);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (progress === 100) {
      const timer = setTimeout(() => {
        setIsDone(true);
        if (onComplete) onComplete();
      }, 350);

      const hideTimer = setTimeout(() => {
        setIsHidden(true);
      }, 950);

      return () => {
        clearTimeout(timer);
        clearTimeout(hideTimer);
      };
    }
  }, [progress, onComplete]);

  if (isHidden) return null;

  return (
    <div
      className={`fixed inset-0 z-[999] flex flex-col items-center justify-center bg-[#080B11] px-6 transition-all duration-700 ease-out ${
        isDone ? 'opacity-0 scale-105 pointer-events-none blur-sm' : 'opacity-100 scale-100'
      }`}
    >
      {/* Resplandor ambiental de fondo */}
      <div className="absolute h-96 w-96 rounded-full bg-[#E5B242]/10 blur-[120px] pointer-events-none" />
      <div className="absolute -top-10 right-10 h-72 w-72 rounded-full bg-[#10B981]/10 blur-[100px] pointer-events-none" />

      {/* Contenido Central */}
      <div className="relative z-10 flex flex-col items-center text-center max-w-sm">
        {/* Corona ZIPP con pulso suave */}
        <div className="relative mb-6">
          <div className="absolute inset-0 rounded-full bg-[#E5B242]/20 blur-xl animate-pulse" />
          <img
            src="/zipp-crown-splash.png"
            alt="ZIPP"
            className="relative h-24 w-auto object-contain drop-shadow-[0_0_25px_rgba(229,178,66,0.4)]"
          />
        </div>

        {/* Indicador de entrega */}
        <div className="mb-6 flex items-center gap-2 rounded-full border border-[#E5B242]/20 bg-[#141B2A]/80 px-3.5 py-1 text-xs font-semibold tracking-wider text-[#E5B242] backdrop-blur-md">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#10B981] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#10B981]" />
          </span>
          PLATAFORMA DE DOMICILIOS EN VIVO
        </div>

        {/* Barra de progreso de carga en oro satinado */}
        <div className="relative w-64 sm:w-72 h-1.5 rounded-full bg-[#141B2A] overflow-hidden border border-[#232E46]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#D69E26] via-[#F3CE72] to-[#E5B242] transition-all duration-150 ease-out"
            style={{
              width: `${progress}%`,
              boxShadow: '0 0 12px rgba(229, 178, 66, 0.7)',
            }}
          />
        </div>

        {/* Porcentaje y estado dinámico */}
        <div className="mt-3 flex w-64 sm:w-72 items-center justify-between text-xs text-[#7184A8]">
          <span className="font-mono font-medium text-white">{progress}%</span>
          <span className="truncate pl-3 text-right text-[11px] text-[#A0ABC0]">{statusText}</span>
        </div>
      </div>
    </div>
  );
}
