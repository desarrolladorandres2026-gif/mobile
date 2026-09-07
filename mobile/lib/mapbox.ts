import AsyncStorage from '@react-native-async-storage/async-storage';
import { trackingApi } from '../services/endpoints';

/**
 * Configuración de mapas de ZIPP.
 *
 * El token de Mapbox no está escrito en ningún archivo de la app: lo pide
 * al backend, que lo lee de su `.env`. Es una llamada de red extra al
 * arrancar a cambio de poder rotar la clave sin publicar una versión nueva
 * en las tiendas — la diferencia entre rotar en diez minutos y esperar una
 * semana de revisión mientras la clave comprometida sigue viva.
 */

export interface MapConfig {
  accessToken: string;
  enabled: boolean;
  style: string;
  styleDark: string;
  tracking?: {
    minPersistIntervalMs: number;
    minMoveMeters: number;
    maxAccuracyMeters: number;
    /** Cada cuánto reenviar la última posición aunque el GPS no entregue nada. */
    heartbeatMs: number;
    /** Sin señal por más de esto, el servidor da al repartidor por perdido. */
    staleAfterMs: number;
  };
}

const CACHE_KEY = 'zipp.mapConfig';

let memoryCache: MapConfig | null = null;
let inFlight: Promise<MapConfig | null> | null = null;

/**
 * Config de mapas, del backend o del último valor conocido.
 *
 * Tres niveles a propósito: memoria (instantáneo), disco (sobrevive al
 * cierre de la app) y red (la verdad). Un repartidor que entra a un sótano
 * sin señal tiene que poder seguir viendo el mapa con el token que ya
 * usaba; obligarle a una llamada de red para pintar un mapa sería romper
 * la app justo donde peor cobertura hay.
 */
export async function getMapConfig(force = false): Promise<MapConfig | null> {
  if (!force && memoryCache) return memoryCache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const config = (await trackingApi.getConfig()) as MapConfig;
      if (config?.accessToken) {
        memoryCache = config;
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(config));
      }
      return config;
    } catch {
      // La red falló. El último token conocido sigue siendo válido: los
      // tokens de Mapbox no caducan solos, se revocan.
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          memoryCache = JSON.parse(cached) as MapConfig;
          return memoryCache;
        }
      } catch {
        // Almacenamiento no disponible. Sin mapa, pero la app sigue.
      }
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Olvida la config cacheada. Se llama al cerrar sesión. */
export async function clearMapConfig(): Promise<void> {
  memoryCache = null;
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // Nada que hacer: el token es público y su caducidad la fija el servidor.
  }
}

// ── Tipos compartidos entre el mapa nativo y el web ───────────────────

export interface MapPoint {
  lat: number;
  lng: number;
}

export type MarkerKind = 'driver' | 'business' | 'client';

export interface MapMarker extends MapPoint {
  id: string;
  kind: MarkerKind;
  label?: string;
  /** Grados. Gira el icono del repartidor hacia donde va. */
  heading?: number | null;
  /** Sin señal reciente: se pinta atenuado en vez de fingir precisión. */
  stale?: boolean;
}

