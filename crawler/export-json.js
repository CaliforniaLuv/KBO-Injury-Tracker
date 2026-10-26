// 6단계: 프론트용 JSON 스냅샷 생성 → web/public/data/
import fs from "node:fs";
import path from "node:path";
import { connect, EXPORT_DIR } from "./common.js";

const db = connect();
fs.mkdirSync(path.join(EXPORT_DIR, "players"), { recursive: true });
const write = (rel, data) =>
  fs.writeFileSync(path.join(EXPORT_DIR, rel), JSON.stringify(data, null, 2), "utf8");

const teams = db.prepare("SELECT * FROM teams ORDER BY id").all();
const bodyParts = db.prepare("SELECT * FROM body_parts").all();
const settings = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));

const ranking = db.prepare(`
  SELECT p.id, p.name, p.team_id, p.position,
         g.injury_count, g.total_days_out, g.late_season_count, g.recurrence_count, g.gbi
  FROM v_player_gbi g JOIN players p ON p.id = g.player_id
  ORDER BY g.gbi DESC`).all();

const leagueParts = db.prepare(`
  SELECT body_part_id, COUNT(*) AS injury_count, COALESCE(SUM(days_out), 0) AS total_days_out
  FROM injuries WHERE status <> 'rejected' GROUP BY body_part_id ORDER BY injury_count DESC`).all();

const q = {
  parts: db.prepare("SELECT * FROM v_player_part_summary WHERE player_id = ?"),
  injuries: db.prepare(`
    SELECT i.*, b.name_ko AS body_part_ko FROM injuries i JOIN body_parts b ON b.id = i.body_part_id
    WHERE i.player_id = ? AND i.status <> 'rejected' ORDER BY i.start_date`),
  articles: db.prepare(`
    SELECT DISTINCT a.id, a.url, a.title, a.press, a.published_at
    FROM articles a JOIN injury_articles ia ON ia.article_id = a.id JOIN injuries i ON i.id = ia.injury_id
    WHERE i.player_id = ? ORDER BY a.published_at DESC`),
};

const players = db.prepare("SELECT * FROM players WHERE active = 1").all();
for (const p of players) {
  write(`players/${p.id}.json`, {
    ...p, parts: q.parts.all(p.id), injuries: q.injuries.all(p.id), articles: q.articles.all(p.id),
  });
}
write("meta.json", { teams, body_parts: bodyParts, settings });
write("ranking.json", ranking);
write("league_parts.json", leagueParts);
console.log(`export → ${EXPORT_DIR}  (선수 ${players.length}명, 랭킹 ${ranking.length}행)`);
