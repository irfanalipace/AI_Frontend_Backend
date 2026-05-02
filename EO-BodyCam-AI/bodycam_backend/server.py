"""
EO Bodycam AI — Backend API v5.0
Complete Enforcement Officer Monitoring System
Detects: NORMAL, HARSH, ANGRY, BRIBE_TONE emotions
Keywords: 500+ Urdu/English/Punjabi violation words in 10 categories
Transcription: Gemini 2.5 Flash (primary) + Google Speech (fallback) + local whisper-small
Categories: RISHWAT, DHAMKI, GALI, RUDE_BEHAVIOR, HARASSMENT,
           GALAT_CHALLAN, ANGRY_TONE, POWER_ABUSE, INTIMIDATION, UNPROFESSIONAL
Severity: NORMAL / WARNING / CRITICAL
"""
import os, json, pickle, time, uuid, tempfile, threading, hashlib, shutil
try:
    from dotenv import load_dotenv
    # Load .env sitting next to this file, regardless of the shell's CWD.
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass
try:
    import psutil
except ImportError:
    psutil = None
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import numpy as np
import librosa
import speech_recognition as sr_lib

BASE    = os.path.dirname(os.path.abspath(__file__))
MODELS  = os.path.join(BASE, "models")
SAMPLES = os.path.join(BASE, "audio_samples")
UPLOADS = os.path.join(BASE, "uploads")
WATCH   = os.path.join(BASE, "watch")            # drop videos here for auto-analysis
WATCH_DONE = os.path.join(BASE, "watch_done")    # processed files moved here
SR      = 16000
os.makedirs(UPLOADS, exist_ok=True)
os.makedirs(WATCH,      exist_ok=True)
os.makedirs(WATCH_DONE, exist_ok=True)

app = Flask(__name__)
app.config["SECRET_KEY"] = "eo-bodycam-v50"
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


def _gemini_key():
    """Return the Gemini API key.

    Priority: per-request header X-Gemini-Api-Key (forwarded by the .NET
    backend from appsettings.json) > GEMINI_API_KEY env var (.env / shell).
    """
    try:
        from flask import has_request_context, request as _req
        if has_request_context():
            hdr = (_req.headers.get("X-Gemini-Api-Key") or "").strip()
            if hdr:
                return hdr
    except Exception:
        pass
    return os.environ.get("GEMINI_API_KEY", "").strip()

# ═══════════════════════════════════════════════════════════════
#  LOAD AI MODELS
# ═══════════════════════════════════════════════════════════════
print("Loading AI models...", flush=True)
with open(f"{MODELS}/voiceprint_EO_001.pkl", "rb") as f:
    ENROLLMENT = pickle.load(f)
with open(f"{MODELS}/tone_classifier.pkl", "rb") as f:
    TONE_MODEL = pickle.load(f)
with open(f"{MODELS}/model_config.json", "r", encoding="utf-8") as f:
    CONFIG = json.load(f)

EO_VECTOR      = np.array(ENROLLMENT["voiceprint"]["vector"])
EO_THRESHOLD   = CONFIG["eo_similarity_threshold"]
ENROLLED_PITCH = ENROLLMENT["voiceprint"]["f0_mean"]
VK             = CONFIG["violation_keywords"]

# ═══════════════════════════════════════════════════════════════
#  LOAD FASTER-WHISPER (small model, int8 for CPU)
# ═══════════════════════════════════════════════════════════════
WHISPER_MODEL = None
try:
    from faster_whisper import WhisperModel
    disk_free = psutil.disk_usage('/').free / (1024**3) if psutil else 0
    ram_total = psutil.virtual_memory().total / (1024**3) if psutil else 0
    whisper_size = CONFIG.get("whisper_model", "small")
    whisper_device = CONFIG.get("whisper_device", "cpu")
    whisper_compute = CONFIG.get("whisper_compute_type", "int8")
    print(f"Loading faster-whisper {whisper_size} ({whisper_device}, {whisper_compute}, "
          f"disk={disk_free:.1f}GB free, RAM={ram_total:.0f}GB)...", flush=True)
    WHISPER_MODEL = WhisperModel(whisper_size, device=whisper_device, compute_type=whisper_compute)
    print(f"faster-whisper {whisper_size} loaded successfully", flush=True)
except ImportError:
    print("faster-whisper not installed — falling back to Google Speech only", flush=True)
except Exception as e:
    print(f"faster-whisper load error: {e}", flush=True)

RECOGNIZER = sr_lib.Recognizer()
print(f"Speech Recognition ready — Google Urdu/English/Punjabi active", flush=True)

kw_total = sum(len(v["words"]) for v in VK.values())
print(f"EO pitch={ENROLLED_PITCH:.1f}Hz  threshold={EO_THRESHOLD}", flush=True)
print(f"Emotions: NORMAL / HARSH / ANGRY / BRIBE_TONE", flush=True)
print(f"Thresholds: warning={CONFIG['warning_score']} critical={CONFIG['critical_score']}", flush=True)
print(f"Keywords: {kw_total} Urdu words in {len(VK)} categories", flush=True)

OFFICERS = {
    "EO_001": {"name": "Irfan Ali",     "badge": "PK-LHR-001", "enrolled": True,  "area": "Lahore - Modal Town"},
    "EO_002": {"name": "Umar Farooq",   "badge": "PK-LHR-002", "enrolled": False, "area": "Lahore - Model Town"},
    "EO_003": {"name": "Fatima Malik",   "badge": "PK-KHI-001", "enrolled": False, "area": "Karachi - Saddar"},
}
INCIDENTS = []


# ═══════════════════════════════════════════════════════════════
#  AUDIO FEATURE EXTRACTION (106-dim MFCC vector)
# ═══════════════════════════════════════════════════════════════
def extract_features(audio, sr=SR):
    if len(audio) < sr * 0.2:
        return np.zeros(106)
    mfccs  = librosa.feature.mfcc(y=audio, sr=sr, n_mfcc=40)
    m_mean = np.mean(mfccs, axis=1)
    m_std  = np.std(mfccs,  axis=1)
    sc     = float(np.mean(librosa.feature.spectral_centroid(y=audio, sr=sr)))
    sb     = float(np.mean(librosa.feature.spectral_bandwidth(y=audio, sr=sr)))
    sro    = float(np.mean(librosa.feature.spectral_rolloff(y=audio, sr=sr)))
    scon   = np.mean(librosa.feature.spectral_contrast(y=audio, sr=sr), axis=1)
    zcr    = float(np.mean(librosa.feature.zero_crossing_rate(y=audio)))
    chroma = np.mean(librosa.feature.chroma_stft(y=audio, sr=sr), axis=1)
    rms    = float(np.mean(librosa.feature.rms(y=audio)))
    try:
        f0, vf, _ = librosa.pyin(audio, sr=sr, fmin=65, fmax=500)
        fv  = f0[vf] if vf is not None else np.array([])
        f0m = float(np.mean(fv)) if len(fv) > 0 else 0.0
        f0s = float(np.std(fv))  if len(fv) > 0 else 0.0
    except:
        f0m, f0s = 0.0, 0.0
    return np.concatenate([m_mean, m_std, scon, chroma, [sc, sb, sro, f0m, f0s, zcr, rms]])


def cosine_sim(a, b):
    a, b   = np.array(a), np.array(b)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na > 0 and nb > 0 else 0.0


# ═══════════════════════════════════════════════════════════════
#  VOICE ACTIVITY DETECTION (VAD)
# ═══════════════════════════════════════════════════════════════
def run_vad(audio, sr=SR):
    frame = int(sr * 0.030)
    hop   = frame // 2
    segs, in_s, t0 = [], False, 0.0
    for i in range(0, len(audio) - frame, hop):
        chunk  = audio[i:i + frame]
        energy = float(np.sqrt(np.mean(chunk ** 2)))
        zcr    = float(np.mean(np.abs(np.diff(np.sign(chunk)))) / 2)
        sp     = energy > 0.005 and zcr < 0.40
        ts     = i / sr
        if sp and not in_s:
            in_s, t0 = True, ts
        elif not sp and in_s:
            in_s = False
            if ts - t0 >= 0.20:
                segs.append({"start": t0, "end": ts})
    if in_s:
        segs.append({"start": t0, "end": len(audio) / sr})
    merged = []
    for s in segs:
        if merged and s["start"] - merged[-1]["end"] < 0.4:
            merged[-1]["end"] = s["end"]
        else:
            merged.append(s)
    return merged


# ═══════════════════════════════════════════════════════════════
#  EO VOICE IDENTIFICATION (cosine similarity)
# ═══════════════════════════════════════════════════════════════
def identify_eo_audio(audio, sr, speech_segs):
    window = sr * 2
    sims, eo_parts = [], []
    for seg in speech_segs:
        sa = audio[int(seg["start"] * sr):int(seg["end"] * sr)]
        for w in range(0, len(sa) - window, window // 2):
            chunk = sa[w:w + window]
            vec   = extract_features(chunk, sr)
            sim   = cosine_sim(EO_VECTOR, vec)
            sims.append(sim)
            if sim >= EO_THRESHOLD:
                eo_parts.append(chunk)
    eo = np.concatenate(eo_parts) if eo_parts else np.array([])
    return eo, float(np.mean(sims)) if sims else 0.0, float(np.max(sims)) if sims else 0.0


def diarize_speakers(audio, sr, speech_segs):
    """Speaker diarization — labels each speech segment as EO (Person 1) or Customer (Person 2).

    Uses the same voiceprint matching logic as identify_eo_audio() but at the segment level
    to produce timestamped speaker labels. Does NOT modify any existing analysis logic —
    this is an additive feature for display/UI purposes only.

    Returns a dict with:
        - segments: list of {start, end, speaker, similarity, duration}
        - eo_total_sec: total seconds EO spoke
        - customer_total_sec: total seconds Customer spoke
        - speaker_count: 1 (only EO) or 2 (EO + Customer)
    """
    window = sr * 2
    hop = window // 2
    seg_labels = []
    eo_total = 0.0
    cust_total = 0.0

    for seg in speech_segs:
        seg_start = float(seg["start"])
        seg_end = float(seg["end"])
        sa = audio[int(seg_start * sr):int(seg_end * sr)]
        seg_dur = seg_end - seg_start

        if len(sa) < window:
            # Short segment — classify whole thing
            vec = extract_features(sa, sr) if len(sa) > sr * 0.3 else None
            sim = cosine_sim(EO_VECTOR, vec) if vec is not None else 0.0
            speaker = "EO" if sim >= EO_THRESHOLD else "Customer"
            seg_labels.append({
                "start": round(seg_start, 2),
                "end": round(seg_end, 2),
                "duration": round(seg_dur, 2),
                "speaker": speaker,
                "similarity": round(float(sim), 3),
            })
            if speaker == "EO":
                eo_total += seg_dur
            else:
                cust_total += seg_dur
            continue

        # Long segment — slide windows and group consecutive same-speaker windows
        current_speaker = None
        current_start = seg_start
        current_sims = []

        for w in range(0, len(sa) - window + 1, hop):
            chunk = sa[w:w + window]
            vec = extract_features(chunk, sr)
            sim = float(cosine_sim(EO_VECTOR, vec))
            speaker = "EO" if sim >= EO_THRESHOLD else "Customer"
            chunk_start_abs = seg_start + (w / sr)

            if current_speaker is None:
                current_speaker = speaker
                current_start = chunk_start_abs
                current_sims = [sim]
            elif speaker != current_speaker:
                # Flush previous run
                chunk_end_abs = chunk_start_abs
                d = chunk_end_abs - current_start
                if d > 0.1:
                    seg_labels.append({
                        "start": round(current_start, 2),
                        "end": round(chunk_end_abs, 2),
                        "duration": round(d, 2),
                        "speaker": current_speaker,
                        "similarity": round(float(np.mean(current_sims)), 3),
                    })
                    if current_speaker == "EO":
                        eo_total += d
                    else:
                        cust_total += d
                current_speaker = speaker
                current_start = chunk_start_abs
                current_sims = [sim]
            else:
                current_sims.append(sim)

        # Flush last run
        if current_speaker is not None:
            d = seg_end - current_start
            if d > 0.1:
                seg_labels.append({
                    "start": round(current_start, 2),
                    "end": round(seg_end, 2),
                    "duration": round(d, 2),
                    "speaker": current_speaker,
                    "similarity": round(float(np.mean(current_sims)), 3),
                })
                if current_speaker == "EO":
                    eo_total += d
                else:
                    cust_total += d

    speaker_count = 1 if cust_total < 0.5 else 2
    return {
        "segments": seg_labels,
        "eo_total_sec": round(eo_total, 1),
        "customer_total_sec": round(cust_total, 1),
        "speaker_count": speaker_count,
        "eo_segments_count": sum(1 for s in seg_labels if s["speaker"] == "EO"),
        "customer_segments_count": sum(1 for s in seg_labels if s["speaker"] == "Customer"),
    }


# ═══════════════════════════════════════════════════════════════
#  TRANSCRIPTION — faster-whisper (primary) + Google Speech (fallback)
# ═══════════════════════════════════════════════════════════════
def normalize_urdu_text(text):
    """Remove Urdu diacritics/tashkeel and normalize Unicode for better matching."""
    import unicodedata
    # Remove Urdu diacritics (zabar, zer, pesh, tashdeed, sukun, etc.)
    diacritics = set('\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652\u0653\u0654\u0655\u0670')
    text = ''.join(c for c in text if c not in diacritics)
    # Normalize Unicode (NFC)
    text = unicodedata.normalize('NFC', text)
    # Normalize common Urdu character variants
    text = text.replace('\u06cc', '\u06cc')  # yeh variants
    text = text.replace('\u0649', '\u06cc')  # alef maksura -> yeh
    text = text.replace('\u064a', '\u06cc')  # arabic yeh -> urdu yeh
    text = text.replace('\u06a9', '\u06a9')  # kaf variants
    text = text.replace('\u0643', '\u06a9')  # arabic kaf -> urdu kaf
    text = text.replace('\u06c1', '\u06c1')  # heh goal
    text = text.replace('\u06be', '\u06c1')  # heh doachashmee -> heh goal (for matching)
    # Collapse multiple spaces
    text = ' '.join(text.split())
    return text


def _detect_hallucination(text):
    """Detect Whisper hallucination — repeating phrases."""
    if not text or len(text) < 10:
        return True
    words = text.split()
    if len(words) < 3:
        return False
    for i in range(len(words) - 5):
        phrase = words[i] + " " + words[i+1]
        count = sum(1 for j in range(i, len(words) - 1) if words[j] + " " + words[j+1] == phrase)
        if count >= 3:
            return True
    from collections import Counter
    counts = Counter(words)
    for word, cnt in counts.most_common(3):
        if cnt >= 4 and cnt / len(words) > 0.3 and len(word) > 1:
            return True
    return False


def _clean_hallucination(text):
    """Remove repeated phrases, keep first occurrence."""
    if not text:
        return text
    words = text.split()
    if len(words) < 6:
        return text
    seen = {}
    for i in range(len(words) - 1):
        bigram = words[i] + " " + words[i+1]
        if bigram in seen and i - seen[bigram] < 5:
            return " ".join(words[:seen[bigram] + 2])
        seen[bigram] = i
    return text


def _google_transcribe_chunk(audio_data, language):
    """Transcribe a single chunk via Google Speech."""
    try:
        text = RECOGNIZER.recognize_google(audio_data, language=language)
        if text and text.strip():
            return text.strip()
    except (sr_lib.UnknownValueError, sr_lib.RequestError):
        pass
    return ""


def _remove_repetitions(text):
    """Aggressively remove phrase repetitions from transcription.

    Handles:
    - Adjacent word duplicates: "آج آج" → "آج"
    - Adjacent phrase duplicates: "لین دین ہے لین دین ہے" → "لین دین ہے"
    - Near-adjacent repetitions (gap up to 3 words): "مجھے رشوت کرنی کوئی مجھے رشوت" → "مجھے رشوت کرنی کوئی"
    - Runs the cleaning MULTIPLE times to catch nested repetitions.
    """
    if not text:
        return text

    prev_text = None
    iterations = 0
    # Keep cleaning until text stabilizes (max 5 iterations)
    while text != prev_text and iterations < 5:
        prev_text = text
        iterations += 1

        # Step 1: Remove exact adjacent word duplicates
        words = text.split()
        cleaned_words = []
        for w in words:
            if cleaned_words and cleaned_words[-1] == w:
                continue
            cleaned_words.append(w)
        text = " ".join(cleaned_words)

        # Step 2: Remove adjacent phrase duplicates (longest first, up to 10 words)
        for phrase_len in range(10, 1, -1):
            words = text.split()
            result = []
            i = 0
            while i < len(words):
                if i + phrase_len * 2 <= len(words):
                    first = words[i:i + phrase_len]
                    second = words[i + phrase_len:i + phrase_len * 2]
                    if first == second:
                        result.extend(first)
                        i += phrase_len * 2
                        continue
                result.append(words[i])
                i += 1
            text = " ".join(result)

        # Step 3: Remove near-adjacent phrase repetitions (gap 1-3 words)
        # Example: "مجھے رشوت کوئی مجھے رشوت" where "مجھے رشوت" repeats with gap
        for phrase_len in range(6, 1, -1):
            for gap in range(1, 4):  # gap of 1, 2, or 3 words
                words = text.split()
                result = []
                i = 0
                while i < len(words):
                    # Look for: [phrase_len words] [gap words] [same phrase_len words]
                    pos_first = i
                    pos_second = i + phrase_len + gap
                    if pos_second + phrase_len <= len(words):
                        first = words[pos_first:pos_first + phrase_len]
                        second = words[pos_second:pos_second + phrase_len]
                        if first == second and len(" ".join(first)) > 4:
                            # Keep first occurrence + gap, skip the duplicate
                            result.extend(words[i:i + phrase_len + gap])
                            i += phrase_len + gap + phrase_len
                            continue
                    result.append(words[i])
                    i += 1
                text = " ".join(result)

    return text


def _strip_llm_commentary(text):
    """Strip LLM meta-commentary that sometimes leaks into Gemini transcripts on noisy audio.

    Removes timestamp prefixes (e.g. '1:50 -'), parenthetical editor notes ('(repeated, but
    I'll transcribe once)'), and lines that are purely commentary. Returns '' if the cleaned
    text is too short to be a real transcript (triggers downstream fallback to Google/Whisper).
    """
    if not text:
        return text
    import re

    commentary_kw = re.compile(
        r"\b(repeated|transcribe|i['’]ll|i will|unclear|inaudible|"
        r"cannot hear|can't hear|no speech|no audio|silence|unintelligible|"
        r"note:|editor|assistant|as an ai)\b",
        re.IGNORECASE,
    )
    timestamp_prefix = re.compile(r"^\s*\d{1,2}:\d{2}\s*[-–—:]*\s*")
    parenthetical = re.compile(r"[\(\[][^\)\]]*[\)\]]")

    cleaned_lines = []
    for line in text.splitlines():
        line = timestamp_prefix.sub("", line)
        line = re.sub(r"\s\d{1,2}:\d{2}\s*[-–—:]*\s*", " ", line)
        dropped = parenthetical.sub(
            lambda m: "" if commentary_kw.search(m.group(0)) else m.group(0),
            line,
        )
        stripped = dropped.strip(" \"'“”‘’")
        if not stripped:
            continue
        if commentary_kw.search(stripped) and len(stripped.split()) < 8:
            continue
        cleaned_lines.append(stripped)

    out = " ".join(cleaned_lines)
    out = re.sub(r"\s+", " ", out).strip()
    if len(out) < 4:
        return ""
    return out


def _gemini_upload_file(key, audio_path, mime_type="audio/wav"):
    """Upload a media file (audio or video) to Gemini's Files API.

    Returns the file URI on success, or ''. Pass mime_type for video uploads,
    e.g. 'video/mp4', 'video/webm'.
    """
    import requests
    try:
        size = os.path.getsize(audio_path)
        headers = {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command":  "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type":   mime_type,
            "Content-Type": "application/json",
        }
        meta = {"file": {"display_name": os.path.basename(audio_path)}}
        r = requests.post(
            f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={key}",
            headers=headers, json=meta, timeout=30,
        )
        if r.status_code != 200:
            print(f"  [gemini-upload] init failed {r.status_code}: {r.text[:200]}", flush=True)
            return ""
        upload_url = r.headers.get("x-goog-upload-url") or r.headers.get("X-Goog-Upload-URL")
        if not upload_url:
            print("  [gemini-upload] no upload URL returned", flush=True)
            return ""
        with open(audio_path, "rb") as f:
            data = f.read()
        r2 = requests.post(
            upload_url,
            headers={
                "Content-Length": str(size),
                "X-Goog-Upload-Offset":  "0",
                "X-Goog-Upload-Command": "upload, finalize",
            },
            data=data, timeout=180,
        )
        if r2.status_code != 200:
            print(f"  [gemini-upload] upload failed {r2.status_code}: {r2.text[:200]}", flush=True)
            return ""
        file_obj = r2.json().get("file", {})
        uri = file_obj.get("uri", "")
        name = file_obj.get("name", "")
        state = file_obj.get("state", "")
        print(f"  [gemini-upload] ok uri={uri} state={state}", flush=True)

        # Video files are PROCESSING for a few seconds after upload. Gemini returns
        # "Please wait for the file to reach ACTIVE state" on generateContent if we
        # use the URI too early. Poll the file resource until ACTIVE (or give up).
        if state and state != "ACTIVE" and name:
            import time as _t
            for _attempt in range(30):  # up to ~60s total
                _t.sleep(2)
                try:
                    sr = requests.get(
                        f"https://generativelanguage.googleapis.com/v1beta/{name}?key={key}",
                        timeout=15,
                    )
                    if sr.status_code != 200:
                        print(f"  [gemini-upload] state poll http {sr.status_code}", flush=True)
                        continue
                    state = sr.json().get("state", "")
                    if state == "ACTIVE":
                        print(f"  [gemini-upload] file ACTIVE after {(_attempt+1)*2}s", flush=True)
                        break
                    if state == "FAILED":
                        print(f"  [gemini-upload] file FAILED processing", flush=True)
                        return ""
                except Exception as _pe:
                    print(f"  [gemini-upload] state poll error: {_pe}", flush=True)
            if state != "ACTIVE":
                print(f"  [gemini-upload] file still {state} after 60s — proceeding anyway", flush=True)
        return uri
    except Exception as e:
        print(f"  [gemini-upload] exception: {e}", flush=True)
        return ""


def _gemini_transcribe_via_file(key, file_uri):
    """Run the two transcription prompts against an already-uploaded Gemini file URI."""
    import requests
    urdu_text, english_text = "", ""
    urdu_prompt = (
        "You are a Pakistani Urdu transcription expert. "
        "Transcribe this audio EXACTLY ONCE in Urdu script. "
        "Do not repeat phrases. If unsure, transcribe once only. "
        "Return ONLY the transcription — no explanations. "
        "NEVER output timestamps (e.g. '1:50 -'), parentheticals like '(repeated)' or "
        "'(I'll transcribe once)', or any commentary about the transcription process. "
        "If audio is unclear, skip it silently. If there is no clear speech, return ENTIRELY EMPTY."
    )
    english_prompt = (
        "Translate this audio to Roman Urdu / English. "
        "Write Urdu words in Roman letters. Do not repeat phrases. "
        "Return ONLY the transliteration. "
        "NEVER output timestamps or parenthetical notes like '(repeated)'. "
        "If a section is unclear, skip it silently. If no clear speech, return empty."
    )
    for label, ptext, target in [("ur", urdu_prompt, "urdu"), ("en", english_prompt, "english")]:
        try:
            payload = {
                "contents": [{"parts": [
                    {"text": ptext},
                    {"file_data": {"mime_type": "audio/wav", "file_uri": file_uri}}
                ]}],
                "generationConfig": {"temperature": 0.0, "maxOutputTokens": 8192, "topK": 1, "topP": 0.1},
            }
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key={key}",
                json=payload, timeout=120,
            )
            if r.status_code != 200:
                print(f"  [gemini-{label}-file] http {r.status_code}: {r.text[:200]}", flush=True)
                continue
            txt = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            cleaned = _remove_repetitions(txt)
            if _detect_hallucination(cleaned):
                cleaned = _clean_hallucination(cleaned)
            cleaned = _strip_llm_commentary(cleaned)
            if target == "urdu":
                urdu_text = cleaned
            else:
                english_text = cleaned
            if cleaned:
                print(f"  [gemini-{label}-file] {cleaned[:150]}", flush=True)
            else:
                print(f"  [gemini-{label}-file] empty after cleanup", flush=True)
        except Exception as e:
            print(f"  [gemini-{label}-file] error: {e}", flush=True)
    return urdu_text, english_text


