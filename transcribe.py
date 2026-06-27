import sys
import os
import urllib.request

# ffmpeg: en Mac/Linux vive en el PATH (brew/apt) y no se toca nada. En Windows,
# si winget no actualizó el PATH de la sesión, exportá FFMPEG_DIR apuntando al
# bin de ffmpeg.
FFMPEG_DIR = os.environ.get("FFMPEG_DIR")
if FFMPEG_DIR and os.path.isdir(FFMPEG_DIR):
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
        raise RuntimeError(f"Transcripción falló (Google STT): {e1}")

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "file":
        print(transcribe_file(sys.argv[2]))
    else:
        print(transcribe(sys.argv[1]))
