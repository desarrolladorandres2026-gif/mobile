import { View, StyleSheet, Image } from 'react-native';
import { StatusBar } from 'expo-status-bar';

export function ZippSplashLoader() {
  return (
    <View style={styles.container}>
      <StatusBar style="dark" backgroundColor="#FFFFFF" />
      <Image
        source={require('../../assets/zipp-crown-splash.png')}
        style={styles.logo}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: '78%',
    maxWidth: 320,
    height: 320,
  },
});
