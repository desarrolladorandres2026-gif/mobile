import type { ComponentType } from 'react';
import paquete from '../assets/logos/paquete.png';
import efectivo from '../assets/logos/efectivo.png';
import negocio from '../assets/logos/negocio.png';
import domiciliario from '../assets/logos/domiciliario.png';
import restaurant from '../assets/logos/restaurant.png';
import fastFood from '../assets/logos/fast_food.png';
import pharmacy from '../assets/logos/pharmacy.png';
import cafe from '../assets/logos/cafe.png';
import supermarket from '../assets/logos/supermarket.png';

/**
 * Logos PNG de concepto (Twemoji 14, CC-BY 4.0), el mismo set que la app.
 * Los archivos los genera `scripts/logos/build.mjs`. La barra lateral sigue
 * con sus ilustraciones SVG a propósito.
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
        className="inline-flex flex-shrink-0 items-center justify-center"
      >
        <img src={src} width={inner} height={inner} alt="" draggable={false} />
      </span>
    );
  };
}

export const PackageLogo = logo(paquete);
export const CashLogo = logo(efectivo);
export const StoreLogo = logo(negocio);
export const DeliveryLogo = logo(domiciliario);

const CATEGORY_LOGOS: Record<string, ComponentType<LogoProps>> = {
  restaurant: logo(restaurant),
  fast_food: logo(fastFood),
  pharmacy: logo(pharmacy),
  cafe: logo(cafe),
  supermarket: logo(supermarket),
};

/** Logo por clave de categoría de negocio; una clave desconocida cae en la tienda. */
export const categoryLogo = (key: string): ComponentType<LogoProps> =>
  CATEGORY_LOGOS[key] ?? StoreLogo;
