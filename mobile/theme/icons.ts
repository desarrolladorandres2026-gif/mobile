// Un archivo por icono y no el índice del paquete: `lucide-react-native`
// a secas trae ~1.750 iconos, y Metro los evalúa todos al arrancar (no
// hay tree shaking ni `inlineRequires` en este proyecto). Aquí se usan
// unos ochenta. Para añadir uno: su nombre en kebab-case, como en la URL
// de lucide.dev/icons.
import House from 'lucide-react-native/icons/house';
import Compass from 'lucide-react-native/icons/compass';
import ReceiptText from 'lucide-react-native/icons/receipt-text';
import User from 'lucide-react-native/icons/user';
import Users from 'lucide-react-native/icons/users';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowRight from 'lucide-react-native/icons/arrow-right';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import X from 'lucide-react-native/icons/x';
import Plus from 'lucide-react-native/icons/plus';
import Minus from 'lucide-react-native/icons/minus';
import Check from 'lucide-react-native/icons/check';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CircleCheckBig from 'lucide-react-native/icons/circle-check-big';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import Share2 from 'lucide-react-native/icons/share-2';
import RotateCw from 'lucide-react-native/icons/rotate-cw';
import Pencil from 'lucide-react-native/icons/pencil';
import Trash2 from 'lucide-react-native/icons/trash-2';
import Repeat2 from 'lucide-react-native/icons/repeat-2';
import ShoppingBag from 'lucide-react-native/icons/shopping-bag';
import ShoppingCart from 'lucide-react-native/icons/shopping-cart';
import Store from 'lucide-react-native/icons/store';
import TicketPercent from 'lucide-react-native/icons/ticket-percent';
import BadgePercent from 'lucide-react-native/icons/badge-percent';
import CreditCard from 'lucide-react-native/icons/credit-card';
import Banknote from 'lucide-react-native/icons/banknote';
import HandCoins from 'lucide-react-native/icons/hand-coins';
import Wallet from 'lucide-react-native/icons/wallet';
import Bike from 'lucide-react-native/icons/bike';
import MapPin from 'lucide-react-native/icons/map-pin';
import Navigation from 'lucide-react-native/icons/navigation';
import LocateFixed from 'lucide-react-native/icons/locate-fixed';
import Clock from 'lucide-react-native/icons/clock';
import Timer from 'lucide-react-native/icons/timer';
import Route from 'lucide-react-native/icons/route';
import Package from 'lucide-react-native/icons/package';
import Building2 from 'lucide-react-native/icons/building-2';
import Camera from 'lucide-react-native/icons/camera';
import ImageIcon from 'lucide-react-native/icons/image';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';
import Sandwich from 'lucide-react-native/icons/sandwich';
import Pill from 'lucide-react-native/icons/pill';
import Coffee from 'lucide-react-native/icons/coffee';
import Heart from 'lucide-react-native/icons/heart';
import Star from 'lucide-react-native/icons/star';
import Phone from 'lucide-react-native/icons/phone';
import PhoneCall from 'lucide-react-native/icons/phone-call';
import PhoneOff from 'lucide-react-native/icons/phone-off';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import Send from 'lucide-react-native/icons/send';
import Headset from 'lucide-react-native/icons/headset';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import Info from 'lucide-react-native/icons/info';
import CircleX from 'lucide-react-native/icons/circle-x';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import WifiOff from 'lucide-react-native/icons/wifi-off';
import Zap from 'lucide-react-native/icons/zap';
import Gift from 'lucide-react-native/icons/gift';
import Trophy from 'lucide-react-native/icons/trophy';
import Flame from 'lucide-react-native/icons/flame';
import Award from 'lucide-react-native/icons/award';
import Sparkles from 'lucide-react-native/icons/sparkles';
import PartyPopper from 'lucide-react-native/icons/party-popper';
import Bell from 'lucide-react-native/icons/bell';
import Settings from 'lucide-react-native/icons/settings';
import CircleQuestionMark from 'lucide-react-native/icons/circle-question-mark';
import LogOut from 'lucide-react-native/icons/log-out';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import KeyRound from 'lucide-react-native/icons/key-round';
import Lock from 'lucide-react-native/icons/lock';
import Eye from 'lucide-react-native/icons/eye';
import EyeOff from 'lucide-react-native/icons/eye-off';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Mail from 'lucide-react-native/icons/mail';
import Moon from 'lucide-react-native/icons/moon';
import Sun from 'lucide-react-native/icons/sun';
import FileText from 'lucide-react-native/icons/file-text';
import FileLock from 'lucide-react-native/icons/file-lock';
import FileCheck from 'lucide-react-native/icons/file-check';

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
  explorar: Compass,
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
  /** Piso, apartamento, torre: la parte del domicilio que no está en el mapa. */
  edificio: Building2,
  paquete: Package,
  camara: Camera,
  foto: ImageIcon,

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
  llamando: PhoneCall,
  colgar: PhoneOff,
  chat: MessageCircle,
  enviar: Send,
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

  // Documentos legales
  documento: FileText,
  privacidad: FileLock,
  consentimiento: FileCheck,
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
