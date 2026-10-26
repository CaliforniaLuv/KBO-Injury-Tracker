// 2단계: 네이버 뉴스 검색 API로 선수별 부상 기사 메타 수집 → articles
//
// 사용법:
//   node fetch-news.js                  # 전체 활성 선수
//   node fetch-news.js --team SSG       # 특정 구단
//   node fetch-news.js --player 김광현  # 특정 선수
//   node fetch-news.js --max 300        # 선수당 최대 수집 건수 (기본 200, 상한 1000)
//
// API 제약: 쿼리당 최대 1000건(start<=1000), display<=100, 일 25,000회.
// 날짜 필터가 없으므로 sort=date 로 최신순 수집 후 seasons 설정 범위 밖은 버린다.
import { connect, loadDotenv, getSetting, parseArgs } from "./common.js";

const API = "https://openapi.naver.com/v1/search/news.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) => (s ?? "")
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
  .trim();

const pressFromUrl = (url) => url?.match(/https?:\/\/([^/]+)\//)?.[1] ?? null;

async function naverSearch(query, start, display, cid, csec) {
  const url = `${API}?${new URLSearchParams({ query, start, display, sort: "date" })}`;
  const res = await fetch(url, { headers: { "X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchPlayer(db, player, cid, csec, maxItems, minYear) {
  const query = `"${player.name}" 부상`;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO articles (url, title, description, press, published_at, player_id, query) " +
    "VALUES (?,?,?,?,?,?,?)");
  let inserted = 0;

  for (let start = 1; start <= Math.min(maxItems, 1000); start += 100) {
    const display = Math.min(100, maxItems - start + 1);
    let data;
    try {
      data = await naverSearch(query, start, display, cid, csec);
    } catch (e) {
      console.error(`  ! ${player.name} start=${start}: ${e.message}`);
      break;
    }
    const items = data.items ?? [];
    if (!items.length) break;

    let stop = false;
    const tx = db.transaction(() => {
      for (const it of items) {
        const pub = new Date(it.pubDate);
        if (Number.isNaN(pub.getTime())) continue;
        if (pub.getFullYear() < minYear) { stop = true; break; }
        inserted += insert.run(
          it.originallink || it.link, clean(it.title), clean(it.description),
          pressFromUrl(it.originallink), pub.toISOString(), player.id, query,
        ).changes;
      }
    });
    tx();
    if (stop || items.length < display) break;
    await sleep(100);
  }
  return inserted;
}

const args = parseArgs();
loadDotenv();
const cid = process.env.NAVER_CLIENT_ID, csec = process.env.NAVER_CLIENT_SECRET;
if (!cid || !csec) {
  console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수(.env)가 필요합니다.");
  process.exit(1);
}

const db = connect();
const minYear = Math.min(...getSetting(db, "seasons", "2021").split(",").map(Number));
const maxItems = Number(args.max ?? 200);

let sql = "SELECT * FROM players WHERE active = 1";
const params = [];
if (args.team) { sql += " AND team_id = ?"; params.push(args.team); }
if (args.player) { sql += " AND name = ?"; params.push(args.player); }
const players = db.prepare(sql).all(...params);
if (!players.length) {
  console.error("대상 선수가 없습니다. seeds/players.csv 를 채우고 seed.js 를 먼저 실행하세요.");
  process.exit(1);
}

let total = 0;
for (const p of players) {
  const n = await fetchPlayer(db, p, cid, csec, maxItems, minYear);
  total += n;
  console.log(`${p.team_id.padEnd(8)} ${p.name.padEnd(6)} +${n}`);
}
console.log(`신규 기사 ${total}건`);
