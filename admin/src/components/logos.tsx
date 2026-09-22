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
import dashboard from '../assets/logos/dashboard.png';
import personas from '../assets/logos/personas.png';
import precio from '../assets/logos/precio.png';
import cupon from '../assets/logos/cupon.png';
import ubicacion from '../assets/logos/ubicacion.png';
import banner from '../assets/logos/banner.png';
import carpeta from '../assets/logos/carpeta.png';
import megafono from '../assets/logos/megafono.png';
import seguridad from '../assets/logos/seguridad.png';
import billetera from '../assets/logos/billetera.png';
import legal from '../assets/logos/legal.png';
import calendario from '../assets/logos/calendario.png';
import evidencia from '../assets/logos/evidencia.png';
import cargos from '../assets/logos/cargos.png';
import roles from '../assets/logos/roles.png';

/**
 * Logos PNG de concepto (Twemoji 14, CC-BY 4.0), el mismo set que la app.
 * Los archivos los genera `scripts/logos/build.mjs`, incluida la barra
 * lateral: sus 18 ilustraciones SVG quedaron sin uso y se borraron.
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
export const DashboardLogo = logo(dashboard);
export const PeopleLogo = logo(personas);
export const PricingLogo = logo(precio);
export const CouponLogo = logo(cupon);
export const LocationLogo = logo(ubicacion);
export const BannerLogo = logo(banner);
export const CategoriesLogo = logo(carpeta);
export const MegaphoneLogo = logo(megafono);
export const SecurityLogo = logo(seguridad);
export const WalletLogo = logo(billetera);
export const LegalLogo = logo(legal);
export const CalendarLogo = logo(calendario);
export const EvidenceLogo = logo(evidencia);
export const PositionsLogo = logo(cargos);
export const RolesLogo = logo(roles);

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