def _gemini_transcribe(audio_path):
    """Transcribe via Google Gemini 2.5 Flash — excellent Urdu/Punjabi/English support.

    Returns tuple: (urdu_text, english_translation)
    """
    import requests, base64
    key = _gemini_key()
    if not key:
        print("  [gemini-transcribe] GEMINI_API_KEY not set — skipping Gemini, will fallback", flush=True)
        return "", ""
    if len(key) < 10:
        print(f"  [gemini-transcribe] key too short ('{key[:6]}...') — check Gemini key", flush=True)
        return "", ""

    try:
        with open(audio_path, "rb") as f:
            raw = f.read()
        # Gemini inline_data hard limit is 20MB (base64). WAV at 16kHz float32 for 5 min = ~19MB,
        # base64 pushes it over. Cap the audio so we stay comfortably under.
        size_mb = len(raw) / (1024 * 1024)
        if size_mb > 14:
            print(f"  [gemini-transcribe] audio {size_mb:.1f}MB exceeds inline limit — using Files API upload", flush=True)
            uploaded_uri = _gemini_upload_file(key, audio_path)
            if uploaded_uri:
                return _gemini_transcribe_via_file(key, uploaded_uri)
            print(f"  [gemini-transcribe] file upload failed, returning empty", flush=True)
            return "", ""
        audio_b64 = base64.b64encode(raw).decode("utf-8")
        print(f"  [gemini-transcribe] sending {size_mb:.2f}MB audio (inline) to Gemini", flush=True)
    except Exception as e:
        print(f"  Gemini file read error: {e}", flush=True)
        return "", ""

    urdu_text = ""
    english_text = ""

    # Single Gemini call returning BOTH the Urdu transcript and the Roman/
    # English transliteration in one structured JSON response. Halves the
    # network round-trips compared to the previous two-call flow — at the
    # cost of a slightly larger response we have to parse defensively.
    try:
        payload = {
            "contents": [{"parts": [
                {"text": (
                    "You are a Pakistani Urdu transcription expert. Listen to this "
                    "police body-camera audio and return a SINGLE JSON object — "
                    "no markdown, no code fences, no commentary — with exactly "
                    "two fields:\n"
                    "  \"urdu\":    the transcript in Urdu script (Urdu words in Urdu, "
                    "             English words in English, standard punctuation ۔ ،)\n"
                    "  \"english\": the same content as Roman Urdu / English "
                    "             (e.g. 'rishwat', 'bakwas', 'chup raho')\n\n"
                    "CRITICAL RULES:\n"
                    "1. Each phrase appears ONCE. Do not repeat or duplicate.\n"
                    "2. NEVER output timestamps like '1:50 -' or '0:23'.\n"
                    "3. NEVER output parentheticals like '(repeated)', '(unclear)', "
                    "   '(I'll transcribe once)' or any commentary about the process.\n"
                    "4. If a section is unclear, skip it silently.\n"
                    "5. If there is NO clear speech in the audio, return "
                    "{\"urdu\":\"\",\"english\":\"\"} — both empty strings.\n"
                    "6. Return ONLY the JSON object, nothing before or after."
                )},
                {"inline_data": {"mime_type": "audio/wav", "data": audio_b64}}
            ]}],
            "generationConfig": {
                "temperature": 0.0,
                "maxOutputTokens": 8192,
                "topK": 1,
                "topP": 0.1,
                "responseMimeType": "application/json",
            }
        }
        resp = None
        for _attempt in range(3):
            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                json=payload, timeout=90
            )
            if resp.status_code == 200:
                break
            if resp.status_code in (429, 503):
                import time as _t
                _t.sleep(2 + _attempt * 3)
                print(f"  [gemini-tx] retry {_attempt+1}/3 (status {resp.status_code})", flush=True)
                continue
            break

        if resp and resp.status_code == 200:
            try:
                raw_text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            except (KeyError, IndexError):
                raw_text = ""
                print(f"  [gemini-tx] empty response", flush=True)

            # Defensive JSON parse — Gemini in JSON mode is reliable, but a
            # malformed response should NOT lose us the whole transcription.
            urdu_raw, english_raw = "", ""
            if raw_text:
                try:
                    j = json.loads(raw_text)
                    urdu_raw    = (j.get("urdu")    or "").strip()
                    english_raw = (j.get("english") or "").strip()
                except Exception:
                    # Fallback: treat the whole response as Urdu text.
                    print(f"  [gemini-tx] JSON parse failed — treating as Urdu only", flush=True)
                    urdu_raw = raw_text

            def _clean(s):
                if not s or len(s) <= 1:
                    return ""
                cleaned = _remove_repetitions(s)
                if _detect_hallucination(cleaned):
                    cleaned = _clean_hallucination(cleaned)
                cleaned = _strip_llm_commentary(cleaned)
                return cleaned

            urdu_text    = _clean(urdu_raw)
            english_text = _clean(english_raw)

            if urdu_text:
                print(f"  [gemini-tx ur] {urdu_text[:200]}", flush=True)
            if english_text:
                print(f"  [gemini-tx en] {english_text[:200]}", flush=True)
            if not urdu_text and not english_text:
                print(f"  [gemini-tx] empty after cleanup — will fallback", flush=True)
        else:
            status = resp.status_code if resp else 'no-response'
            body   = resp.text[:150] if resp else ''
            print(f"  Gemini transcribe error {status}: {body}", flush=True)
    except Exception as e:
        print(f"  Gemini transcribe error: {e}", flush=True)

    return urdu_text, english_text


def _gemini_full_analysis(audio_path, transcript, tone_label, violations, acoustics, language_hint="ur", greeting_info=None):
    """Run Gemini as a full Internal-Affairs analyst: uploads audio + transcript context,
    returns a structured JSON dict with transcription, vulgar_language, false_statements,
    loud_aggressive_voice, bribery_indicators, and overall_assessment.
    """
    import requests, base64
    key = _gemini_key()
    if not key:
        return {}

    audio_b64 = ""
    mime_type = "audio/wav"
    try:
        ext = os.path.splitext(audio_path)[1].lower()
        mime_map = {
            ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
            ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
            ".webm": "audio/webm",
        }
        mime_type = mime_map.get(ext, "audio/wav")
        with open(audio_path, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("utf-8")
    except Exception as e:
        print(f"  [gemini-full] audio read error: {e}", flush=True)

    system_prompt = (
        "You are an expert AI analyst for a Police Internal Affairs department. "
        "Your job is to analyze body-camera audio recordings of officers interacting with civilians. "
        "Detect: (1) VULGAR/ABUSIVE LANGUAGE — curses, slurs, insults in Urdu/Punjabi/Roman Urdu/English; "
        "(2) FALSE/MISLEADING STATEMENTS — lies, fake charges (jhoota muqadma), misrepresentation of law; "
        "(3) LOUD/AGGRESSIVE VOICE — shouting, yelling, intimidating delivery; "
        "(4) BRIBERY INDICATORS — 'chai pani', 'samajh jao', 'settle karo', 'bandobast', 'nazrana', direct money mentions; "
        "(5) OVERALL BEHAVIOR ASSESSMENT. "
        "Analyze AUDIO directly for tone/volume/emotion. Rate severity: none/low/medium/high/critical."
    )

    analysis_prompt = """Analyze this police body-camera audio recording and provide your assessment.

Listen carefully to:
- The words spoken (in any language: Urdu, Punjabi, English, or mixed)
- The tone and volume of voice
- Any signs of aggression, intimidation, or unprofessional conduct
- Any bribery-related language or hints

Respond ONLY with valid JSON in this exact format (no markdown, no code fences):
{
    "transcription": {
        "full_text": "Complete transcription of all speech heard",
        "language": "detected language (ur/pa/en/mixed)",
        "speakers": ["officer", "civilian"]
    },
    "vulgar_language": {
        "detected": true/false,
        "severity": "none/low/medium/high/critical",
        "instances": [
            {
                "text": "the vulgar word or phrase",
                "translation": "English translation if not in English",
                "timestamp_approx": "approximate time in recording",
                "context": "surrounding context"
            }
        ]
    },
    "false_statements": {
        "detected": true/false,
        "severity": "none/low/medium/high/critical",
        "instances": [
            {
                "statement": "the false/misleading statement",
                "reason": "why this appears false or misleading",
                "timestamp_approx": "approximate time"
            }
        ]
    },
    "loud_aggressive_voice": {
        "detected": true/false,
        "severity": "none/low/medium/high/critical",
        "instances": [
            {
                "description": "description of aggressive vocal behavior",
                "timestamp_approx": "approximate time",
                "type": "shouting/yelling/intimidating/threatening"
            }
        ]
    },
    "bribery_indicators": {
        "detected": true/false,
        "severity": "none/low/medium/high/critical",
        "instances": [
            {
                "text": "the bribery-related phrase",
                "translation": "English translation if needed",
                "type": "direct_demand/euphemism/hint/coercion",
                "timestamp_approx": "approximate time"
            }
        ]
    },
    "emotions": {
        "dominant": "one of: anger|frustration|contempt|intimidation|fear|calm|neutral|agitation",
        "breakdown": {
            "anger": 0-100,
            "frustration": 0-100,
            "contempt": 0-100,
            "intimidation": 0-100,
            "fear": 0-100,
            "calm": 0-100,
            "neutral": 0-100,
            "agitation": 0-100
        },
        "description": "1-2 sentences explaining the officer's emotional state in this recording"
    },
    "overall_assessment": {
        "classification": "normal/concerning/unprofessional/critical",
        "risk_score": 0-100,
        "severity": "NORMAL/WARNING/CRITICAL",
        "tone_label": "NORMAL/HARSH/ANGRY/BRIBE_TONE",
        "tone_percents": {
            "NORMAL": 0-100,
            "HARSH": 0-100,
            "ANGRY": 0-100,
            "BRIBE_TONE": 0-100
        },
        "is_flagged": true/false,
        "summary": "2-3 sentence summary of officer behavior",
        "recommended_action": "what action should be taken",
        "keywords_detected": [
            {"category": "RISHWAT/DHAMKI/GALI/RUDE_BEHAVIOR/HARASSMENT/GALAT_CHALLAN/ANGRY_TONE/POWER_ABUSE/INTIMIDATION/UNPROFESSIONAL", "phrase": "the actual abusive/threat/bribe phrase heard", "translation": "English translation"}
        ]
    }
}

The tone_percents MUST sum to 100 and reflect WHAT WAS HEARD (words + context).
For lawful enforcement with no abuse: NORMAL >= 70, HARSH 0-30, ANGRY 0-10, BRIBE_TONE 0-5.
For mild rudeness: HARSH 40-70, NORMAL 20-40, ANGRY 0-30, BRIBE_TONE 0-5.
For hostile shouting/slurs: ANGRY 50-90, HARSH 10-40, NORMAL 0-20, BRIBE_TONE 0-5.
For bribery hints: BRIBE_TONE 40-80, NORMAL 10-40, HARSH 5-30, ANGRY 0-20.

SCORING RULES — this system monitors POLICE OFFICER MISCONDUCT. Lawful, firm
enforcement is NOT misconduct. Be CONSERVATIVE. Default to NORMAL when unsure.

WHAT COUNTS AS LAWFUL ENFORCEMENT (score NORMAL even if voice is loud/firm):
- Sealing shops, removing encroachments, issuing fines/challans
- Telling civilians to leave premises, close shops, wind up
- Directing civilians to file applications at SDO/station
- Following chain of command ("if SDO sahib says so, we comply")
- Using polite markers like "please", "sir", "ji", "shukria", "thank you"
- Repeating orders for clarity (officers must repeat in noisy environments)
- Firm/projected voice — necessary to be heard across a shop or crowd

WHAT COUNTS AS ACTUAL MISCONDUCT:
- WARNING: dismissive sarcasm, mocking civilians, sustained rudeness, refusing
           to identify oneself, ignoring civilian's lawful questions
- CRITICAL: explicit slurs/profanity directed at civilians ("bakwas",
            personal insults, gali); explicit threats of unlawful arrest,
            beating, or detention; bribery language ("kuch de do", "paisy",
            "chai pani", "deal kar lete hain", "samjhauta", "settle karo");
            sustained hostile shouting >5s aimed at intimidation (NOT
            commanding "bahar aaiye" loudly to be heard).

SCORING BANDS:
- risk_score 0-29   → "NORMAL"   — DEFAULT. Lawful enforcement, professional
                                   conduct, polite or firm-but-civil tone.
                                   Even loud commands during a sealing
                                   operation belong here unless words show
                                   hostility/abuse/bribery.
- risk_score 30-69  → "WARNING"  — Mild rudeness, sarcasm, dismissive replies
                                   to civilian questions, missing greeting
                                   protocol. Words show some unprofessionalism
                                   but no slurs/threats/bribes.
- risk_score 70-100 → "CRITICAL" — At least ONE of: explicit slurs, explicit
                                   threats of unlawful action, bribery
                                   language, sustained hostile shouting with
                                   intent to intimidate. Acoustic loudness
                                   alone is NEVER enough.

Do NOT inflate severity from acoustic features (loudness, pitch, speed). The
audio's WORDS and INTENT determine severity. A police officer firmly directing
shop closure during a legal enforcement operation is NORMAL — even at high
volume.

tone_label MUST be one of NORMAL / HARSH / ANGRY / BRIBE_TONE based on the
WORDS HEARD (not just voice volume):
- NORMAL: professional language, even if firm or loud (DEFAULT)
- HARSH:  dismissive, sarcastic, or rude WORDS (not just loud voice)
- ANGRY:  hostile WORDS, slurs, explicit threats
- BRIBE_TONE: any bribery hint ("kuch de do", "settle karo", "chai pani", etc.)
- keywords_detected: list every abusive word, threat, slur, or bribery hint you actually heard (or [] if none). Do NOT invent. Empty list when audio is normal.

For `emotions.breakdown`, the eight values should roughly sum to 100 (they represent the relative proportion of each emotion heard). Rate purely from VOICE CUES (tone, pitch, volume, cadence) — not from the spoken words alone. If audio is unclear, set all to 0 and dominant = "neutral"."""

    if language_hint:
        analysis_prompt += (
            f"\n\nNote: The primary language expected is '{language_hint}' "
            "(Urdu/Punjabi). Pay special attention to Urdu/Punjabi slang and idioms."
        )
    if transcript:
        analysis_prompt += f"\n\nReference transcript (already extracted): {transcript[:1500]}"
    if tone_label:
        analysis_prompt += f"\n\nAcoustic tone classifier said: {tone_label}."

    # Style requirements for the summary + recommended_action — disciplinary report tone
    analysis_prompt += (
        "\n\nSTYLE REQUIREMENTS for `overall_assessment.summary` and `overall_assessment.recommended_action`:\n"
        "- Write in clean PROFESSIONAL ENGLISH (translate any Urdu/Punjabi quotes into English in the summary).\n"
        "- The `summary` must be 3-4 complete sentences in the tone of a Police Internal Affairs disciplinary report.\n"
        "- Describe (a) what the officer did initially, (b) how their tone or language escalated, "
        "(c) any dismissive/mocking/aggressive behavior, and (d) the unprofessional impact on the interaction.\n"
        "- When quoting the officer, translate the quote to English (e.g., \"Don't you understand?\" not \"O tainu saunda nahi?\").\n"
        "- The `recommended_action` must be 2-3 sentences recommending specific training "
        "(professional communication, de-escalation, respectful tone) and any review of body-camera footage.\n"
        "- Do NOT use bullet points, headings, or lists inside these two fields — plain prose only.\n"
        "- Past tense for summary, imperative/advisory tone for recommended_action.\n"
        "Example of the desired style:\n"
        "summary: \"The officer initially issues a firm command to close the shops. However, his tone quickly "
        "becomes impatient and aggressive, using dismissive language such as 'Don't you understand?' and repeating "
        "the civilian's complaint in a mocking manner. This behavior reflects unprofessional communication and an "
        "unnecessary escalation of the situation.\"\n"
        "recommended_action: \"The officer should receive training in professional communication and de-escalation "
        "techniques, ensuring a respectful tone while delivering lawful instructions. Reviewing body-camera footage "
        "for similar incidents is also advised.\""
    )

    greeting_block = ""
    if greeting_info:
        compliance = greeting_info.get("greeting_compliance", "MISSING")
        g_score = greeting_info.get("greeting_score", 0)
        salam = greeting_info.get("salam_found", False)
        name_ok = greeting_info.get("name_introduced", False)
        station_ok = greeting_info.get("station_mentioned", False)
        role_ok = greeting_info.get("role_mentioned", False)
        ex_name = greeting_info.get("extracted_name") or "NOT PROVIDED"
        ex_station = greeting_info.get("extracted_station") or "NOT PROVIDED"
        greeting_block = (
            f"\n\n**EO GREETING PROTOCOL COMPLIANCE (Officer self-identification):**\n"
            f"- Compliance: {compliance} ({g_score}/100)\n"
            f"- Salam greeting: {'YES' if salam else 'NO (VIOLATION)'}\n"
            f"- Officer name introduced: {'YES (' + ex_name + ')' if name_ok else 'NO (VIOLATION)'}\n"
            f"- Station mentioned: {'YES (' + ex_station + ')' if station_ok else 'NO (VIOLATION)'}\n"
            f"- Role/Designation stated: {'YES' if role_ok else 'NO (VIOLATION)'}\n"
            f"NOTE: Per EO Protocol, officers MUST introduce themselves before citizen interaction. "
            f"Failure to do so is an Officer violation (not Customer).\n"
        )

    parts = [{"text": system_prompt + "\n\n" + analysis_prompt + greeting_block}]
    if audio_b64:
        parts.append({"inline_data": {"mime_type": mime_type, "data": audio_b64}})

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192,
            "topP": 0.8,
            "responseMimeType": "application/json",
        }
    }
    # Retry on 429/503 — without this, the narrative summary silently vanishes
    # when other concurrent Gemini calls (video analysis, transcription) hit
    # the same free-tier quota window.
    import time as _t
    last_http = None
    for _attempt in range(4):
        try:
            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                json=payload, timeout=120,
            )
            last_http = resp.status_code
            if resp.status_code == 200:
                raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                if raw.startswith("```json"): raw = raw[7:]
                if raw.startswith("```"):     raw = raw[3:]
                if raw.endswith("```"):       raw = raw[:-3]
                data = json.loads(raw.strip())
                oa = data.get("overall_assessment", {}) or {}
                em = data.get("emotions", {}) or {}
                print(
                    f"  [gemini-full] classification={oa.get('classification')} "
                    f"risk={oa.get('risk_score')} flagged={oa.get('is_flagged')} "
                    f"emotion={em.get('dominant', 'n/a')}",
                    flush=True,
                )
                return data
            if resp.status_code in (429, 503):
                wait = 2 * (2 ** _attempt)
                print(f"  [gemini-full] http {resp.status_code} — retry {_attempt+1}/4 in {wait}s", flush=True)
                _t.sleep(wait)
                continue
            print(f"  [gemini-full] http {resp.status_code}: {resp.text[:200]}", flush=True)
            return {}
        except requests.exceptions.Timeout:
            print(f"  [gemini-full] timeout attempt {_attempt+1}/4", flush=True)
            continue
        except json.JSONDecodeError as e:
            print(f"  [gemini-full] JSON parse error: {e}", flush=True)
            return {}
        except Exception as e:
            print(f"  [gemini-full] error: {e}", flush=True)
            return {}
    print(f"  [gemini-full] all retries exhausted (last http={last_http})", flush=True)
    return {}

