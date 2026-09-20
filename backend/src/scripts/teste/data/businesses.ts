import { BusinessCategory, WeekSchedule } from '../../../types';

/**
 * Los cinco comercios del TESTE, con sus 50 productos y sus grupos de
 * modificadores.
 *
 * Son ficticios, pero están escritos como si fueran reales: nombres que
 * no existen en Colombia (se buscaron antes de fijarlos), precios enteros
 * en pesos y múltiplos de 100, horarios con un caso raro cada uno (lunes
 * cerrado, cierre pasada la medianoche), y grupos de modificadores con la
 * forma que tendría cada negocio de verdad. Varios productos existen solo
 * para probar un caso: el que está agotado, el que tiene una opción
 * agotada, el que exige exactamente dos acompañantes, el que pide cédula.
 *
 * Todo lo que se marca como TESTE se distingue por las cuentas de los
 * dueños (`@teste.zipp.co`, teléfonos `300999xxxx`), no por el nombre: en
 * la app se ven como comercios normales.
 */

export const TESTE_EMAIL_DOMAIN = 'teste.zipp.co';
export const TESTE_PHONE_PREFIX = '300999';
export const TESTE_PASSWORD = 'Teste.2026';

export interface TesteOption {
  name: string;
  price: number;
  isAvailable?: boolean;
}

export interface TesteGroup {
  name: string;
  minSelect: number;
  maxSelect: number;
  options: TesteOption[];
}

export interface TesteProduct {
  /** Sufijo de la clave de imagen: `<negocio>.<esto>`. */
  imageKey: string;
  name: string;
  description: string;
  price: number;
  discountPrice?: number;
  category: string;
  isFeatured?: boolean;
  isAvailable?: boolean;
  /** `null` o ausente = sin control de inventario. */
  stock?: number;
  lowStockThreshold?: number;
  requiresAgeVerification?: boolean;
  extras?: TesteOption[];
  groups?: TesteGroup[];
}

export interface TesteBusiness {
  /** Prefijo de las claves de imagen y del slug de las cuentas. */
  key: 'c21' | 'tul' | 'cyp' | 'tyt' | 'sur';
  name: string;
  description: string;
  category: BusinessCategory;
  address: string;
  /** Desplazamiento en km respecto al punto base, para que no se apilen. */
  offsetKm: { north: number; east: number };
  phone: string;
  deliveryTime: number;
  minOrder: number;
  freeDeliveryThreshold: number;
  schedule: WeekSchedule;
  owner: { name: string; phone: string; email: string };
  /** Orden de las categorías del menú. */
  categories: string[];
  products: TesteProduct[];
}

const day = (open: string, close: string) => ({ open, close, isOpen: true });
const closed = { open: '00:00', close: '00:00', isOpen: false };

const everyDay = (open: string, close: string): WeekSchedule => ({
  monday: day(open, close), tuesday: day(open, close), wednesday: day(open, close),
  thursday: day(open, close), friday: day(open, close), saturday: day(open, close), sunday: day(open, close),
});

// ── Grupos que se repiten dentro de un mismo negocio ──────────────────

const SALSAS_C21: TesteGroup = {
  name: 'Salsas', minSelect: 0, maxSelect: 4,
  options: [
    { name: 'Rosada', price: 0 }, { name: 'Piña', price: 0 }, { name: 'Ajo', price: 0 },
    { name: 'BBQ', price: 0 }, { name: 'Mostaza', price: 0 }, { name: 'Showy', price: 0 },
  ],
};

const PAPAS_CYP: TesteGroup = {
  name: 'Papas', minSelect: 0, maxSelect: 1,
  options: [
    { name: 'Francesas', price: 6000 }, { name: 'Rústicas', price: 6500 }, { name: 'Cascos con queso', price: 8500 },
  ],
};

const BEBIDA_CYP: TesteGroup = {
  name: 'Bebida', minSelect: 0, maxSelect: 1,
  options: [
    { name: 'Gaseosa 350 ml', price: 4500 }, { name: 'Limonada de hierbabuena', price: 5500 },
    { name: 'Malteada pequeña', price: 9000 },
  ],
};

const TAMANO_CAFE: TesteGroup = {
  name: 'Tamaño', minSelect: 1, maxSelect: 1,
  options: [{ name: '8 oz', price: 0 }, { name: '12 oz', price: 1500 }, { name: '16 oz', price: 2800 }],
};

const ENDULZANTE: TesteGroup = {
  name: 'Endulzante', minSelect: 1, maxSelect: 1,
  options: [{ name: 'Azúcar', price: 0 }, { name: 'Panela', price: 0 }, { name: 'Stevia', price: 0 }, { name: 'Sin endulzar', price: 0 }],
};