export interface MapRoute {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface MapState {
  center?: MapPoint | null;
  zoom?: number;
  markers: MapMarker[];
  route?: MapRoute | null;
  /** Camino ya recorrido. Se dibuja punteado detrás del repartidor. */
  trail?: MapPoint[] | null;
  /** Encuadra todos los marcadores y la ruta. Se ignora si `follow`. */
  fitAll?: boolean;
  /** Centra la cámara en el repartidor en cada actualización. */
  follow?: boolean;
  /**
   * Solo en modo `pick`: mueve la cámara al `center` cuando cambia de valor.
   *
   * En el mapa de elegir punto la cámara y el estado se persiguen — el
   * usuario arrastra, el mapa reporta el centro nuevo, el host lo guarda y
   * lo devolvería como `center`, que dispararía otro movimiento y otro
   * reporte. Obedecer solo cuando esta llave cambia deja que el arrastre
   * mande y reserva la cámara para lo que sí la pide: el botón de volver a
   * mi ubicación.
   */
  recenterKey?: number;
}

export interface MapPalette {
  route: string;
  trail: string;
  driver: string;
  business: string;
  client: string;
  stale: string;
  onMarker: string;
  /** Fondo del documento mientras los tiles se descargan. */
  background: string;
}

/**
 * Documento HTML que corre dentro del WebView.
 *
 * Se genera una sola vez con el token y el estilo, y a partir de ahí la
 * comunicación es por `postMessage`: recargar el HTML en cada cambio
 * volvería a descargar los tiles y haría parpadear el mapa entero cada
 * cinco segundos.
 *
 * El token entra aquí y no en la URL de un iframe para que no acabe en el
 * historial ni en los logs del navegador embebido.
 */
export function buildMapHtml(config: {
  accessToken: string;
  style: string;
  palette: MapPalette;
  /**
   * Modo "elegir punto": una cruz fija en el centro y el mapa moviéndose
   * debajo, en vez de un pin que se arrastra.
   *
   * Se eligió así porque el pin arrastrable obliga a tapar con el dedo
   * justo el punto que se está intentando ver, y en una pantalla de
   * teléfono eso es la mitad de la manzana. Con el objetivo fijo, el dedo
   * empuja el mapa desde cualquier parte y el punto queda siempre a la
   * vista.
   */
  pick?: boolean;
}): string {
  const { accessToken, style, palette, pick = false } = config;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<!--
  La versión va fijada a propósito: un "latest" haría que una publicación
  de Mapbox cambiara el mapa de la app sin que nadie lo desplegara.

  Sin atributo integrity, deliberadamente. La regla general —firmar todo
  script de CDN— protege de que un tercero altere el código; aquí el "tercero" es
  api.mapbox.com, que es también quien sirve el estilo y cada tile del
  mapa. Un compromiso de ese host ya controla lo que se dibuja, así que
  firmar el script no defiende de nada que no esté ya perdido, y a cambio
  rompería el mapa entero el día que Mapbox reconstruya el archivo.
-->
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet" />
<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: ${palette.background}; }
  .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib { transform: scale(0.8); transform-origin: bottom left; }
  .zipp-pin {
    width: 34px; height: 34px; border-radius: 17px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.28);
    border: 2px solid ${palette.onMarker};
    font: 600 13px/1 -apple-system, system-ui, sans-serif;
    color: ${palette.onMarker};
    transition: opacity .3s ease;
  }
  .zipp-pin.driver { background: ${palette.driver}; }
  .zipp-pin.business { background: ${palette.business}; }
  .zipp-pin.client { background: ${palette.client}; }
  .zipp-pin.stale { background: ${palette.stale}; opacity: .55; }
  .zipp-arrow { transition: transform .5s linear; }

  /*
    Objetivo del modo "elegir punto".

    La punta de la gota tiene que caer en el centro exacto del mapa, que es
    la coordenada que se guarda. Girada -45deg, la esquina afilada de un
    cuadrado de 26px queda 18.4px (26 * 0.7071) por debajo de su centro, así
    que el elemento se sube esos 18.4px más su media altura. Sin esa cuenta
    el pin miente por casi dos centímetros de calle.
  */
  .zipp-target-head {
    position: absolute; left: 50%; top: 50%;
    width: 26px; height: 26px;
    margin-left: -13px; margin-top: -31.4px;
    border-radius: 50% 50% 50% 0;
    background: ${palette.client};
    border: 2.5px solid ${palette.onMarker};
    box-shadow: 0 4px 12px rgba(0,0,0,.35);
    transform: rotate(-45deg);
    transition: transform .18s ease-out;
    pointer-events: none;
    z-index: 3;
  }
  /* Levantado mientras el mapa se mueve: dice "esto se está recolocando". */
  .zipp-target-head.lifted { transform: translateY(-7px) rotate(-45deg); }

  /* Marca en el suelo. Es lo que hace legible la altura del salto. */
  .zipp-target-dot {
    position: absolute; left: 50%; top: 50%;
    width: 9px; height: 9px; margin-left: -4.5px; margin-top: -4.5px;
    border-radius: 50%;
    background: rgba(0,0,0,.28);
    pointer-events: none;
    z-index: 2;
  }
