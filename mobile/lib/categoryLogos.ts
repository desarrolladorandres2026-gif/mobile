/**
 * Logo real por categoría, usado como respaldo cuando el admin no configuró
 * `imageUrl`. Reemplaza las mini-ilustraciones propias a pedido explícito
 * del usuario — ver `CategoryTile`.
 */
export const CATEGORY_LOGOS: Record<string, number> = {
  restaurant: require('../assets/categories/restaurant.png'),
  fast_food: require('../assets/categories/fast_food.png'),
  pharmacy: require('../assets/categories/pharmacy.png'),
  cafe: require('../assets/categories/cafe.png'),
  supermarket: require('../assets/categories/supermarket.png'),
  errand: require('../assets/categories/errand.png'),
};

export const categoryLogo = (key: string): number | undefined => CATEGORY_LOGOS[key];