# ═══════════════════════════════════════════════════════════════
#  GEMINI VIDEO ANALYSIS — analyzes visual frames for bribery,
#  aggressive posture, physical contact, and concealed gestures.
#  Only runs when the uploaded file is a video (is_video=True).
# ═══════════════════════════════════════════════════════════════
_VIDEO_MIME_MAP = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
    ".3gp": "video/3gpp", ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv",
}


def _gemini_video_analysis(video_path):
    """Analyze video FRAMES for visual misconduct indicators.

    Uses Gemini 2.5 Flash multimodal video input to detect:
      - Cash / money exchange (bribery)
      - Aggressive posture (pointing, chest puffing, arms raised)
      - Physical contact (grabbing, pushing, striking)
      - Concealed gestures (hidden transactions, palmed objects)

    Returns a dict with keys: bribery_visual, aggressive_posture, physical_contact,
    concealed_gestures, visual_summary, risk_score. Empty dict on any failure.
    """
    import requests
    key = _gemini_key()
    if not key:
        print("  [gemini-video] GEMINI_API_KEY not set — skipping visual analysis", flush=True)
        return {}
    if not os.path.exists(video_path):
        return {}

    ext = os.path.splitext(video_path)[1].lower()
    mime_type = _VIDEO_MIME_MAP.get(ext, "video/mp4")
    size_mb = os.path.getsize(video_path) / (1024 * 1024)

    # Always use Files API for video — videos are typically large.
    print(f"  [gemini-video] uploading {size_mb:.1f}MB video ({mime_type})...", flush=True)
    file_uri = _gemini_upload_file(key, video_path, mime_type=mime_type)
    if not file_uri:
        print("  [gemini-video] upload failed — visual analysis skipped", flush=True)
        return {}

    prompt = """You are a visual misconduct analyst reviewing police body-camera footage.

Watch the video carefully and detect visual evidence of officer misconduct. Focus on:

1. BRIBERY_VISUAL — Cash, coins, folded currency, wallets being opened, money being passed,
   handed, palmed, or placed on surfaces. Any exchange of objects between officer and civilian.
2. AGGRESSIVE_POSTURE — Finger pointing at face, chest puffing, arms crossed aggressively,
   leaning in threateningly, blocking path, towering over seated civilian.
3. PHYSICAL_CONTACT — Grabbing, pushing, shoving, striking, pulling, restraining without
   clear lawful basis. Note any physical contact initiated by the officer.
4. CONCEALED_GESTURES — Hands behind back during conversation, hidden pockets, items slipped
   into uniform or bag, quick behind-the-back handoffs, covering actions with body.

Return ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "bribery_visual": {
    "detected": true/false,
    "severity": "none|low|medium|high|critical",
    "confidence": 0-100,
    "instances": [
      {"description": "what was seen", "timestamp_approx": "MM:SS", "type": "cash_exchange|object_passed|money_placed"}
    ]
  },
  "aggressive_posture": {
    "detected": true/false,
    "severity": "none|low|medium|high|critical",
    "confidence": 0-100,
    "instances": [
      {"description": "posture observed", "timestamp_approx": "MM:SS", "type": "pointing|looming|crossed_arms|blocking"}
    ]
  },
  "physical_contact": {
    "detected": true/false,
    "severity": "none|low|medium|high|critical",
    "confidence": 0-100,
    "instances": [
      {"description": "contact observed", "timestamp_approx": "MM:SS", "type": "grab|push|strike|restrain"}
    ]
  },
  "concealed_gestures": {
    "detected": true/false,
    "severity": "none|low|medium|high|critical",
    "confidence": 0-100,
    "instances": [
      {"description": "gesture observed", "timestamp_approx": "MM:SS", "type": "hidden_hand|palmed_object|behind_back_handoff"}
    ]
  },
  "visual_summary": "2-3 sentences in professional English describing the visual context of the interaction. Mention body language, any suspicious actions, and whether the footage visually supports or contradicts audio-based findings. If nothing notable, say so plainly.",
  "risk_score": 0-100
}

Rules:
- Rate severity only from VISUAL CUES. If you're uncertain, mark detected: false.
- `confidence` = how sure you are the action happened (0=guess, 100=very clear on camera).
- Timestamps MM:SS relative to start of video.
- If camera is obstructed, dark, or shaky throughout, set all categories to detected: false
  and note it in visual_summary.
- Professional English only. Past tense for instance descriptions."""

    payload = {
        "contents": [{"parts": [
            {"text": prompt},
            {"file_data": {"mime_type": mime_type, "file_uri": file_uri}},
        ]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 4096,
            "topP": 0.8,
            "responseMimeType": "application/json",
        },
    }

    # Retry loop — Gemini frequently returns 429 (rate-limited) or 503 (overloaded)
    # on video workloads. Up to 4 attempts with exponential backoff (2, 4, 8, 16s).
    import time as _t
    last_http = None
    for _attempt in range(4):
        try:
            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                json=payload, timeout=300,
            )
            last_http = resp.status_code
            if resp.status_code == 200:
                raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                for fence in ("```json", "```"):
                    if raw.startswith(fence):
                        raw = raw[len(fence):]
                if raw.endswith("```"):
                    raw = raw[:-3]
                data = json.loads(raw.strip())
                flags = [k for k in ("bribery_visual", "aggressive_posture", "physical_contact", "concealed_gestures")
                         if (data.get(k) or {}).get("detected")]
                print(
                    f"  [gemini-video] detected={flags or 'none'} risk={data.get('risk_score')}",
                    flush=True,
                )
                return data
            if resp.status_code in (429, 503):
                wait = 2 * (2 ** _attempt)
                print(f"  [gemini-video] http {resp.status_code} — retry {_attempt+1}/4 in {wait}s", flush=True)
                _t.sleep(wait)
                continue
            # 4xx client errors — don't retry
            print(f"  [gemini-video] http {resp.status_code}: {resp.text[:200]}", flush=True)
            return {}
        except requests.exceptions.Timeout:
            print(f"  [gemini-video] timeout on attempt {_attempt+1}/4", flush=True)
            continue
        except json.JSONDecodeError as e:
            print(f"  [gemini-video] JSON parse error: {e}", flush=True)
            return {}
        except Exception as e:
            print(f"  [gemini-video] error: {e}", flush=True)
            return {}
    print(f"  [gemini-video] all retries exhausted (last http={last_http})", flush=True)
    return {}


def _gemini_assess_behavior(transcript, tone_label, violations, acoustics, greeting_info=None):
    """Use Gemini to generate a professional behavior assessment based on transcript + analysis.
    Returns human-readable paragraph describing the officer's behavior.
    """
    import requests
    key = _gemini_key()
    if not key or not transcript:
        return ""

    # Build context for Gemini
    viol_summary = ""
    if violations:
        cats = {}
        for v in violations:
            t = v.get("type", "OTHER")
            cats[t] = cats.get(t, 0) + 1
        viol_summary = "Detected violations: " + ", ".join(f"{k} ({v}x)" for k, v in cats.items())

    acoustic_info = ""
    if acoustics:
        pitch = acoustics.get("avg_pitch_hz", 0)
        ratio = acoustics.get("pitch_ratio", 0)
        energy = acoustics.get("avg_energy", 0)
        agitation = acoustics.get("agitation", 0)
        loud_dur = acoustics.get("loud_duration_sec", 0)
        acoustic_info = (
            f"Voice analysis: pitch={pitch}Hz (ratio={ratio}x baseline), "
            f"energy={energy}, agitation={agitation}, loud_duration={loud_dur}s"
        )

    greeting_context = ""
    if greeting_info:
        compliance = greeting_info.get("greeting_compliance", "MISSING")
        g_score = greeting_info.get("greeting_score", 0)
        salam = greeting_info.get("salam_found", False)
        name_ok = greeting_info.get("name_introduced", False)
        station_ok = greeting_info.get("station_mentioned", False)
        role_ok = greeting_info.get("role_mentioned", False)
        greeting_context = (
            f"\n**EO Greeting Protocol (Officer self-identification):** "
            f"{compliance} ({g_score}/100) — "
            f"Salam:{'✓' if salam else '✗'}, Name:{'✓' if name_ok else '✗'}, "
            f"Station:{'✓' if station_ok else '✗'}, Role:{'✓' if role_ok else '✗'}"
        )

    prompt = f"""You are an expert professional conduct evaluator analyzing a bodycam recording of an Enforcement Officer (EO) interaction with a civilian.

**Audio Transcript (Urdu/English):**
{transcript[:2000]}

**AI Tone Classification:** {tone_label}

**{acoustic_info}**

**{viol_summary}**
{greeting_context}

Write a PROFESSIONAL behavior assessment in 3-4 sentences. Analyze:
1. Whether the officer properly introduced themselves (Salam, Name, Station, Role)
2. Whether the officer used abusive, harsh, or unprofessional language
3. The tone (aggressive/calm/intimidating/bribing)
4. Voice characteristics (shouting/loud/calm based on acoustics)
5. Key violations observed
6. Severity of professional ethics breach

Rules:
- Write ONLY the assessment paragraph, no headings, no bullet points
- Be direct and professional, like a disciplinary report
- Use past tense
- Focus on WHAT the officer did wrong (or well)
- Mention specific behaviors if evident
- Keep it 60-100 words

Return only the assessment text."""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 2000,
            "topP": 0.8,
        }
    }
    # Retry on transient 429/503 so the narrative doesn't silently disappear when
    # the other parallel Gemini calls (transcribe, full-analysis, video) briefly
    # saturate the free-tier quota window.
    import time as _t
    last_http = None
    for _attempt in range(4):
        try:
            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                json=payload, timeout=60,
            )
            last_http = resp.status_code
            if resp.status_code == 200:
                try:
                    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                    print(f"  [gemini-assessment] {text[:150]}", flush=True)
                    return text
                except (KeyError, IndexError):
                    return ""
            if resp.status_code in (429, 503):
                wait = 2 * (2 ** _attempt)
                print(f"  [gemini-assessment] http {resp.status_code} — retry {_attempt+1}/4 in {wait}s", flush=True)
                _t.sleep(wait)
                continue
            print(f"  Gemini assessment error {resp.status_code}", flush=True)
            return ""
        except requests.exceptions.Timeout:
            print(f"  [gemini-assessment] timeout attempt {_attempt+1}/4", flush=True)
            continue
        except Exception as e:
            print(f"  Gemini assessment error: {e}", flush=True)
            return ""
    print(f"  [gemini-assessment] all retries exhausted (last http={last_http})", flush=True)
    return ""


def _deepgram_transcribe(audio_path, language="ur"):
    """Transcribe via Deepgram API — fallback only."""
    import requests
    key = os.environ.get("DEEPGRAM_API_KEY", "")
    if not key:
        return ""

    # Nova-3 doesn't support Urdu — use whisper-medium for Urdu/Punjabi
    urdu_langs = {"ur", "pa", "hi", "bn"}
    model = "whisper-medium" if language in urdu_langs else "nova-3"

    try:
        with open(audio_path, "rb") as f:
            audio_data = f.read()

        params = {
            "model": model,
            "language": language,
            "smart_format": "true",
            "punctuate": "true",
            "diarize": "false",
        }

        resp = requests.post(
            "https://api.deepgram.com/v1/listen",
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": "audio/wav",
            },
            params=params,
            data=audio_data,
            timeout=90,
        )

        if resp.status_code == 200:
            result = resp.json()
            try:
                transcript = result["results"]["channels"][0]["alternatives"][0]["transcript"]
                if transcript and transcript.strip():
                    if _detect_hallucination(transcript):
                        transcript = _clean_hallucination(transcript)
                    if transcript:
                        print(f"  [deepgram-{model}-{language}] {transcript[:200]}", flush=True)
                        return transcript.strip()
            except (KeyError, IndexError):
                pass
        else:
            print(f"  Deepgram error {resp.status_code}: {resp.text[:150]}", flush=True)
    except Exception as e:
        print(f"  Deepgram error: {e}", flush=True)

    return ""


def auto_transcribe(audio, sample_rate=SR):
    """Transcribe audio — Deepgram Nova-3 PRIMARY, Google chunks fallback, Whisper local backup.

    Pipeline:
      1. Deepgram Nova-3 (PRIMARY — 90%+ accuracy, no hallucination, unlimited length)
      2. Google Speech in 25s chunks (FALLBACK — if Deepgram fails)
      3. Local whisper small (FINAL fallback)

    Groq completely removed (was causing hallucination loops).
    """
    import soundfile as sf

    total_duration = len(audio) / sample_rate
    print(f"  Audio: {total_duration:.1f}s", flush=True)

    # Normalize volume
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.95

    urdu_transcript = ""
    english_extra = ""
    method = "none"

    # ═══════════════════════════════════════════════════════════
    #  1. GEMINI 2.5 FLASH — PRIMARY (best Urdu understanding, free)
    # ═══════════════════════════════════════════════════════════
    tmp_full = None
    try:
        full_clip = audio[:sample_rate * 300]  # up to 5 minutes
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, full_clip.astype(np.float32), sample_rate)
            tmp_full = f.name
    except Exception as e:
        print(f"  Temp file error: {e}", flush=True)

    # Gemini is mandatory whenever a key is configured — if it's set, we
    # require a real Gemini response. Falling back silently would mean the
    # DB row says "analyzed" with degraded Google Speech data, which is
    # exactly what the user does NOT want. Set GEMINI_REQUIRED=false to opt
    # back into the fallback chain (useful when Gemini is quota-limited).
    gemini_required = (
        bool(_gemini_key())
        and os.environ.get("GEMINI_REQUIRED", "true").strip().lower() != "false"
    )

    if tmp_full:
        gemini_ur, gemini_en = _gemini_transcribe(tmp_full)
        if gemini_ur:
            urdu_transcript = gemini_ur
            method = "gemini_2.5_flash"
            print(f"  ✓ Gemini transcription SUCCESS ({len(gemini_ur)} chars) — skipping fallbacks", flush=True)
        elif gemini_required:
            print(f"  ✗ Gemini transcription returned empty AND key is configured — failing hard (no fallback).", flush=True)
        else:
            print(f"  ✗ Gemini transcription returned empty — will try Google Speech fallback", flush=True)
        if gemini_en:
            english_extra = gemini_en

        try:
            os.unlink(tmp_full)
        except:
            pass

    # Hard-stop: if Gemini was supposed to run and didn't produce a transcript,
    # surface the error so the .NET handler skips the DB save and the file is
    # moved to WatchFolder/Failed/ with a useful error message.
    if gemini_required and not urdu_transcript:
        raise RuntimeError(
            "Gemini transcription failed (key set but no response). "
            "Check Gemini quota, network, or audio length. "
            "Set GEMINI_REQUIRED=false in .env if you want to allow Google Speech fallback."
        )

    # ═══════════════════════════════════════════════════════════
    #  2. GOOGLE SPEECH CHUNKS — FALLBACK if Gemini failed
    # ═══════════════════════════════════════════════════════════
    if not urdu_transcript:
        print(f"  Gemini failed, trying Google Speech chunks...", flush=True)
        chunk_sec = 25
        chunk_size = sample_rate * chunk_sec
        chunks = []
        for i in range(0, len(audio), chunk_size):
            chunk = audio[i:i + chunk_size]
            if len(chunk) > sample_rate * 0.5:
                chunks.append(chunk)

        print(f"  Split: {len(chunks)} chunks ({chunk_sec}s each)", flush=True)

        urdu_parts = []
        for ci, chunk in enumerate(chunks):
            tmp_chunk = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    sf.write(f.name, chunk.astype(np.float32), sample_rate)
                    tmp_chunk = f.name
            except Exception:
                continue

            chunk_text = ""
            try:
                with sr_lib.AudioFile(tmp_chunk) as source:
                    audio_data = RECOGNIZER.record(source)

                chunk_text = _google_transcribe_chunk(audio_data, "ur-PK")
                if chunk_text:
                    print(f"  [chunk {ci+1}/{len(chunks)} ur] {chunk_text[:100]}", flush=True)

                if not chunk_text:
                    chunk_text = _google_transcribe_chunk(audio_data, "pa-IN")
                    if chunk_text:
                        print(f"  [chunk {ci+1}/{len(chunks)} pa] {chunk_text[:100]}", flush=True)

                if not chunk_text:
                    chunk_text = _google_transcribe_chunk(audio_data, "en-PK")
                    if chunk_text:
                        print(f"  [chunk {ci+1}/{len(chunks)} en] {chunk_text[:100]}", flush=True)
            except Exception as e:
                print(f"  [chunk {ci+1}] error: {e}", flush=True)
            finally:
                try:
                    os.unlink(tmp_chunk)
                except:
                    pass

            if chunk_text:
                urdu_parts.append(chunk_text)

        if urdu_parts:
            urdu_transcript = " ".join(urdu_parts)
            method = "google_speech"

    # ═══════════════════════════════════════════════════════════
    #  3. LOCAL WHISPER — last fallback
    # ═══════════════════════════════════════════════════════════
    if not urdu_transcript and WHISPER_MODEL is not None:
        try:
            tmp_wb = None
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                sf.write(f.name, audio[:sample_rate * 60].astype(np.float32), sample_rate)
                tmp_wb = f.name
            segments, info = WHISPER_MODEL.transcribe(
                tmp_wb, language="ur", task="transcribe",
                beam_size=3, best_of=1, temperature=0.0,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=300, speech_pad_ms=200),
            )
            whisper_text = " ".join(seg.text.strip() for seg in segments).strip()
            if whisper_text:
                if _detect_hallucination(whisper_text):
                    whisper_text = _clean_hallucination(whisper_text)
                if whisper_text:
                    urdu_transcript = whisper_text
                    method = "whisper_local"
                    print(f"  [whisper-local] {whisper_text[:200]}", flush=True)
            try:
                os.unlink(tmp_wb)
            except:
                pass
        except Exception as e:
            print(f"  whisper-local error: {e}", flush=True)

    if not urdu_transcript:
        print("  No transcript from any engine", flush=True)
        return "", "no_speech_detected"

    # Single clean output: Urdu (displayed) + English (hidden, keywords only)
    transcript = urdu_transcript + (" | " + english_extra if english_extra else "")
    print(f"  Final [{method}]: {urdu_transcript[:200]}", flush=True)

    return transcript, method, urdu_transcript, english_extra


