import {
  House, Search, ReceiptText, User, Users,
  ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  X, Plus, Minus, Check, CircleCheck, CircleCheckBig,
  SlidersHorizontal, Share2, RotateCw, Pencil, Trash2, Repeat2,
  ShoppingBag, ShoppingCart, Store, TicketPercent, BadgePercent,
  CreditCard, Banknote, HandCoins, Wallet,
  Bike, MapPin, Navigation, LocateFixed, Clock, Timer, Route, Package,
  UtensilsCrossed, Sandwich, Pill, Coffee,
  Heart, Star, Phone, MessageCircle, Headset,
  TriangleAlert, Info, CircleX, CircleAlert, WifiOff, Zap,
  Gift, Trophy, Flame, Award, Sparkles, PartyPopper,
  Bell, Settings, CircleQuestionMark, LogOut,
  ShieldCheck, KeyRound, Lock, Eye, EyeOff, Smartphone, Mail,
  Moon, Sun,
} from 'lucide-react-native';

/**
 * Vocabulario de iconos de Zipp.
 *
 * Las pantallas piden iconos por lo que significan en español, no por su
 * nombre en la librería. Dos razones: el código se lee en el mismo idioma que
 * la interfaz, y cambiar el icono de "bolsa" en toda la app es editar una
 * línea de este archivo.
 *
 * Todo icono de la interfaz sale de aquí. Sin emojis, sin caracteres
 * decorativos, sin imágenes haciendo de icono.
 */
export const IconRegistry = {
  // Navegación principal
  inicio: House,
  explorar: Search,
  pedidos: ReceiptText,
  perfil: User,

  // Desplazamiento
  atras: ArrowLeft,
  adelante: ArrowRight,
  anterior: ChevronLeft,
  siguiente: ChevronRight,
  desplegar: ChevronDown,
  plegar: ChevronUp,

  // Acciones
  cerrar: X,
  mas: Plus,
  menos: Minus,
  check: Check,
  checkCirculo: CircleCheck,
  checkGrande: CircleCheckBig,
  filtros: SlidersHorizontal,
  compartir: Share2,
  reintentar: RotateCw,
  editar: Pencil,
  eliminar: Trash2,
  repetir: Repeat2,

  // Compra
  bolsa: ShoppingBag,
  mercado: ShoppingCart,
  negocio: Store,
  cupon: TicketPercent,
  descuento: BadgePercent,
  tarjeta: CreditCard,
  efectivo: Banknote,
  propina: HandCoins,
  billetera: Wallet,

  // Entrega
  domiciliario: Bike,
  ubicacion: MapPin,
  navegar: Navigation,
  miUbicacion: LocateFixed,
  reloj: Clock,
  minutos: Timer,
  ruta: Route,
  paquete: Package,

  // Categorías de negocio
  catRestaurante: UtensilsCrossed,
  catRapidas: Sandwich,
  catFarmacia: Pill,
  catCafe: Coffee,
  catMercado: ShoppingCart,

  // Relación
  favorito: Heart,
  calificacion: Star,
  llamar: Phone,
  chat: MessageCircle,
  soporte: Headset,

  // Estados del sistema
  alerta: TriangleAlert,
  info: Info,
  error: CircleX,
  atencion: CircleAlert,
  sinConexion: WifiOff,
  rayo: Zap,

  // Recompensas
  regalo: Gift,
  trofeo: Trophy,
  racha: Flame,
  medalla: Award,
  destello: Sparkles,
  celebracion: PartyPopper,
  amigos: Users,

  // Cuenta
  notificaciones: Bell,
  ajustes: Settings,
  ayuda: CircleQuestionMark,
  salir: LogOut,
  seguridad: ShieldCheck,
  clave: KeyRound,
  candado: Lock,
  ver: Eye,
  ocultar: EyeOff,
  celular: Smartphone,
  correo: Mail,
  temaOscuro: Moon,
  temaClaro: Sun,
} as const;

export type IconName = keyof typeof IconRegistry;

/**
 * Icono por categoría de negocio. El backend manda la clave; aquí decidimos
 * cómo se ve. Cualquier categoría nueva cae en el icono genérico de negocio.
 */
export const categoryIcon = (key: string): IconName => {
  const map: Record<string, IconName> = {
    restaurant: 'catRestaurante',
    fast_food: 'catRapidas',
    pharmacy: 'catFarmacia',
    cafe: 'catCafe',
    supermarket: 'catMercado',
  };
  return map[key] ?? 'negocio';
};
