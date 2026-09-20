import { useEffect, useState } from "react";
import {
  subscribeVoice,
  setVoiceMuted,
  type VoiceStatus,
} from "../voice/voicePlayer";

/**
 * Caption strip for SIGHTLINE's voice. Shows the last thing it said, so the
 * line is readable in a loud demo room and visible if the browser has blocked
 * audio. Also the mute control, because a judge shouldn't be shouted at.
 */
export function VoiceIndicator() {
  const [v, setV] = useState<VoiceStatus | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeVoice(setV), []);

  useEffect(() => {
    if (!v?.lastText) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 9000);
    return () => clearTimeout(t);
  }, [v?.lastText, v?.lastAtMs]);

  if (!v || !v.lastText || !visible) return null;

  const blocked = Boolean(v.lastError);

  return (
    <div
      className={`voice-cap${v.speaking ? " voice-cap--live" : ""}${blocked ? " voice-cap--blocked" : ""}`}
      aria-live="polite"
    >
      <span className="voice-cap-icon" aria-hidden="true">
        {v.muted ? "🔇" : v.speaking ? "🔊" : "💬"}
      </span>
      <div className="voice-cap-copy">
        <span className="voice-cap-kicker">
          {v.muted ? "SIGHTLINE (muted)" : v.speaking ? "SIGHTLINE speaking" : "SIGHTLINE said"}
        </span>
        <p className="voice-cap-text">{v.lastText}</p>
        {blocked && <p className="voice-cap-err">{v.lastError}</p>}
      </div>
      <button
        type="button"
        className="voice-cap-mute"
        onClick={() => setVoiceMuted(!v.muted)}
        aria-label={v.muted ? "Unmute SIGHTLINE voice" : "Mute SIGHTLINE voice"}
        title={v.muted ? "Unmute" : "Mute"}
      >
        {v.muted ? "unmute" : "mute"}
      </button>
    </div>
  );
}
