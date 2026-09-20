/** In-memory cache of the last ElevenLabs clip so the dashboard can GET it as MP3. */
let latest: { buf: Buffer; text: string; atMs: number } | null = null;

export function storeVoiceClip(text: string, buf: Buffer): string {
  latest = { buf, text, atMs: Date.now() };
  return `/api/voice/latest.mp3?t=${latest.atMs}`;
}

export function getLatestVoiceClip(): { buf: Buffer; text: string; atMs: number } | null {
  return latest;
}
