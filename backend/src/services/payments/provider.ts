/**
 * Payment provider contract.
 *
 * Nothing in the platform imports a payment SDK directly. Order flow talks
 * to this interface only, so swapping Wompi / Stripe / Mercado Pago is a
 * matter of adding one file and changing PAYMENT_PROVIDER — no changes to
 * business logic, controllers, or the mobile app.
 */

export type PaymentIntentStatus =
  | 'pending'      // created, awaiting customer action
  | 'processing'   // customer acted, provider is settling
  | 'approved'
  | 'declined'
  | 'refunded'
  | 'cancelled'
  // Gateway-native terminal states some providers (Wompi) report distinctly
  // from 'declined'. They still collapse to PaymentStatus.FAILED for order
  // gating — the raw value survives on Payment.gatewayStatus for audit.
  | 'voided'
  | 'error';

export interface CreatePaymentInput {
  orderId: string;
  userId: string;
  /** Integer amount in the currency's minor-unit-free form (COP has no cents). */
  amount: number;
  currency: string;
  description: string;
  customer: {
    name: string;
    // Both optional: a user who signed up with email OTP has no phone, and
    // one who signed up by phone has no email (see IUser). Wompi treats
    // every customer-data field as optional too, and the provider omits
    // whichever is missing rather than sending the string "undefined".
    phone?: string;
    email?: string;
  };
  /** Where the provider should send the customer back to. */
  redirectUrl?: string;
  /**
   * Merchant-generated unique reference for this attempt, minted once by
   * PaymentService and stable across retries of the same pending payment.
   * Redirect-based providers (Wompi Web Checkout) have nothing else to key
   * on until the gateway assigns its own id, so this is what ties a webhook
   * back to the local Payment row. Optional only so providers that don't
   * need it (sandbox, tests) can omit it — PaymentService always sets it.
   */
  reference?: string;
}

export interface PaymentIntent {
  /** Provider-side identifier. Persisted as Payment.transactionId. */
  id: string;
  status: PaymentIntentStatus;
  amount: number;
  currency: string;
  orderId: string;
  /** Hosted checkout URL, when the provider uses a redirect flow. */
  checkoutUrl?: string;
  /** Human-readable reason when declined. */
  declineReason?: string;
  /** Specific rail used (CARD, NEQUI, PSE, BANCOLOMBIA_TRANSFER…), once known. */
  paymentMethodType?: string;
  /** The gateway's own, un-mapped status string (e.g. Wompi's "APPROVED"),
   *  kept for audit even though only `status` drives platform logic. */
  rawStatus?: string;
  raw?: unknown;

  // ── Cobro nativo (dentro de la app) ──
  /**
   * Reto 3D Secure que el cliente tiene que resolver, ya decodificado y
   * listo para pintarse. Wompi lo entrega con las entidades HTML escapadas
   * y exige renderizarlo con `srcDoc`, no con `src`: es un documento, no
   * una dirección. Presente solo cuando el banco pide autenticación.
   */
  threeDsChallengeHtml?: string;
  /**
   * URL a la que la pasarela manda al cliente para que su banco autorice
   * (PSE, Bancolombia). Se abre en un WebView **dentro** de la app, nunca
   * en el navegador del sistema: ese salto es justo lo que este camino
   * existe para evitar.
   */
  asyncPaymentUrl?: string;
  /** Identificador de la fuente de pago creada, cuando se guardó la tarjeta. */
  paymentSourceId?: number;
  /**
   * El carril espera un código de un solo uso que la pasarela acaba de
   * mandarle al cliente por SMS (DaviPlata).
   *
   * Es un booleano y no la dirección del servicio de OTP a propósito: esa
   * dirección viaja con un `Bearer` que autoriza a confirmar el cobro, y no
   * tiene por qué salir del servidor. El cliente solo necesita saber que
   * toca pedirle seis dígitos a la persona.
   */
  otpRequired?: boolean;
}

