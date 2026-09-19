// Beep corto generado con Web Audio API — no depende de un archivo de
// audio (sin binarios que versionar) y no bloquea nada: solo suena.
export function playAlertBeep(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
    oscillator.onended = () => context.close();
  } catch {
    // Si el navegador bloquea audio sin interacción previa del usuario, no
    // pasa nada — la notificación visual/push sigue funcionando igual.
  }
}
