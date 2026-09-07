import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useThemeStore } from './stores/themeStore';
import { RealtimeProvider } from './hooks/RealtimeProvider';
import PrivateRoute from './components/PrivateRoute';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import OrdersPage from './pages/Orders';
import MenuPage from './pages/Menu';
import SettlementsPage from './pages/Settlements';
import Login from './pages/Login';

function App() {
  const initTheme = useThemeStore((s) => s.initTheme);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <BrowserRouter>
      {/*
        El proveedor envuelve también al login: la conexión solo se abre
        cuando hay sesión, y montarlo aquí evita que entrar al panel
        desmonte y vuelva a montar el socket con cada navegación.
      */}
      <RealtimeProvider>
        <Routes>
          {/* Ruta pública */}
          <Route path="/login" element={<Login />} />

          {/* Rutas protegidas — requieren sesión activa */}
          <Route element={<PrivateRoute />}>
            <Route path="/" element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="orders" element={<OrdersPage />} />
              <Route path="settlements" element={<SettlementsPage />} />
              <Route path="menu" element={<MenuPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </RealtimeProvider>
    </BrowserRouter>
  );
}

export default App;
