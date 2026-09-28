/**
 * Timbre original del panel Business.
 *
 * No carga muestras, música ni archivos de terceros: el navegador sintetiza
 * tres notas suaves con Web Audio. Para sustituirlo más adelante, cambia las
 * frecuencias, duración o envolvente de `playNotificationSound` en este
 * archivo, o reemplaza esta función por la reproducción de un audio propio.
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

/** Se llama desde la primera interacción para cumplir la política de autoplay. */
export function primeNotificationSound() {
  const audio = context();
  if (audio?.state === 'suspended') void audio.resume();
}

/** Un arpegio breve y propio para pedidos, cambios de estado y alertas. */
export function playNotificationSound(kind: 'new' | 'update' | 'attention' = 'update') {
  try {
    const audio = context();
    if (!audio) return;
    if (audio.state === 'suspended') {
      void audio.resume();
      return;
    }

    const now = audio.currentTime;
    const master = audio.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(kind === 'attention' ? 0.085 : 0.065, now + 0.018);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    master.connect(audio.destination);

    const notes = kind === 'new'
      ? [659.25, 783.99, 1046.5]
      : kind === 'attention'
        ? [523.25, 440]
        : [587.33, 783.99];

    notes.forEach((frequency, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const start = now + index * (kind === 'new' ? 0.095 : 0.12);
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

    window.setTimeout(() => master.disconnect(), 700);
  } catch {
    // Un aviso visual sigue siendo suficiente si el navegador bloquea audio.
  }
}
