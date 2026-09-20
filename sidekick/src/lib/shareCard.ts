import type { SidekickProfile } from "./types";

const W = 1080;
const H = 1350;
const TEAL = "#2dd4bf";
const PINK = "#e879f9";
const INK = "#eef4f6";
const SOFT = "#9fb3bd";
const MUTED = "#5d707c";

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Render the share card to a PNG blob. 1080x1350 (4:5, social-friendly). */
export async function renderShareCard(
  profile: SidekickProfile,
  profileId: string
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  // background
  ctx.fillStyle = "#07090d";
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, -80, 0, W / 2, -80, 900);
  glow.addColorStop(0, "rgba(45,212,191,0.16)");
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(W, H, 0, W, H, 700);
  glow2.addColorStop(0, "rgba(168,85,247,0.14)");
  glow2.addColorStop(1, "transparent");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 84) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 84) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // frame
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 48, W - 96, H - 96);
  // corner accents
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 5;
  const c = 34;
  for (const [x, y, dx, dy] of [
    [48, 48, 1, 1],
    [W - 48, 48, -1, 1],
    [48, H - 48, 1, -1],
    [W - 48, H - 48, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x + dx * c, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * c);
    ctx.stroke();
  }

  const mono = (size: number) => `${size}px "JetBrains Mono", monospace`;
  const disp = (size: number, w = 800) => `${w} ${size}px "Syne", sans-serif`;
  const sans = (size: number) => `${size}px "DM Sans", sans-serif`;

  // header
  ctx.fillStyle = SOFT;
  ctx.font = mono(30);
  ctx.fillText("SIGHTLINE", 96, 132);
  ctx.fillStyle = TEAL;
  ctx.fillText("// SIDEKICK", 96 + ctx.measureText("SIGHTLINE").width + 24, 132);

  ctx.fillStyle = MUTED;
  ctx.font = mono(24);
  ctx.textAlign = "right";
  ctx.fillText(profileId, W - 96, 132);
  ctx.textAlign = "left";

  // label
  ctx.fillStyle = TEAL;
  ctx.font = mono(26);
  ctx.fillText("YOUR SIGHTLINE PROFILE", 96, 236);

  // archetype (wrap, up to 2 lines)
  ctx.font = disp(104);
  ctx.fillStyle = INK;
  const archLines = wrapText(ctx, profile.archetype.toUpperCase(), W - 192).slice(0, 2);
  let y = 340;
  for (const l of archLines) {
    ctx.fillText(l, 96, y);
    y += 108;
  }

  // subtitle
  ctx.font = mono(28);
  ctx.fillStyle = PINK;
  const subLines = wrapText(ctx, profile.subtitle, W - 220).slice(0, 2);
  for (const l of subLines) {
    ctx.fillText(l, 96, y + 8);
    y += 40;
  }

  // stats — two bars: chaos + memory
  y += 60;
  const stats: Array<[string, number, string]> = [
    ["CHAOS", profile.scores.chaos, PINK],
    ["MEMORY", profile.scores.memory, TEAL],
  ];
  for (const [label, val, color] of stats) {
    ctx.font = mono(24);
    ctx.fillStyle = SOFT;
    ctx.fillText(label, 96, y);
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.fillText(`${val}%`, W - 96, y);
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(96, y + 18, W - 192, 8);
    ctx.fillStyle = color;
    ctx.fillRect(96, y + 18, ((W - 192) * val) / 100, 8);
    y += 86;
  }

  // ability
  y += 24;
  ctx.font = mono(24);
  ctx.fillStyle = MUTED;
  ctx.fillText("#1 AI GLASSES ABILITY", 96, y);
  y += 62;
  ctx.font = disp(72);
  ctx.fillStyle = TEAL;
  ctx.fillText(profile.recommendedAbility.name.toUpperCase(), 96, y);
  y += 44;
  ctx.font = sans(30);
  ctx.fillStyle = SOFT;
  for (const l of wrapText(ctx, profile.recommendedAbility.description, W - 192).slice(0, 2)) {
    ctx.fillText(l, 96, y);
    y += 42;
  }

  // verdict
  y += 56;
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(96, y - 20);
  ctx.lineTo(96, y + 120);
  ctx.stroke();
  ctx.font = disp(46, 600);
  ctx.fillStyle = INK;
  const vLines = wrapText(ctx, `“${profile.verdict}”`, W - 240).slice(0, 3);
  for (const l of vLines) {
    ctx.fillText(l, 128, y + 24);
    y += 58;
  }

  // footer
  ctx.font = mono(24);
  ctx.fillStyle = PINK;
  ctx.fillText("POWERED BY HOKIEAI", 96, H - 96);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText("INSPIRED BY SIGHTLINE", W - 96, H - 96);
  ctx.textAlign = "left";

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}
