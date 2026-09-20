/**
 * Mini design system de Zipp.
 *
 * Las pantallas importan desde aquí y solo desde aquí. Si algo hace falta, se
 * agrega al sistema; no se resuelve con estilos sueltos en una pantalla, que
 * es como una app termina con nueve botones distintos.
 */

export { Text } from './Text';
export type { TextProps } from './Text';

export { Icon } from './Icon';
export type { IconProps } from './Icon';

export { Button, IconButton } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { GoogleButton } from './GoogleButton';
export { FacebookButton } from './FacebookButton';
export { AppleButton } from './AppleButton';

export { Card, SectionHeader, Sheet, DetailRow, ConfirmDialog } from './Surface';
export type { CardProps, SheetProps, ConfirmDialogProps } from './Surface';

export { Input, OtpInput, SearchField } from './Input';
export type { InputProps, OtpInputProps } from './Input';

export { PlainField } from './PlainField';
export type { PlainFieldProps } from './PlainField';

export { PlainSelect } from './PlainSelect';
export type { PlainSelectProps, PlainSelectOption } from './PlainSelect';

export {
  Badge, PulseDot, StatusPill, Chip, DismissChip, MetaRow, CountBadge, CatalogBadge, CatalogBadges,
} from './Badge';
export type { BadgeProps, BadgeTone, ChipProps, MetaItem } from './Badge';

export { CategoryChip } from './CategoryChip';
export type { CategoryChipProps } from './CategoryChip';

export {
  EmptyState, ErrorState, Notice,
  Skeleton, BusinessCardSkeleton, BusinessResultRowSkeleton, DiscoveryHubSkeleton,
  CouponCardSkeleton, LoadingScreen,
  OfflineBanner, SuccessCheck,
} from './Feedback';
export type { EmptyStateProps } from './Feedback';

export { Screen, ScreenFooter, Header, QtyStepper } from './Screen';
export type { HeaderProps } from './Screen';
