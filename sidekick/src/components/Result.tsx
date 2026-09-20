"use client";

import { useState } from "react";
import type { SidekickProfile } from "@/lib/types";
import { renderShareCard } from "@/lib/shareCard";

function AbilityIcon({ icon }: { icon: string }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (icon) {
    case "shield":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
        </svg>
      );
    case "brain":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 003 3c1.5 0 3-1 3-2.5v-11C12 5 10.5 4 9 4zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-3 3c-1.5 0-3-1-3-2.5v-11C12 5 13.5 4 15 4z" />
        </svg>
      );
    case "target":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="12" cy="12" r="0.5" fill="currentColor" />
        </svg>
      );
    case "wave":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.5-4.5" />
        </svg>
      );
  }
}

export default function Result({
  profile,
  profileId,
  source,
  onRestart,
}: {
  profile: SidekickProfile;
  profileId: string;
  source?: string;
  onRestart: () => void;
}) {
  const [shareState, setShareState] = useState<string | null>(null);

  async function makeCard() {
    const blob = await renderShareCard(profile, profileId);
    return new File([blob], `sightline-sidekick-${profileId}.png`, {
      type: "image/png",
    });
  }

  function download(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function onShare() {
    setShareState(null);
    try {
      const file = await makeCard();
      if (
        typeof navigator !== "undefined" &&
        "share" in navigator &&
        navigator.canShare?.({ files: [file] })
      ) {
        await navigator.share({
          files: [file],
          title: "My SIGHTLINE Profile",
          text: `${profile.archetype} — ${profile.verdict}`,
        });
        return;
      }
      download(file);
      setShareState("No native share here — downloaded your card instead.");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setShareState("Couldn't generate the card. Try again.");
    }
  }

  async function onSave() {
    setShareState(null);
    try {
      download(await makeCard());
    } catch {
      setShareState("Couldn't generate the card. Try again.");
    }
  }

  const s = profile.scores;
  const stats: Array<{ label: string; value: number; hot?: boolean }> = [
    { label: "MEMORY", value: s.memory },
    { label: "AWARENESS", value: s.situationalAwareness },
    { label: "SURVIVAL INSTINCT", value: s.survivalInstinct },
    { label: "CHAOS", value: s.chaos, hot: true },
  ];

  return (
    <div className="result">
      <div>
        <div className="result-id">
          YOUR SIGHTLINE PROFILE — <b>{profileId}</b>
        </div>
        <h1 className="archetype" style={{ marginTop: 14 }}>
          {profile.archetype}
        </h1>
        <p className="subtitle" style={{ marginTop: 12 }}>
          {profile.subtitle}
        </p>
      </div>

      <div>
        <div className="section-label">TELEMETRY</div>
        <div className="stats" style={{ marginTop: 16 }}>
          {stats.map((st, i) => (
            <div className={`stat ${st.hot ? "hot" : ""}`} key={st.label}>
              <div className="stat-top">
                <span>{st.label}</span>
                <span className="num">{st.value}%</span>
              </div>
              <div className="bar">
                <i
                  style={
                    {
                      "--v": st.value / 100,
                      animationDelay: `${0.15 + i * 0.12}s`,
                    } as React.CSSProperties
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="section-label">SIDEKICK DIAGNOSIS</div>
        <p className="diagnosis" style={{ marginTop: 16 }}>
          {profile.diagnosis}
        </p>
      </div>

      <div>
        <div className="section-label">YOUR #1 AI GLASSES ABILITY</div>
        <div className="ability-card" style={{ marginTop: 16 }}>
          <div className="ability-name">
            <AbilityIcon icon={profile.recommendedAbility.icon} />
            {profile.recommendedAbility.name}
          </div>
          <p className="ability-desc">
            {profile.recommendedAbility.description}
          </p>
        </div>
      </div>

      <div>
        <div className="section-label">AI GLASSES VERDICT</div>
        <p className="verdict" style={{ marginTop: 16 }}>
          {profile.verdict}
        </p>
      </div>

      <div className="result-actions">
        <button className="btn-primary" onClick={onShare}>
          SHARE MY PROFILE
        </button>
        <button className="btn-ghost" onClick={onSave}>
          SAVE RESULT
        </button>
        <button className="btn-ghost" onClick={onRestart}>
          TRY AGAIN
        </button>
      </div>
      {shareState && <div className="result-note">{shareState}</div>}
      {source === "fallback" && (
        <div className="result-note">
          DEV MODE — generated locally (HokieAI credentials not configured)
        </div>
      )}
    </div>
  );
}
