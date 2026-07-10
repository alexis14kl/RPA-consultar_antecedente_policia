"""whisper_paths.py — Resolución DINÁMICA de las rutas de whisper.cpp (binario + modelo).

Evita hardcodear rutas de un solo equipo (p. ej. /root/whisper.cpp del VPS): la misma
copia del proyecto corre en el VPS Linux y en la Mac sin editar nada. La clase busca la
instalación en ubicaciones típicas y respeta overrides por variable de entorno.

Orden de resolución del binario:
  1) $WHISPER_CPP_BIN (ruta explícita, si existe)
  2) whisper-cli / whisper-cpp / main en el PATH (brew/apt)
  3) <home>/build/bin/<nombre> por cada home candidato
Orden de resolución del modelo:
  1) $WHISPER_CPP_MODEL (ruta explícita, si existe)
  2) <home>/models/ggml-base.bin por cada home candidato
  3) <script_dir>/models/ggml-base.bin (modelo dejado junto al proyecto)

Homes candidatos (en orden): $WHISPER_CPP_HOME, <script_dir>/whisper.cpp,
~/whisper.cpp, /root/whisper.cpp, /opt/whisper.cpp, /usr/local/whisper.cpp.
"""
# Anotaciones perezosas: el VPS corre Python 3.8, donde `str | None` y `list[str]`
# reventarían al evaluarse. Con esto quedan como strings y nunca se evalúan.
from __future__ import annotations

import os
import shutil


class WhisperPaths:
    # Nombres del binario según versión/plataforma (whisper.cpp renombró `main`→`whisper-cli`).
    BIN_NAMES = ("whisper-cli", "whisper-cpp", "main")
    # Modelo MULTILINGÜE (el .en devuelve "(speaking in foreign language)" en audio español).
    MODEL_NAME = "ggml-base.bin"

    def __init__(self, script_dir: str | None = None,
                 bin_env: str = "WHISPER_CPP_BIN",
                 model_env: str = "WHISPER_CPP_MODEL",
                 home_env: str = "WHISPER_CPP_HOME"):
        self.script_dir = script_dir or os.path.dirname(os.path.abspath(__file__))
        self.bin_env = bin_env
        self.model_env = model_env
        self.home_env = home_env

    def _homes(self) -> list[str]:
        """Raíces candidatas de una instalación de whisper.cpp, en orden de prioridad."""
        cands: list[str] = []
        env_home = os.environ.get(self.home_env)
        if env_home:
            cands.append(env_home)
        cands += [
            os.path.join(self.script_dir, "whisper.cpp"),
            os.path.join(os.path.expanduser("~"), "whisper.cpp"),
            "/root/whisper.cpp",
            "/opt/whisper.cpp",
            "/usr/local/whisper.cpp",
        ]
        # dedup preservando orden
        seen, out = set(), []
        for c in cands:
            if c not in seen:
                seen.add(c)
                out.append(c)
        return out

    def bin(self) -> str | None:
        env = os.environ.get(self.bin_env)
        if env and os.path.exists(env):
            return env
        # Preferir el whisper EMBEBIDO en el proyecto (<script_dir>/whisper.cpp es el 2º
        # home candidato, tras $WHISPER_CPP_HOME) → encapsulado, no depende del brew global.
        for home in self._homes():
            for name in self.BIN_NAMES:
                p = os.path.join(home, "build", "bin", name)
                if os.path.exists(p):
                    return p
        # Fallback: en el PATH (brew/apt).
        for name in self.BIN_NAMES:
            found = shutil.which(name)
            if found:
                return found
        return None

    def model(self) -> str | None:
        env = os.environ.get(self.model_env)
        if env and os.path.exists(env):
            return env
        for home in self._homes():
            p = os.path.join(home, "models", self.MODEL_NAME)
            if os.path.exists(p):
                return p
        p = os.path.join(self.script_dir, "models", self.MODEL_NAME)
        if os.path.exists(p):
            return p
        return None

    def available(self) -> bool:
        return bool(self.bin() and self.model())

    def describe(self) -> str:
        return f"bin={self.bin()!r} model={self.model()!r}"
