insert into public.categories (slug, name, description, sort_order)
values
  ('beginner-guide', '초보자 가이드', '초반 성장, 기본 UI, 우선순위, 실수 방지 팁', 10),
  ('heroes', '영웅', '영웅 조합, 스킬, 등급, 육성 우선순위', 20),
  ('troops-formations', '병종/편성', '보병, 기병, 궁병, 행군 편성 및 비율', 30),
  ('buildings', '건물', '도시 건물, 업그레이드 조건, 기능 설명', 40),
  ('research', '연구', '아카데미 연구, 전투/경제/성장 연구 우선순위', 50),
  ('governor-gear', '영주 장비', '영주 장비 해금, 강화, 재료, 우선순위', 60),
  ('governor-charms', '영주 참/강화', '영주 참, 강화 재료, 해금 조건', 70),
  ('pets', '펫', '펫 해금, 스킬, 육성 및 전투 활용', 80),
  ('resources-items', '자원/아이템', '자원, 가속, 상자, 재료, 아이템 사용처', 90),
  ('alliance', '동맹', '동맹 운영, 도움, 상점, 기술, 역할', 100),
  ('alliance-territory', '동맹 영토/건물', '배너, 영토, 동맹 건물, 자원지', 110),
  ('events', '이벤트', '반복 이벤트, 보상표, 참여 전략', 120),
  ('combat-pvp', '전투/PvP', '전투 규칙, 정찰, 공격/방어, 병원 관리', 130),
  ('kvk-castle-battle', 'KvK/왕성전', '서버전, 왕성전, 대형 전투 운영', 140),
  ('shop-spending', '과금/상점/패키지', '상점, 패키지 효율, 과금 우선순위', 150),
  ('gift-codes', '쿠폰/기프트 코드', '쿠폰 코드와 보상 수령 방법', 160),
  ('calculators-upgrade-costs', '계산기/업그레이드 비용', '건물, 연구, 훈련, 장비 비용 계산', 170),
  ('faq-tips', 'FAQ/팁', '자주 묻는 질문과 짧은 팁', 180)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  sort_order = excluded.sort_order;