</style>
</head>
<body>
<div id="map"></div>
${pick ? '<div class="zipp-target-dot"></div><div class="zipp-target-head" id="target"></div>' : ''}
<script>
(function () {
  mapboxgl.accessToken = ${JSON.stringify(accessToken)};

  var map = new mapboxgl.Map({
    container: 'map',
    style: ${JSON.stringify(style)},
    center: [-75.6258, 2.1958],
    zoom: 13,
    attributionControl: false,
    // El mapa de un domicilio se lee de un vistazo con el teléfono en la
    // mano: rotarlo sin querer con dos dedos desorienta más de lo que
    // aporta, y en el bolsillo del repartidor pasa constantemente.
    pitchWithRotate: false,
    dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();

  var PICK = ${pick ? 'true' : 'false'};

  var markers = {};
  var ready = false;
  var pending = null;
  var animations = {};
  var lastRecenterKey = null;

  /**
   * Avisa al anfitrión, sea cual sea.
   *
   * Este mismo documento corre en dos sitios: dentro de un WebView en el
   * teléfono y dentro de un iframe en la versión web. Cada uno tiene su
   * canal de vuelta. Detectarlo aquí permite que exista un solo generador
   * de HTML en lugar de dos que se van separando con cada arreglo.
   */
  function post(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify(payload), '*');
    }
  }

  // Los marcadores se construyen con nodos del DOM, nunca con innerHTML.
  // Hoy el contenido es constante, pero el día que alguien meta aquí el
  // nombre del negocio o del cliente —que son texto que escribe un
  // usuario— innerHTML convertiría ese nombre en un vector de XSS dentro
  // de un WebView que lleva el token de Mapbox en memoria.
  function makeElement(marker) {
    var el = document.createElement('div');
    el.className = 'zipp-pin ' + marker.kind + (marker.stale ? ' stale' : '');
    if (marker.kind === 'driver') {
      var arrow = document.createElement('span');
      arrow.className = 'zipp-arrow';
      arrow.textContent = '\\u25B2';
      el.appendChild(arrow);
    } else {
      el.textContent = marker.kind === 'business' ? 'L' : 'T';
    }
    return el;
  }

  /**
   * Mueve un marcador interpolando en vez de teletransportarlo.
   *
   * Las posiciones llegan cada pocos segundos. Aplicarlas de golpe hace
   * que el repartidor salte de manzana en manzana y el mapa parezca roto
   * o congelado entre salto y salto. Animando el tramo, el mismo dato se
   * lee como un vehículo que avanza.
   */
  function moveTo(id, marker, lngLat) {
    var from = marker.getLngLat();
    var dx = lngLat[0] - from.lng;
    var dy = lngLat[1] - from.lat;

    // Un salto grande no es movimiento: es una corrección del GPS o la
    // primera posición tras recuperar señal. Animarla durante segundos
    // mostraría al repartidor cruzando la ciudad en línea recta.
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
      marker.setLngLat(lngLat);
      return;
    }

    if (animations[id]) cancelAnimationFrame(animations[id]);

    var start = performance.now();
    var duration = 900;

    function step(now) {
      var t = Math.min(1, (now - start) / duration);
      marker.setLngLat([from.lng + dx * t, from.lat + dy * t]);
      if (t < 1) animations[id] = requestAnimationFrame(step);
      else delete animations[id];
    }
    animations[id] = requestAnimationFrame(step);
  }

  function setLine(id, coordinates, color, dashed) {
    var data = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coordinates || [] } };

    if (map.getSource(id)) {
      map.getSource(id).setData(data);
      return;
    }
    if (!coordinates || coordinates.length < 2) return;

    map.addSource(id, { type: 'geojson', data: data });
    map.addLayer({
      id: id,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: Object.assign(
        { 'line-color': color, 'line-width': dashed ? 3 : 5, 'line-opacity': dashed ? 0.55 : 0.9 },
        dashed ? { 'line-dasharray': [1.5, 1.5] } : {}
      ),
    // La ruta va por debajo de las etiquetas de calle: tapar los nombres
    // de las vías en un mapa de navegación es esconder justo el dato que
    // se está buscando.
    }, firstSymbolLayer());
  }

  function firstSymbolLayer() {
    var layers = map.getStyle().layers || [];
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].type === 'symbol') return layers[i].id;
    }
    return undefined;
  }

  function apply(state) {
    if (!ready) { pending = state; return; }

    var seen = {};
    (state.markers || []).forEach(function (m) {
      seen[m.id] = true;
      var lngLat = [m.lng, m.lat];

      if (markers[m.id]) {
        var existing = markers[m.id];
        moveTo(m.id, existing, lngLat);
        var el = existing.getElement();
        el.className = 'zipp-pin ' + m.kind + (m.stale ? ' stale' : '');
        var arrow = el.querySelector('.zipp-arrow');
        if (arrow && typeof m.heading === 'number') {
          arrow.style.transform = 'rotate(' + m.heading + 'deg)';
        }
      } else {
        var created = new mapboxgl.Marker({ element: makeElement(m) })
          .setLngLat(lngLat)
          .addTo(map);
        markers[m.id] = created;
      }
    });

    Object.keys(markers).forEach(function (id) {
      if (!seen[id]) { markers[id].remove(); delete markers[id]; }
    });

    setLine('zipp-trail', (state.trail || []).map(function (p) { return [p.lng, p.lat]; }), ${JSON.stringify(palette.trail)}, true);
    setLine('zipp-route', state.route ? state.route.coordinates : [], ${JSON.stringify(palette.route)}, false);

    // En modo pick el arrastre del usuario es la fuente de verdad de la
    // cámara. Solo se le quita el mando cuando llega una llave nueva —
    // esto es, cuando alguien tocó "volver a mi ubicación".
    if (PICK) {
      if (state.center && state.recenterKey !== lastRecenterKey) {
        lastRecenterKey = state.recenterKey;
        map.easeTo({ center: [state.center.lng, state.center.lat], zoom: state.zoom || 17, duration: 600 });
      }
      return;
    }

    if (state.follow) {
      var driver = (state.markers || []).filter(function (m) { return m.kind === 'driver'; })[0];
      if (driver) map.easeTo({ center: [driver.lng, driver.lat], zoom: state.zoom || 16, duration: 900 });
    } else if (state.fitAll) {
      var points = (state.markers || []).map(function (m) { return [m.lng, m.lat]; });
      if (state.route && state.route.coordinates) points = points.concat(state.route.coordinates);
      if (points.length === 1) {
        map.easeTo({ center: points[0], zoom: state.zoom || 15, duration: 600 });
      } else if (points.length > 1) {
        var bounds = points.reduce(function (b, p) { return b.extend(p); }, new mapboxgl.LngLatBounds(points[0], points[0]));
        map.fitBounds(bounds, { padding: 64, maxZoom: 16, duration: 600 });
      }
    } else if (state.center) {
      map.easeTo({ center: [state.center.lng, state.center.lat], zoom: state.zoom || 14, duration: 600 });
    }
  }

  window.__zippMap = { apply: apply };

  // Camino de entrada del iframe. En el WebView el anfitrión llama a
  // window.__zippMap.apply por inyección directa; en web no puede, así
  // que el estado entra por postMessage.
  //
  // El origen es "null" porque el documento se sirve por srcDoc, así que
  // no se puede filtrar por él. Lo que sí se puede es no confiar en la
  // forma: cualquier cosa que no sea un estado de mapa reconocible se
  // descarta sin tocarla.
  window.addEventListener('message', function (event) {
    try {
      var payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (payload && payload.__zipp === 'state' && Array.isArray(payload.state.markers)) {
        apply(payload.state);
      }
    } catch (err) {
      // Mensaje ajeno al puente. Ignorado a propósito.
    }
  });

  if (PICK) {
    var target = document.getElementById('target');

    map.on('movestart', function () { if (target) target.classList.add('lifted'); });

    /*
      El punto se reporta al soltar, no mientras se arrastra.

      El evento "move" se dispara en cada fotograma del gesto; cruzar ese
      puente sesenta veces por segundo satura el canal con el WebView y, del
      otro lado, provoca un render de React por fotograma. "moveend" da el
      único dato que importa —dónde quedó— una sola vez.
    */
    map.on('moveend', function () {
      if (target) target.classList.remove('lifted');
      var c = map.getCenter();
      post({ type: 'moved', lat: c.lat, lng: c.lng });
    });
  }

  map.on('load', function () {
    ready = true;
    post({ type: 'ready' });
    if (pending) { apply(pending); pending = null; }
  });

  map.on('error', function (e) {
    post({ type: 'error', message: (e && e.error && e.error.message) || 'Error del mapa' });
  });
})();
</script>
</body>
</html>`;
}
