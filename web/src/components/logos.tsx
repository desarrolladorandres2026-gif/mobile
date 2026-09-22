import type { ComponentType } from 'react';
import bolsa from '../assets/logos/bolsa.png';
import negocio from '../assets/logos/negocio.png';
import domiciliario from '../assets/logos/domiciliario.png';

/**
 * Logos PNG de concepto (Twemoji 14, CC-BY 4.0), el mismo set que la app.
 * Los archivos los genera `scripts/logos/build.mjs` a 288 px: nítidos hasta
 * 144 px en pantallas 2x.
 */

// El emoji llena su lienzo; a esta escala pesa lo que pesaba la ilustración SVG.
const LOGO_SCALE = 0.8;

type LogoProps = { size?: number };

function logo(src: string): ComponentType<LogoProps> {
  return function Logo({ size = 44 }: LogoProps) {
    const inner = Math.round(size * LOGO_SCALE);
    return (
      <span
        style={{ width: size, height: size }}
        className="inline-flex shrink-0 items-center justify-center"
      >
        <img src={src} width={inner} height={inner} alt="" draggable={false} />
      </span>
    );
  };
}

export const CustomerLogo = logo(bolsa);
export const StoreLogo = logo(negocio);
export const DeliveryLogo = logo(domiciliario);
