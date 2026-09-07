import { CheckCircle2, Navigation, Flame, ShoppingBag, ShieldCheck } from 'lucide-react';

export function FloatingLiveNotification() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[#E5B242]/30 bg-[#141B2A]/85 p-3.5 shadow-2xl backdrop-blur-md transition-all hover:scale-[1.02]">
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#D69E26] to-[#9C6E0E] text-[#080B11]">
        <Navigation className="h-5 w-5 text-white" />
        <span className="absolute -top-1 -right-1 flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#10B981] opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-[#10B981]" />
        </span>
      </div>

      <div className="min-w-0 pr-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold text-white">Alexander S. • En ruta</p>
          <span className="rounded bg-[#10B981]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#10B981]">
            4 min
          </span>
        </div>
        <p className="text-[11px] text-[#A0ABC0] truncate">
          Pedido #4829 • La Brasa Burger Gourmet
        </p>
      </div>
    </div>
  );
}

export function FloatingOrderDelivered() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[#10B981]/30 bg-[#0E131E]/90 p-3 shadow-xl backdrop-blur-md">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#10B981]/20 text-[#10B981]">
        <CheckCircle2 className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xs font-bold text-white">¡Entregado a tiempo!</p>
        <p className="text-[10px] text-[#10B981] font-medium">100% propina acreditada al repartidor</p>
      </div>
    </div>
  );
}

export function DeliveryCategoriesTicker() {
  const categories = [
    { label: 'Hamburguesas Gourmet', icon: Flame, color: 'text-amber-400' },
    { label: 'Pizzas Artesanales', icon: ShoppingBag, color: 'text-rose-400' },
    { label: 'Sushi & Nikkei', icon: SparkleIcon, color: 'text-emerald-400' },
    { label: 'Farmacia & Bienestar', icon: ShieldCheck, color: 'text-sky-400' },
    { label: 'Café & Panadería', icon: Flame, color: 'text-yellow-400' },
  ];

  return (
    <div className="flex flex-wrap items-center justify-center gap-2.5 sm:gap-3 py-4">
      {categories.map((cat, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-full border border-[#232E46] bg-[#0E131E]/60 px-4 py-2 text-xs font-medium text-[#A0ABC0] backdrop-blur-sm transition-all hover:border-[#E5B242]/40 hover:text-white hover:bg-[#141B2A]/80 cursor-default"
        >
          <cat.icon className={`h-3.5 w-3.5 ${cat.color}`} />
          <span>{cat.label}</span>
        </div>
      ))}
    </div>
  );
}

function SparkleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
    </svg>
  );
}
