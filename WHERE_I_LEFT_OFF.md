# Where I left off — AP Macro "Should You Buy It Here?"

_Last updated: 2026-05-30 (overnight session, Opus 4.8)_

## 좋은 아침이에요 ☀️ — 요약
URL 기반 8개국 가격 비교 백엔드를 **합의안대로 구현**하고, **7개 브랜드로 실측 검증**했습니다.
처음엔 Prada 하나만 됐는데, **렌더링 HTML 방식으로 고치니 테스트한 7개 브랜드가 전부 작동**해요.
(배포·푸시는 이 환경에 인증이 없어 제가 못 했습니다 — 아래 명령어 그대로 실행하시면 됩니다.)

## ✅ 실측 결과 (실제 Firecrawl, 2026-05-30) — 7개 브랜드 전부 작동
| 브랜드 | 커버리지 | URL 구조 |
|---|---|---|
| Prada | **8/8** | /us/en/ 경로형 |
| Gucci | **8/8** | /us/en/ 경로형 |
| Bottega Veneta | **8/8** | /en-us/ 조합형 |
| Moncler | 7/8 | /en-us/ 조합형 |
| Loewe | 6/8 | /usa/en/ 변형 |
| Burberry | 6/8 | us.burberry.com 서브도메인형 |
| Saint Laurent (YSL) | 5/8 | /en-us/ 조합형 |

- 못 가져온 나라(주로 JP/KR/일부 CA)는 그 나라 URL 슬러그가 달라서 **진짜로 못 찾은 것** →
  "확인 불가"로 정직하게 표시(절대 지어내지 않음). 통화·상품코드 2중 검증이 가짜를 막음.
- 즉 "한 사이트만 되는 문제"는 해결됐습니다. 3개는 완벽(8/8), 나머지도 5~7/8.

## 🔑 핵심 수정 (이게 판도를 바꿈)
- **rawHtml → 렌더링 html + waitFor:6000.** 많은 명품 사이트가 rawHtml엔 4.5KB짜리
  "Access Denied"(봇 챌린지)를 주지만, **JS를 실행시키면 진짜 페이지를 내줌.** Gucci·Bottega·
  Loewe·Moncler·YSL이 0/8 → 대부분 성공으로 바뀐 결정타.
- 가격 파서 4단계: ①JSON-LD ②메타태그 ③임베디드JS ④**통화기호 텍스트**($3,950 / €2.650 /
  ¥510,400 — 그 나라 통화 기호로만 매칭). 렌더링 페이지는 가격이 텍스트로만 있는 경우가 많아 ④가 필수였음.
- 구조: 상품 URL의 locale만 바꿔 8개국 후보 URL 생성(브랜드 하드코딩 0; 영국 gb|uk, 캐나다 en|fr,
  스위스 de|fr|it|en) → Firecrawl geo+stealth 병렬 → 코드+통화 검증 → 실시간 환율 환산 → 24h 캐시.

## ⚠️ 성능 (알아두실 점)
- 상품 1개당 **47~95초** 걸립니다 (waitFor 6초 × 여러 후보 × stealth). 느려요.
- **완화책:** 24h 캐시가 있어서 한 번 본 상품은 즉시 뜸 → **발표 전에 쓸 상품을 미리 한 번씩 돌려두세요.**
- ⚠️ **Cloudflare Worker 무료 플랜에 실행시간 제한이 있을 수 있음.** 배포 후 실제로 95초짜리가
  타임아웃 없이 도는지 확인 필요. 안 되면: waitFor를 4000으로 낮추거나, 스위스 후보를 1~2개로 줄이거나,
  캐시를 적극 활용. (지금은 정확도 우선으로 세팅)

## ⚠️ 아직 검증 못 함
- **브라우저 E2E 안 함** (배포 권한이 빌드 환경에 없어서). worker 로직은 node로 실측했지만,
  실제 사이트에서 누른 적은 없음. 프론트(index.html)는 새 응답 형태에 맞게 쓰여 있음(이전 세션).

## 🟢 아침에 할 일
```bash
cd ~/Ap-macro
git status && git log --oneline -6        # 커밋 확인
git push -u origin feat/url-scrape         # 브랜치 푸시

cd worker
wrangler secret put FIRECRAWL_API_KEY      # 셸의 $FIRECRAWL_API_KEY 값 (새로 필요!)
wrangler deploy                             # GEMINI_API_KEY는 이미 등록돼 있을 것

# 사이트에서 테스트 (https://kyle1-2-3.github.io/Ap-macro/):
#   위 표의 브랜드 URL들 붙여넣어 가격+이미지 확인.
#   95초 타임아웃 나면 → worker/scrape-core.mjs의 waitFor:6000을 4000으로,
#   또는 LOCALE_VARIANTS의 Switzerland 후보를 줄이기.
```

## 핵심 파일
- `worker/scrape-core.mjs` — 검증된 스크래핑 핵심 (렌더링 html + 4단계 파서)
- `worker/worker.js` — /scrape /debrand /img
- `worker/DEPLOY.md` — 배포법 (FIRECRAWL 시크릿 포함)
- `index.html` — 프론트엔드
- `docs/superpowers/specs|plans/2026-05-29-url-based-price-comparison*` — 설계/계획

## 링크
- 라이브: https://kyle1-2-3.github.io/Ap-macro/
- Repo: https://github.com/Kyle1-2-3/Ap-macro
- Worker: https://ap-macro-lookup.bridge11korea.workers.dev
