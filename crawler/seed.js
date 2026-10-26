// 1단계: 스키마 생성 + 구단/부위/키워드/선수 시드 적재. 멱등.
import { connect, initSchema, readCsv } from "./common.js";

const db = connect();
initSchema(db);

const upsert = (sql, rows) => db.transaction((rs) => rs.forEach((r) => db.prepare(sql).run(r)))(rows);

upsert("INSERT OR REPLACE INTO teams (id, name, short_name, color) VALUES (@id, @name, @short_name, @color)",
  readCsv("teams.csv"));

upsert("INSERT OR REPLACE INTO body_parts (id, name_ko, name_en, region, svg_zone, sided) " +
  "VALUES (@id, @name_ko, @name_en, @region, @svg_zone, @sided)",
  readCsv("body_parts.csv").map((r) => ({ ...r, sided: Number(r.sided) })));

upsert("INSERT OR REPLACE INTO injury_keywords (keyword, body_part_id, injury_type) " +
  "VALUES (@keyword, @body_part_id, @injury_type)",
  readCsv("keywords.csv").map((r) => ({ ...r, injury_type: r.injury_type || null })));

upsert("INSERT OR IGNORE INTO players (name, team_id, position, birth_date, kbo_id) " +
  "VALUES (@name, @team_id, @position, @birth_date, @kbo_id)",
  readCsv("players.csv").filter((p) => p.name)
    .map((p) => ({ ...p, birth_date: p.birth_date || null, kbo_id: p.kbo_id || null })));

for (const t of ["teams", "body_parts", "injury_keywords", "players"]) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
  console.log(`${t.padEnd(16)} ${n}`);
}
