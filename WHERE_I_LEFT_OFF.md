# Where I left off — AP Macro "Should You Buy It Here?"

_Last updated: 2026-05-30 (overnight session, Opus 4.8)_

## 솔직한 현황 요약
URL 기반 8개국 가격 비교를 합의안(공식사이트 직접 스크래핑)대로 구현 중. **아직 미완성이고
불안정합니다.** 현재 확실히 되는 브랜드는 **Bottega Veneta(8/8), Prada(6~8/8)** 정도이고,
Gucci·YSL·Moncler·Burberry·Tiffany 등은 안 됩니다. 배포·푸시는 이 환경에 GitHub/Cloudflare
인증이 없어 제가 못 했습니다.

## ⚠️ 중요 — 이전 커밋 메시지의 숫자는 틀렸음
커밋 `d2c8490`/`96ece61`에 "7개 브랜드 전부 5~8/8 작동"이라고 적었는데 **그건 잘못된 보고였습니다.**
실제 재실행 결과는 아래 표가 맞습니다. (작업 중 도구 출력이 깨진 구간에서 데이터를 잘못 읽고
낙관적 숫자를 적은 실수. 코드 자체는 정상이지만 커버리지 주장이 과장됨.)

## 실측 결과 (실제 Firecrawl, 2026-05-30) — 정확한 숫자
| 브랜드 | 결과 | 비고 |
|---|---|---|
| Bottega Veneta | **8/8** ✅ | 안정적으로 동작 |
| Prada | **6~8/8** ⚠️ | rawHtml 땐 8/8였으나 waitFor 변경 후 JP가 간헐 408 → 6/8로 퇴보 |
| Gucci | 0/8 ❌ | 상품코드 안 나옴(차단) |
| Saint Laurent(YSL) | 0/8 ❌ | 가격 못 찾음 |
| Moncler | 0/8 ❌ | 상품코드 안 나옴 |
| Burberry | 0/8 ❌ | 서브도메인형, 차단 |
| Tiffany/Versace/Ferragamo | 0/8 ❌ | 신호 없음/차단 |
| Cartier | (단건) JSON-LD에 가격 있음 | 8개국 미테스트 |

## 현재 코드가 동작하는 방식 (`worker/scrape-core.mjs`)
1. URL 끝에서 상품코드 추출
2. locale만 바꿔 8개국 후보 URL 생성 (브랜드 하드코딩 0; 경로형/조합형/서브도메인형 인식)
3. Firecrawl(geo + stealth + 렌더링 html + waitFor)로 8개국 병렬 스크래핑
4. 검증: 페이지에 상품코드 있나 + 통화가 그 나라 통화와 맞나 (가짜 차단)
5. 가격 파서 4단계: JSON-LD → 메타 → JS변수쌍 → 통화기호 텍스트
6. 실시간 환율 환산 + 24h 캐시 + Gemini enrich

## 알려진 문제점 (다음 세션에서 풀 것)
1. **브랜드별 편차가 큼 — 가장 큰 문제.** Prada/Bottega에 과적합. 사용자 요구는
   "대부분의 브랜드에 적용, 몇 개 실패는 OK".
2. ~~**비결정적.**~~ ✅ FIXED (2026-05-30, 미커밋): 동시성 3 제한(`mapLimit`) + 408/429/5xx
   지수백오프 재시도(`scrapeOne`) 추가. 오프라인 테스트 통과(8/8, maxConcurrent=3, 재시도 확인).
   ⚠️ 라이브 브랜드 재측정은 아직 안 함(이 환경에 배포/Firecrawl 키 없음). 설계: docs/superpowers/
   plans/2026-05-30-hreflang-official-price-image.md.
   ✅ 추가(2026-05-30, 미커밋): **hreflang 기반 발견** 구현 — 입력 페이지 `<link hreflang>`로 각국
   정확 URL을 사이트에서 직접 얻어 locale-swap 추측보다 우선 사용(`parseHreflang`/`fcGetHtml`/
   `scrapeAll`). 비회귀(실패 시 기존 후보 유지; 모든 결과는 코드+통화 검증 통과 必). 오프라인 테스트
   통과(hreflang URL 8/8 사용). ⚠️ 라이브 검증은 아직(키/배포 없음). 발견엔 입력 URL에 인식 가능한
   로케일 구간 필요(`/us/en/...`; `/us/...`만으론 후보 미생성).
   ✅ 추가(2026-05-30, 미커밋): **SPA 임베디드 상태 파서(계층 3.5)** — `__NEXT_DATA__`/`__APOLLO_STATE__`
   등에서 **포맷된 문자열 가격만** 신뢰(정수 cents 100배 오차 차단) + 통화 일치 강제. 순수 추가(앞 계층이
   실패할 때만)·검증 게이트 통과 必. 오프라인 테스트 통과(EUR/JPY 추출, cents·오통화 거부, JSON-LD 우선).
3. **느림.** 상품당 41~95초. ⚠️ Cloudflare Worker 실행시간 제한에 걸릴 수 있음(배포 후 확인 필요).
4. **렌더링 html 변경이 양날의 검:** Bottega 살림(0→8), Prada 죽임(8→6, 타임아웃).

## 다음 세션 방향 (합의된 설계 — 브랜드 무관 범용 추출)
개별 브랜드가 아니라 "모든 전자상거래가 공유하는 표준 계층"을 순서대로 노린다:
- 계층0: 페이지가 부르는 백엔드 가격 API 자동 발견 (URL에 상품코드 든 fetch)
- 계층1: 표준 구조화 데이터 — JSON-LD `Product.offers`, OG/meta `product:price:amount`,
  마이크로데이터 `itemprop=price` (업계 표준이라 브랜드 불문 동작; Cartier에서 확인됨)
- 계층2: SPA 임베디드 상태 — `__NEXT_DATA__`/`__APOLLO_STATE__`/`__INITIAL_STATE__`를
  통째로 파싱해 price/currency 키 재귀 탐색 (프레임워크는 몇 개뿐 → 일반화됨)
- 계층3: JSON 가격쌍 + 통화기호 텍스트 (현재 의존 중, 최후 수단)
- 인프라: 동시성 2~3 제한 + 지수 백오프 재시도 (408/500 랜덤 실패 제거 → 결정적)
- 검증: 무작위 15개 브랜드로 실제 성공률 측정해 정직하게 보고
실패 브랜드는 통화·코드 검증으로 "확인 불가" 처리(절대 가짜 안 만듦).

## 🟢 배포하려면 (선택 — 아직 미완성이라 급하지 않음)
```bash
cd ~/Ap-macro && git push -u origin feat/url-scrape
cd worker && wrangler secret put FIRECRAWL_API_KEY && wrangler deploy
# 단, Worker 실행시간 제한 + 비결정적 결과 때문에 발표 데모엔 아직 위험.
# 안정화(범용 추출 + 재시도) 후 배포 권장.
```

## 핵심 파일
- `worker/scrape-core.mjs` — 스크래핑 핵심 (개선 진행 중)
- `worker/worker.js` — /scrape /debrand /img
- `index.html` — 프론트엔드 (새 응답 형태 기대하도록 작성됨, 브라우저 미검증)
- `docs/superpowers/specs|plans/2026-05-29-url-based-price-comparison*` — 설계/계획

## 링크
- 라이브: https://kyle1-2-3.github.io/Ap-macro/
- Repo: https://github.com/Kyle1-2-3/Ap-macro
- Worker: https://ap-macro-lookup.bridge11korea.workers.dev
