# KBO 유리몸 트래커

2021–2026 시즌 KBO 선수 부상 이력을 SVG 신체 히트맵으로 보여주는 대시보드.

- 기획: `docs/01-기획.md`
- 아키텍처: `docs/02-아키텍처.md`
- 디자인: `docs/03-디자인.md`

## 시작하기
```bash
cp .env.example .env          # 네이버 개발자센터에서 발급한 키 입력
# crawler/seeds/players.csv 에 선수 명단 채우기
cd crawler && npm install
npm run seed                                  # DB 생성 + 시드
node fetch-news.js --team SSG --max 200       # 네이버 뉴스 수집
npm run parse                                 # 부위/기간 추출
npm run export                                # web/public/data/*.json 생성
```
한 번에: `npm run all` (fetch 옵션 없이 전체 선수 대상).

## 검수
```sql
-- 자동 추출 결과 확인
SELECT i.id, p.name, b.name_ko, i.side, i.injury_type, i.start_date, i.end_date, i.confidence, a.title
FROM injuries i JOIN players p ON p.id=i.player_id JOIN body_parts b ON b.id=i.body_part_id
JOIN articles a ON a.id=i.source_article_id ORDER BY i.confidence;
-- 오탐 처리
UPDATE injuries SET status='rejected' WHERE id=?;
```
