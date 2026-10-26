// 공통 유틸: 경로, DB 연결, .env, CSV
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = path.join(ROOT, "data", "kbo_injury.db");
export const SCHEMA_PATH = path.join(ROOT, "db", "schema.sql");
export const SEEDS_DIR = path.join(ROOT, "crawler", "seeds");
export const EXPORT_DIR = path.join(ROOT, "web", "public", "data");

/** 의존성 없이 .env 읽기. 이미 설정된 환경변수는 덮어쓰지 않음. */
export function loadDotenv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function connect() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  return db;
}

export function initSchema(db) {
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

/** 단순 CSV 파서 (따옴표 필드 지원, '#' 주석줄 무시) → 객체 배열 */
export function readCsv(name) {
  const text = fs.readFileSync(path.join(SEEDS_DIR, name), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const parseLine = (line) => {
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [header[i], v])));
}

/** --key value / --flag 형태 인자 파싱 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}
