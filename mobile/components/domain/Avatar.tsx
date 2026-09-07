import { View } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { initials } from '../../lib/format';

/** Foto de perfil de un usuario, con degradado a iniciales si no hay imagen. */
export function Avatar({
  uri,
  name,
  size,
  fontVariant = 'displayM',
}: {
  uri?: string | null;
  name?: string;
  size: number;
  fontVariant?: 'displayM' | 'titleL';
}) {
  const { c } = useTheme();
  const radius = size / 2;

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: radius }}
        contentFit="cover"
        transition={150}
        accessibilityLabel="Foto de perfil"
      />
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: c.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text v={fontVariant} color="#FFFFFF">
        {initials(name)}
      </Text>
    </View>
  );
}
