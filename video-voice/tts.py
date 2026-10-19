"""Generates the 5-minute video's voice-over: one MP3 per beat plus word timings, checked by transcription."""
import asyncio, json, re, subprocess, sys
from difflib import SequenceMatcher
from pathlib import Path

import edge_tts

here = Path(__file__).parent
script = json.loads((here / "script.json").read_text())
out = here / "audio"
out.mkdir(exist_ok=True)


def spoken(beat):
    return beat.get("say", beat["text"]).replace("ToolTrace", "Tool Trace")


async def synth(beat):
    for attempt in range(5):
        try:
            comm = edge_tts.Communicate(spoken(beat), script["voice"], rate=script["rate"], boundary="WordBoundary")
            audio, words = bytearray(), []
            async for c in comm.stream():
                if c["type"] == "audio":
                    audio += c["data"]
                elif c["type"] == "WordBoundary":
                    words.append({"w": c["text"], "t": c["offset"] / 1e7, "d": c["duration"] / 1e7})
            (out / f"{beat['id']}.mp3").write_bytes(audio)
            (out / f"{beat['id']}.json").write_text(json.dumps(words))
            return
        except Exception as e:  # transient service errors
            print("retry", beat["id"], e, file=sys.stderr)
            await asyncio.sleep(3 * (attempt + 1))
    raise SystemExit(f"TTS failed for {beat['id']}")


async def main():
    for beat in script["beats"]:
        await synth(beat)


asyncio.run(main())

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel("small.en", device="cpu", compute_type="int8")
norm = lambda s: re.sub(r"[^a-z0-9 ]", "", s.lower().replace("-", " "))
report = {}
for beat in script["beats"]:
    path = out / f"{beat['id']}.mp3"
    dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]))
    pcm = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", "16000", "-"])
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
    heard = " ".join(s.text for s in model.transcribe(audio, beam_size=1)[0]).strip()
    score = SequenceMatcher(None, norm(spoken(beat)), norm(heard)).ratio()
    report[beat["id"]] = {"duration": round(dur, 3), "heard": heard, "match": round(score, 3)}
    print(f"{beat['id']:5} {dur:5.2f}s {score:.2f}  {heard}")
(here / "report.json").write_text(json.dumps(report, indent=1))
