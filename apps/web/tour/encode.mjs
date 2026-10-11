/**
 * Turns the recorded screencast frames into:
 *   docs/demo/tooltrace-tour.mp4  the full tour (H.264, plays everywhere)
 *   docs/demo/live-update.gif     the live-update moment, for the README
 * Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const framesDir = path.resolve(here, '../tour-results/frames');
const outDir = path.resolve(here, '../../../docs/demo');
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
mkdirSync(outDir, { recursive: true });

const { frames, marks } = JSON.parse(readFileSync(path.join(framesDir, 'frames.json'), 'utf8'));
// Each frame stays on screen until the next one arrived (the screencast only sends changes).
const lines = [];
frames.forEach((f, i) => {
  const next = frames[i + 1]?.t ?? f.t + 1.5;
  lines.push(`file '${path.join(framesDir, f.file)}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
});
lines.push(`file '${path.join(framesDir, frames.at(-1).file)}'`);
const list = path.join(framesDir, 'list.txt');
writeFileSync(list, lines.join('\n'));

const mp4 = path.join(outDir, 'tooltrace-tour.mp4');
const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
run(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1280:720:flags=lanczos,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', mp4]);

if (marks.liveStart !== undefined && marks.liveEnd !== undefined) {
  const start = Math.max(0, marks.liveStart - 0.5).toFixed(2);
  const length = (marks.liveEnd - marks.liveStart + 0.5).toFixed(2);
  const gif = path.join(outDir, 'live-update.gif');
  run(['-ss', start, '-t', length, '-i', mp4, '-vf',
    'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    gif]);
}
const seconds = frames.at(-1).t + 1.5;
console.log(`[tour] ${frames.length} frames, ${seconds.toFixed(1)} s -> ${path.relative(process.cwd(), mp4)}`);
