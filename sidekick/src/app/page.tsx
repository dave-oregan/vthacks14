"use client";

import { useCallback, useRef, useState } from "react";
import { QUESTIONS } from "@/lib/questions";
import type { SidekickProfile, Tone } from "@/lib/types";
import Analyzing from "@/components/Analyzing";
import Result from "@/components/Result";
import ToneToggle from "@/components/ToneToggle";

type Stage = "landing" | "quiz" | "analyzing" | "result" | "error";

const MIN_ANALYZE_MS = 2600;

export default function Home() {
  const [stage, setStage] = useState<Stage>("landing");
  const [leaving, setLeaving] = useState(false);
  const [qIndex, setQIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [tone, setTone] = useState<Tone>("roast");
  const [profile, setProfile] = useState<SidekickProfile | null>(null);
  const [source, setSource] = useState<string>();
  const [profileId, setProfileId] = useState("SL-0000");
  const runId = useRef(0);

  const transition = useCallback((next: () => void) => {
    setLeaving(true);
    setTimeout(() => {
      next();
      setLeaving(false);
    }, 200);
  }, []);

  const analyze = useCallback(async (ans: string[], t: Tone) => {
    const id = ++runId.current;
    setStage("analyzing");
    const started = Date.now();
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer1: ans[0],
          answer2: ans[1],
          answer3: ans[2],
          tone: t,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const wait = Math.max(0, MIN_ANALYZE_MS - (Date.now() - started));
      setTimeout(() => {
        if (runId.current !== id) return;
        const { _source, ...rest } = data;
        setProfile(rest as SidekickProfile);
        setSource(_source);
        setProfileId(`SL-${1000 + Math.floor(Math.random() * 9000)}`);
        setStage("result");
      }, wait);
    } catch {
      const wait = Math.max(0, MIN_ANALYZE_MS - (Date.now() - started));
      setTimeout(() => {
        if (runId.current !== id) return;
        setStage("error");
      }, wait);
    }
  }, []);

  const pickOption = (optIdx: number, optText: string) => {
    if (picked !== null) return;
    setPicked(optIdx);
    const nextAnswers = [...answers, optText];
    setTimeout(() => {
      setPicked(null);
      if (qIndex < QUESTIONS.length - 1) {
        setAnswers(nextAnswers);
        transition(() => setQIndex(qIndex + 1));
      } else {
        setAnswers(nextAnswers);
        analyze(nextAnswers, tone);
      }
    }, 220);
  };

  const restart = () => {
    runId.current++;
    setAnswers([]);
    setQIndex(0);
    setProfile(null);
    setSource(undefined);
    transition(() => setStage("landing"));
  };

  return (
    <main className="stage">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          SIGHTLINE <span className="slash">{"//"}</span> SIDEKICK
        </div>
        <ToneToggle tone={tone} onChange={setTone} />
      </header>

      <div className={`screen ${leaving ? "leaving" : ""}`}>
        {stage === "landing" && (
          <div className="landing">
            <div className="hokie-badge">POWERED BY HOKIEAI</div>
            <div>
              <div className="eyebrow">SIGHTLINE {"//"} SIDEKICK</div>
              <h1 className="headline" style={{ marginTop: 16 }}>
                WHAT WOULD YOUR <span className="glitch">AI GLASSES</span> LEARN
                ABOUT YOU?
              </h1>
            </div>
            <p className="lede">
              Answer 3 questions. We&apos;ll tell you what kind of AI sidekick
              you actually need.
            </p>
            <div className="cta-row">
              <button
                className="btn-primary"
                onClick={() => transition(() => setStage("quiz"))}
              >
                ANALYZE ME →
              </button>
            </div>
            <div className="landing-foot">
              Inspired by SIGHTLINE — an AI perception and memory system for
              smart glasses.
              <br />
              ~45 seconds · no login · judged by robots, kindly
            </div>
          </div>
        )}

        {stage === "quiz" && (
          <div>
            <div className="quiz-head">
              <div className="progress-row">
                <span className="progress-label">
                  0{qIndex + 1} / 0{QUESTIONS.length}
                </span>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      transform: `scaleX(${(qIndex + 1) / QUESTIONS.length})`,
                    }}
                  />
                </div>
              </div>
              <h2 className="question">{QUESTIONS[qIndex].prompt}</h2>
            </div>
            <div className="options">
              {QUESTIONS[qIndex].options.map((opt, i) => (
                <button
                  key={opt}
                  className={`option ${picked === i ? "picked" : ""}`}
                  onClick={() => pickOption(i, opt)}
                >
                  <span className="key">{String.fromCharCode(65 + i)}</span>
                  {opt}
                </button>
              ))}
            </div>
          </div>
        )}

        {stage === "analyzing" && <Analyzing />}

        {stage === "result" && profile && (
          <Result
            profile={profile}
            profileId={profileId}
            source={source}
            onRestart={restart}
          />
        )}

        {stage === "error" && (
          <div className="analyzing">
            <div className="error-box">
              <h2>SIGNAL LOST</h2>
              <p>
                HokieAI couldn&apos;t complete your diagnosis. The model may be
                busy, unreachable, or returned something unreadable.
              </p>
              <div className="cta-row">
                <button
                  className="btn-primary"
                  onClick={() => analyze(answers, tone)}
                >
                  RETRY ANALYSIS
                </button>
                <button className="btn-ghost" onClick={restart}>
                  START OVER
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