export interface WebhookEvent {
  /** Key to resolve the local Payment row — a provider's own id or, for
   *  reference-based providers, the merchant reference. */
  paymentId: string;
  status: PaymentIntentStatus;
  amount?: number;
  /** ISO-4217 code the gateway settled in. Checked against the local row when present. */
  currency?: string;
  /** The provider's own transaction id, when different from `paymentId`. */
  gatewayTransactionId?: string;
  /** Human-readable status detail (decline reason, gateway message). */
  message?: string;
  paymentMethodType?: string;
  /** The gateway's own, un-mapped status string — see PaymentIntent.rawStatus. */
  rawStatus?: string;
  raw?: unknown;
}


/**
 * Lo que el dispositivo necesita para cobrar sin salir de la app.
 *
 * La llave que viaja aquí es **la pública**, y eso no es un descuido: es la
 * que Wompi documenta para tokenizar desde el cliente. Con ella el número
 * de tarjeta va del teléfono a la pasarela sin pasar por este servidor, que
 * solo llega a ver un `tok_...`. La privada y el secreto de integridad no
 * salen del proceso.
 */
export interface CheckoutConfig {
  publicKey: string;
  environment: 'test' | 'production';
  /** Consentimiento de términos. Obligatorio en toda transacción. */
  acceptanceToken: string;
  /** Consentimiento de tratamiento de datos. Obligatorio para guardar una tarjeta. */
  personalDataAuthToken: string;
  /**
   * Los documentos que el usuario tiene derecho a leer antes de aceptar.
   * Van juntos con los tokens a propósito: un consentimiento que no se
   * puede leer no es un consentimiento, es una casilla.
   */
  permalinks: {
    termsAndConditions?: string;
    personalDataAuth?: string;
  };
  /**
   * A dónde vuelve la persona desde su banco (PSE). La app la intercepta
   * dentro de su WebView en vez de cargarla.
   */
  returnUrl: string;
  /**
   * Si los cobros con tarjeta nueva piden 3D Secure. Con esto en verdadero
   * la app manda los datos de su navegador, que Wompi exige para el reto.
   */
  threeDs: boolean;
}

/**
 * Con qué se cobra. Unión discriminada y no un objeto laxo: cada carril
 * pide datos distintos, y un campo de más viajando "por si acaso" es
 * exactamente como un CVV acaba en un log.
 *
 * Ninguna variante lleva número de tarjeta. Cuando el cliente paga con una
 * tarjeta nueva, ya la tokenizó él contra Wompi y lo único que llega aquí
 * es el token.
 */
export type PaymentInstrument =
  | {
      kind: 'card_token';
      /** `tok_test_...` / `tok_prod_...`, emitido por Wompi al dispositivo. */
      token: string;
      /** Cuotas. 1 = una sola. Wompi lo exige en toda transacción con tarjeta. */
      installments: number;
    }
  | {
      kind: 'saved_source';
      /**
       * Id de la fuente en la pasarela. Solo lo construye `PaymentService`
       * a partir de una `SavedCard` cuyo dueño ya comprobó: la app nunca lo
       * manda, ver `SavedCard`.
       */
      paymentSourceId: number;
      installments: number;
    }
  | { kind: 'nequi'; phone: string }
  /**
   * Botón Bancolombia. No lleva campos: Wompi solo pide `user_type`, y
   * quien compra en Zipp es una persona. Preguntárselo sería una pantalla
   * más para una respuesta que ya sabemos.
   */
  | { kind: 'bancolombia_transfer' }
  /**
   * DaviPlata. Wompi busca la billetera por documento y manda un código al
   * teléfono asociado; no se pide número de celular porque el que vale es el
   * que DaviPlata tiene registrado, no el que escriba quien paga.
   */
  | { kind: 'daviplata'; userLegalIdType: string; userLegalId: string }
  | {
      kind: 'pse';
      financialInstitutionCode: string;
      /** 0 = persona natural, 1 = jurídica. Es la codificación de Wompi. */
      userType: 0 | 1;
      /** CC, CE, NIT, TI… */
      userLegalIdType: string;
      userLegalId: string;
    };

