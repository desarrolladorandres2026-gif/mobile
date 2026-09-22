/**
 * El contrato de cualquier servicio que quite el fondo de una foto.
 *
 * La lógica de productos solo conoce esto. Cambiar Photoroom por otro
 * proveedor es escribir otra implementación y registrarla en `index.ts`:
 * ni el modelo, ni las rutas, ni el panel se enteran.
 */
export interface BackgroundRemovalInput {
  buffer: Buffer;
  mimetype: string;
}

export interface BackgroundRemovalOutput {
  /** Imagen con canal alfa: el producto sobre transparencia. */
  buffer: Buffer;
  format: 'png' | 'webp';
  width: number;
  height: number;
}

export interface BackgroundRemovalProvider {
  /** Nombre estable: se guarda en el producto y en las métricas. */
  readonly name: string;
  isConfigured(): boolean;
  removeBackground(input: BackgroundRemovalInput): Promise<BackgroundRemovalOutput>;
}

/**
 * Por qué falló, en palabras que el orquestador sabe tratar.
 *
 * El código es lo único que se guarda y se registra: el texto del
 * proveedor puede citar datos de la petición, y la clave nunca pasa por
 * aquí.
 */
export type BackgroundRemovalErrorCode =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'NO_CREDITS'
  | 'AUTH_FAILED'
  | 'REJECTED'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  // Fuera del proveedor, pero en el mismo camino: bajar el original de
  // Cloudinary y guardar allí el resultado.
  | 'SOURCE_UNAVAILABLE'
  | 'STORAGE_FAILED';

export class BackgroundRemovalError extends Error {
  readonly code: BackgroundRemovalErrorCode;
  /** Si volver a intentarlo más tarde puede salir bien. */
  readonly retryable: boolean;
  /** Lo que pidió esperar el proveedor (`Retry-After`), si lo dijo. */
  readonly retryAfterMs: number | null;
  /** Si el proveedor llegó a cobrar esta llamada. */
  readonly billable: boolean;

  constructor(
    code: BackgroundRemovalErrorCode,
    options: { retryable?: boolean; retryAfterMs?: number | null; billable?: boolean; message?: string } = {}
  ) {
    super(options.message ?? code);
    this.name = 'BackgroundRemovalError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.billable = options.billable ?? false;
  }
}
