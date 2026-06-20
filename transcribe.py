import sys
import os
import urllib.request

# ffmpeg path explícito (winget no actualiza PATH en sesión activa)
FFMPEG_DIR = r"C:\Users\NyGsoft\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin"
os.environ["PATH"] = FFMPEG_DIR + os.pathsep + os.environ.get("PATH", "")

def download_audio(url: str, dest: str):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://www.google.com/recaptcha/",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as r:
        with open(dest, "wb") as f:
            f.write(r.read())

def mp3_to_wav(mp3_path: str, wav_path: str):
    from pydub import AudioSegment
    AudioSegment.from_file(mp3_path).export(wav_path, format="wav")

def transcribe_google(wav_path: str) -> str:
    import speech_recognition as sr
    r = sr.Recognizer()
    with sr.AudioFile(wav_path) as source:
        audio_data = r.record(source)
    return r.recognize_google(audio_data, language="en-US").lower()

def transcribe_whisper(mp3_path: str) -> str:
    import whisper
    model = whisper.load_model("base")
    result = model.transcribe(
        mp3_path,
        language="en",
        fp16=False,
        condition_on_previous_text=False,
        initial_prompt="The audio code is:",
    )
    return result["text"].strip().lower()

def transcribe(url: str) -> str:
    tmp = "captcha_audio.mp3"
    download_audio(url, tmp)
    return transcribe_file(tmp)

def transcribe_file(mp3_path: str) -> str:
    wav = mp3_path.replace(".mp3", ".wav")
    try:
        mp3_to_wav(mp3_path, wav)
        text = transcribe_google(wav)
        os.remove(wav)
        return text
    except Exception as e1:
        print(f"Google STT falló: {e1}", file=sys.stderr)
        try:
            return transcribe_whisper(mp3_path)
        except Exception as e2:
            print(f"Whisper falló: {e2}", file=sys.stderr)
            raise RuntimeError(f"Ambos STT fallaron. Google: {e1} | Whisper: {e2}")

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "file":
        print(transcribe_file(sys.argv[2]))
    else:
        print(transcribe(sys.argv[1]))
