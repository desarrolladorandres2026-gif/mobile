import type { ComponentType } from 'react';
import preparacion from '../assets/logos/preparacion.png';
import efectivo from '../assets/logos/efectivo.png';
import paquete from '../assets/logos/paquete.png';
import billetera from '../assets/logos/billetera.png';
import cupon from '../assets/logos/cupon.png';
import domiciliario from '../assets/logos/domiciliario.png';
import dashboard from '../assets/logos/dashboard.png';
import restaurant from '../assets/logos/restaurant.png';
import calificacion from '../assets/logos/calificacion.png';

/**
 * Logos PNG de concepto (Twemoji 14, CC-BY 4.0), el mismo set que la app.
 * Los archivos los genera `scripts/logos/build.mjs`, incluida la barra
 * lateral: sus 7 ilustraciones SVG quedaron sin uso y se borraron.
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

export const PrepTimeLogo = logo(preparacion);
export const CashLogo = logo(efectivo);
export const PackageLogo = logo(paquete);
export const WalletLogo = logo(billetera);
export const CouponLogo = logo(cupon);
export const DeliveryLogo = logo(domiciliario);
export const DashboardLogo = logo(dashboard);
export const RestaurantLogo = logo(restaurant);
export const RatingLogo = logo(calificacion);
