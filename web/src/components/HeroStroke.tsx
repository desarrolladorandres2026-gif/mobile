import { Store, MapPin } from 'lucide-react';

/**
 * La ilustración del hero es el mismo trazo que dibuja el logo, a escala de
 * sección: sale del comercio, dobla una vez y termina en un punto lima sobre
 * tu dirección. Nada de capturas de pantalla ni cifras inventadas — solo la
 * idea central del producto.
 */
export default function HeroStroke() {
  return (
    <div className="relative aspect-square w-full max-w-md rounded-[32px] bg-sidebar p-8 sm:p-10">
      <svg
        viewBox="0 0 320 320"
        className="absolute inset-0 h-full w-full p-8 sm:p-10"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M40 64 H210 L60 256 H280"
          stroke="#E5B242"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          className="hero-stroke-path"
        />
      </svg>

      <div className="absolute left-8 top-8 flex items-center gap-2.5 rounded-full bg-white py-2 pl-2 pr-4 shadow-lg sm:left-10 sm:top-10">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-bg">
          <Store className="h-4 w-4 text-primary" />
        </span>
        <span className="text-xs font-semibold text-text-main">Comercio</span>
      </div>

      <div className="absolute bottom-8 right-8 flex items-center gap-2.5 rounded-full bg-white py-2 pl-2 pr-4 shadow-lg sm:bottom-10 sm:right-10">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/25">
          <MapPin className="h-4 w-4 text-sidebar" />
        </span>
        <span className="text-xs font-semibold text-text-main">Tu dirección</span>
      </div>

      <span className="absolute h-4 w-4 rounded-full bg-accent shadow-[0_0_0_6px_rgba(217,245,91,0.25)]" style={{ right: '15%', bottom: '19.5%' }} />
    </div>
  );
}
