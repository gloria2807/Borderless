"""Transcribe the founders' narration with word timestamps (local faster-whisper, base.en).

Usage: python video/transcribe.py <audio.wav> <out.json>
"""
import json
import sys

from faster_whisper import WhisperModel

audio, out = sys.argv[1], sys.argv[2]
model = WhisperModel("base.en", device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio, word_timestamps=True, vad_filter=True, vad_parameters={"min_silence_duration_ms": 250})
words = []
for seg in segments:
    for w in seg.words:
        words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)})
with open(out, "w", encoding="utf-8") as f:
    json.dump(words, f, ensure_ascii=False)
print(f"{len(words)} words")
