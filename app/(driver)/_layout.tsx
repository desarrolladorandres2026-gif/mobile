import { Stack } from 'expo-router';
import { Colors } from '../../constants';

export default function DriverLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
