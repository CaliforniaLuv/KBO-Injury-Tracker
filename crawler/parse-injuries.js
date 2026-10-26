// 3단계: articles(제목+요약) → injuries. 규칙 기반 추출. 멱등.
//
// - 키워드 사전으로 부위/유형 추출, 좌/우 추출
// - 복귀 문맥("복귀", "1군 등록", "합류")이면 해당 선수·부위의 미종료 부상 end_date 로 사용
//   (복귀 기사는 "이상 없다" 같은 부정 문맥과 함께 나와도 종료 처리 우선)
// - 부정 문맥("부상 없", "이상 없", "우려 없")이면 신규 생성하지 않음
// - 같은 선수·부위·시작일 ±MERGE_DAYS 이내면 기존 부상에 기사만 연결
//
//   node parse-injuries.js             # parsed=0 인 기사만
//   node parse-injuries.js --reparse   # 전체 재처리
import { connect, getSetting, parseArgs } from "./common.js";

const MERGE_DAYS = 14;
const NEGATION = /(부상|이상|문제|우려)\s*(은|는|이|도)?\s*(없|아니)/;
const RETURN_CTX = /(복귀|1군\s*(등록|콜업|합류)|엔트리\s*등록|실전\s*복귀)/;
const SIDE_RE = { L: /(왼|좌측|좌)\s*(쪽)?/, R: /(오른|우측|우)\s*(쪽)?/ };
const TYPE_RE = [
  ["수술", /수술/], ["골절", /골절|금이/], ["파열", /파열|손상/], ["염좌", /염좌|삠|접질/],
  ["염증", /염증|건염/], ["타박", /타박|사구|맞[아은]/], ["경련", /경련|쥐가/], ["통증", /통증|불편/],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isoDate = (d) => d.toISOString().slice(0, 10);

/** 텍스트에서 부위별 후보 1개씩: [{partId, side, type, kw}] */
function extract(text, keywords, sided) {
  const best = new Map();
  for (const { keyword, body_part_id: partId, injury_type: kwType } of keywords) {
    for (const m of text.matchAll(new RegExp(escapeRe(keyword), "g"))) {
      const before = text.slice(Math.max(0, m.index - 8), m.index);
      let side = null;
      if (sided[partId]) for (const [s, rx] of Object.entries(SIDE_RE)) if (rx.test(before)) { side = s; break; }
      let type = kwType;
      if (!type) {
        const after = text.slice(m.index + keyword.length, m.index + keyword.length + 20);
        for (const [name, rx] of TYPE_RE) if (rx.test(after)) { type = name; break; }
      }
      const score = (side ? 1 : 0) + (type ? 1 : 0);
      const cur = best.get(partId);
      if (!cur || score > cur.score) best.set(partId, { partId, side, type, kw: keyword, score });
    }
  }
  return [...best.values()];
}

function isLateSeason(d, lateFrom) {
  const [mm, dd] = lateFrom.split("-").map(Number);
  return d.getUTCMonth() + 1 > mm || (d.getUTCMonth() + 1 === mm && d.getUTCDate() >= dd);
}

const args = parseArgs();
const db = connect();
const keywords = db.prepare("SELECT * FROM injury_keywords ORDER BY length(keyword) DESC").all();
const sided = Object.fromEntries(db.prepare("SELECT id, sided FROM body_parts").all().map((r) => [r.id, !!r.sided]));
const lateFrom = getSetting(db, "late_season_from", "09-01");

const q = {
  openInjury: db.prepare(
    "SELECT id, start_date FROM injuries WHERE player_id=? AND body_part_id=? AND end_date IS NULL " +
    "AND start_date<=? ORDER BY start_date DESC LIMIT 1"),
  closeInjury: db.prepare("UPDATE injuries SET end_date=?, days_out=? WHERE id=?"),
  nearInjury: db.prepare(
    "SELECT id FROM injuries WHERE player_id=? AND body_part_id=? " +
    "AND abs(julianday(start_date) - julianday(?)) <= ? ORDER BY start_date DESC LIMIT 1"),
  link: db.prepare("INSERT OR IGNORE INTO injury_articles VALUES (?,?)"),
  insert: db.prepare(
    "INSERT INTO injuries (player_id, body_part_id, side, injury_type, start_date, season, late_season, " +
    "confidence, source_article_id, note) VALUES (?,?,?,?,?,?,?,?,?,?)"),
  markParsed: db.prepare("UPDATE articles SET parsed=1 WHERE id=?"),
};

const articles = db.prepare(
  `SELECT * FROM articles ${args.reparse ? "" : "WHERE parsed=0"} ORDER BY published_at`).all();
let created = 0, linked = 0, closed = 0;

db.transaction(() => {
  for (const a of articles) {
    const text = `${a.title} ${a.description ?? ""}`;
    const pub = new Date(a.published_at);
    const pubIso = isoDate(pub);
    const negated = NEGATION.test(text);
    const returning = RETURN_CTX.test(text);

    for (const { partId, side, type, kw } of extract(text, keywords, sided)) {
      if (returning) {
        const row = q.openInjury.get(a.player_id, partId, pubIso);
        if (row) {
          const days = Math.round((pub - new Date(row.start_date)) / 86_400_000);
          q.closeInjury.run(pubIso, days, row.id);
          q.link.run(row.id, a.id);
          closed++;
        }
        continue;
      }
      if (negated) continue;

      const near = q.nearInjury.get(a.player_id, partId, pubIso, MERGE_DAYS);
      if (near) { q.link.run(near.id, a.id); linked++; continue; }

      const confidence = Math.min(1, 0.4 + (side ? 0.2 : 0) + (type ? 0.2 : 0) + (a.title.includes(kw) ? 0.1 : 0));
      const { lastInsertRowid } = q.insert.run(
        a.player_id, partId, side, type, pubIso, pub.getUTCFullYear(),
        isLateSeason(pub, lateFrom) ? 1 : 0, Number(confidence.toFixed(2)), a.id, `kw=${kw}`);
      q.link.run(lastInsertRowid, a.id);
      created++;
    }
    q.markParsed.run(a.id);
  }
})();

console.log(`기사 ${articles.length}건 처리 → 부상 신규 ${created}, 기존 연결 ${linked}, 종료 처리 ${closed}`);
