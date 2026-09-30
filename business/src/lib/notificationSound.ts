/**
 * Timbre original del panel Business.
 *
 * No carga muestras, música ni archivos de terceros: el navegador sintetiza
 * notas suaves con Web Audio. Para sustituirlo más adelante, cambia las
 * frecuencias, duración o envolvente en este archivo, o reemplaza el
 * renderizado de `renderRing` por la carga de un audio propio.
 *
 * Dos usos:
 *  - `playNotificationSound`: un aviso corto y único (cancelaciones, alertas).
 *  - `startRingLoop` / `stopRingLoop`: el timbre de pedido nuevo, que se
 *    repite hasta que alguien lo atiende.
 */

type AudioContextWindow = typeof window & {
  webkitAudioContext?: typeof AudioContext;
};

let audioContext: AudioContext | null = null;

function context() {
  if (typeof window === 'undefined') return null;
  const AudioContextConstructor = window.AudioContext
    || (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContext ??= new AudioContextConstructor();
  return audioContext;
}

// ── Estado del audio (para el aviso de desbloqueo) ────────────────────

export type AudioStatus = 'running' | 'suspended' | 'unsupported';

/** El navegador no deja sonar hasta la primera interacción: `suspended`. */
export function audioState(): AudioStatus {
  const audio = context();
  if (!audio) return 'unsupported';
  return audio.state === 'running' ? 'running' : 'suspended';
}

export function subscribeAudioState(onChange: () => void): () => void {
  const audio = context();
  if (!audio) return () => {};
  audio.addEventListener('statechange', onChange);
  return () => audio.removeEventListener('statechange', onChange);
}

/** Se llama desde una interacción de la persona para cumplir la política de autoplay. */
export function primeNotificationSound() {
  const audio = context();
  if (!audio) return;
  if (audio.state !== 'running') void audio.resume();
  // Con el audio ya desbloqueado, el primer pedido no espera al renderizado.
  void ringBuffer('normal', audio).catch(() => {});
  void ringBuffer('urgent', audio).catch(() => {});
}

// ── Arpegio compartido ────────────────────────────────────────────────

const NEW_ORDER_NOTES = [659.25, 783.99, 1046.5];

/**
 * Programa un arpegio breve en cualquier contexto (en vivo o fuera de línea).
 * Es la única definición del timbre: el aviso suelto y el bucle suenan igual.
 */
function scheduleArpeggio(
  audio: BaseAudioContext,
  destination: AudioNode,
  at: number,
  notes: number[],
  step: number,
  peak: number
) {
  const master = audio.createGain();
  master.gain.setValueAtTime(0.0001, at);
  master.gain.exponentialRampToValueAtTime(peak, at + 0.018);
  master.gain.exponentialRampToValueAtTime(0.0001, at + 0.52);
  master.connect(destination);

  notes.forEach((frequency, index) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const start = at + index * step;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.006, start + 0.22);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.8, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
    oscillator.connect(gain).connect(master);
    oscillator.start(start);
    oscillator.stop(start + 0.3);
  });
  return master;
}

/** Un arpegio breve y propio para alertas sueltas. */
export function playNotificationSound(kind: 'new' | 'update' | 'attention' = 'update') {
  try {
    const audio = context();
    if (!audio) return;
    if (audio.state === 'suspended') {
      void audio.resume();
      return;
    }

    const notes = kind === 'new'
      ? NEW_ORDER_NOTES
      : kind === 'attention'
        ? [523.25, 440]
        : [587.33, 783.99];
    const peak = kind === 'attention' ? 0.13 : 0.1;
    const master = scheduleArpeggio(audio, audio.destination, audio.currentTime, notes, kind === 'new' ? 0.095 : 0.12, peak);
    window.setTimeout(() => master.disconnect(), 700);
  } catch {
    // Un aviso visual sigue siendo suficiente si el navegador bloquea audio.
  }
}

// ── Timbre en bucle ───────────────────────────────────────────────────

export type RingKind = 'normal' | 'urgent';

/**
 * El patrón se renderiza una vez en un `AudioBuffer` y se reproduce con
 * `loop = true`. Un `setInterval` que disparara el arpegio cada pocos
 * segundos se retrasaría o se saltaría vueltas: el navegador frena los
 * temporizadores de una pestaña en segundo plano, que es justo donde está
 * un panel de cocina la mayor parte del día. Un buffer en bucle lo
 * reproduce el hilo de audio, que no se frena.
 *
 * Normal: un arpegio cada 2,4 s. Urgente: dos arpegios seguidos cada 1,2 s,
 * más insistente y más fuerte.
 */
async function renderRing(kind: RingKind, sampleRate: number): Promise<AudioBuffer> {
  const seconds = kind === 'urgent' ? 1.2 : 2.4;
  const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * seconds), sampleRate);
  if (kind === 'urgent') {
    scheduleArpeggio(offline, offline.destination, 0, NEW_ORDER_NOTES, 0.08, 0.16);
    scheduleArpeggio(offline, offline.destination, 0.45, NEW_ORDER_NOTES, 0.08, 0.16);
  } else {
    scheduleArpeggio(offline, offline.destination, 0, NEW_ORDER_NOTES, 0.095, 0.12);
  }
  return offline.startRendering();
}

const buffers = new Map<string, Promise<AudioBuffer>>();

function ringBuffer(kind: RingKind, audio: AudioContext): Promise<AudioBuffer> {
  const key = `${kind}:${audio.sampleRate}`;
  let pending = buffers.get(key);
  if (!pending) {
    pending = renderRing(kind, audio.sampleRate);
    // Un renderizado fallido no se cachea: se reintenta la próxima vez.
    pending.catch(() => buffers.delete(key));
    buffers.set(key, pending);
  }
  return pending;
}

interface Ring {
  kind: RingKind;
  source: AudioBufferSourceNode | null;
  timer: number | null;
}

let ring: Ring | null = null;
let ringGeneration = 0;

function stopCurrent() {
  if (!ring) return;
  try { ring.source?.stop(); } catch { /* ya estaba detenido */ }
  ring.source?.disconnect();
  if (ring.timer !== null) window.clearInterval(ring.timer);
  ring = null;
}

/**
 * Empieza (o cambia) el timbre en bucle. Devuelve `false` si el audio sigue
 * bloqueado; quien llama lo reintenta cuando el estado cambie a `running`.
 */
export async function startRingLoop(kind: RingKind): Promise<boolean> {
  const audio = context();
  if (!audio || audio.state !== 'running') return false;
  if (ring?.kind === kind) return true;

  // Si mientras se renderiza llega un `stop` u otro `start`, este pierde.
  const generation = ++ringGeneration;
  try {
    const buffer = await ringBuffer(kind, audio);
    if (generation !== ringGeneration) return false;
    stopCurrent();
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audio.destination);
    source.start();
    ring = { kind, source, timer: null };
    return true;
  } catch {
    // Sin OfflineAudioContext (navegadores muy viejos): se repite el aviso
    // suelto. Menos robusto en pestañas ocultas, pero suena.
    if (generation !== ringGeneration) return false;
    stopCurrent();
    playNotificationSound('new');
    ring = {
      kind,
      source: null,
      timer: window.setInterval(() => playNotificationSound('new'), kind === 'urgent' ? 1200 : 2400),
    };
    return true;
  }
}

export function stopRingLoop() {
  ringGeneration++;
  stopCurrent();
}