export interface CreateNativePaymentInput extends CreatePaymentInput {
  instrument: PaymentInstrument;
  /**
   * El token de aceptación **que se le mostró al usuario**, devuelto tal
   * cual por el cliente y reenviado a Wompi sin reescribirlo.
   *
   * Viaja de ida y vuelta en vez de pedirlo el servidor en el momento de
   * cobrar porque así lo que se envía es el consentimiento que la persona
   * tuvo delante, no uno equivalente que nadie llegó a ver.
   *
   * Tampoco se contrasta contra el vigente: estos tokens rotan, y una
   * rotación entre que se pinta la pantalla y se toca "Pagar" convertiría
   * esa comprobación en un rechazo de un cobro legítimo. Quien sabe si
   * sigue siendo válido es Wompi, y lo dice al recibirlo.
   */
  acceptanceToken: string;
  /** Solo cuando se va a guardar la tarjeta. */
  personalDataAuthToken?: string;
  /**
   * Datos del navegador que 3D Secure v2 exige (`browser_color_depth`,
   * `browser_user_agent`…), con los nombres de Wompi. Solo se usan si el
   * comercio tiene 3DS encendido y el cobro es con tarjeta nueva.
   */
  browserInfo?: Record<string, string>;
}

/**
 * Guardar una tarjeta ya tokenizada como fuente de pago reutilizable.
 *
 * El token se consume al hacerlo: Wompi no deja usar el mismo `tok_...`
 * para crear la fuente y además para una transacción. Por eso "pagar y
 * guardar" es crear la fuente primero y cobrar después contra ella.
 */
export interface CreatePaymentSourceInput {
  token: string;
  customerEmail: string;
  acceptanceToken: string;
  /** Obligatorio aquí: guardar una tarjeta es tratar datos personales. */
  personalDataAuthToken: string;
}

/** Un banco de la lista de PSE. */
export interface PseFinancialInstitution {
  code: string;
  name: string;
}

/**
 * Cuántas veces se ha pedido y se ha probado el código, y cuántas quedan.
 *
 * Se devuelve al cliente porque "te queda un intento" y "código incorrecto"
 * son dos mensajes distintos, y el segundo a secas hace que la gente gaste
 * el último intento sin saberlo.
 */
export interface OtpAttempts {
  sent: number;
  maxSends: number;
  validated: number;
  maxValidations: number;
}

/**
 * La pasarela dijo que no al código, y no por un fallo de red: se agotaron
 * los intentos, la sesión venció o la transacción ya terminó.
 *
 * Se distingue de un `Error` cualquiera porque piden respuestas distintas.
 * Esto es una respuesta —la persona tiene que saberlo y pasar a otra
 * cosa—; un fallo de red es un "inténtalo otra vez".
 */
export class OtpRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: 'exhausted' | 'expired' | 'finalized'
  ) {
    super(message);
    this.name = 'OtpRejectedError';
  }
}

/**
 * La pasarela no quiso crear el cobro, y se sabe decirle al cliente por qué.
 *
 * Lleva dos textos porque tienen dos lectores. `message` es para el registro
 * y el soporte: el detalle crudo de la pasarela, con su código HTTP y su
 * JSON. `customerMessage` es lo único que sale hacia la app — en español
 * llano y sin el nombre de la pasarela, que mucha gente no conoce y que
 * leído en un rechazo hace pensar que el cobro fue a otra empresa.
 *
 * Un `Error` cualquiera que salga de `createNativePayment` no se enseña:
 * quien llama lo cambia por un mensaje genérico.
 */
export class GatewayRejectedError extends Error {
  constructor(
    message: string,
    readonly customerMessage: string
  ) {
    super(message);
    this.name = 'GatewayRejectedError';
  }
}

/** Resultado de entregarle a la pasarela el código que escribió el cliente. */
export interface OtpOutcome {
  /**
   * La pasarela dio el código por bueno. No significa que el cobro esté
   * aprobado: la transacción puede seguir `pending` y resolverse después.
   */
  accepted: boolean;
  attempts?: OtpAttempts;
  /** La transacción releída de la pasarela justo después del intento. */
  intent: PaymentIntent;
}

