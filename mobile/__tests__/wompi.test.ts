import { tokenizeCard, CardTokenizationError } from '../lib/wompi';

const CARD = { number: '4242 4242 4242 4242', cvc: '123', expMonth: '12', expYear: '29', holder: ' Ana Pérez ' };

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

describe('tokenizeCard', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('tokeniza contra el sandbox con la llave pública y nada más', async () => {
    const spy = respond(201, {
      data: { id: 'tok_test_1_ABC', brand: 'VISA', last_four: '4242', exp_month: '12', exp_year: '29' },
    });
    global.fetch = spy as unknown as typeof fetch;

    const result = await tokenizeCard('pub_test_xyz', CARD);

    expect(result).toEqual({ token: 'tok_test_1_ABC', brand: 'VISA', lastFour: '4242', expMonth: '12', expYear: '29' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://sandbox.wompi.co/v1/tokens/cards');
    // La única credencial es la pública del comercio: nunca la sesión de Zipp.
    expect(init.headers).toEqual({ Authorization: 'Bearer pub_test_xyz', 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    expect(body.number).toBe('4242424242424242');
    expect(body.card_holder).toBe('Ana Pérez');
  });

  it('usa producción solo con una llave de producción', async () => {
    const spy = respond(201, { data: { id: 'tok_prod_1_ABC' } });
    global.fetch = spy as unknown as typeof fetch;
    await tokenizeCard('pub_prod_xyz', CARD);
    expect(spy.mock.calls[0][0]).toBe('https://production.wompi.co/v1/tokens/cards');
  });

  it('traduce el error de validación de Wompi al campo que falló', async () => {
    global.fetch = respond(422, {
      error: { type: 'INPUT_VALIDATION_ERROR', messages: { cvc: ['invalid'] } },
    }) as unknown as typeof fetch;

    const error = await tokenizeCard('pub_test_xyz', CARD).catch((e) => e);
    expect(error).toBeInstanceOf(CardTokenizationError);
    expect(error.field).toBe('cvc');
  });

  it('una caída de red se explica como tal', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;
    await expect(tokenizeCard('pub_test_xyz', CARD)).rejects.toThrow(/conexión/);
  });

  it('rechaza una respuesta que no trae un token', async () => {
    global.fetch = respond(201, { data: { id: 'algo-raro' } }) as unknown as typeof fetch;
    await expect(tokenizeCard('pub_test_xyz', CARD)).rejects.toBeInstanceOf(CardTokenizationError);
  });
});