export const TESTE_BUSINESSES: TesteBusiness[] = [
  // ───────────────────────────────────────────────────────────────────
  // 1. Comidas rápidas — cierra pasada la medianoche
  // ───────────────────────────────────────────────────────────────────
  {
    key: 'c21',
    name: 'Callejón 21',
    description:
      'Comidas rápidas de esquina, de las de verdad: perros, salchipapas, pizza en horno de piedra y alitas ahumadas. Salsas de la casa y porciones para compartir. Abiertos hasta la 1 de la mañana.',
    category: BusinessCategory.FAST_FOOD,
    address: 'Calle 21 # 8-14, barrio Centro',
    offsetKm: { north: 0.6, east: 0.4 },
    phone: '3009990101',
    deliveryTime: 25,
    minOrder: 0,
    freeDeliveryThreshold: 45000,
    // Horario real de este comercio: everyDay('16:00', '01:00')
    // En TESTE se abre 24 h para que una simulación de compra no dependa
    // de la hora a la que se corra.
    schedule: everyDay('00:00', '23:59'),
    owner: { name: 'Mauricio Cerón', phone: '3009990001', email: 'dueno.c21@teste.zipp.co' },
    categories: ['Perros y salchipapas', 'Pizza y sándwiches', 'Para compartir', 'Bebidas'],
    products: [
      {
        imageKey: 'perro', name: 'Perro Americano', category: 'Perros y salchipapas',
        description: 'Salchicha americana en pan brioche, con queso fundido, cebolla crocante, papas ripiadas y salsas al gusto.',
        price: 12900, isFeatured: true,
        groups: [
          SALSAS_C21,
          {
            name: 'Adiciones', minSelect: 0, maxSelect: 3,
            options: [
              { name: 'Salchicha extra', price: 3500 }, { name: 'Tocineta', price: 3000 },
              { name: 'Queso extra', price: 2000 }, { name: 'Huevo de codorniz x3', price: 2500 },
            ],
          },
        ],
      },
      {
        imageKey: 'salchipapa', name: 'Salchipapa Ranchera', category: 'Perros y salchipapas',
        description: 'Papa francesa recién frita con salchicha ranchera a la plancha, queso gratinado y salsas de la casa.',
        price: 19900,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Personal', price: 0 }, { name: 'Para dos', price: 9000 }, { name: 'Familiar', price: 17000 }],
          },
          SALSAS_C21,
        ],
      },
      {
        imageKey: 'pizza', name: 'Pizza Mitad y Mitad', category: 'Pizza y sándwiches',
        description: 'Dos sabores en una sola pizza, horneada en piedra. Elige tamaño, masa y los dos sabores; el borde de queso va aparte.',
        price: 38900, isFeatured: true,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Mediana (6 porciones)', price: 0 }, { name: 'Familiar (8 porciones)', price: 12000 }],
          },
          {
            name: 'Masa', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Tradicional', price: 0 }, { name: 'Delgada', price: 0 }, { name: 'Integral', price: 2000 }],
          },
          {
            name: 'Primera mitad', minSelect: 1, maxSelect: 1,
            options: [
              { name: 'Hawaiana', price: 0 }, { name: 'Pepperoni', price: 0 }, { name: 'Pollo con champiñones', price: 0 },
              { name: 'Vegetariana', price: 0 }, { name: 'Carnes frías', price: 3000 },
            ],
          },
          {
            name: 'Segunda mitad', minSelect: 1, maxSelect: 1,
            options: [
              { name: 'Hawaiana', price: 0 }, { name: 'Pepperoni', price: 0 }, { name: 'Pollo con champiñones', price: 0 },
              { name: 'Vegetariana', price: 0 }, { name: 'Carnes frías', price: 3000 },
            ],
          },
          {
            name: 'Borde', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Borde de queso', price: 6000 }],
          },
          {
            name: 'Ingredientes extra', minSelect: 0, maxSelect: 3,
            options: [
              { name: 'Queso extra', price: 4000 }, { name: 'Maíz tierno', price: 2500 },
              { name: 'Jalapeños', price: 2500 }, { name: 'Tocineta', price: 4000 },
            ],
          },
        ],
      },
      {
        imageKey: 'mazorcada', name: 'Mazorcada Mixta', category: 'Para compartir',
        description: 'Maíz tierno desgranado con queso doble crema, papa criolla y la proteína que elijas. Sale caliente, para dos.',
        price: 26500,
        groups: [
          {
            name: 'Proteínas', minSelect: 1, maxSelect: 2,
            options: [
              { name: 'Pollo desmechado', price: 0 }, { name: 'Carne desmechada', price: 0 },
              { name: 'Chorizo', price: 2000 }, { name: 'Tocineta', price: 2500 },
            ],
          },
          SALSAS_C21,
        ],
      },
      {
        imageKey: 'cubano', name: 'Sándwich Cubano', category: 'Pizza y sándwiches',
        description: 'Jamón, pierna de cerdo, queso suizo, pepinillos y mostaza, prensado en pan de hojaldre hasta quedar crocante.',
        price: 18500,
        groups: [
          {
            name: 'Pan', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Hojaldre', price: 0 }, { name: 'Baguette', price: 0 }, { name: 'Sin gluten', price: 3000 }],
          },
          {
            name: 'Acompañante', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Papas francesas', price: 5000 }, { name: 'Ensalada de la casa', price: 4500 }],
          },
        ],
      },
      {
        imageKey: 'patacon', name: 'Patacón con Todo', category: 'Para compartir',
        description: 'Patacón grande de plátano verde cubierto de frijol, hogao, queso rallado y la proteína que quieras.',
        price: 21000,
        groups: [
          {
            name: 'Proteína', minSelect: 1, maxSelect: 1,
            options: [
              { name: 'Carne desmechada', price: 0 }, { name: 'Pollo desmechado', price: 0 },
              { name: 'Chicharrón', price: 3000 }, { name: 'Mixto', price: 4500 },
            ],
          },
        ],
      },
      {
        imageKey: 'choripapa', name: 'Choripapa', category: 'Perros y salchipapas',
        description: 'Papa francesa con chorizo santarrosano en trozos, queso gratinado, cebolla caramelizada y salsas.',
        price: 17500,
        groups: [SALSAS_C21],
        extras: [{ name: 'Chorizo extra', price: 4000 }, { name: 'Queso extra', price: 2000 }],
      },
      {
        imageKey: 'alitas', name: 'Alitas BBQ x8', category: 'Para compartir',
        description: 'Ocho alitas marinadas 12 horas y terminadas al horno con salsa BBQ ahumada. Vienen con un acompañante.',
        price: 24900, isFeatured: true,
        groups: [
          {
            name: 'Salsa', minSelect: 1, maxSelect: 1,
            options: [{ name: 'BBQ ahumada', price: 0 }, { name: 'Búfalo picante', price: 0 }, { name: 'Miel mostaza', price: 0 }, { name: 'Teriyaki', price: 1000 }],
          },
          {
            name: 'Acompañante', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Papas francesas', price: 0 }, { name: 'Yuca frita', price: 0 }, { name: 'Ensalada', price: 0 }],
          },
          {
            name: 'Dips', minSelect: 0, maxSelect: 2,
            options: [{ name: 'Ranch', price: 1500 }, { name: 'Queso azul', price: 2000 }, { name: 'Ajo', price: 1000 }],
          },
        ],
      },
      {
        imageKey: 'jugo', name: 'Jugo Natural 16 oz', category: 'Bebidas',
        description: 'Fruta fresca licuada al momento. En agua o en leche, con el endulzante que prefieras.',
        price: 8500,
        groups: [
          {
            name: 'Fruta', minSelect: 1, maxSelect: 1,
            options: [
              { name: 'Mora', price: 0 }, { name: 'Lulo', price: 0 }, { name: 'Maracuyá', price: 0 },
              { name: 'Mango', price: 0 }, { name: 'Guanábana', price: 1500, isAvailable: false },
            ],
          },
          {
            name: 'Preparación', minSelect: 1, maxSelect: 1,
            options: [{ name: 'En agua', price: 0 }, { name: 'En leche', price: 1500 }],
          },
          ENDULZANTE,
        ],
      },
      {
        imageKey: 'gaseosa', name: 'Gaseosa 1,5 L', category: 'Bebidas',
        description: 'Botella familiar bien fría, para acompañar la pizza o la salchipapa.',
        price: 7500, stock: 20, lowStockThreshold: 5,
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────
  // 2. Cocina típica — lunes cerrado, pedido mínimo
  // ───────────────────────────────────────────────────────────────────
  {
    key: 'tul',
    name: 'Sazón de la Tulia',
    description:
      'Cocina tradicional colombiana en fogón de leña: bandeja paisa, ajiaco, sancocho trifásico y mojarra fresca. Recetas de familia, porciones generosas y jugos de fruta de temporada. Descansamos los lunes.',
    category: BusinessCategory.RESTAURANT,
    address: 'Carrera 5 # 12-40, barrio La Esperanza',
    offsetKm: { north: -0.8, east: 0.5 },
    phone: '3009990102',
    deliveryTime: 35,
    minOrder: 15000,
    freeDeliveryThreshold: 0,
    // Horario real de este comercio: { monday: closed, tuesday: day('11:00', '21:00'), wednesday: day('11:00', '21:00'), thursday: day('11:00', '21:00'), friday: day('11:00', '21:00'), saturday: day('11:00', '21:00'), sunday: day('11:00', '21:00'), }
    // En TESTE se abre 24 h para que una simulación de compra no dependa
    // de la hora a la que se corra.
    schedule: everyDay('00:00', '23:59'),
    owner: { name: 'Gloria Amparo Losada', phone: '3009990002', email: 'dueno.tul@teste.zipp.co' },
    categories: ['Platos fuertes', 'Sopas', 'Para picar', 'Postres y bebidas'],
    products: [
      {
        imageKey: 'bandeja', name: 'Bandeja Paisa', category: 'Platos fuertes',
        description: 'Frijoles, arroz, carne molida, chicharrón, chorizo, huevo frito, plátano maduro, arepa y aguacate. La de siempre.',
        price: 32000, isFeatured: true,
        groups: [
          {
            name: 'Porción', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Tradicional', price: 0 }, { name: 'Doble carne', price: 8000 }, { name: 'Con chorizo extra', price: 4000 }],
          },
          {
            name: 'Adiciones', minSelect: 0, maxSelect: 3,
            options: [
              { name: 'Chicharrón extra', price: 6000, isAvailable: false }, { name: 'Aguacate extra', price: 3000 },
              { name: 'Huevo extra', price: 2000 }, { name: 'Arepa extra', price: 1500 },
            ],
          },
        ],
      },
      {
        imageKey: 'ajiaco', name: 'Ajiaco Santafereño', category: 'Sopas',
        description: 'Sopa espesa de tres papas con pollo desmechado, mazorca y guascas. Viene con crema, alcaparras y aguacate aparte.',
        price: 27500,
        groups: [
          {
            name: 'Acompañantes incluidos', minSelect: 0, maxSelect: 3,
            options: [{ name: 'Crema de leche', price: 0 }, { name: 'Alcaparras', price: 0 }, { name: 'Aguacate', price: 0 }, { name: 'Arroz blanco', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'sancocho', name: 'Sancocho Trifásico', category: 'Sopas',
        description: 'Res, cerdo y gallina en un solo caldo, con yuca, plátano, papa y mazorca. Viene con arroz, aguacate y ají.',
        price: 29000,
        groups: [
          {
            name: 'Porción', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Personal', price: 0 }, { name: 'Para llevar (olla 1 L)', price: 4000 }],
          },
        ],
      },
      {
        imageKey: 'mojarra', name: 'Mojarra Frita', category: 'Platos fuertes',
        description: 'Mojarra roja entera, frita en aceite limpio hasta quedar crocante. Elige dos acompañantes.',
        price: 34000, isFeatured: true,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Mediana (450 g)', price: 0 }, { name: 'Grande (650 g)', price: 9000 }],
          },
          {
            name: 'Acompañantes (elige 2)', minSelect: 2, maxSelect: 2,
            options: [
              { name: 'Patacones', price: 0 }, { name: 'Arroz con coco', price: 0 },
              { name: 'Ensalada', price: 0 }, { name: 'Yuca cocida', price: 0 }, { name: 'Papa salada', price: 0 },
            ],
          },
        ],
      },
      {
        imageKey: 'lechona', name: 'Lechona Tolimense', category: 'Platos fuertes',
        description: 'Cerdo relleno de arroz, arveja y especias, horneado toda la noche. Solo fines de semana, con arepa blanca e insulso.',
        price: 24000, isAvailable: false,
        groups: [
          {
            name: 'Porción', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Plato', price: 0 }, { name: 'Libra para llevar', price: 12000 }],
          },
        ],
      },
      {
        imageKey: 'sobrebarriga', name: 'Sobrebarriga en Salsa Criolla', category: 'Platos fuertes',
        description: 'Sobrebarriga cocida lentamente y bañada en hogao de tomate y cebolla. Elige dos acompañantes.',
        price: 30500,
        groups: [
          {
            name: 'Acompañantes (elige 2)', minSelect: 2, maxSelect: 2,
            options: [
              { name: 'Arroz blanco', price: 0 }, { name: 'Papa criolla', price: 0 },
              { name: 'Yuca', price: 0 }, { name: 'Ensalada', price: 0 },
            ],
          },
        ],
      },
      {
        imageKey: 'empanadas', name: 'Empanadas de Pipián x4', category: 'Para picar',
        description: 'Cuatro empanadas de maíz rellenas de pipián de papa y maní, fritas al momento. Con ají de la casa.',
        price: 9000,
        groups: [
          {
            name: 'Ají', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Ají de maní', price: 0 }, { name: 'Ají de cilantro', price: 0 }, { name: 'Sin ají', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'tamal', name: 'Tamal Tolimense', category: 'Para picar',
        description: 'Masa de maíz con arroz, pollo, cerdo, zanahoria y huevo, envuelto en hoja de plátano y cocido tres horas.',
        price: 16500,
        groups: [
          {
            name: 'Acompañantes', minSelect: 0, maxSelect: 2,
            options: [{ name: 'Arepa blanca', price: 1500 }, { name: 'Chocolate caliente', price: 4500 }, { name: 'Queso campesino', price: 3000 }],
          },
        ],
      },
      {
        imageKey: 'arrozleche', name: 'Arroz con Leche', category: 'Postres y bebidas',
        description: 'Cremoso, con canela y un toque de uvas pasas. Receta de la abuela, servido frío.',
        price: 7500,
        groups: [
          {
            name: 'Toppings', minSelect: 0, maxSelect: 2,
            options: [{ name: 'Canela extra', price: 0 }, { name: 'Coco rallado', price: 800 }, { name: 'Arequipe', price: 1500 }],
          },
        ],
      },
      {
        imageKey: 'limonada', name: 'Limonada de Panela', category: 'Postres y bebidas',
        description: 'Limón exprimido con panela disuelta. Fría con hielo o caliente para la tarde.',
        price: 6000,
        groups: [
          {
            name: 'Temperatura', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Fría', price: 0 }, { name: 'Caliente', price: 0 }],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────
  // 3. Hamburguesería — el producto con más grupos
  // ───────────────────────────────────────────────────────────────────
  {
    key: 'cyp',
    name: 'Carbón & Pan',
    description:
      'Hamburguesas de carne madurada a la parrilla de carbón, en pan brioche horneado cada mañana. Papas rústicas, aros de cebolla y malteadas de verdad. Arma la tuya como quieras.',
    category: BusinessCategory.FAST_FOOD,
    address: 'Calle 15 # 9-22, barrio San José',
    offsetKm: { north: 1.1, east: -0.6 },
    phone: '3009990103',
    deliveryTime: 30,
    minOrder: 0,
    freeDeliveryThreshold: 60000,
    // Horario real de este comercio: { monday: day('12:00', '22:30'), tuesday: day('12:00', '22:30'), wednesday: day('12:00', '22:30'), thursday: day('12:00', '22:30'), friday: day('12:00', '23:30'), saturday: day('12:00', '23:30'), sunday: day('12:00', '21:00'), }
    // En TESTE se abre 24 h para que una simulación de compra no dependa
    // de la hora a la que se corra.
    schedule: everyDay('00:00', '23:59'),
    owner: { name: 'Daniel Restrepo', phone: '3009990003', email: 'dueno.cyp@teste.zipp.co' },
    categories: ['Hamburguesas', 'Acompañantes', 'Bebidas'],
    products: [
      {
        imageKey: 'clasica', name: 'Clásica de la Casa', category: 'Hamburguesas',
        description: 'Carne a la parrilla, lechuga, tomate, cebolla y salsa de la casa en pan brioche. La base para armarla a tu manera.',
        price: 22900, isFeatured: true,
        groups: [
          {
            name: 'Tipo de carne', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Res 120 g', price: 0 }, { name: 'Angus 150 g', price: 7000 }, { name: 'Pollo a la parrilla', price: 0 }],
          },
          {
            name: 'Término', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Medio', price: 0 }, { name: 'Tres cuartos', price: 0 }, { name: 'Bien cocido', price: 0 }],
          },
          {
            name: 'Queso', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Cheddar', price: 2500 }, { name: 'Mozzarella', price: 2500 }, { name: 'Queso azul', price: 3500 }],
          },
          {
            name: 'Tocineta', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Tocineta', price: 3500 }, { name: 'Tocineta doble', price: 6000 }],
          },
          {
            name: 'Salsas', minSelect: 0, maxSelect: 3,
            options: [
              { name: 'De la casa', price: 0 }, { name: 'BBQ', price: 0 }, { name: 'Chipotle', price: 1000 },
              { name: 'Ajo asado', price: 1000 }, { name: 'Mostaza miel', price: 0 },
            ],
          },
          {
            name: 'Vegetales', minSelect: 0, maxSelect: 4,
            options: [
              { name: 'Sin cebolla', price: 0 }, { name: 'Sin tomate', price: 0 }, { name: 'Pepinillos', price: 0 },
              { name: 'Cebolla caramelizada', price: 1500 }, { name: 'Jalapeños', price: 1000 },
            ],
          },
          PAPAS_CYP,
          BEBIDA_CYP,
        ],
      },
      {
        imageKey: 'smash', name: 'Doble Smash', category: 'Hamburguesas',
        description: 'Dos carnes aplastadas en plancha de hierro hasta el borde crocante, queso fundido y pepinillos. Sin lechuga, a propósito.',
        price: 29900, isFeatured: true,
        groups: [
          {
            name: 'Queso', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Cheddar americano', price: 0 }, { name: 'Suizo', price: 1000 }],
          },
          {
            name: 'Tocineta', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Tocineta', price: 3500 }],
          },
          PAPAS_CYP,
          BEBIDA_CYP,
        ],
      },
      {
        imageKey: 'crispy', name: 'Crispy Chicken', category: 'Hamburguesas',
        description: 'Pechuga apanada crocante con ensalada de repollo y salsa cremosa en pan brioche. Elige qué tan picante.',
        price: 24500,
        groups: [
          {
            name: 'Picante', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Sin picante', price: 0 }, { name: 'Suave', price: 0 }, { name: 'Fuerte', price: 0 }],
          },
          {
            name: 'Salsas', minSelect: 0, maxSelect: 2,
            options: [{ name: 'Ranch', price: 0 }, { name: 'Miel mostaza', price: 0 }, { name: 'Búfalo', price: 1000 }],
          },
          PAPAS_CYP,
        ],
      },
      {
        imageKey: 'bbq', name: 'BBQ Ahumada', category: 'Hamburguesas',
        description: 'Carne a la parrilla con tocineta, cebolla crocante, cheddar y salsa BBQ ahumada en casa.',
        price: 27900,
        groups: [
          {
            name: 'Tipo de carne', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Res 120 g', price: 0 }, { name: 'Angus 150 g', price: 7000 }],
          },
          {
            name: 'Término', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Medio', price: 0 }, { name: 'Tres cuartos', price: 0 }, { name: 'Bien cocido', price: 0 }],
          },
          {
            name: 'Adiciones', minSelect: 0, maxSelect: 3,
            options: [{ name: 'Carne extra', price: 8000 }, { name: 'Aros de cebolla dentro', price: 2500 }, { name: 'Huevo frito', price: 2000 }, { name: 'Jalapeños', price: 1000 }],
          },
          PAPAS_CYP,
          BEBIDA_CYP,
        ],
      },
      {
        imageKey: 'veggie', name: 'Veggie de Garbanzo', category: 'Hamburguesas',
        description: 'Torta de garbanzo y quinua a la plancha, con aguacate, tomate asado y mayonesa de cilantro.',
        price: 23500,
        groups: [
          {
            name: 'Pan', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Brioche', price: 0 }, { name: 'Integral', price: 0 }, { name: 'Sin gluten', price: 3000, isAvailable: false }],
          },
          {
            name: 'Queso', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Mozzarella', price: 2500 }, { name: 'Queso vegano', price: 3500 }],
          },
          PAPAS_CYP,
        ],
      },
      {
        imageKey: 'papas', name: 'Papas Rústicas', category: 'Acompañantes',
        description: 'Papa con cáscara, cortada gruesa y frita dos veces. Con sal de romero.',
        price: 11500,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Personal', price: 0 }, { name: 'Para compartir', price: 6000 }],
          },
          {
            name: 'Toppings', minSelect: 0, maxSelect: 2,
            options: [{ name: 'Queso cheddar fundido', price: 3500 }, { name: 'Tocineta en trozos', price: 3500 }, { name: 'Cebollín', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'aros', name: 'Aros de Cebolla x10', category: 'Acompañantes',
        description: 'Diez aros gruesos con apanado crocante de cerveza. Vienen con un dip.',
        price: 12900,
        groups: [
          {
            name: 'Dip', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Ranch', price: 0 }, { name: 'BBQ', price: 0 }, { name: 'Chipotle', price: 500 }],
          },
        ],
      },
      {
        imageKey: 'nuggets', name: 'Nuggets de Pollo x8', category: 'Acompañantes',
        description: 'Ocho trozos de pechuga apanados a mano. Elige una o dos salsas.',
        price: 16900,
        groups: [
          {
            name: 'Salsas (1 o 2)', minSelect: 1, maxSelect: 2,
            options: [{ name: 'BBQ', price: 0 }, { name: 'Miel mostaza', price: 0 }, { name: 'Ranch', price: 0 }, { name: 'Búfalo', price: 500 }],
          },
        ],
      },
      {
        imageKey: 'malteada', name: 'Malteada de Arequipe', category: 'Bebidas',
        description: 'Helado de vainilla batido con arequipe y leche, coronada con crema y más arequipe.',
        price: 14500,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: '12 oz', price: 0 }, { name: '16 oz', price: 3000 }],
          },
          {
            name: 'Extras', minSelect: 0, maxSelect: 2,
            options: [{ name: 'Brownie en trozos', price: 2500 }, { name: 'Chantilly extra', price: 1000 }, { name: 'Galleta', price: 1500 }],
          },
        ],
      },
      {
        imageKey: 'limonada', name: 'Limonada de Hierbabuena', category: 'Bebidas',
        description: 'Limón, hierbabuena machacada y hielo triturado. Refrescante y sin exceso de azúcar.',
        price: 8900,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: '12 oz', price: 0 }, { name: '16 oz', price: 2000 }, { name: 'Jarra 1 L', price: 9000 }],
          },
          ENDULZANTE,
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────
  // 4. Panadería café — inventario contado, agotados y descuento
  // ───────────────────────────────────────────────────────────────────
  {
    key: 'tyt',
    name: 'Trigo & Tinto',
    description:
      'Panadería de barrio con horno de leña y café de origen. Pandebonos y almojábanas calientes desde las seis, croissants de mantequilla, desayunos y tortas caseras. Lo que sale del horno se acaba.',
    category: BusinessCategory.CAFE,
    address: 'Carrera 7 # 18-05, barrio Las Mercedes',
    offsetKm: { north: -0.3, east: -0.9 },
    phone: '3009990104',
    deliveryTime: 15,
    minOrder: 0,
    freeDeliveryThreshold: 0,
    // Horario real de este comercio: { monday: day('06:00', '20:00'), tuesday: day('06:00', '20:00'), wednesday: day('06:00', '20:00'), thursday: day('06:00', '20:00'), friday: day('06:00', '20:00'), saturday: day('06:00', '20:00'), sunday: day('07:00', '14:00'), }
    // En TESTE se abre 24 h para que una simulación de compra no dependa
    // de la hora a la que se corra.
    schedule: everyDay('00:00', '23:59'),
    owner: { name: 'Lucía Fernanda Ortiz', phone: '3009990004', email: 'dueno.tyt@teste.zipp.co' },
    categories: ['Café', 'Panadería', 'Desayunos', 'Tortas'],
    products: [
      {
        imageKey: 'capuchino', name: 'Capuchino', category: 'Café',
        description: 'Doble espresso de café de origen con leche texturizada. Arte latte cuando la mañana lo permite.',
        price: 7500, isFeatured: true,
        groups: [
          TAMANO_CAFE,
          {
            name: 'Leche', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Entera', price: 0 }, { name: 'Deslactosada', price: 0 }, { name: 'Almendras', price: 2000 }, { name: 'Avena', price: 2000 }],
          },
          ENDULZANTE,
          {
            name: 'Sabor', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Vainilla', price: 1500 }, { name: 'Caramelo', price: 1500 }, { name: 'Avellana', price: 1500 }],
          },
          {
            name: 'Extra shot', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Shot adicional de espresso', price: 2500 }],
          },
        ],
      },
      {
        imageKey: 'tinto', name: 'Tinto Campesino', category: 'Café',
        description: 'Café filtrado en tela, como en finca. Suave, sin amargor.',
        price: 3500,
        groups: [TAMANO_CAFE, ENDULZANTE],
      },
      {
        imageKey: 'frappe', name: 'Frappé de Café', category: 'Café',
        description: 'Café frío licuado con hielo y leche, coronado con crema batida.',
        price: 11900,
        groups: [
          {
            name: 'Tamaño', minSelect: 1, maxSelect: 1,
            options: [{ name: '12 oz', price: 0 }, { name: '16 oz', price: 2500 }],
          },
          {
            name: 'Leche', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Entera', price: 0 }, { name: 'Deslactosada', price: 0 }, { name: 'Almendras', price: 2000 }],
          },
          {
            name: 'Chantilly', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Con chantilly', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'pandebono', name: 'Pandebono', category: 'Panadería',
        description: 'Almidón de yuca y queso costeño, horneado cada hora. Mejor caliente.',
        price: 2800, stock: 24, lowStockThreshold: 6,
      },
      {
        imageKey: 'almojabana', name: 'Almojábana', category: 'Panadería',
        description: 'Cuajada fresca y harina de maíz, esponjosa por dentro y dorada por fuera.',
        price: 2800, stock: 18, lowStockThreshold: 6,
      },
      {
        imageKey: 'croissant', name: 'Croissant de Almendras', category: 'Panadería',
        description: 'Hojaldre de mantequilla relleno de crema de almendra, con almendras laminadas y azúcar glas.',
        price: 8500, stock: 6, lowStockThreshold: 3, isFeatured: true,
      },
      {
        imageKey: 'desayuno', name: 'Desayuno Huevos al Gusto', category: 'Desayunos',
        description: 'Dos huevos como los pidas, con arepa o pan de la casa y bebida caliente incluida.',
        price: 16900,
        groups: [
          {
            name: 'Huevos', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Pericos', price: 0 }, { name: 'Fritos', price: 0 }, { name: 'Revueltos', price: 0 }, { name: 'Con tocineta', price: 3500 }],
          },
          {
            name: 'Acompañante', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Arepa con queso', price: 0 }, { name: 'Pan de la casa', price: 0 }, { name: 'Calentado', price: 3000 }],
          },
          {
            name: 'Bebida incluida', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Tinto', price: 0 }, { name: 'Chocolate', price: 0 }, { name: 'Jugo de naranja', price: 2000 }],
          },
        ],
      },
      {
        imageKey: 'croissantjq', name: 'Croissant de Jamón y Queso', category: 'Desayunos',
        description: 'Croissant de mantequilla relleno de jamón de cerdo y queso mozzarella.',
        price: 13500,
        groups: [
          {
            name: 'Preparación', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Gratinado al horno', price: 0 }, { name: 'Frío', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'torta', name: 'Torta de Zanahoria', category: 'Tortas',
        description: 'Porción generosa con nueces y cobertura de queso crema. Hoy en promoción.',
        price: 9500, discountPrice: 8000, stock: 0, isAvailable: false,
      },
      {
        imageKey: 'chocolate', name: 'Chocolate Santafereño', category: 'Café',
        description: 'Chocolate espeso batido en olleta. Con queso campesino para meterle, como manda la tradición.',
        price: 8900,
        groups: [
          {
            name: 'Con queso', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Queso campesino', price: 2500 }],
          },
          {
            name: 'Acompañante', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Almojábana', price: 2800 }, { name: 'Pandebono', price: 2800 }, { name: 'Mantequilla y pan', price: 2000 }],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────
  // 5. Minimercado — inventario, mayoría de edad y descuento
  // ───────────────────────────────────────────────────────────────────
  {
    key: 'sur',
    name: 'Autoservicio Punto Fresco',
    description:
      'Minimercado de barrio con fruta y verdura del día, lácteos, granos, panadería y aseo. Lo que falta en la casa, en veinte minutos.',
    category: BusinessCategory.SUPERMARKET,
    address: 'Calle 9 # 4-31, barrio Guaduales',
    offsetKm: { north: 0.2, east: 1.2 },
    phone: '3009990105',
    deliveryTime: 20,
    minOrder: 15000,
    freeDeliveryThreshold: 50000,
    // Horario real de este comercio: everyDay('07:00', '22:00')
    // En TESTE se abre 24 h para que una simulación de compra no dependa
    // de la hora a la que se corra.
    schedule: everyDay('00:00', '23:59'),
    owner: { name: 'Jairo Alberto Muñoz', phone: '3009990005', email: 'dueno.sur@teste.zipp.co' },
    categories: ['Frutas y verduras', 'Lácteos y huevos', 'Despensa', 'Bebidas', 'Aseo'],
    products: [
      {
        imageKey: 'huevos', name: 'Huevos AA x30', category: 'Lácteos y huevos',
        description: 'Panal de 30 huevos tipo AA, de granja. Llegan protegidos en su bandeja.',
        price: 19900, stock: 12, lowStockThreshold: 4, isFeatured: true,
      },
      {
        imageKey: 'leche', name: 'Leche Entera 1,1 L', category: 'Lácteos y huevos',
        description: 'Leche entera pasteurizada en bolsa de 1.100 ml.',
        price: 4800, stock: 40, lowStockThreshold: 10,
      },
      {
        imageKey: 'arroz', name: 'Arroz Blanco 1 kg', category: 'Despensa',
        description: 'Arroz de grano largo, seleccionado. Bolsa de un kilo.',
        price: 5200, stock: 35,
      },
      {
        imageKey: 'pan', name: 'Pan Tajado Artesanal', category: 'Despensa',
        description: 'Pan de molde horneado en el barrio, sin conservantes. Dura tres días.',
        price: 7900, stock: 10, lowStockThreshold: 3,
        groups: [
          {
            name: 'Presentación', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Blanco', price: 0 }, { name: 'Integral', price: 800 }],
          },
        ],
      },
      {
        imageKey: 'aguacate', name: 'Aguacate Hass (unidad)', category: 'Frutas y verduras',
        description: 'Aguacate Hass seleccionado a mano. Dinos para cuándo lo quieres y te lo elegimos al punto.',
        price: 3500, stock: 30,
        groups: [
          {
            name: 'Madurez', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Para hoy', price: 0 }, { name: 'Para 2–3 días', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'tomate', name: 'Tomate Chonto (libra)', category: 'Frutas y verduras',
        description: 'Tomate chonto maduro, de cosecha local. Media libra o libra.',
        price: 3200, stock: 50,
      },
      {
        imageKey: 'queso', name: 'Queso Campesino 500 g', category: 'Lácteos y huevos',
        description: 'Queso fresco de leche entera, bajo en sal. Bloque de 500 gramos.',
        price: 12500, stock: 8, lowStockThreshold: 3,
        groups: [
          {
            name: 'Tajado', minSelect: 0, maxSelect: 1,
            options: [{ name: 'Tajado', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'cerveza', name: 'Cerveza Nacional six pack', category: 'Bebidas',
        description: 'Seis botellas de 330 ml. Venta solo a mayores de edad; el domiciliario pedirá la cédula.',
        price: 22000, stock: 15, requiresAgeVerification: true,
        groups: [
          {
            name: 'Temperatura', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Fría', price: 0 }, { name: 'Al clima', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'agua', name: 'Agua sin Gas 600 ml', category: 'Bebidas',
        description: 'Agua purificada en botella de 600 ml.',
        price: 2500, stock: 60,
        groups: [
          {
            name: 'Temperatura', minSelect: 1, maxSelect: 1,
            options: [{ name: 'Fría', price: 0 }, { name: 'Al clima', price: 0 }],
          },
        ],
      },
      {
        imageKey: 'detergente', name: 'Detergente en Polvo 1 kg', category: 'Aseo',
        description: 'Detergente multiusos en polvo, rinde hasta 20 lavadas. En promoción esta semana.',
        price: 12900, discountPrice: 10900, stock: 25,
      },
    ],
  },
];

/**
 * Los dos clientes de prueba, con sus direcciones dentro de cobertura.
 *
 * Los dos son adultos con fecha de nacimiento: sin ella el servidor no deja
 * pedir productos +18 (caso A-01, el six pack), desde que la edad se valida
 * al crear el pedido (2026-09-19).
 */
export const TESTE_CLIENTS = [
  {
    name: 'Camila Andrade', phone: '3009990011', email: 'cliente1@teste.zipp.co', birthDate: '1994-05-12',
    address: { label: 'Casa', address: 'Carrera 6 # 14-20, apto 301', details: 'Edificio Mirador, portería', offsetKm: { north: 0.4, east: 0.1 } },
  },
  {
    name: 'Andrés Felipe Rojas', phone: '3009990012', email: 'cliente2@teste.zipp.co', birthDate: '1989-11-03',
    address: { label: 'Oficina', address: 'Calle 19 # 7-55, local 2', details: 'Frente al parque', offsetKm: { north: -0.5, east: -0.3 } },
  },
];