export interface PaymentProvider {
  readonly name: string;

  /** True when this provider needs real credentials that are absent. */
  isConfigured(): boolean;

  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;

  getPayment(paymentId: string): Promise<PaymentIntent>;

  /**
   * La transacción creada con nuestra referencia, o `null` si la pasarela
   * confirma que no existe ninguna. Lanza si no se le pudo preguntar.
   *
   * Es lo que resuelve un cobro cuya creación se cortó por la red: sin
   * esto no hay forma de saber si la pasarela lo alcanzó a crear.
   */
  findPaymentByReference?(reference: string): Promise<PaymentIntent | null>;

  refund(paymentId: string, amount?: number): Promise<PaymentIntent>;

  /**
   * Verifies a webhook's authenticity from the raw request body.
   * Must return false rather than throwing on malformed input.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  /** Translates a provider payload into a normalized event. */
  parseWebhook(payload: unknown): WebhookEvent | null;

  /**
   * Re-reads the event's transaction from the gateway and returns the
   * gateway's own version of it.
   *
   * Optional, and implemented by any provider whose signature does not
   * cover every field that matters. Wompi is one: its checksum covers only
   * `transaction.id`, `transaction.status` and `transaction.amount_in_cents`
   * — the `reference` that resolves the local payment row travels unsigned,
   * so a single genuine event body could otherwise be retargeted at another
   * order of the same amount.
   *
   * Contract:
   *  - Return the authoritative event; PaymentService applies **this** and
   *    discards the delivered payload's version of the same fields.
   *  - Return `null` when the gateway contradicts the event. That is a
   *    forgery, and it must not be retried.
   *  - Throw when the gateway could not be reached. That is not an answer,
   *    and the caller turns it into a retry rather than a rejection.
   */
  confirmEvent?(event: WebhookEvent): Promise<WebhookEvent | null>;

  // ── Cobro nativo ──
  //
  // Opcionales, y no por indecisión: un proveedor puede cobrar
  // perfectamente por redirección y no ofrecer nada de esto. El sandbox es
  // uno. `PaymentService` comprueba su presencia y responde 501 en vez de
  // romperse, así que añadir un proveedor nuevo no obliga a escribirlos.

  /** Llave pública, entorno y tokens de aceptación vigentes. */
  getCheckoutConfig?(): Promise<CheckoutConfig>;

  /**
   * Cobra con un instrumento que el cliente ya capturó en la app.
   *
   * A diferencia de `createPayment`, esto **sí** llama a la pasarela y crea
   * una transacción real. El estado que devuelve casi nunca es definitivo:
   * una tarjeta tarda segundos y un Nequi minutos, así que quien llama debe
   * esperar el webhook o consultar, nunca dar por aprobado lo que vuelva.
   */
  createNativePayment?(input: CreateNativePaymentInput): Promise<PaymentIntent>;

  /** Bancos disponibles para PSE. */
  listPseBanks?(): Promise<PseFinancialInstitution[]>;

  /** Convierte un token de tarjeta en una fuente de pago reutilizable. */
  createPaymentSource?(input: CreatePaymentSourceInput): Promise<{ id: number }>;

  // ── Código de un solo uso (DaviPlata) ──
  //
  // Opcionales por la misma razón que el resto del cobro nativo: un
  // proveedor puede no tener ningún carril que pida OTP. `PaymentService`
  // comprueba su presencia y responde 501 en vez de romperse.

  /** Vuelve a mandarle el código al cliente. */
  resendOtp?(gatewayTransactionId: string): Promise<OtpAttempts | undefined>;

  /**
   * Entrega el código que escribió el cliente y devuelve la transacción tal
   * como queda después.
   *
   * Lo que vuelve **no** es la última palabra: la pasarela puede seguir en
   * `pending` tras aceptar el código. Quien llama lo pasa por el mismo
   * camino que el webhook en vez de darlo por bueno.
   */
  validateOtp?(gatewayTransactionId: string, code: string): Promise<OtpOutcome>;
}
