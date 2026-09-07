import { ScrollViewStyleReset } from 'expo-router/html';

// Este archivo sólo se usa en web (convención de expo-router: "+html.tsx"
// reemplaza el <html> raíz del export estático). No corre en iOS/Android.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
        />
        <meta name="description" content="Pide en tus comercios favoritos y sigue tu pedido en tiempo real." />
        <meta name="theme-color" content="#141A2E" />

        {/* Instalable como PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-180.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Zipp" />

        {/*
          React Native Web pone overflow en los ScrollView vía estilos en línea;
          esto resetea el <body>/<html> para que el scroll se comporte como en
          nativo en vez de como una página normal.
        */}
        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
  html, body { background-color: #141A2E; }
`;
