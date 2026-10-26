-- KBO 부상 이탈 트래커 스키마 (SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,          -- 'LG', 'KIA' ...
  name        TEXT NOT NULL,             -- 'LG 트윈스'
  short_name  TEXT NOT NULL,             -- '트윈스'
  color       TEXT                       -- 구단 대표색 hex
);

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  position    TEXT CHECK (position IN ('투수','포수','내야수','외야수','지명타자')),
  birth_date  TEXT,                      -- 'YYYY-MM-DD', 동명이인 구분용
  kbo_id      TEXT,                      -- koreabaseball.com 선수 ID
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (name, team_id, birth_date)
);

CREATE TABLE IF NOT EXISTS body_parts (
  id          TEXT PRIMARY KEY,          -- 'hamstring'
  name_ko     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  region      TEXT NOT NULL CHECK (region IN ('head','torso','arm','leg','other')),
  svg_zone    TEXT NOT NULL,             -- SVG data-zone 접두어. 좌우는 '_l' / '_r' 접미
  sided       INTEGER NOT NULL DEFAULT 0 -- 좌우 구분 가능 여부
);

-- 기사 텍스트에서 부위를 찾기 위한 키워드 사전
CREATE TABLE IF NOT EXISTS injury_keywords (
  keyword       TEXT PRIMARY KEY,
  body_part_id  TEXT NOT NULL REFERENCES body_parts(id),
  injury_type   TEXT                      -- 키워드가 유형까지 암시하면 기록 ('수술','염좌' 등)
);

CREATE TABLE IF NOT EXISTS articles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT,
  press         TEXT,
  published_at  TEXT NOT NULL,            -- ISO 8601
  player_id     INTEGER REFERENCES players(id),
  query         TEXT,                     -- 수집 당시 검색어
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  parsed        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_articles_player ON articles(player_id, published_at);

CREATE TABLE IF NOT EXISTS injuries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       INTEGER NOT NULL REFERENCES players(id),
  body_part_id    TEXT NOT NULL REFERENCES body_parts(id),
  side            TEXT CHECK (side IN ('L','R','B') OR side IS NULL),  -- B: 양쪽, NULL: 불명
  injury_type     TEXT,                   -- '염좌','파열','골절','수술','타박','염증','통증','질병','기타'
  start_date      TEXT NOT NULL,          -- 최초 보도일 또는 말소일
  end_date        TEXT,                   -- 복귀 보도일 또는 재등록일
  days_out        INTEGER,                -- end-start, 미복귀면 NULL
  season          INTEGER NOT NULL,
  late_season     INTEGER NOT NULL DEFAULT 0,  -- 9/1 이후 또는 포스트시즌 발생
  confidence      REAL NOT NULL DEFAULT 0.5,   -- 0~1 자동 추출 신뢰도
  status          TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto','confirmed','rejected')),
  source_article_id INTEGER REFERENCES articles(id),
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_injuries_player ON injuries(player_id, start_date);
CREATE INDEX IF NOT EXISTS idx_injuries_part   ON injuries(body_part_id);

-- 부상 1건을 뒷받침하는 기사 (다대다)
CREATE TABLE IF NOT EXISTS injury_articles (
  injury_id   INTEGER NOT NULL REFERENCES injuries(id) ON DELETE CASCADE,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (injury_id, article_id)
);

-- KBO 1군 엔트리 등록/말소 (2차)
CREATE TABLE IF NOT EXISTS roster_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  move_type   TEXT NOT NULL CHECK (move_type IN ('등록','말소')),
  move_date   TEXT NOT NULL,
  reason      TEXT,
  source      TEXT,
  UNIQUE (player_id, move_type, move_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('iai.w_frequency',   '1.0'),
  ('iai.w_days',        '1.0'),
  ('iai.w_late_season', '1.5'),
  ('iai.w_recurrence',  '1.2'),
  ('iai.days_divisor',  '30'),
  ('color.yellow_max_count', '2'),  ('color.yellow_max_days', '30'),
  ('color.orange_max_count', '4'),  ('color.orange_max_days', '90'),
  ('seasons', '2021,2022,2023,2024,2025,2026'),
  ('late_season_from', '09-01');

-- 선수×부위 집계 뷰 (프론트 색상 계산용)
CREATE VIEW IF NOT EXISTS v_player_part_summary AS
SELECT
  i.player_id,
  i.body_part_id,
  COUNT(*)                       AS injury_count,
  COALESCE(SUM(i.days_out), 0)   AS total_days_out,
  SUM(i.late_season)             AS late_season_count,
  MIN(i.start_date)              AS first_date,
  MAX(i.start_date)              AS last_date
FROM injuries i
WHERE i.status <> 'rejected'
GROUP BY i.player_id, i.body_part_id;

-- 선수별 IAI(부상 이탈 지수) 뷰
CREATE VIEW IF NOT EXISTS v_player_iai AS
WITH s AS (
  SELECT key, CAST(value AS REAL) AS v FROM settings
),
per_part AS (
  SELECT player_id, body_part_id, COUNT(*) AS c
  FROM injuries WHERE status <> 'rejected'
  GROUP BY player_id, body_part_id
),
agg AS (
  SELECT
    i.player_id,
    COUNT(*)                                  AS injury_count,
    COALESCE(SUM(i.days_out), 0)              AS total_days_out,
    SUM(i.late_season)                        AS late_season_count,
    (SELECT COALESCE(SUM(c - 1), 0) FROM per_part p WHERE p.player_id = i.player_id AND c > 1) AS recurrence_count
  FROM injuries i
  WHERE i.status <> 'rejected'
  GROUP BY i.player_id
)
SELECT
  a.*,
  ROUND(
      a.injury_count     * (SELECT v FROM s WHERE key='iai.w_frequency')
    + (a.total_days_out  / (SELECT v FROM s WHERE key='iai.days_divisor')) * (SELECT v FROM s WHERE key='iai.w_days')
    + a.late_season_count * (SELECT v FROM s WHERE key='iai.w_late_season')
    + a.recurrence_count  * (SELECT v FROM s WHERE key='iai.w_recurrence')
  , 2) AS iai
FROM agg a;
