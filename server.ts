// server.ts — ENTRY POINT. Lee la config del entorno, construye el RpaServer y arranca.
// Toda la lógica vive en clases (core/ y scrapers/). Este archivo solo cablea env → config.
import { mkdirSync } from "fs";
import path from "path";
import { RpaServer, RpaConfig } from "./RpaServer";

const SCRIPT_DIR = __dirname;
const SERVER_PORT = parseInt(process.env.PORT ?? "3000");
const MAX_WORKERS = parseInt(process.env.WORKERS ?? "2");
const POOL_TARGET = parseInt(process.env.POOL_TARGET ?? String(MAX_WORKERS * 3));
const POOL_SOLVERS = parseInt(process.env.POOL_SOLVERS ?? "2");
const SCREENSHOTS_DIR = path.join(SCRIPT_DIR, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const cfg: RpaConfig = {
  serverPort: SERVER_PORT,
  serverHost: process.env.HOST ?? "127.0.0.1",
  cdpPort: 9223,
  urlSite: "https://antecedentes.policia.gov.co:7005/WebJudicial/index.xhtml",
  scriptDir: SCRIPT_DIR,
  screenshotsDir: SCREENSHOTS_DIR,
  baseUrl: process.env.BASE_URL ?? `http://localhost:${SERVER_PORT}`,
  python: process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
  maxWorkers: MAX_WORKERS,
  loteStreamMax: parseInt(process.env.LOTE_STREAM_MAX ?? "200"),
  maxIntentos: parseInt(process.env.MAX_INTENTOS ?? "2"),
  cacheTtlMs: parseInt(process.env.CACHE_TTL ?? "30") * 60 * 1000,
  consultaTimeoutMs: parseInt(process.env.CONSULTA_TIMEOUT ?? "120") * 1000,
  // Captcha (WebScraperConfig)
  audioMaxAttempts: parseInt(process.env.AUDIO_MAX_ATTEMPTS ?? "3"),
  captchaTimeoutMs: parseInt(process.env.CAPTCHA_TIMEOUT ?? "35") * 1000,
  captchaTimeoutBlockedMs: parseInt(process.env.CAPTCHA_TIMEOUT_BLOCKED ?? "10") * 1000,
  // Object Pool
  pool: {
    target: POOL_TARGET,
    idle: parseInt(process.env.POOL_IDLE ?? "1"),
    solvers: POOL_SOLVERS,
    demandWindowMs: parseInt(process.env.DEMAND_WINDOW ?? "120") * 1000,
    tokenMaxAgeMs: 100_000,
    tokenMinBufferMs: 3_000,
    warmupMs: parseInt(process.env.POOL_WARMUP ?? "20") * 1000,
    waitMs: parseInt(process.env.POOL_WAIT ?? "45") * 1000,
    reaperIntervalMs: parseInt(process.env.REAPER_INTERVAL ?? "20000"),
    maxPages: POOL_TARGET + POOL_SOLVERS + 3,
    circuitFails: parseInt(process.env.CIRCUIT_FAILS ?? "6"),
    circuitCooldownMs: parseInt(process.env.CIRCUIT_COOLDOWN ?? "30") * 1000,
  },
};

new RpaServer(cfg).start();