# ═══════════════════════════════════════════════════════════════
#  PUNJABI GURMUKHI → ROMAN TRANSLITERATION
# ═══════════════════════════════════════════════════════════════
def transliterate_punjabi_to_roman(text):
    """Convert Punjabi Gurmukhi script to Roman for keyword matching."""
    punjabi_map = {
        # Bribe / money
        "ਰਿਸ਼ਵਤ": "rishwat", "ਪੈਸੇ": "paise", "ਪੈਸਾ": "paisa",
        "ਪੈਸੇ ਦੇ ਦੇ": "paise de do", "ਪੈਸੇ ਕੱਢ": "paise nikal",
        "ਛੱਡ ਦੇ": "chhod do", "ਜਾਣ ਦੇ": "jaane do",
        "ਮਾਫ਼": "maaf", "ਡੀਲ": "deal", "ਸਮਝੌਤਾ": "samjhota",
        "ਚਾਹ ਪਾਣੀ": "chai paani", "ਨੋਟ": "note",
        # Threat
        "ਗ੍ਰਿਫ਼ਤਾਰ": "arrest", "ਜੇਲ੍ਹ": "jail", "ਜੇਲ": "jail",
        "ਥਾਣਾ": "thana", "ਥਾਣੇ": "thane",
        "ਮਾਰ": "maar", "ਮਾਰਾਂਗਾ": "marunga",
        "ਫੜ ਲਵਾਂਗਾ": "pakad loon ga", "ਫੜ": "pakad",
        "ਘਰ ਦਾ ਪਤਾ": "ghar ka pata",
        "ਤੋੜ ਦਿਆਂਗਾ": "tod doon ga",
        "ਬਰਬਾਦ": "barbaad", "ਥੱਪੜ": "thappad",
        "ਕੇਸ": "case", "ਚਲਾਨ": "challan",
        # Abuse
        "ਗਧਾ": "gadha", "ਗਧੇ": "gadhe",
        "ਬੇਵਕੂਫ਼": "bewaqoof", "ਬੇਵਕੂਫ": "bewaqoof",
        "ਜਾਹਿਲ": "jahil", "ਪਾਗਲ": "pagal",
        "ਬੇਸ਼ਰਮ": "besharam",
        "ਕਮੀਨਾ": "kamina", "ਕਮੀਨੇ": "kamine",
        "ਹਰਾਮੀ": "harami", "ਹਰਾਮਖੋਰ": "haramkhor",
        "ਝੂਠਾ": "jhoota", "ਕੁੱਤਾ": "kutta", "ਕੁੱਤੇ": "kutte",
        "ਸੂਰ": "suar", "ਨਾਲਾਇਕ": "nalayak",
        "ਬਦਤਮੀਜ਼": "badtameez", "ਬਦਤਮੀਜ਼ੀ": "badtameezi",
        "ਜ਼ਲੀਲ": "zaleel", "ਲਾਹਨਤ": "laanat",
        "ਚੋਰ": "chor", "ਡਾਕੂ": "dakait", "ਬਦਮਾਸ਼": "badmaash",
        "ਉੱਲੂ": "ullu", "ਸਾਲਾ": "saala", "ਸਾਲੀ": "saali",
        "ਕੰਜਰ": "kanjar", "ਬੇਗ਼ੈਰਤ": "beghairat",
        "ਅਹਿਮਕ": "ahmaq", "ਹਰਾਮਜ਼ਾਦਾ": "haramzada",
        # Rude
        "ਚੁੱਪ": "chup", "ਚੁੱਪ ਕਰ": "chup kar", "ਚੁੱਪ ਰਹਿ": "chup raho",
        "ਹੱਟ": "hat", "ਨਿਕਲ ਜਾ": "nikal jao",
        "ਜ਼ਬਾਨ": "zuban", "ਹੈਸੀਅਤ": "haisiyat", "ਹਿੰਮਤ": "himmat",
        "ਔਕਾਤ": "auqat", "ਬਕਵਾਸ": "bakwaas",
        "ਤਮੀਜ਼": "tameez", "ਐਟੀਟਿਊਡ": "attitude",
        # Harassment
        "ਨੌਕਰੀ": "naukri", "ਦੁਕਾਨ": "dukaan",
        "ਬਦਨਾਮ": "badnaam", "ਇੱਜ਼ਤ": "izzat",
        "ਖ਼ਾਨਦਾਨ": "khandaan", "ਜ਼ਿੰਦਗੀ": "zindagi", "ਹਰਾਮ": "haraam",
        # Angry
        "ਗੁੱਸਾ": "gussa", "ਚੀਕ": "cheekh", "ਚਿੱਲਾ": "chilla",
        "ਡਾਂਟ": "daant", "ਸ਼ੋਰ": "shor",
        # Power
        "ਅਫ਼ਸਰ": "officer", "ਕਾਨੂੰਨ": "kanoon",
        "ਹੁਕਮ": "hukum", "ਸ਼ਿਕਾਇਤ": "shikayat",
        "ਲਾਇਸੈਂਸ": "license", "ਸੀਲ": "seal", "ਰੇਡ": "raid",
        # Intimidation
        "ਡਰ": "dar", "ਅੰਜਾਮ": "anjaam", "ਨਤੀਜਾ": "nateeja",
        "ਮੌਕਾ": "mauka", "ਸਬਕ": "sabaq", "ਅੱਗ": "aag",
        # Galat challan
        "ਗ਼ਲਤ": "galat", "ਗਲਤ": "galat", "ਗਲਤ ਚਲਾਨ": "galat challan",
        "ਰਸੀਦ": "receipt",
    }
    result = text
    for punjabi, roman in sorted(punjabi_map.items(), key=lambda x: -len(x[0])):
        result = result.replace(punjabi, roman)
    return result


def transliterate_urdu_to_roman(text):
    """Convert Urdu script to Roman Urdu for keyword matching."""
    mapping = {
        # Bribe
        "\u0631\u0634\u0648\u062a": "rishwat",
        "\u067e\u06cc\u0633\u06d2": "paisay", "\u067e\u06cc\u0633\u0627": "paisa",
        "\u067e\u06cc\u0633\u06d2 \u062f\u06d2 \u062f\u0648": "paisy de do",
        "\u067e\u06cc\u0633\u06d2 \u062f\u0648": "paisy do",
        "\u067e\u06cc\u0633\u06d2 \u0646\u06a9\u0627\u0644": "paisy nikal",
        "\u0686\u06be\u0648\u0691 \u062f\u0648": "chhod do",
        "\u062c\u0627\u0646\u06d2 \u062f\u0648": "jaane do",
        "\u0645\u0639\u0627\u0641": "maaf",
        "\u0644\u06cc\u0646 \u062f\u06cc\u0646": "lein dein",
        "\u0645\u0639\u0627\u0645\u0644\u06c1": "mamla",
        "\u0633\u0645\u062c\u06be\u0648\u062a\u0627": "samjhota",
        "\u0688\u06cc\u0644": "deal",
        "\u0646\u067e\u0679\u0627": "nipta",
        "\u0686\u0627\u0626\u06d2 \u067e\u0627\u0646\u06cc": "chai paani",
        "\u067e\u0631\u0686\u06cc": "parchi",
        "\u0646\u0648\u0679": "note",
        "\u062d\u0633\u0627\u0628": "hisaab",
        # Threat
        "\u06af\u0631\u0641\u062a\u0627\u0631": "arrest",
        "\u062c\u06cc\u0644": "jail", "\u062b\u0627\u0646\u0627": "thana",
        "\u0645\u0627\u0631 \u062f\u0648\u06ba \u06af\u0627": "maar doon ga",
        "\u0645\u0627\u0631\u0648\u06ba\u06af\u0627": "marunga",
        "\u067e\u06a9\u0691 \u0644\u0648\u06ba \u06af\u0627": "pakad loon ga",
        "\u06af\u06be\u0631 \u06a9\u0627 \u067e\u062a\u06c1": "ghar ka pata",
        "\u062a\u0648\u0691 \u062f\u0648\u06ba \u06af\u0627": "tod doon ga",
        "\u062e\u062a\u0645 \u06a9\u0631": "khatam kar",
        "\u0628\u0631\u0628\u0627\u062f \u06a9\u0631": "barbaad kar",
        "\u062a\u06be\u067e\u0691": "thappad",
        "\u067e\u0679\u0627\u0626\u06cc": "pitai",
        "\u06a9\u06cc\u0633": "case",
        "\u0686\u0627\u0644\u0627\u0646": "challan",
        # Abuse
        "\u06af\u062f\u06be\u0627": "gadha", "\u06af\u062f\u06be\u06d2": "gadhe",
        "\u0628\u06d2\u0648\u0642\u0648\u0641": "bewaqoof",
        "\u062c\u0627\u06c1\u0644": "jahil", "\u067e\u0627\u06af\u0644": "pagal",
        "\u0628\u06d2\u0634\u0631\u0645": "besharam",
        "\u06a9\u0645\u06cc\u0646\u06d2": "kamine", "\u06a9\u0645\u06cc\u0646\u0627": "kamina",
        "\u062d\u0631\u0627\u0645\u06cc": "harami", "\u062d\u0631\u0627\u0645\u062e\u0648\u0631": "haramkhor",
        "\u062c\u06be\u0648\u0679\u0627": "jhoota",
        "\u06a9\u062a\u0651\u0627": "kutta", "\u06a9\u062a\u0651\u06d2": "kutte",
        "\u0633\u0624\u0631": "suar",
        "\u0646\u0627\u0644\u0627\u0626\u0642": "nalayak",
        "\u0628\u062f\u062a\u0645\u06cc\u0632": "badtameez",
        "\u0630\u0644\u06cc\u0644": "zaleel", "\u0644\u0639\u0646\u062a": "laanat",
        "\u0686\u0648\u0631": "chor", "\u0688\u0627\u06a9\u0648": "dakait",
        "\u0628\u062f\u0645\u0639\u0627\u0634": "badmaash",
        "\u0627\u0644\u0648": "ullu",
        "\u0633\u0627\u0644\u0627": "saala", "\u0633\u0627\u0644\u06cc": "saali",
        "\u06a9\u0646\u062c\u0631": "kanjar",
        "\u0628\u06d2 \u063a\u06cc\u0631\u062a": "beghairat",
        "\u0627\u062d\u0645\u0642": "ahmaq",
        "\u062d\u0631\u0627\u0645\u0632\u0627\u062f\u06c1": "haramzada",
        # Rude
        "\u0686\u067e": "chup", "\u0686\u067e \u0631\u06c1\u0648": "chup raho",
        "\u06c1\u0679\u0648": "hato", "\u0646\u06a9\u0644 \u062c\u0627\u0624": "nikal jao",
        "\u0632\u0628\u0627\u0646": "zuban",
        "\u062d\u06cc\u062b\u06cc\u062a": "haisiyat",
        "\u06c1\u0645\u062a": "himmat",
        "\u0627\u0648\u0642\u0627\u062a": "auqat",
        # Harassment
        "\u0646\u0648\u06a9\u0631\u06cc": "naukri",
        "\u062f\u06a9\u0627\u0646": "dukaan",
        "\u0628\u062f\u0646\u0627\u0645": "badnaam",
        "\u0639\u0632\u062a": "izzat",
        "\u062e\u0627\u0646\u062f\u0627\u0646": "khandaan",
        "\u0632\u0646\u062f\u06af\u06cc": "zindagi",
        "\u062d\u0631\u0627\u0645": "haraam",
        # Angry
        "\u063a\u0635\u0651\u0627": "gussa",
        "\u0686\u06cc\u062e": "cheekh", "\u0686\u0644\u0627": "chilla",
        "\u0688\u0627\u0646\u0679": "daant",
        "\u0634\u0648\u0631": "shor",
        # Power abuse
        "\u0627\u062e\u062a\u06cc\u0627\u0631": "ikhtiyaar",
        "\u0622\u0641\u06cc\u0633\u0631": "officer",
        "\u0642\u0627\u0646\u0648\u0646": "kanoon",
        "\u062d\u06a9\u0645": "hukum",
        "\u0634\u06a9\u0627\u06cc\u062a": "shikayat",
        "\u0644\u0627\u0626\u0633\u0646\u0633": "license",
        "\u0633\u06cc\u0644": "seal",
        "\u0646\u0648\u0679\u0633": "notice",
        "\u0631\u06cc\u0688": "raid",
        # Intimidation
        "\u0688\u0631": "dar",
        "\u0627\u0646\u062c\u0627\u0645": "anjaam",
        "\u0646\u062a\u06cc\u062c\u06c1": "nateeja",
        "\u0648\u0627\u0631\u0646\u0646\u06af": "warning",
        "\u0645\u0648\u0642\u0639": "mauka",
        "\u0633\u0628\u0642": "sabaq",
        "\u0622\u06af": "aag",
        # General
        "\u063a\u0644\u0637 \u0686\u0627\u0644\u0627\u0646": "galat challan",
        # Rude / attitude
        "\u0628\u06a9\u0648\u0627\u0633": "bakwaas",
        "\u062a\u0645\u06cc\u0632": "tameez",
        "\u0627\u06cc\u0679\u06cc\u0679\u06cc\u0648\u0688": "attitude",
        # Extra bribe
        "\u067e\u06cc\u0633\u06d2 \u062f\u06d2": "paisay de",
        "\u067e\u06cc\u0633\u06d2 \u0644\u0627\u0624": "paisay lao",
        "\u067e\u06cc\u0633\u06d2 \u0646\u06a9\u0627\u0644\u0648": "paisay nikalo",
        # Greeting-related (for greeting detection)
        "السلام علیکم": "assalam alaikum",
        "وعلیکم السلام": "walaikum assalam",
        "علیکم السلام": "alaikum assalam",
        "میرا نام": "mera naam",
        "میں ہوں": "mein hoon",
        "نام ہے": "naam hai",
        "سٹیشن سے": "station se",
        "سٹیشن": "station",
        "تھانے سے": "thane se",
        "سے آیا ہوں": "se aaya hoon",
        "آیا ہوں": "aaya hoon",
        "انفورسمنٹ آفیسر": "enforcement officer",
        "انفورسمنٹ": "enforcement",
        "آفیسر": "officer",
        "افیسر": "officer",
        "افسر": "officer",
        "ٹریفک وارڈن": "traffic warden",
        "وارڈن": "warden",
    }
    result = text
    for urdu, roman in sorted(mapping.items(), key=lambda x: -len(x[0])):
        result = result.replace(urdu, roman)
    return result


# ═══════════════════════════════════════════════════════════════
#  SPELLING NORMALIZATION — handles Whisper spelling variations
# ═══════════════════════════════════════════════════════════════
# Common spelling variations Whisper produces vs what's in keywords
SPELLING_VARIANTS = {
    "bakvaas": "bakwaas", "bakwas": "bakwaas", "bakvas": "bakwaas",
    "bewakuf": "bewaqoof", "bewaquf": "bewaqoof", "bevakoof": "bewaqoof",
    "rishvat": "rishwat", "rishват": "rishwat",
    "paisy": "paise", "pese": "paise", "paise": "paisa",
    "chhup": "chup", "choop": "chup",
    "ghussa": "gussa", "ghusa": "gussa",
    "tameez": "tameez", "tamiz": "tameez", "tameej": "tameez",
    "chalaan": "challan", "chalan": "challan",
    "badtmeez": "badtameez", "badtamiz": "badtameez",
    "kamina": "kamine", "kameena": "kamine",
    "harami": "harami", "haraami": "harami",
    "pagal": "paagal", "pagl": "pagal",
    "bewkoof": "bewaqoof",
    "galat": "galat", "ghalt": "galat",
    "dhamki": "dhamki", "damki": "dhamki",
    "gali": "gali", "gaali": "gali",
}


def normalize_roman_spelling(text):
    """Normalize common Whisper spelling variations to match keywords."""
    words = text.split()
    normalized = []
    for w in words:
        normalized.append(SPELLING_VARIANTS.get(w, w))
    return " ".join(normalized)


# ═══════════════════════════════════════════════════════════════
#  EO GREETING DETECTION — Identifies officer from spoken greeting
# ═══════════════════════════════════════════════════════════════
# Standard greeting patterns officers should use before interactions
EO_GREETING_TEMPLATES = [
    "Assalam Alaikum, mera naam {name} hai, mein {station} enforcement station se aaya hoon",
    "Assalam Alaikum, mera naam {name} hai aur mein {station} se hoon",
    "Assalam Alaikum, mein {name} hoon, {station} enforcement officer",
    "Assalam Alaikum, mein enforcement officer {name}, {station} area",
    "Assalam Alaikum, Traffic Warden {name}, {station} station",
]

# Greeting detection keywords (Urdu + Roman + English)
GREETING_MARKERS = {
    "salam": [
        "assalam alaikum", "asslam alikum", "assalamu alaikum", "salam alaikum",
        "aslam o alikum", "asalam alekum", "slam alaikum", "salam",
        "assalam o alaikum", "assalam u alaikum", "assalamoalaikum",
        "as salam alaikum", "aslam alaikum", "aslam alikum",
        "assalam walaikum", "salam walaikum", "assalamualaikum",
        "assalam aleykum", "assalam alikum", "a salam alaikum",
        "alsalam alaikum", "alsalamu alaikum",
        "السلام علیکم", "اسلام علیکم", "سلام", "السلام و علیکم",
        "وعلیکم السلام", "علیکم السلام", "و علیکم السلام",
        "walaikum assalam", "walaikum salam", "wa alaikum assalam",
        "walekum salam", "walaikum as salam",
    ],
    "introduction": [
        "mera naam", "mera name", "mein hoon", "main hoon", "mei hoon",
        "mein hun", "main hun", "my name", "i am",
        "mera nam", "naam hai", "name hai", "naam h", "name h",
        "naam ha", "name ha", "mein hon", "main hon",
        "میرا نام", "میں ہوں", "نام ہے",
    ],
    "station": [
        "station se", "station say", "station sy", "thane se", "thana se",
        "area se", "area say", "enforcement station", "enforcement office",
        "se aaya hoon", "say aya hon", "se aya hoon", "sy aya hon",
        "se aya hon", "say aaya hoon", "say aaya hon", "se aaya hon",
        "se aya hun", "say aya hun", "sy aya hoon", "sy aaya hoon",
        "stations se", "stations say", "stations sy",
        "station sey", "stations sey",
        "se aya hu", "say aya hu", "se aaya hu",
        "سٹیشن سے", "تھانے سے", "سے آیا ہوں", "ایریا سے",
        "سے آیا ہوں", "سٹیشنز سے",
    ],
    "role": [
        "enforcement officer", "traffic warden", "warden", "officer",
        "eo", "traffic officer", "enforcement",
        "انفورسمنٹ آفیسر", "ٹریفک وارڈن", "وارڈن", "آفیسر", "انفورسمنٹ",
        "افیسر", "افسر", "آفسر",
    ],
}

