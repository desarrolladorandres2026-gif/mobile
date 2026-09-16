import { buildDirectionsUrl, geoPointToLatLng } from '../lib/mapNavigation';

/**
 * A dónde manda "Navegar" al domiciliario.
 *
 * Dos cosas concretas se rompían antes: el enlace abría un marcador
 * (`/maps/search/`) en vez de arrancar direcciones de manejo, y la
 * tarjeta de "Mis Entregas" leía `order.deliveryLatitude/Longitude` —
 * campos que no existen en el pedido persistido— así que ese botón caía
 * siempre al texto de la dirección, ignorando la coordenada real.
 */
describe('geoPointToLatLng', () => {
  it('lee lat/lng de un punto GeoJSON [lng, lat], sin invertirlos', () => {
    expect(geoPointToLatLng({ coordinates: [-75.6258, 2.1958] })).toEqual({
      lat: 2.1958,
      lng: -75.6258,
    });
  });

  it('no confunde longitud con latitud', () => {
    const { lat, lng } = geoPointToLatLng({ coordinates: [10, 20] });
    expect(lat).toBe(20);
    expect(lng).toBe(10);
  });

  it('devuelve undefined sin coordenadas, en vez de reventar', () => {
    expect(geoPointToLatLng(null)).toEqual({ lat: undefined, lng: undefined });
    expect(geoPointToLatLng(undefined)).toEqual({ lat: undefined, lng: undefined });
    expect(geoPointToLatLng({})).toEqual({ lat: undefined, lng: undefined });
  });
});

describe('buildDirectionsUrl', () => {
  it('usa el endpoint de direcciones (turn-by-turn), no el de búsqueda', () => {
    const url = buildDirectionsUrl('Cra 10 #5-23', 2.1958, -75.6258);
    expect(url).toContain('/maps/dir/');
    expect(url).not.toContain('/maps/search/');
    expect(url).toContain('travelmode=driving');
  });

  it('con coordenadas válidas, el destino es "lat,lng" en ese orden', () => {
    const url = buildDirectionsUrl('Cra 10 #5-23', 2.1958, -75.6258);
    expect(url).toContain('destination=2.1958,-75.6258');
  });

  it('sin coordenadas, cae a la dirección en texto', () => {
    const url = buildDirectionsUrl('Cra 10 #5-23', undefined, undefined);
    expect(url).toContain(`destination=${encodeURIComponent('Cra 10 #5-23')}`);
  });

  it('trata (0,0) como "sin coordenadas" (Null Island no es una dirección real)', () => {
    const url = buildDirectionsUrl('Cra 10 #5-23', 0, 0);
    expect(url).toContain(`destination=${encodeURIComponent('Cra 10 #5-23')}`);
  });

  it('el pickup de un negocio y el de un mandado usan su propio punto, nunca el de entrega', () => {
    const business = { coordinates: [-75.6, 2.1] };
    const errandPickup = { coordinates: [-75.7, 2.2] };
    const delivery = { coordinates: [-75.8, 2.3] };

    const toBusiness = geoPointToLatLng(business);
    const toErrandPickup = geoPointToLatLng(errandPickup);
    const toDelivery = geoPointToLatLng(delivery);

    expect(buildDirectionsUrl('Negocio', toBusiness.lat, toBusiness.lng)).toContain(
      'destination=2.1,-75.6'
    );
    expect(buildDirectionsUrl('Punto de compra', toErrandPickup.lat, toErrandPickup.lng)).toContain(
      'destination=2.2,-75.7'
    );
    expect(buildDirectionsUrl('Cliente', toDelivery.lat, toDelivery.lng)).toContain(
      'destination=2.3,-75.8'
    );
  });
});