def detect_eo_greeting(transcript):
    """Detect officer self-identification greeting from transcript.

    Looks for patterns like:
      'Assalam Alaikum, mera naam Irfan Ali hai, mein Modal Town enforcement station se aaya hoon'

    Returns:
      dict with greeting detection results:
        - greeting_detected (bool)
        - salam_found (bool)
        - name_introduced (bool)
        - station_mentioned (bool)
        - role_mentioned (bool)
        - extracted_name (str or None)
        - extracted_station (str or None)
        - matched_officer_id (str or None)
        - matched_officer_name (str or None)
        - greeting_text (str) - the part of transcript identified as greeting
        - greeting_score (int) - 0-100 how complete the greeting is
        - greeting_compliance (str) - FULL / PARTIAL / MISSING
        - suggestions (list) - what was missing from the greeting
    """
    if not transcript:
        return {
            "greeting_detected": False, "salam_found": False,
            "name_introduced": False, "station_mentioned": False,
            "role_mentioned": False, "extracted_name": None,
            "extracted_station": None, "matched_officer_id": None,
            "matched_officer_name": None, "greeting_text": "",
            "greeting_score": 0, "greeting_compliance": "MISSING",
            "suggestions": ["Officer did not introduce themselves before the interaction"],
        }

    text = transcript.lower().strip()
    text_roman = transliterate_urdu_to_roman(text) if any(ord(c) > 255 for c in text) else text
    search_text = f"{text} {text_roman}"

    # Check each greeting component
    salam_found = any(kw in search_text for kw in GREETING_MARKERS["salam"])
    name_introduced = any(kw in search_text for kw in GREETING_MARKERS["introduction"])
    station_mentioned = any(kw in search_text for kw in GREETING_MARKERS["station"])
    role_mentioned = any(kw in search_text for kw in GREETING_MARKERS["role"])

    # Extract officer name from greeting.
    # Priority patterns:
    #   1. "mera naam <NAME> hai"  — strongest, name between two explicit markers
    #   2. "my name is <NAME>"     — English equivalent
    #   3. "naam <NAME> hai"       — shorter Urdu variant
    #   4. Urdu script "میرا نام <NAME>"
    # NOTE: "mein/main/i am <X>" is DELIBERATELY NOT a name pattern any more —
    # in Urdu "main <station> se aaya hoon" ("I am from <station>") has the station name
    # right after "main", so pattern 2 of the old code was routinely capturing the station
    # (e.g. "Model") as the officer's name. The fix is to require the stronger "naam/name"
    # anchor; the `i_am_fallback` below is only used when no "naam" anchor exists.
    import re
    extracted_name = None
    _name_filler = {
        "mera", "meri", "mere", "naam", "nam", "name", "hai", "hain", "hun", "hoon", "hon",
        "main", "mein", "mei", "aur", "or", "ki", "ka", "se", "say", "sy",
        "wa", "walaikum", "assalam", "alaikum", "salam", "my", "is", "i", "am",
        "ji", "the", "a", "an", "and", "from", "of",
        # Location-type words — never an officer's name, always a station qualifier
        "model", "station", "stations", "area", "thana", "thane", "police",
        "enforcement", "officer", "warden", "investigation", "town", "city",
        # Urdu fillers / copula / location markers
        "ہے", "ہوں", "میں", "اور", "سے", "کا", "کی", "سر", "بھی",
        "سٹیشن", "ماڈل", "تھانے", "تھانا", "ایریا", "پولیس", "آفیسر", "افیسر",
    }
    name_patterns = [
        # Primary: "mera naam <NAME> hai" — captures 1-3 ASCII tokens between markers
        r"(?:mera\s+(?:naam|nam|name))\s+((?:[A-Za-z]+\s+){0,2}?[A-Za-z]+)\s+(?:hai|h\b|ha\b|he\b|ہے)",
        # English: "my name is <NAME>" — ends at hai/.|,|end
        r"(?:my\s+name\s+is)\s+((?:[A-Za-z]+\s+){0,2}?[A-Za-z]+)(?:\s+hai|[,\.]|\s+and\b|$)",
        # Shorter: "naam <NAME> hai" — only 1 word captured (to avoid sweeping phrases)
        r"\b(?:naam|nam|name)\s+([A-Za-z]+)\s+(?:hai|h\b|ha\b|he\b)",
        # Urdu script: "میرا نام <NAME>" — capture only ONE token (stops at whitespace/۔/،)
        # Previously captured 2 tokens, often sweeping in "ہے" as part of the name.
        r"میرا\s+نام\s+([^\s،۔\.,؟?]+)",
    ]
    for pattern in name_patterns:
        for match in re.finditer(pattern, search_text, re.IGNORECASE):
            if not match.lastindex:
                continue
            candidate = (match.group(1) or "").strip()
            tokens = candidate.split()
            # Pop fillers from edges
            while tokens and tokens[0].lower() in _name_filler:
                tokens.pop(0)
            while tokens and tokens[-1].lower() in _name_filler:
                tokens.pop()
            # Reject if any interior token is filler (means capture spanned phrase boundary)
            if any(t.lower() in _name_filler for t in tokens):
                continue
            cleaned = " ".join(tokens)
            if 2 <= len(cleaned) <= 40 and tokens:
                extracted_name = cleaned.title() if cleaned.isascii() else cleaned
                break
        if extracted_name:
            break

    # Extract station/area name.
    # Strategy: capture ONLY the 1-4 words immediately before "station"/"thane"/"enforcement".
    # The old logic greedily captured everything before "station se" (including the officer's
    # name/greeting) and then tried to delete stop words — but "main" (Urdu for "I") precedes
    # the station name, so `\bmain\b.*$` was deleting the real station. Rewritten to be
    # anchor-based: match "<STATION_NAME_WORDS> (enforcement )?station se" and capture only
    # the immediately-preceding word tokens.
    extracted_station = None
    # Fallback is restricted to 1-2 words to avoid scooping up "ahmed hai" etc.;
    # the primary "main"-anchored patterns allow up to 3 words for multi-word station names.
    station_patterns = [
        # "main <STATION> (enforcement )?(station|thane) se aaya" — primary, "main" anchor
        r"\b(?:mein|main)\s+((?:[A-Za-z]+\s+){0,2}?[A-Za-z]+)\s+(?:enforcement\s+)?(?:stations?|thanas?|thanes?)\s+(?:se|say|sy|sey)\s+(?:aaya|aya|aye)",
        # "main <STATION> area se"
        r"\b(?:mein|main)\s+((?:[A-Za-z]+\s+){0,2}?[A-Za-z]+)\s+area\s+(?:se|say|sy|sey)",
        # Fallback: "<STATION> (enforcement )?(station|thane) se" — only 1-2 words captured
        r"\b([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(?:enforcement\s+)?(?:stations?|thanas?|thanes?)\s+(?:se|say|sy|sey)",
    ]
    # Words that are NEVER a station name — at the edge, pop them; inside, REJECT capture.
    _filler_words = {
        "mera", "meri", "mere", "naam", "nam", "name", "hai", "hain", "hun", "hoon", "hon",
        "main", "mein", "mei", "aur", "or", "ki", "ka", "se", "say", "sy",
        "wa", "walaikum", "assalam", "alaikum", "salam", "my", "is", "i", "am",
        "ji", "the", "a", "an", "and", "enforcement",
    }
    for pattern in station_patterns:
        for match in re.finditer(pattern, search_text, re.IGNORECASE):
            if not match.lastindex:
                continue
            candidate = match.group(1).strip()
            tokens = candidate.split()
            while tokens and tokens[0].lower() in _filler_words:
                tokens.pop(0)
            while tokens and tokens[-1].lower() in _filler_words:
                tokens.pop()
            # If any interior token is a filler word, the capture spanned across a phrase
            # boundary (e.g. "ahmed hai model town") — reject and try the next match/pattern.
            if any(t.lower() in _filler_words for t in tokens):
                continue
            candidate = " ".join(tokens)
            if 2 <= len(candidate) <= 50 and tokens:
                extracted_station = candidate.title()
                break
        if extracted_station:
            break

    # Try to match extracted name with enrolled officers
    matched_officer_id = None
    matched_officer_name = None
    if extracted_name:
        for oid, odata in OFFICERS.items():
            officer_name = odata.get("name", "").lower()
            extracted_lower = extracted_name.lower()
            # Check if names match (full or partial — first name or last name)
            name_parts = officer_name.split()
            extracted_parts = extracted_lower.split()
            if (extracted_lower in officer_name or officer_name in extracted_lower or
                any(p in extracted_parts for p in name_parts if len(p) > 2)):
                matched_officer_id = oid
                matched_officer_name = odata.get("name")
                break

    # Calculate greeting score
    score_parts = {
        "salam": 25 if salam_found else 0,
        "name": 30 if name_introduced and extracted_name else (15 if name_introduced else 0),
        "station": 25 if station_mentioned else 0,
        "role": 20 if role_mentioned else 0,
    }
    greeting_score = sum(score_parts.values())

    # Determine compliance level
    if greeting_score >= 75:
        greeting_compliance = "FULL"
    elif greeting_score >= 40:
        greeting_compliance = "PARTIAL"
    else:
        greeting_compliance = "MISSING"

    greeting_detected = greeting_score >= 40

    # Build suggestions for missing components
    suggestions = []
    if not salam_found:
        suggestions.append("Start with 'Assalam Alaikum' greeting")
    if not name_introduced:
        suggestions.append("Introduce yourself: 'Mera naam [Your Name] hai'")
    elif not extracted_name:
        suggestions.append("Name was mentioned but could not be clearly detected — speak slowly")
    if not station_mentioned:
        suggestions.append("Mention your station: '[Station Name] enforcement station se aaya hoon'")
    if not role_mentioned:
        suggestions.append("Mention your role: 'Enforcement Officer' or 'Traffic Warden'")

    # Extract the greeting portion of transcript (first ~50 words or first sentence)
    greeting_text = ""
    if greeting_detected:
        words = transcript.split()
        greeting_text = " ".join(words[:min(50, len(words))])
        # Try to cut at first violation-like content
        for sep in [".", "!", "?", "۔"]:
            if sep in greeting_text:
                greeting_text = greeting_text[:greeting_text.index(sep) + 1]
                break

    print(f"  [greeting] score={greeting_score} compliance={greeting_compliance} "
          f"salam={salam_found} name={extracted_name} station={extracted_station} "
          f"officer_match={matched_officer_id}", flush=True)

    return {
        "greeting_detected": greeting_detected,
        "salam_found": salam_found,
        "name_introduced": name_introduced,
        "station_mentioned": station_mentioned,
        "role_mentioned": role_mentioned,
        "extracted_name": extracted_name,
        "extracted_station": extracted_station,
        "matched_officer_id": matched_officer_id,
        "matched_officer_name": matched_officer_name,
        "greeting_text": greeting_text,
        "greeting_score": greeting_score,
        "greeting_compliance": greeting_compliance,
        "greeting_score_breakdown": score_parts,
        "suggestions": suggestions,
    }


# ═══════════════════════════════════════════════════════════════
#  KEYWORD DETECTION — scans transcript for violation words
# ═══════════════════════════════════════════════════════════════
def detect_keywords(transcript):
    """Detect violation keywords from transcribed text.
    Uses multiple text representations for maximum matching:
    1. Original transcript (Urdu script / English / Punjabi)
    2. Urdu → Roman transliteration
    3. Punjabi → Roman transliteration
    4. Normalized spelling variants
    Returns score and list of violations with severity."""
    if not transcript:
        return 0, []

    text = transcript.lower().strip()

    # Build search representations (Urdu, English, Punjabi — NO Hindi)
    text_normalized = normalize_urdu_text(text)
    text_roman_ur = transliterate_urdu_to_roman(text)
    text_roman_pa = transliterate_punjabi_to_roman(text)
    text_spell_fix = normalize_roman_spelling(text_roman_ur)
    text_spell_fix2 = normalize_roman_spelling(text)
    text_spell_fix3 = normalize_roman_spelling(text_roman_pa)

    # Combine all representations for searching
    search_text = " | ".join([
        text, text_normalized,
        text_roman_ur, text_roman_pa,
        text_spell_fix, text_spell_fix2, text_spell_fix3
    ])

    print(f"  [keyword-search] search text: {search_text[:400]}", flush=True)

    score = 0
    viols = []

    for vtype, cfg in VK.items():
        hits = set()
        for word in cfg["words"]:
            w_lower = word.lower().strip()
            if not w_lower:
                continue

            # Normalize the keyword (Urdu + Punjabi only)
            w_normalized = normalize_urdu_text(w_lower)
            w_roman = transliterate_urdu_to_roman(w_lower)
            w_roman_pa = transliterate_punjabi_to_roman(w_lower)
            w_spell = normalize_roman_spelling(w_roman)

            # Check if any variant of the keyword matches in any variant of the text
            variants_to_check = {w_lower, w_normalized, w_roman, w_roman_pa, w_spell}
            for variant in variants_to_check:
                if variant and variant in search_text:
                    # Use Roman version for display
                    if all(ord(c) < 256 for c in word):
                        hits.add(word)
                    else:
                        roman = transliterate_urdu_to_roman(word)
                        if roman != word:
                            hits.add(roman)
                        else:
                            hits.add(word)
                    break  # Found a match, no need to check other variants

        if hits:
            unique_hits = sorted(hits)
            pts = cfg["score"]
            score += pts
            viols.append({
                "type":           vtype,
                "severity":       cfg["severity"],
                "score":          pts,
                "label":          cfg.get("label", vtype),
                "description":    cfg.get("description", ""),
                "detail":         f"Spoken words detected: {', '.join(unique_hits)}",
                "keywords_found": unique_hits,
                "source":         "voice_transcription",
            })

    return min(score, 100), viols


# ═══════════════════════════════════════════════════════════════
#  TONE ANALYSIS — acoustic features (energy, pitch, agitation)
# ═══════════════════════════════════════════════════════════════
def analyze_tone(eo_audio, sr):
    """Acoustic-based tone analysis using RAW audio energy (no normalization).

    The key insight: we must NOT normalize volume before measuring energy,
    because normalization makes whispers and shouts look identical.
    We use raw RMS for loudness, but normalized audio for pitch extraction only.
    """
    tone_proba = {"NORMAL": 1.0, "HARSH": 0.0, "ANGRY": 0.0, "BRIBE_TONE": 0.0}
    acoustics  = {
        "avg_energy": 0.0, "avg_pitch_hz": 0.0,
        "zcr": 0.0, "pitch_variance": 0.0,
        "loud_duration_sec": 0.0, "agitation": 0.0,
        "enrolled_pitch_hz": ENROLLED_PITCH, "pitch_ratio": 0.0,
    }
    tone_score = 0
    tone_viols = []

    if len(eo_audio) < sr * 0.3:
        return "NORMAL", tone_proba, acoustics, 0, [], {"NORMAL": 100, "HARSH": 0, "ANGRY": 0, "BRIBE_TONE": 0}

    # ── RAW energy (DO NOT normalize — this measures actual loudness) ──
    raw_rms = float(np.sqrt(np.mean(eo_audio ** 2)))
    raw_rms_frames = librosa.feature.rms(y=eo_audio)[0]
    zcr_val = float(np.mean(librosa.feature.zero_crossing_rate(y=eo_audio)))

    # ── Normalized audio ONLY for pitch extraction (pitch needs clean signal) ──
    peak = np.max(np.abs(eo_audio))
    norm_audio = eo_audio / peak * 0.9 if peak > 0.01 else eo_audio

    try:
        f0, vf, _ = librosa.pyin(norm_audio, sr=sr, fmin=65, fmax=500)
        fv        = f0[vf] if vf is not None else np.array([])
        avg_pitch = float(np.mean(fv)) if len(fv) > 0 else 0.0
        pitch_var = float(np.std(fv))  if len(fv) > 0 else 0.0
    except:
        avg_pitch, pitch_var = 0.0, 0.0

    mfcc_delta = librosa.feature.delta(librosa.feature.mfcc(y=norm_audio, sr=sr, n_mfcc=13))
    agitation  = float(np.mean(np.abs(mfcc_delta)))

    # ── Dynamic loudness analysis (compares loud vs quiet parts within clip) ──
    rms_sorted = np.sort(raw_rms_frames)
    n_frames = len(rms_sorted)
    if n_frames > 10:
        quiet_avg = float(np.mean(rms_sorted[:n_frames//4]))
        loud_avg  = float(np.mean(rms_sorted[-n_frames//4:]))
        loudness_ratio = loud_avg / (quiet_avg + 1e-6)
        # Percentile-based loudness (more robust than mean)
        p90_energy = float(np.percentile(raw_rms_frames, 90))
        p50_energy = float(np.percentile(raw_rms_frames, 50))
    else:
        loudness_ratio = 1.0
        p90_energy = raw_rms
        p50_energy = raw_rms

    # Count frames above different thresholds
    loud_frames     = np.sum(raw_rms_frames > 0.08)
    shouting_frames = np.sum(raw_rms_frames > 0.15)
    loud_duration   = float(loud_frames * 512 / sr)
    shout_duration  = float(shouting_frames * 512 / sr)
    ratio           = avg_pitch / ENROLLED_PITCH if ENROLLED_PITCH > 0 else 0

    # Spectral features for harsh vs soft detection
    spectral_centroid = float(np.mean(librosa.feature.spectral_centroid(y=eo_audio, sr=sr)))
    spectral_rolloff  = float(np.mean(librosa.feature.spectral_rolloff(y=eo_audio, sr=sr)))

    print(f"  Tone: raw_rms={raw_rms:.4f} p90={p90_energy:.4f} p50={p50_energy:.4f} "
          f"pitch={avg_pitch:.0f}Hz ratio={ratio:.2f} pitch_var={pitch_var:.1f} "
          f"agitation={agitation:.3f} loudness_ratio={loudness_ratio:.1f} "
          f"loud_dur={loud_duration:.1f}s shout_dur={shout_duration:.1f}s "
          f"centroid={spectral_centroid:.0f} zcr={zcr_val:.4f}", flush=True)

    acoustics = {
        "avg_energy":        round(raw_rms, 4),
        "avg_pitch_hz":      round(avg_pitch, 1),
        "zcr":               round(zcr_val, 4),
        "pitch_variance":    round(pitch_var, 1),
        "loud_duration_sec": round(loud_duration, 1),
        "agitation":         round(agitation, 4),
        "enrolled_pitch_hz": round(ENROLLED_PITCH, 1),
        "pitch_ratio":       round(ratio, 2),
    }

    def flag(t, s, pts, d):
        tone_viols.append({
            "type": t, "severity": s, "score": pts,
            "detail": d, "source": "acoustic_analysis",
        })
        return pts

    # ═══════════════════════════════════════════════════════════
    #  SCORING — calibrated for real phone/bodycam audio (not studio).
    #  Thresholds raised so normal conversational speech (raw_rms ≈ 0.08-
    #  0.15, agitation 1.5-3.0, pitch_var 30-60) doesn't accumulate 40+
    #  points before any actual shouting / threats / keywords appear.
    #  When Gemini runs, its risk_score still overrides this entirely
    #  (see "Gemini-authoritative scoring" below) — these heuristics are
    #  only the fallback when Gemini is unreachable.
    # ═══════════════════════════════════════════════════════════

    # 1. Overall loudness (raw RMS — louder voice = higher score)
    if raw_rms > 0.30:
        tone_score += flag("SHOUTING", "CRITICAL", 20,
            f"Shouting detected — very loud voice (energy {raw_rms:.3f})")
    elif raw_rms > 0.20:
        tone_score += flag("LOUD_VOICE", "HIGH", 10,
            f"Loud/raised voice detected (energy {raw_rms:.3f})")
    elif raw_rms > 0.13:
        tone_score += flag("ELEVATED_VOICE", "MEDIUM", 3,
            f"Slightly raised voice (energy {raw_rms:.3f})")

    # 2. Peak loudness (p90 — catches bursts of shouting even in otherwise calm audio)
    if p90_energy > 0.35:
        tone_score += flag("BURST_SHOUTING", "HIGH", 8,
            f"Bursts of shouting detected (peak energy {p90_energy:.3f})")

    # 3. Pitch analysis
    if ratio > 1.8 and avg_pitch > 0:
        tone_score += flag("EXTREME_PITCH", "HIGH", 10,
            f"Extreme high pitch {avg_pitch:.0f}Hz — {ratio:.1f}x above baseline {ENROLLED_PITCH:.0f}Hz")
    elif ratio > 1.5 and avg_pitch > 0:
        tone_score += flag("HIGH_PITCH", "MEDIUM", 5,
            f"Raised pitch {avg_pitch:.0f}Hz — {ratio:.1f}x above baseline {ENROLLED_PITCH:.0f}Hz")

    # 4. Pitch instability (angry/emotional speech has high variance)
    if pitch_var > 80:
        tone_score += flag("PITCH_UNSTABLE", "HIGH", 5,
            f"Very unstable pitch (variance {pitch_var:.0f}Hz) — angry/emotional speech")
    elif pitch_var > 60:
        tone_score += flag("PITCH_UNSTABLE", "MEDIUM", 2,
            f"Unstable pitch (variance {pitch_var:.0f}Hz)")

    # 5. Sustained loud speech (duration matters)
    if shout_duration > 8.0:
        tone_score += flag("PROLONGED_SHOUTING", "CRITICAL", 12,
            f"Sustained shouting for {shout_duration:.1f}s")
    elif loud_duration > 5.0:
        tone_score += flag("PROLONGED_LOUD", "HIGH", 5,
            f"Sustained loud speech for {loud_duration:.1f}s")

    # 6. Agitation (rapid MFCC changes = emotional/aggressive speech)
    if agitation > 4.0:
        tone_score += flag("HIGH_AGITATION", "HIGH", 6,
            f"Highly agitated speech (index {agitation:.2f})")
    elif agitation > 3.0:
        tone_score += flag("AGITATED_SPEECH", "MEDIUM", 2,
            f"Agitated speech (index {agitation:.2f})")

    # 7. Dynamic range (voice raised vs calm parts within same clip)
    if loudness_ratio > 8.0:
        tone_score += flag("VOICE_EXPLOSION", "HIGH", 6,
            f"Voice raised {loudness_ratio:.0f}x louder than calm parts — sudden anger")
    elif loudness_ratio > 5.0:
        tone_score += flag("VOICE_RAISED", "MEDIUM", 3,
            f"Voice raised {loudness_ratio:.0f}x louder than calm parts")

    # 8. Harsh spectral quality (high spectral centroid = harsh/aggressive tone)
    if spectral_centroid > 3000 and raw_rms > 0.13:
        tone_score += flag("HARSH_TONE", "MEDIUM", 3,
            f"Harsh vocal quality detected (spectral centroid {spectral_centroid:.0f}Hz)")

    # ═══════════════════════════════════════════════════════════
    #  TONE LABEL — weighted combination of all signals
    # ═══════════════════════════════════════════════════════════
    anger_score = 0.0
    harsh_score = 0.0
    bribe_score = 0.0

    # Anger signals
    if raw_rms > 0.15: anger_score += 0.30
    elif raw_rms > 0.08: anger_score += 0.15
    if ratio > 1.6 and avg_pitch > 0: anger_score += 0.20
    elif ratio > 1.3 and avg_pitch > 0: anger_score += 0.10
    if pitch_var > 50: anger_score += 0.15
    if shout_duration > 3.0: anger_score += 0.20
    elif loud_duration > 2.0: anger_score += 0.10
    if agitation > 2.5: anger_score += 0.15
    elif agitation > 1.5: anger_score += 0.08
    if loudness_ratio > 6.0: anger_score += 0.15

    # Harsh signals (moderate aggression)
    if raw_rms > 0.04: harsh_score += 0.15
    if ratio > 1.2 and avg_pitch > 0: harsh_score += 0.15
    if pitch_var > 20: harsh_score += 0.10
    if loud_duration > 1.0: harsh_score += 0.10
    if agitation > 1.0: harsh_score += 0.10
    if spectral_centroid > 2000: harsh_score += 0.10
    if loudness_ratio > 2.5: harsh_score += 0.10

    # Bribe signals (quiet, low, conspiratorial)
    if raw_rms < 0.025: bribe_score += 0.25
    if ratio < 0.85 and avg_pitch > 0: bribe_score += 0.20
    if pitch_var < 15 and avg_pitch > 0: bribe_score += 0.15
    if agitation < 0.5: bribe_score += 0.15
    if loudness_ratio < 1.5: bribe_score += 0.10

    # Determine label from scores
    if anger_score >= 0.45:
        tone_label = "ANGRY"
        n = round(max(0.02, 1.0 - anger_score - harsh_score * 0.3), 3)
        tone_proba = {"NORMAL": n, "HARSH": round(harsh_score * 0.5, 3),
                      "ANGRY": round(min(0.95, anger_score), 3), "BRIBE_TONE": 0.02}
    elif harsh_score >= 0.35:
        tone_label = "HARSH"
        n = round(max(0.05, 1.0 - harsh_score - anger_score * 0.3), 3)
        tone_proba = {"NORMAL": n, "HARSH": round(min(0.90, harsh_score), 3),
                      "ANGRY": round(anger_score * 0.5, 3), "BRIBE_TONE": 0.03}
    elif bribe_score >= 0.40:
        tone_label = "BRIBE_TONE"
        tone_proba = {"NORMAL": round(max(0.10, 1.0 - bribe_score), 3), "HARSH": 0.03,
                      "ANGRY": 0.02, "BRIBE_TONE": round(min(0.85, bribe_score), 3)}
    else:
        tone_label = "NORMAL"
        # Even NORMAL gets proportional probabilities
        total_bad = anger_score + harsh_score + bribe_score
        n = round(max(0.50, min(0.98, 1.0 - total_bad * 0.6)), 3)
        tone_proba = {"NORMAL": n,
                      "HARSH": round(harsh_score * 0.4, 3),
                      "ANGRY": round(anger_score * 0.3, 3),
                      "BRIBE_TONE": round(bribe_score * 0.3, 3)}

    # Normalize so the four probabilities always sum to exactly 100% using the
    # largest-remainder (Hamilton) method — this guarantees integer percents
    # summing to exactly 100 even after rounding.
    _total = sum(max(0.0, float(v)) for v in tone_proba.values())
    if _total > 0:
        norm = {k: max(0.0, float(v)) / _total for k, v in tone_proba.items()}
        exact = {k: norm[k] * 100.0 for k in norm}
        floors = {k: int(exact[k]) for k in exact}
        remainder = 100 - sum(floors.values())
        # Distribute the remaining 1% units to the classes with the largest fractional parts
        fracs = sorted(exact.items(), key=lambda kv: (exact[kv[0]] - floors[kv[0]]), reverse=True)
        int_percents = dict(floors)
        for i in range(remainder):
            int_percents[fracs[i % len(fracs)][0]] += 1
        # Write back both: float probabilities (normalized) and integer percents (sum to 100)
        tone_proba = {k: round(int_percents[k] / 100.0, 4) for k in int_percents}
        tone_percents = int_percents
    else:
        tone_percents = {k: 0 for k in tone_proba}
        tone_percents["NORMAL"] = 100

    print(f"  Tone result: label={tone_label} score={tone_score} "
          f"anger={anger_score:.2f} harsh={harsh_score:.2f} bribe={bribe_score:.2f} "
          f"percents={tone_percents} sum={sum(tone_percents.values())}", flush=True)

    return tone_label, tone_proba, acoustics, min(tone_score, 50), tone_viols, tone_percents


# ═══════════════════════════════════════════════════════════════
#  BEHAVIOR ASSESSMENT — overall EO behavior rating
# ═══════════════════════════════════════════════════════════════
def assess_behavior(total_score, severity, tone_label, violations, transcript):
    """Generate a detailed behavior assessment for the EO."""
    assessment = {
        "overall_rating": "PROFESSIONAL",
        "behavior_flags": [],
        "recommendation": "",
        "violation_summary": {},
    }

    # Count violations by category
    cat_counts = {}
    for v in violations:
        cat = v["type"]
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
    assessment["violation_summary"] = cat_counts

    flags = []

    if severity == "CRITICAL":
        assessment["overall_rating"] = "SEVERE_MISCONDUCT"
        flags.append("Immediate disciplinary action recommended")
        flags.append("Recording flagged for supervisory review")

        if any(v["type"] == "RISHWAT" for v in violations):
            flags.append("BRIBERY DETECTED — Anti-corruption unit notification required")
        if any(v["type"] == "DHAMKI" for v in violations):
            flags.append("THREATS DETECTED — Internal affairs review required")
        if any(v["type"] == "POWER_ABUSE" for v in violations):
            flags.append("POWER ABUSE DETECTED — Authority misuse investigation required")

        assessment["recommendation"] = "SUSPEND pending investigation. Forward to Internal Affairs."

    elif severity == "WARNING":
        assessment["overall_rating"] = "UNPROFESSIONAL"
        flags.append("Behavior falls below acceptable standards")

        if tone_label in ("ANGRY", "HARSH"):
            flags.append(f"Tone classified as {tone_label} — de-escalation training recommended")
        if any(v["type"] == "GALI" for v in violations):
            flags.append("Abusive language used — verbal conduct warning required")
        if any(v["type"] == "RUDE_BEHAVIOR" for v in violations):
            flags.append("Rude behavior detected — customer service retraining needed")
        if any(v["type"] == "INTIMIDATION" for v in violations):
            flags.append("Intimidation tactics used — written warning required")

        assessment["recommendation"] = "Issue formal WARNING. Schedule conduct retraining."

    else:
        assessment["overall_rating"] = "PROFESSIONAL"
        flags.append("No significant violations detected")
        flags.append("Behavior within acceptable standards")
        assessment["recommendation"] = "No action required. Continue monitoring."

    assessment["behavior_flags"] = flags
    return assessment


# ═══════════════════════════════════════════════════════════════
#  MAIN ANALYSIS PIPELINE
# ═══════════════════════════════════════════════════════════════
def run_analysis(audio, sr, officer_id="EO_001", source="upload", filename=""):
    t0           = time.time()
    speech_segs  = run_vad(audio, sr)
    total_dur    = len(audio) / sr
    speech_ratio = sum(s["end"] - s["start"] for s in speech_segs) / (total_dur + 1e-9)

    eo_audio, avg_sim, max_sim = identify_eo_audio(audio, sr, speech_segs)
    eo_detected = len(eo_audio) >= sr * CONFIG["min_eo_audio_sec"]
    eo_duration = len(eo_audio) / sr if len(eo_audio) > 0 else 0.0

    # Speaker diarization — Person 1 (EO) vs Person 2 (Customer) timestamps for UI.
    # Additive only: does NOT affect transcription, tone, keyword, or scoring logic.
    try:
        diarization = diarize_speakers(audio, sr, speech_segs)
    except Exception as _diar_err:
        print(f"  [diarize] error: {_diar_err}", flush=True)
        diarization = {"segments": [], "eo_total_sec": 0.0, "customer_total_sec": 0.0,
                       "speaker_count": 1, "eo_segments_count": 0, "customer_segments_count": 0}

    analyze_audio = eo_audio if eo_detected and len(eo_audio) > sr * 0.3 else audio

    # ─── Pre-submit Gemini full_analysis in parallel ──────────────────
    # The structured Gemini analysis only needs the audio file — the
    # transcript / tone_label / violations passed to it are HINTS, not
    # required input. Submitting it now lets it run alongside the rest of
    # the pipeline (transcription, tone classifier, keyword scan, greeting
    # detection, diarization scoring) so wall-clock time becomes
    # max(gemini_full_time, local_pipeline_time) instead of their sum.
    # On a typical 2-min clip this saves ~30-50 seconds.
    import soundfile as _sf_pre
    from concurrent.futures import ThreadPoolExecutor as _TPEpre
    gemini_full_future = None
    gemini_full_tmp    = None
    gemini_full_executor = None
    try:
        if _gemini_key():
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as _gf:
                _sf_pre.write(_gf.name, analyze_audio[:sr * 300].astype(np.float32), sr)
                gemini_full_tmp = _gf.name
            gemini_full_executor = _TPEpre(max_workers=1)
            # Empty hints — Gemini analyzes the audio directly. The prompt
            # is self-contained for the audio-only pathway.
            gemini_full_future = gemini_full_executor.submit(
                _gemini_full_analysis,
                gemini_full_tmp, "", "", [], {}, "ur", None,
            )
            print(f"  [gemini-full] kicked off in parallel ({len(analyze_audio)/sr:.1f}s of audio)", flush=True)
    except Exception as _pre_e:
        print(f"  [gemini-full] pre-submit failed: {_pre_e}", flush=True)
        gemini_full_future = None

    print(f"  Transcribing ({len(analyze_audio)/sr:.1f}s)...", flush=True)
    transcript, transcription_method, transcript_urdu_only, transcript_english_only = auto_transcribe(analyze_audio, sr)

    tone_label, tone_proba, acoustics, tone_score, tone_viols, tone_percents = analyze_tone(analyze_audio, sr)
    kw_score, kw_viols = detect_keywords(transcript)

    # EO Greeting Detection — identify officer from spoken introduction
    greeting_info = detect_eo_greeting(transcript)

    # If greeting matched an enrolled officer, update officer identification
    if greeting_info["matched_officer_id"] and greeting_info["matched_officer_id"] in OFFICERS:
        greeting_officer_id = greeting_info["matched_officer_id"]
        # If voiceprint also detected EO, double-confirmed
        if eo_detected:
            greeting_info["voice_match"] = True
            greeting_info["identification_method"] = "greeting + voiceprint (double confirmed)"
        else:
            greeting_info["voice_match"] = False
            greeting_info["identification_method"] = "greeting only (voiceprint not matched)"
    elif eo_detected:
        greeting_info["voice_match"] = True
        greeting_info["identification_method"] = "voiceprint only (no greeting detected)"
    else:
        greeting_info["voice_match"] = False
        greeting_info["identification_method"] = "unidentified"

    # Add greeting compliance as a violation if MISSING
    if greeting_info["greeting_compliance"] == "MISSING":
        kw_viols.append({
            "type":           "UNPROFESSIONAL",
            "severity":       "MEDIUM",
            "score":          10,
            "label":          "No Greeting / Self-Introduction",
            "description":    "Officer did not introduce themselves before the interaction",
            "detail":         "EO Protocol: Officers must greet citizens and introduce themselves with name and station",
            "keywords_found": [],
            "source":         "greeting_detection",
        })
        kw_score = min(kw_score + 10, 100)

    all_viols   = tone_viols + kw_viols
    total_score = min(tone_score + kw_score, 100)
    severity    = (
        "CRITICAL" if total_score >= CONFIG["critical_score"] else
        "WARNING"  if total_score >= CONFIG["warning_score"]  else
        "NORMAL"
    )

    # Number violations by severity rank (CRITICAL 1..N, WARNING 1..N, NORMAL 1..N)
    # and attach impact_percent = this violation's share of the total uncapped score.
    # This guarantees bars always sum to exactly 100 %, matching the displayed total.
    _rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    all_viols.sort(key=lambda v: (_rank.get((v.get("severity") or "LOW").upper(), 99), -int(v.get("score", 0) or 0)))
    _raw_total = sum(int(v.get("score", 0) or 0) for v in all_viols)
    _sev_counters = {}
    _running_pct = 0.0
    for i, v in enumerate(all_viols):
        sev = (v.get("severity") or "LOW").upper()
        _sev_counters[sev] = _sev_counters.get(sev, 0) + 1
        v["severity_index"] = _sev_counters[sev]
        v["severity_label"] = f"{sev} {_sev_counters[sev]}"
        try:
            raw = int(v.get("score", 0) or 0)
            if _raw_total > 0:
                # Last violation gets whatever rounds to 100 - running total,
                # so the final sum is exactly 100.0 (no rounding drift).
                if i == len(all_viols) - 1:
                    pct = round(100.0 - _running_pct, 1)
                else:
                    pct = round((raw / _raw_total) * 100.0, 1)
                    _running_pct += pct
                v["impact_percent"] = pct
            else:
                v["impact_percent"] = 0.0
        except Exception:
            v["impact_percent"] = 0.0
    critical_count = _sev_counters.get("CRITICAL", 0)
    high_count     = _sev_counters.get("HIGH", 0)
    medium_count   = _sev_counters.get("MEDIUM", 0)
    low_count      = _sev_counters.get("LOW", 0)

    # Behavior assessment
    behavior = assess_behavior(total_score, severity, tone_label, all_viols, transcript)

    # Wait for the parallel Gemini full_analysis we kicked off earlier.
    # Usually completes BEFORE we reach this point (the local pipeline runs
    # while it's in flight) — so the .result() call returns immediately.
    # Worst case: we wait up to 180s for a slow Gemini response.
    gemini_analysis = {}
    if gemini_full_future is not None:
        try:
            _gem_t0 = time.time()
            gemini_analysis = gemini_full_future.result(timeout=180) or {}
            _gem_dt = time.time() - _gem_t0
            print(f"  [gemini-full] returned after additional {_gem_dt:.1f}s wait "
                  f"(0s = ran fully in parallel)", flush=True)
        except Exception as _e:
            print(f"  [gemini-full] parallel result error: {_e}", flush=True)
            gemini_analysis = {}
        finally:
            if gemini_full_executor is not None:
                try: gemini_full_executor.shutdown(wait=False)
                except Exception: pass
            if gemini_full_tmp:
                try: os.unlink(gemini_full_tmp)
                except Exception: pass

    # Prefer the summary that came back with the structured analysis.
    ai_assessment = ""
    if gemini_analysis:
        oa = gemini_analysis.get("overall_assessment", {}) or {}
        if oa.get("summary"):
            ai_assessment = oa["summary"]

    # Only burn a second Gemini round-trip if we still have no narrative.
    if not ai_assessment:
        ai_assessment = _gemini_assess_behavior(
            transcript, tone_label, all_viols, acoustics, greeting_info)

    # ── Gemini-authoritative scoring ───────────────────────────────────
    # The acoustic heuristics over-fire on phone/bodycam audio (every clip
    # over 0.08 RMS gets LOUD_VOICE; >1.5s of speech gets PROLONGED_LOUD;
    # agitation > 1.5 fires on natural speech), pushing normal recordings
    # into CRITICAL with an inflated 70-90 score. Gemini hears the actual
    # words and tone and returns its own risk_score (0-100) plus a
    # classification — when both are present, trust them as the final
    # severity over the heuristic-only computation. The heuristic
    # tone_score / kw_score / violation list is preserved untouched for
    # the dashboard panels; only total_score and severity are re-derived.
    heuristic_total_score = total_score
    heuristic_severity    = severity
    heuristic_tone_label  = tone_label
    score_source          = "heuristic"
    gemini_keywords       = []
    if gemini_analysis:
        oa = gemini_analysis.get("overall_assessment", {}) or {}
        g_risk     = oa.get("risk_score")
        g_class    = (oa.get("classification") or "").strip().lower()
        g_severity = (oa.get("severity") or "").strip().upper()
        g_tone     = (oa.get("tone_label") or "").strip().upper()
        g_kw       = oa.get("keywords_detected") or []

        # Trust Gemini for tone label when it gave a valid one.
        if g_tone in ("NORMAL", "HARSH", "ANGRY", "BRIBE_TONE"):
            tone_label = g_tone

        # Override the SVM acoustic-only tone bars with Gemini's word/context
        # judgment. The SVM cannot tell "firm enforcement" from "angry abuse"
        # — it only sees energy/pitch — so its 75% ANGRY on lawful sealing
        # operations is misleading on the dashboard. Gemini hears the WORDS,
        # so its tone breakdown is the one users should see.
        g_tone_pct = oa.get("tone_percents") or {}
        if isinstance(g_tone_pct, dict):
            valid_keys = ("NORMAL", "HARSH", "ANGRY", "BRIBE_TONE")
            picked = {k: float(g_tone_pct.get(k, 0) or 0) for k in valid_keys}
            total = sum(picked.values())
            if total > 0:
                # Normalise to exactly 100 in case Gemini's numbers don't sum
                # cleanly, then mirror into tone_proba (0-1 floats) which the
                # legacy dashboard panels still read.
                tone_percents = {k: int(round(v * 100.0 / total)) for k, v in picked.items()}
                drift = 100 - sum(tone_percents.values())
                if drift != 0:
                    tone_percents[tone_label if tone_label in valid_keys else "NORMAL"] += drift
                tone_proba = {k: round(tone_percents[k] / 100.0, 3) for k in valid_keys}
                print(f"  [tone-override] Gemini tone bars: {tone_percents}", flush=True)

        # Capture Gemini's detected abusive/threat/bribe phrases for the response.
        if isinstance(g_kw, list):
            gemini_keywords = [k for k in g_kw if isinstance(k, dict)]

        try:
            if isinstance(g_risk, (int, float)) and 0 <= float(g_risk) <= 100:
                total_score = int(round(float(g_risk)))
                # Use Gemini's explicit severity if present; else derive from score.
                if g_severity in ("NORMAL", "WARNING", "CRITICAL"):
                    severity = g_severity
                else:
                    severity = (
                        "CRITICAL" if total_score >= CONFIG["critical_score"] else
                        "WARNING"  if total_score >= CONFIG["warning_score"]  else
                        "NORMAL"
                    )
                score_source = "gemini_risk_score"
            elif g_severity in ("NORMAL", "WARNING", "CRITICAL"):
                # No numeric risk_score but explicit severity — anchor score to band.
                if g_severity == "NORMAL":
                    total_score = min(total_score, CONFIG["warning_score"] - 1)
                elif g_severity == "WARNING":
                    total_score = max(CONFIG["warning_score"],
                                      min(total_score, CONFIG["critical_score"] - 1))
                else:
                    total_score = max(CONFIG["critical_score"], total_score)
                severity = g_severity
                score_source = f"gemini_severity_{g_severity.lower()}"
            elif g_class:
                # Final fallback: textual classification.
                if g_class == "normal":
                    total_score = min(total_score, CONFIG["warning_score"] - 1)
                    severity = "NORMAL"
                    score_source = "gemini_class_normal"
                elif g_class in ("concerning", "unprofessional"):
                    total_score = max(CONFIG["warning_score"],
                                      min(total_score, CONFIG["critical_score"] - 1))
                    severity = "WARNING"
                    score_source = "gemini_class_warning"
                elif g_class == "critical":
                    total_score = max(CONFIG["critical_score"], total_score)
                    severity = "CRITICAL"
                    score_source = "gemini_class_critical"
        except Exception as _se:
            print(f"  [score-rebase] Gemini score parse error: {_se}", flush=True)

    if score_source != "heuristic":
        print(f"  [score-rebase] {score_source}: heuristic={heuristic_total_score}/{heuristic_severity}/{heuristic_tone_label} -> gemini={total_score}/{severity}/{tone_label} ({len(gemini_keywords)} kw)", flush=True)

        # When Gemini judged NORMAL but the heuristic created acoustic-only
        # violations (LOUD_VOICE / PROLONGED_LOUD / HIGH_PITCH / AGITATION /
        # HARSH_TONE) — those came from a firm enforcement voice, not from
        # actual misconduct. Suppress them so the dashboard's "violations"
        # list reflects WORDS, not loudness. Keyword violations from real
        # abusive language are KEPT.
        if severity == "NORMAL":
            ACOUSTIC_ONLY_TYPES = {
                "LOUD_VOICE", "PROLONGED_LOUD", "HIGH_PITCH", "EXTREME_PITCH",
                "AGITATION", "HARSH_TONE", "ELEVATED_VOICE", "SHOUTING",
            }
            before = len(all_viols)
            all_viols = [v for v in all_viols
                         if str(v.get("type", "")).upper() not in ACOUSTIC_ONLY_TYPES]
            removed = before - len(all_viols)
            if removed > 0:
                print(f"  [violations-filter] dropped {removed} acoustic-only "
                      f"violation(s) because Gemini judged NORMAL "
                      f"(words show no misconduct)", flush=True)
                # Re-number the remaining violations so severity_label is consistent.
                _sev_counters = {}
                _raw_total = sum(int(v.get("score", 0) or 0) for v in all_viols)
                _running_pct = 0.0
                for i, v in enumerate(all_viols):
                    sev = (v.get("severity") or "LOW").upper()
                    _sev_counters[sev] = _sev_counters.get(sev, 0) + 1
                    v["severity_index"] = _sev_counters[sev]
                    v["severity_label"] = f"{sev} {_sev_counters[sev]}"
                    raw = int(v.get("score", 0) or 0)
                    if _raw_total > 0:
                        if i == len(all_viols) - 1:
                            pct = round(100.0 - _running_pct, 1)
                        else:
                            pct = round((raw / _raw_total) * 100.0, 1)
                            _running_pct += pct
                        v["impact_percent"] = pct
                    else:
                        v["impact_percent"] = 0.0
                critical_count = _sev_counters.get("CRITICAL", 0)
                high_count     = _sev_counters.get("HIGH", 0)
                medium_count   = _sev_counters.get("MEDIUM", 0)
                low_count      = _sev_counters.get("LOW", 0)
    else:
        # Heuristic-only path: cap at WARNING ceiling so we never CRITICAL-flag
        # a clip we couldn't have Gemini judge. The acoustic detectors fire on
        # normal speech (loud_frame_energy=0.20 catches mic compression peaks,
        # agitation>2.0 fires on natural prosody) so >=70 here just means "we
        # had no AI judgment", not "officer was abusive".
        gemini_attempted = bool(_gemini_key())
        if gemini_attempted and total_score >= CONFIG["critical_score"]:
            capped = CONFIG["critical_score"] - 1   # 69 — top of WARNING band
            print(f"  [score-cap] Gemini did not return a usable risk_score; "
                  f"heuristic={total_score}/{severity} → capped to {capped}/WARNING. "
                  f"Check Gemini logs above for parse/timeout errors.", flush=True)
            total_score = capped
            severity = "WARNING"
        else:
            print(f"  [score-source] heuristic-only path "
                  f"(gemini_key_present={gemini_attempted}) score={total_score}/{severity}",
                  flush=True)

    print(f"  Score:{total_score} tone={tone_score} kw={kw_score} -> {severity}", flush=True)
    print(f"  Emotion:{tone_label} Violations:{len(all_viols)} Rating:{behavior['overall_rating']}", flush=True)
    _total_secs = time.time() - t0
    print(f"  ⏱  TOTAL ANALYSIS TIME: {_total_secs:.1f}s "
          f"(audio={total_dur:.1f}s, transcript={transcription_method}, "
          f"score_source={score_source})", flush=True)

    incident_id = str(uuid.uuid4())[:8].upper()
    result = {
        "incident_id":          incident_id,
        "officer_id":           officer_id,
        "officer_name":         OFFICERS.get(officer_id, {}).get("name", "Unknown"),
        "officer_badge":        OFFICERS.get(officer_id, {}).get("badge", ""),
        "officer_area":         OFFICERS.get(officer_id, {}).get("area", ""),
        "filename":             filename,
        "source":               source,
        "timestamp":            datetime.now().isoformat(),
        "total_duration_sec":   round(total_dur, 1),
        "speech_segments":      len(speech_segs),
        "speech_ratio":         round(speech_ratio, 2),
        "eo_detected":          eo_detected,
        "eo_speaking_sec":      round(eo_duration, 1),
        "avg_similarity":       round(avg_sim, 3),
        "max_similarity":       round(max_sim, 3),
        "eo_threshold":         EO_THRESHOLD,
        "transcript":           transcript,
        "transcript_urdu":      transcript_urdu_only,
        "transcript_english":   transcript_english_only,
        "transcription_method": transcription_method,
        "transcript_source":    "auto_voice_detection",
        "greeting":             greeting_info,
        "diarization":          diarization,
        "tone_label":           tone_label,
        "tone_proba":           tone_proba,
        "tone_percents":        tone_percents,
        "acoustics":            acoustics,
        "violations":           all_viols,
        "tone_score":           tone_score,
        "keyword_score":        kw_score,
        "total_score":          total_score,
        "severity":             severity,
        "score_source":         score_source,
        "heuristic_total_score": heuristic_total_score,
        "heuristic_severity":   heuristic_severity,
        "heuristic_tone_label": heuristic_tone_label,
        "gemini_keywords":      gemini_keywords,
        "behavior_assessment":  behavior,
        "ai_assessment":        ai_assessment,
        "gemini_analysis":      gemini_analysis,
        "severity_bands":       {
            "NORMAL":   {"min": 0,  "max": 29,  "label": "Normal (0–29%)"},
            "WARNING":  {"min": 30, "max": 69,  "label": "Warning (30–69%)"},
            "CRITICAL": {"min": 70, "max": 100, "label": "Critical (70–100%)"},
        },
        "severity_counts":      {
            "CRITICAL": critical_count,
            "HIGH":     high_count,
            "MEDIUM":   medium_count,
            "LOW":      low_count,
            "TOTAL":    len(all_viols),
        },
        "tone_percent":         int(round((tone_score / 100.0) * 100)),
        "keyword_percent":      int(round((kw_score / 100.0) * 100)),
        "total_percent":        int(round(total_score)),
        "alert_required":       severity != "NORMAL",
        "processing_time_sec":  round(time.time() - t0, 2),
    }

    INCIDENTS.append(result)

    if severity in ("CRITICAL", "WARNING"):
        socketio.emit("violation_alert", {
            "incident_id":        incident_id,
            "officer_id":         officer_id,
            "officer_name":       result["officer_name"],
            "severity":           severity,
            "total_score":        total_score,
            "tone_score":         tone_score,
            "keyword_score":      kw_score,
            "tone_label":         tone_label,
            "violations":         all_viols,
            "behavior_rating":    behavior["overall_rating"],
            "behavior_flags":     behavior["behavior_flags"],
            "recommendation":     behavior["recommendation"],
            "timestamp":          result["timestamp"],
            "filename":           filename,
            "keywords_found":     [kw for v in kw_viols for kw in v.get("keywords_found", [])],
        })

    return result


# ═══════════════════════════════════════════════════════════════
#  API ENDPOINTS
# ═══════════════════════════════════════════════════════════════
@app.route("/api/health")
def health():
    return jsonify({
        "status":             "healthy",
        "version":            "5.0",
        "whisper_model":      CONFIG.get("whisper_model", "small"),
        "whisper_available":  WHISPER_MODEL is not None,
        "models_loaded":      ["voiceprint_EO_001", "tone_classifier", "model_config"],
        "enrolled_pitch":     round(ENROLLED_PITCH, 1),
        "eo_threshold":       EO_THRESHOLD,
        "tone_cv_acc":        round(CONFIG.get("tone_classifier_cv_accuracy", 0) * 100, 1),
        "emotions":           list(TONE_MODEL["label_names"]) if isinstance(TONE_MODEL["label_names"], list) else list(TONE_MODEL["label_names"].values()),
        "keyword_categories": list(VK.keys()),
        "total_keywords":     sum(len(v["words"]) for v in VK.values()),
        "incidents_total":    len(INCIDENTS),
        "officers":           len(OFFICERS),
        "warning_score":      CONFIG["warning_score"],
        "critical_score":     CONFIG["critical_score"],
        "severity_levels":    CONFIG.get("severity_levels", {}),
    })


@app.route("/api/officers")
def get_officers():
    return jsonify({"officers": [{"id": k, **v} for k, v in OFFICERS.items()]})


@app.route("/api/officers/enroll", methods=["POST"])
def enroll_officer():
    officer_id = request.form.get("officer_id", "").strip()
    name       = request.form.get("name", "").strip()
    area       = request.form.get("area", "").strip()
    f          = request.files.get("audio")

    if not officer_id: return jsonify({"error": "Officer ID is required"}), 400
    if not name:       return jsonify({"error": "Full name is required"}), 400
    if not f:          return jsonify({"error": "Audio file is required"}), 400

    suffix = os.path.splitext(f.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        f.save(tmp.name)
        path = tmp.name

    try:
        audio, sr_ = librosa.load(path, sr=SR)
        if len(audio) < sr_ * 3:
            return jsonify({"error": "Audio too short — minimum 3 seconds"}), 400

        window  = sr_ * 2
        vectors = []
        for s in range(0, len(audio) - window, window // 2):
            vectors.append(extract_features(audio[s:s + window], sr_))
        if not vectors:
            vectors = [extract_features(audio, sr_)]

        vp = np.mean(vectors, axis=0)

        try:
            f0, vf, _ = librosa.pyin(audio, sr=sr_, fmin=65, fmax=2093)
            fv    = f0[vf] if vf is not None else np.array([])
            pitch = float(np.mean(fv)) if len(fv) > 0 else 0.0
        except:
            pitch = 0.0

        enrollment_data = {
            "officer_id": officer_id,
            "threshold":  0.82,
            "voiceprint": {
                "vector":              vp.tolist(),
                "vector_std":          np.std(vectors, axis=0).tolist(),
                "f0_mean":             pitch,
                "rms":                 float(np.sqrt(np.mean(audio ** 2))),
                "zcr":                 float(np.mean(librosa.feature.zero_crossing_rate(y=audio))),
                "training_windows":    len(vectors),
                "enrollment_duration": round(len(audio) / sr_, 1),
            },
            "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }

        pkl_path = os.path.join(MODELS, f"voiceprint_{officer_id}.pkl")
        with open(pkl_path, "wb") as pf:
            pickle.dump(enrollment_data, pf)

        OFFICERS[officer_id] = {
            "name": name, "badge": officer_id,
            "area": area, "enrolled": True,
        }
        print(f"Enrolled: {name} ({officer_id}) pitch={pitch:.1f}Hz", flush=True)

        return jsonify({
            "officer_id": officer_id, "name": name,
            "badge": officer_id, "area": area,
            "enrolled": True, "pitch_hz": round(pitch, 1),
            "windows": len(vectors),
            "message": f"Officer {name} enrolled successfully",
        })

    except Exception as e:
        print(f"Enrollment error: {e}", flush=True)
        return jsonify({"error": f"Enrollment failed: {str(e)}"}), 500
    finally:
        if os.path.exists(path):
            os.unlink(path)


VIDEO_EXTS = {'.mp4', '.webm', '.mov', '.avi', '.mkv', '.3gp', '.flv', '.wmv'}
AUDIO_EXTS = {'.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma'}


def _load_media(path, filename):
    """Load audio from file. Handles both audio and video files.
    For video, extracts audio track automatically via librosa (requires ffmpeg).
    """
    ext = os.path.splitext(filename)[1].lower()
    is_video = ext in VIDEO_EXTS

    try:
        # librosa.load handles both audio + video (extracts audio track)
        audio, sr_ = librosa.load(path, sr=SR, mono=True)
        return audio, sr_, is_video
    except Exception as e:
        if is_video:
            raise Exception(
                f"Video file detected but FFmpeg is required to extract audio. "
                f"Install FFmpeg: https://ffmpeg.org/download.html OR convert video to audio first. "
                f"Original error: {str(e)[:100]}"
            )
        raise


@app.route("/api/analyze/upload", methods=["POST"])
def analyze_upload():
    officer_id = request.form.get("officer_id", "EO_001")
    f          = request.files.get("audio")
    if not f: return jsonify({"error": "No audio/video file uploaded"}), 400
    suffix = os.path.splitext(f.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        f.save(tmp.name)
        path = tmp.name
    try:
        print(f"Analyzing: {f.filename}", flush=True)
        audio, sr_, is_video = _load_media(path, f.filename)
        if is_video:
            print(f"  Video file — extracted audio track ({len(audio)/sr_:.1f}s)", flush=True)

        # For videos: start visual analysis in a background thread NOW so it runs
        # in parallel with the audio pipeline (upload + PROCESSING + generateContent
        # all overlap with transcription/tone/keyword analysis). Total wall-clock
        # time becomes max(audio_time, video_time) instead of their sum.
        video_future = None
        if is_video:
            from concurrent.futures import ThreadPoolExecutor
            _video_executor = ThreadPoolExecutor(max_workers=1)
            video_future = _video_executor.submit(_gemini_video_analysis, path)
            print(f"  [gemini-video] started in background, audio pipeline continues...", flush=True)

        result = run_analysis(audio, sr_, officer_id, source="upload", filename=f.filename)

        if isinstance(result, dict):
            result["media_type"] = "video" if is_video else "audio"
            if is_video:
                video_analysis = {}
                status = "ok"
                err_msg = ""
                try:
                    # Wait for the parallel video job — cap total wait at 6 minutes.
                    video_analysis = (video_future.result(timeout=360) if video_future else {}) or {}
                    if not video_analysis:
                        status = "empty"
                        err_msg = "Gemini returned no visual analysis — check backend logs for reason (key/quota/upload/JSON)."
                except Exception as _ve:
                    status = "error"
                    err_msg = str(_ve)[:200]
                    print(f"  [gemini-video] wrapper error: {_ve}", flush=True)
                video_analysis.setdefault("_status", status)
                if err_msg:
                    video_analysis["_status_message"] = err_msg
                result["video_analysis"] = video_analysis
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if os.path.exists(path):
            os.unlink(path)


@app.route("/api/analyze/sample", methods=["POST"])
def analyze_sample():
    data       = request.get_json() or {}
    filename   = data.get("filename", "")
    officer_id = data.get("officer_id", "EO_001")
    fpath      = os.path.join(SAMPLES, filename)
    if not os.path.exists(fpath):
        for d in [os.path.join(BASE, "challan_audio_samples"), BASE]:
            alt = os.path.join(d, filename)
            if os.path.exists(alt):
                fpath = alt
                break
    if not os.path.exists(fpath):
        return jsonify({"error": f"Not found: {filename}"}), 404
    print(f"Analyzing sample: {filename}", flush=True)
    audio, sr_ = librosa.load(fpath, sr=SR)
    return jsonify(run_analysis(audio, sr_, officer_id, source="sample", filename=filename))


@app.route("/api/samples")
def get_samples():
    if not os.path.exists(SAMPLES):
        return jsonify({"samples": []})
    files = sorted(f for f in os.listdir(SAMPLES) if f.endswith(".wav"))
    out   = []
    for fname in files:
        audio, sr_ = librosa.load(os.path.join(SAMPLES, fname), sr=SR)
        energy = float(np.sqrt(np.mean(audio ** 2)))
        exp    = "CRITICAL" if any(x in fname for x in ["harsh","threat","bribe","violation"]) else "NORMAL"
        out.append({
            "filename":          fname,
            "duration_sec":      round(len(audio) / sr_, 1),
            "energy":            round(energy, 4),
            "expected_severity": exp,
        })
    return jsonify({"samples": out})


@app.route("/api/greeting-templates")
def get_greeting_templates():
    """Return suggested greeting templates for officers."""
    templates = []
    for tmpl in EO_GREETING_TEMPLATES:
        templates.append({
            "template_urdu": tmpl,
            "template_roman": tmpl,
        })
    return jsonify({
        "templates": templates,
        "required_components": [
            {"key": "salam",   "label": "Greeting (Salam)",    "points": 25, "example": "Assalam Alaikum"},
            {"key": "name",    "label": "Officer Name",         "points": 30, "example": "Mera naam Irfan Ali hai"},
            {"key": "station", "label": "Station / Area",       "points": 25, "example": "Modal Town enforcement station se aaya hoon"},
            {"key": "role",    "label": "Role / Designation",   "points": 20, "example": "Enforcement Officer / Traffic Warden"},
        ],
        "example_full": "Assalam Alaikum, mera naam Irfan Ali hai, mein Modal Town enforcement station se aaya hoon, enforcement officer hoon",
        "compliance_levels": {
            "FULL":    {"min_score": 75, "label": "Full Compliance", "color": "#10B981"},
            "PARTIAL": {"min_score": 40, "label": "Partial Compliance", "color": "#F59E0B"},
            "MISSING": {"min_score": 0,  "label": "No Greeting", "color": "#EF4444"},
        },
    })


@app.route("/api/keywords")
def get_keywords():
    return jsonify({
        "version":        CONFIG.get("version", "5.0"),
        "detection":      "Auto from voice via faster-whisper + Google Speech",
        "keywords":       {k: {
            "score":       v["score"],
            "severity":    v["severity"],
            "label":       v.get("label", k),
            "description": v.get("description", ""),
            "words":       v["words"],
            "count":       len(v["words"]),
        } for k, v in VK.items()},
        "total_keywords": sum(len(v["words"]) for v in VK.values()),
        "categories":     len(VK),
    })


@app.route("/api/incidents")
def get_incidents():
    page  = int(request.args.get("page",  1))
    limit = int(request.args.get("limit", 20))
    sev   = request.args.get("severity",  "")
    oid   = request.args.get("officer_id","")
    items = list(reversed(INCIDENTS))
    if sev: items = [i for i in items if i["severity"]   == sev]
    if oid: items = [i for i in items if i["officer_id"] == oid]
    total = len(items)
    start = (page - 1) * limit
    return jsonify({
        "incidents": items[start:start + limit],
        "total":     total,
        "page":      page,
        "pages":     max(1, (total + limit - 1) // limit),
    })


@app.route("/api/incidents/<incident_id>")
def get_incident(incident_id):
    for inc in INCIDENTS:
        if inc["incident_id"] == incident_id:
            return jsonify(inc)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/dashboard/stats")
def dashboard_stats():
    total    = len(INCIDENTS)
    critical = sum(1 for i in INCIDENTS if i["severity"] == "CRITICAL")
    warning  = sum(1 for i in INCIDENTS if i["severity"] == "WARNING")
    normal   = sum(1 for i in INCIDENTS if i["severity"] == "NORMAL")
    avg_sc   = float(np.mean([i["total_score"] for i in INCIDENTS])) if INCIDENTS else 0
    vtype_counts = {}
    for inc in INCIDENTS:
        for v in inc.get("violations", []):
            vtype_counts[v["type"]] = vtype_counts.get(v["type"], 0) + 1

    # Behavior rating distribution
    behavior_dist = {}
    for inc in INCIDENTS:
        rating = inc.get("behavior_assessment", {}).get("overall_rating", "UNKNOWN")
        behavior_dist[rating] = behavior_dist.get(rating, 0) + 1

    return jsonify({
        "total_analyzed":       total,
        "critical":             critical,
        "warning":              warning,
        "normal":               normal,
        "avg_score":            round(avg_sc, 1),
        "violation_types":      sorted(vtype_counts.items(), key=lambda x: -x[1])[:10],
        "behavior_distribution": behavior_dist,
        "recent_incidents":     list(reversed(INCIDENTS[-10:])),
        "officers_enrolled":    sum(1 for o in OFFICERS.values() if o.get("enrolled")),
        "keyword_categories":   list(VK.keys()),
        "total_keywords":       sum(len(v["words"]) for v in VK.values()),
        "model_version":        CONFIG.get("version", "5.0"),
        "tone_cv_accuracy":     round(CONFIG.get("tone_classifier_cv_accuracy", 0) * 100, 1),
        "transcription":        "faster-whisper small" + (" + Google Speech" if True else ""),
        "severity_levels":      CONFIG.get("severity_levels", {}),
    })


@app.route("/api/livestream/chunk", methods=["POST"])
def livestream_chunk():
    officer_id  = request.form.get("officer_id",  "EO_001")
    session_id  = request.form.get("session_id",  "live_01")
    chunk_index = int(request.form.get("chunk_index", 0))
    f           = request.files.get("audio")
    if not f: return jsonify({"error": "No audio chunk"}), 400
    suffix = os.path.splitext(f.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        f.save(tmp.name)
        path = tmp.name
    try:
        audio, sr_ = librosa.load(path, sr=SR)
        result = run_analysis(audio, sr_, officer_id, source="livestream",
                              filename=f"chunk_{chunk_index:04d}")
        result["session_id"]  = session_id
        result["chunk_index"] = chunk_index
        socketio.emit("analysis_progress", {
            "session_id":  session_id,
            "chunk_index": chunk_index,
            "severity":    result["severity"],
            "total_score": result["total_score"],
            "eo_detected": result["eo_detected"],
            "violations":  len(result["violations"]),
            "behavior_rating": result.get("behavior_assessment", {}).get("overall_rating", ""),
        })
        return jsonify(result)
    finally:
        if os.path.exists(path):
            os.unlink(path)


# ═══════════════════════════════════════════════════════════════
#  WATCH-FOLDER AUTO ANALYSIS
#  Drop a video / audio file into bodycam_backend/watch/ and the
#  background worker picks it up, runs the full pipeline, and emits
#  SocketIO events so the frontend updates live.
# ═══════════════════════════════════════════════════════════════
WATCH_RESULTS = []      # list of dicts: {file_id, filename, status, ...}
WATCH_LOCK    = threading.Lock()
WATCH_QUEUE   = []      # list of full paths waiting to be processed
WATCH_SEEN    = set()   # keys = "name|size|mtime" we have already enqueued
WATCH_STATE   = {
    "running":    True,
    "last_scan":  0.0,
    "scan_every": 3.0,
    "folder":     WATCH,
    "done_folder": WATCH_DONE,
    "default_officer_id": "EO_001",
}

_MEDIA_EXTS = (
    ".mp4", ".webm", ".mov", ".avi", ".mkv", ".3gp", ".flv", ".wmv", ".m4v",
    ".wav", ".mp3", ".ogg", ".m4a", ".flac", ".aac", ".opus", ".wma",
)


def _watch_key(path):
    try:
        st = os.stat(path)
        return f"{os.path.basename(path)}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        return None


def _watch_file_id(path):
    h = hashlib.md5(_watch_key(path).encode("utf-8")).hexdigest()[:10]
    return h.upper()


def _watch_summary(item):
    """Compact card-friendly view of a watch result for /api/watch/list."""
    r = item.get("result") or {}
    viols = r.get("violations") or []
    return {
        "file_id":          item["file_id"],
        "filename":         item["filename"],
        "status":           item["status"],         # queued | analyzing | done | error
        "queued_at":        item.get("queued_at"),
        "started_at":       item.get("started_at"),
        "finished_at":      item.get("finished_at"),
        "size_bytes":       item.get("size_bytes", 0),
        "duration_sec":     r.get("total_duration_sec"),
        "officer_id":       r.get("officer_id"),
        "officer_name":     r.get("officer_name"),
        "officer_badge":    r.get("officer_badge"),
        "media_type":       r.get("media_type"),
        "severity":         r.get("severity"),
        "total_score":      r.get("total_score"),
        "tone_score":       r.get("tone_score"),
        "keyword_score":    r.get("keyword_score"),
        "tone_label":       r.get("tone_label"),
        "violations_count": len(viols),
        "top_violations":   [
            {"type": v.get("type"), "severity": v.get("severity"),
             "label": v.get("label"), "score": v.get("score")}
            for v in viols[:3]
        ],
        "behavior_rating":  (r.get("behavior_assessment") or {}).get("overall_rating"),
        "transcript_preview": (r.get("transcript") or "")[:240],
        "error":            item.get("error"),
    }


def _watch_emit(event, data):
    try:
        socketio.emit(event, data)
    except Exception:
        pass


def _watch_enqueue(path):
    """Add a new file to the queue if we haven't seen it before."""
    key = _watch_key(path)
    if not key:
        return False
    with WATCH_LOCK:
        if key in WATCH_SEEN:
            return False
        WATCH_SEEN.add(key)
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        item = {
            "file_id":    _watch_file_id(path),
            "filename":   os.path.basename(path),
            "path":       path,
            "size_bytes": size,
            "status":     "queued",
            "queued_at":  time.time(),
            "result":     None,
            "error":      None,
        }
        WATCH_RESULTS.insert(0, item)
        WATCH_QUEUE.append(path)
    print(f"[watch] queued: {os.path.basename(path)} ({size/1024/1024:.1f} MB)", flush=True)
    _watch_emit("watch_queued", _watch_summary(item))
    return True


def _watch_find_item(path):
    for it in WATCH_RESULTS:
        if it["path"] == path:
            return it
    return None


def _watch_is_stable(path, settle_sec=1.5):
    """Skip files still being copied — wait until size stops changing."""
    try:
        s1 = os.path.getsize(path)
    except OSError:
        return False
    time.sleep(settle_sec)
    try:
        s2 = os.path.getsize(path)
    except OSError:
        return False
    return s1 == s2 and s1 > 0


def _watch_scanner():
    """Poll the watch folder every WATCH_STATE['scan_every'] seconds."""
    print(f"[watch] scanner started — folder={WATCH}", flush=True)
    while WATCH_STATE["running"]:
        try:
            WATCH_STATE["last_scan"] = time.time()
            if os.path.isdir(WATCH):
                for name in sorted(os.listdir(WATCH)):
                    fp = os.path.join(WATCH, name)
                    if not os.path.isfile(fp):
                        continue
                    if not name.lower().endswith(_MEDIA_EXTS):
                        continue
                    if _watch_key(fp) in WATCH_SEEN:
                        continue
                    if not _watch_is_stable(fp):
                        continue
                    _watch_enqueue(fp)
        except Exception as e:
            print(f"[watch] scanner error: {e}", flush=True)
        time.sleep(WATCH_STATE["scan_every"])


def _watch_worker():
    """Pull from queue, run the full analysis pipeline, store result."""
    print(f"[watch] worker started", flush=True)
    while WATCH_STATE["running"]:
        path = None
        with WATCH_LOCK:
            if WATCH_QUEUE:
                path = WATCH_QUEUE.pop(0)
        if not path:
            time.sleep(0.5)
            continue
        item = _watch_find_item(path)
        if not item:
            continue

        item["status"]     = "analyzing"
        item["started_at"] = time.time()
        _watch_emit("watch_started", _watch_summary(item))
        print(f"[watch] analyzing: {item['filename']}", flush=True)

        try:
            audio, sr_, is_video = _load_media(path, item["filename"])

            # Run visual analysis in parallel with the audio pipeline (same as
            # /api/analyze/upload) so wall-clock = max(audio, video).
            video_future = None
            if is_video:
                from concurrent.futures import ThreadPoolExecutor
                _ex = ThreadPoolExecutor(max_workers=1)
                video_future = _ex.submit(_gemini_video_analysis, path)

            officer_id = WATCH_STATE.get("default_officer_id") or "EO_001"
            result = run_analysis(audio, sr_, officer_id,
                                  source="watch_folder",
                                  filename=item["filename"])

            if isinstance(result, dict):
                result["media_type"] = "video" if is_video else "audio"
                if is_video:
                    va, status, err = {}, "ok", ""
                    try:
                        va = (video_future.result(timeout=360) if video_future else {}) or {}
                        if not va:
                            status = "empty"
                            err = "Gemini returned no visual analysis."
                    except Exception as _ve:
                        status = "error"
                        err = str(_ve)[:200]
                    va.setdefault("_status", status)
                    if err:
                        va["_status_message"] = err
                    result["video_analysis"] = va

            item["result"]      = result
            item["status"]      = "done"
            item["finished_at"] = time.time()
            print(f"[watch] done: {item['filename']} → {result.get('severity')} "
                  f"({result.get('total_score')}/100)", flush=True)
            _watch_emit("watch_finished", _watch_summary(item))

            # Move processed file to watch_done/ so the folder stays clean.
            try:
                dest = os.path.join(WATCH_DONE, item["filename"])
                base, ext = os.path.splitext(item["filename"])
                idx = 1
                while os.path.exists(dest):
                    dest = os.path.join(WATCH_DONE, f"{base}_{idx}{ext}")
                    idx += 1
                shutil.move(path, dest)
                item["path"] = dest
            except Exception as _mv:
                print(f"[watch] move error (non-fatal): {_mv}", flush=True)

        except Exception as e:
            item["status"]      = "error"
            item["error"]       = str(e)[:300]
            item["finished_at"] = time.time()
            print(f"[watch] error on {item['filename']}: {e}", flush=True)
            _watch_emit("watch_failed", _watch_summary(item))


def start_watch_threads():
    # The .NET backend runs its own VideoFolderWatcherService against
    # bodycam_dotnet/WatchFolder/Inbox/ — that pipeline persists results to
    # MSSQL and is the sole source of truth for the dashboard. Running the
    # Python watcher in parallel double-processes every file (wasting Gemini
    # quota) and only writes to an in-memory list that vanishes on restart.
    # Set PYTHON_WATCH_ENABLED=true to opt back in for standalone Python use.
    if os.environ.get("PYTHON_WATCH_ENABLED", "false").strip().lower() != "true":
        print("[watch] Python watcher disabled — .NET WatchFolder is authoritative. "
              "Set PYTHON_WATCH_ENABLED=true to re-enable.", flush=True)
        return
    threading.Thread(target=_watch_scanner, name="watch-scanner", daemon=True).start()
    threading.Thread(target=_watch_worker,  name="watch-worker",  daemon=True).start()


@app.route("/api/watch/status")
def watch_status():
    pending = sum(1 for it in WATCH_RESULTS if it["status"] == "queued")
    analyzing = sum(1 for it in WATCH_RESULTS if it["status"] == "analyzing")
    done = sum(1 for it in WATCH_RESULTS if it["status"] == "done")
    err  = sum(1 for it in WATCH_RESULTS if it["status"] == "error")
    return jsonify({
        "running":     WATCH_STATE["running"],
        "folder":      WATCH_STATE["folder"],
        "done_folder": WATCH_STATE["done_folder"],
        "scan_every":  WATCH_STATE["scan_every"],
        "last_scan":   WATCH_STATE["last_scan"],
        "default_officer_id": WATCH_STATE["default_officer_id"],
        "counts": {
            "total":     len(WATCH_RESULTS),
            "queued":    pending,
            "analyzing": analyzing,
            "done":      done,
            "error":     err,
        },
    })


@app.route("/api/watch/list")
def watch_list():
    sev = (request.args.get("severity") or "").upper()
    status = (request.args.get("status") or "").lower()
    items = [_watch_summary(it) for it in WATCH_RESULTS]
    if sev:
        items = [i for i in items if (i.get("severity") or "") == sev]
    if status:
        items = [i for i in items if (i.get("status") or "") == status]
    return jsonify({"items": items, "total": len(items)})


@app.route("/api/watch/result/<file_id>")
def watch_result(file_id):
    fid = file_id.upper()
    for it in WATCH_RESULTS:
        if it["file_id"] == fid:
            return jsonify({
                "file_id":   it["file_id"],
                "filename":  it["filename"],
                "status":    it["status"],
                "queued_at":   it.get("queued_at"),
                "started_at":  it.get("started_at"),
                "finished_at": it.get("finished_at"),
                "size_bytes":  it.get("size_bytes"),
                "error":     it.get("error"),
                "result":    it.get("result"),
            })
    return jsonify({"error": "Not found"}), 404


@app.route("/api/watch/rescan", methods=["POST"])
def watch_rescan():
    """Force an immediate scan instead of waiting for the next tick."""
    found = 0
    if os.path.isdir(WATCH):
        for name in sorted(os.listdir(WATCH)):
            fp = os.path.join(WATCH, name)
            if not os.path.isfile(fp):
                continue
            if not name.lower().endswith(_MEDIA_EXTS):
                continue
            if _watch_key(fp) in WATCH_SEEN:
                continue
            if _watch_enqueue(fp):
                found += 1
    return jsonify({"queued_now": found, "queue_size": len(WATCH_QUEUE)})


@app.route("/api/watch/result/<file_id>", methods=["DELETE"])
def watch_delete(file_id):
    fid = file_id.upper()
    with WATCH_LOCK:
        for i, it in enumerate(WATCH_RESULTS):
            if it["file_id"] == fid:
                WATCH_RESULTS.pop(i)
                return jsonify({"removed": fid})
    return jsonify({"error": "Not found"}), 404


@app.route("/api/watch/config", methods=["POST"])
def watch_config():
    data = request.get_json() or {}
    if "default_officer_id" in data:
        oid = (data["default_officer_id"] or "").strip()
        if oid:
            WATCH_STATE["default_officer_id"] = oid
    if "scan_every" in data:
        try:
            v = float(data["scan_every"])
            if 1.0 <= v <= 60.0:
                WATCH_STATE["scan_every"] = v
        except (TypeError, ValueError):
            pass
    return jsonify({
        "default_officer_id": WATCH_STATE["default_officer_id"],
        "scan_every":         WATCH_STATE["scan_every"],
    })


@socketio.on("connect")
def on_connect():
    emit("connected", {"message": "EO Bodycam AI v5.0 ready — Complete Monitoring Active"})

@socketio.on("join_supervisor")
def on_join(data):
    emit("joined", {"role": "supervisor", "message": "Live alerts active — 10 violation categories monitored"})


# ═══════════════════════════════════════════════════════════════
#  SERVER STARTUP
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    kw_total = sum(len(v["words"]) for v in VK.values())
    ln = TONE_MODEL["label_names"]
    emotions = list(ln.values()) if isinstance(ln, dict) else list(ln)
    print(f"\n{'='*60}")
    print(f" EO Bodycam AI Server v5.0 — Complete Monitoring System")
    print(f"{'='*60}")
    _gk = os.environ.get("GEMINI_API_KEY", "").strip()
    if not _gk:
        gem_status = "ENV unset — will use X-Gemini-Api-Key from .NET (appsettings.json)"
    elif len(_gk) < 10:
        gem_status = (
            f"ENV KEY TOO SHORT ('{_gk[:6]}...') — fix GEMINI_API_KEY or rely on .NET header. "
            "Create one at https://aistudio.google.com/app/apikey"
        )
    else:
        gem_status = "ENV active (header from .NET will override per-request if present)"
    print(f" Gemini API:    {gem_status}")
    print(f" Transcription: Gemini 2.5 Flash → Google Speech (fallback) → local whisper-small")
    print(f" Emotions:      {' / '.join(emotions)}")
    print(f" Warning:       score >= {CONFIG['warning_score']}")
    print(f" Critical:      score >= {CONFIG['critical_score']}")
    print(f" Keywords:      {kw_total} Urdu words in {len(VK)} categories")
    print(f" Categories:    {', '.join(VK.keys())}")
    print(f"{'─'*60}")
    for cat, cfg in VK.items():
        ascii_words = [w for w in cfg['words'] if all(ord(c) < 256 for c in w)][:3]
        sample = ', '.join(ascii_words) if ascii_words else '...'
        print(f"   {cat} ({cfg['severity']}, +{cfg['score']}pts): {sample}...")
    print(f"{'─'*60}")
    print(f" Severity Levels:")
    for level, info in CONFIG.get("severity_levels", {}).items():
        print(f"   {level}: {info['min_score']}-{info['max_score']} pts -> {info['action']}")
    print(f"{'─'*60}")
    print(f" Tone detection: Acoustic-based (energy, pitch, agitation)")
    print(f" Enrolled pitch: {ENROLLED_PITCH:.1f}Hz")
    print(f" Watch folder:   {WATCH}")
    print(f" Watch done:     {WATCH_DONE}")
    print(f" http://localhost:5050")
    print(f"{'='*60}\n")
    start_watch_threads()
    socketio.run(app, host="0.0.0.0", port=5050, debug=False,
                 allow_unsafe_werkzeug=True)
