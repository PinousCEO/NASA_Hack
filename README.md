# Mission Forge

2026 NASA Space Apps Challenge — **Space Mission Design Game (Challenge 13)** 용 협업 우주 미션 설계 플랫폼.

여러 명이 같은 미션을 Web과 WebXR(Meta Quest 브라우저)에서 동시에 설계하고, 자연어로 기능을 요청하면 AI가 계획·생성·검증·배포하며, 모든 변경은 실제 공학 모델로 재계산되어 전원에게 동기화됩니다.

> NASA와 무관한 독립 프로젝트입니다. 공학 모델은 가정이 명시된 1차 근사이고, 비용은 게임용 비용 모델입니다.

## 실행

```bash
npm install && npm run install:web   # 서버 + 웹 클라이언트 의존성
npm run build:web                    # Next.js 정적 빌드 (apps/web/out)
npm run dev                          # http://127.0.0.1:8787
```

Node 22 이상. 첫 번째로 가입한 계정이 플랫폼 관리자가 됩니다. 상태는 `.data/`에 저장됩니다. NASA에서 받은 영상 타일과 고도 데이터는 `.data/cache/`에 캐시됩니다(지워도 다시 받습니다).

| 명령 | 내용 |
|---|---|
| `npm test` | 단위·통합 테스트 116개 (JPL Horizons·NASA PDS·영상 타일 실연동, MCP 왕복, 4인 협업, TLS 포함) |
| `npm run e2e` | 실제 브라우저(Edge/Chrome) E2E 31개 — XR 에뮬레이션 포함. 먼저 `build:web` 필요 |
| `npm run typecheck` | 서버 + 웹 타입 검사 |
| `npm run dev:web` | 프런트엔드 개발 서버(3000). `ALLOWED_ORIGINS=http://localhost:3000`, `NEXT_PUBLIC_CORE_ORIGIN=http://127.0.0.1:8787` 설정 |
| `npm run mcp` | stdio MCP 서버 (읽기 전용 도구) |

### 환경 변수 (`.env.example` 참고 — 비밀값은 git에서 제외되는 `.env` 또는 환경에서만 읽음)

- `OPENAI_API_KEY`, `OPENAI_MODEL` — 모델 기반 요청 분석·다중 도구 계획·코드 생성·text-to-3D. 기본 모델은 `gpt-5.5`이며 `OPENAI_MODEL`로 바꿉니다(예: `gpt-6-astra`).
- `ANTHROPIC_API_KEY` — 대체 제공자. 두 키가 모두 있으면 `LLM_PROVIDER=openai|anthropic`으로 고정합니다.
- 키가 없으면 규칙 기반 분석기로 동작하고, 모델이 꼭 필요한 요청은 "추가 자원 필요"로 분류됩니다.
- `GMAT_BIN` — GMAT 콘솔 실행 파일 경로(`gmat.run` 활성화).
- `PDFTOTEXT_BIN` — PDF 색인용. Windows에서는 Git for Windows에 들어 있는 `pdftotext.exe`를 자동으로 찾습니다.
- `HOST`, `PORT`, `TLS_CERT_FILE`, `TLS_KEY_FILE` — LAN/HTTPS 제공.

### XR 테스트 방법

| 방법 | 여는 곳 | 확인할 수 있는 것 |
|---|---|---|
| **에뮬레이터** | PC 브라우저에서 미션 URL 뒤에 `&iwer=1` (예: `http://127.0.0.1:8787/mission?s=<id>&iwer=1`) → 상단의 **Enter MR** | 세션 진입, 공간 패널·슬라이더, 컨트롤러 그랩 로직. 소프트웨어 Quest 3(IWER)이므로 패스스루·손 추적·성능은 볼 수 없음 |
| **Quest 실기 (USB)** | `adb reverse tcp:8787 tcp:8787` 후 헤드셋의 Meta Quest Browser에서 `http://localhost:8787` | 전부 |
| **Quest 실기 (Wi-Fi)** | `HOST=0.0.0.0` + `TLS_CERT_FILE`/`TLS_KEY_FILE` 지정 후 `https://<PC IP>:8787` | 전부 (WebXR은 보안 컨텍스트가 필요해 HTTPS 필수) |

자동 검사는 `npm run e2e`가 에뮬레이터로 수행합니다.

## 구성

```
apps/web/            Next.js 16 + React 19 + Three.js + IWSDK (정적 export, 서버가 같은 오리진으로 제공)
  app/               랜딩 · 인증 · 로비 · 미션 작업공간 · 리더보드 · 연구 기록
  lib/scene/         space(NASA 영상·고도 기반 행성, 하늘, 태양) · models(비행 하드웨어 모델)
                     · MissionScene(궤도/시스템 뷰) · fx(블룸·필름 그레이드)
  lib/xr/            IWSDK World, XR 능력 감지, 그랩, 공간 슬라이더·패널·키보드
  components/        HUD 패널, 모션 프리미티브, 타임라인·궤적·착륙지 조사
src/
  platform/          인증, 감사 로그, 시크릿, 세션 관리자(멤버·권한·편집·게임)
  server/            HTTP API, WebSocket 협업 허브
  pipeline/          요구사항 분석 → 계획 → 실현 가능성 → 실행 → 미리보기/승인
  registry/ capabilities/ sandbox/ mcp/   Capability Registry, 28개 capability, QuickJS, MCP
  llm/               OpenAI · Anthropic 제공자
  science/ nasa/     궤도·전력·통신·로버 모델, J2 전파기, GMAT, 지형(DEM), 영상 타일, 수명주기/CML
  game/              시나리오, 미션 생성, 일 단위 시뮬레이션, 채점
  knowledge/ memory/ 지식 베이스(BM25, RAG 컨텍스트), 연구 기록
tests/               vitest 8개 파일 + tests/e2e (Playwright)
```

## 무엇이 구현되어 있는가

**그래픽** — 행성은 NASA 실측 데이터로 그립니다: 달은 LROC WAC 모자이크 + LOLA 고도, 화성은 Viking MDIM 2.1 + MOLA 고도, 지구는 Blue Marble + VIIRS 야간 조명(구름·대기는 절차적). 영상이 도착하기 전과 오프라인에서는 절차적 표면으로 대체됩니다. 우주선·부품은 설계 수치(어레이 면적, 안테나 지름, 구경, 배터리 용량, 버스 질량)로부터 만드는 PBR 모델(구겨진 MLI, 커버글라스 태양전지, 가공 알루미늄, 열제어 도료)이고, 데스크톱에서는 HDR 블룸과 필름 그레이드를 거칩니다. 소프트웨어 렌더러와 헤드셋에서는 가벼운 등급으로 자동 전환됩니다. 궤도 뷰의 우주선은 보이도록 확대되어 있으며 화면에 "not to scale"로 표시됩니다.

**WebXR 작업공간** — 하나의 IWSDK World가 데스크톱과 헤드셋을 모두 렌더링합니다. `immersive-ar`(패스스루 MR) 우선, 없으면 `immersive-vr`, 둘 다 없으면 데스크톱 모드와 그 이유를 표시합니다. XR에서는 가슴 높이의 "미션 테이블"에 궤도/시스템 뷰가 놓이고, 공간 슬라이더(고도·경사각·미션일)와 부품을 잡아 옮길 수 있으며, 상태 패널·명령 패널·공간 키보드가 제공됩니다.

**실시간 멀티플레이** — 세션당 최대 8명. 클라이언트는 *의도*(편집, 잠금, 프레즌스)만 보내고 서버가 권위 상태를 버전 단위로 방송합니다. 같은 필드를 동시에 고치면 뒤늦은 쪽이 현재 값과 함께 거절되고, 다른 필드는 자동 병합됩니다. 재접속 시 놓친 버전 목록을 받습니다.

**자연어 런타임 빌더** — 상태 검사 → 분석(지식 베이스 검색 결과를 프롬프트에 포함) → capability 탐색 → 실현 가능성 → 계획 → 에셋/컴포넌트/스크립트 생성 → 격리 테스트 → 미리보기 → 승인 → 배포 → 동기화. 생성 코드는 QuickJS(WASM) 샌드박스에서만 실행됩니다. 모델이 만든 결과는 정책과 무관하게 승인이 필요합니다.

**Text-to-3D** — 설명을 *형상 프로그램*(크기·자세·재질이 있는 프리미티브 목록, 최대 64개)으로 바꾸고, 이를 결정적으로 GLB로 컴파일해 장면에 배치합니다. 언어 모델이 있으면 모델이 형상 프로그램을 쓰고, 없으면 키워드 조합기가 흔한 우주선 부품(탱크, 엔진, 붐, 망원경, 접시 안테나, 태양전지, 라디에이터, 바퀴, 착륙 다리, 장비 박스)만 인식합니다. 신경망 메시 생성기가 아니라 프리미티브 조립이므로 결과는 공학 목업 수준입니다.

**NASA 연동**

| 항목 | 상태 |
|---|---|
| JPL Horizons 상태 벡터 | 실연동 (테스트에서 실시간 호출) |
| 지형 DEM — 달 LOLA LDEM_4, 화성 MOLA MEGDR | 실연동 (NASA PDS). 알려진 지형(올림푸스 산, 헬라스, 남극-에이트켄 분지, 전역 최고·최저점)으로 검증. 해상도 7.6 km(달)/14.8 km(화성)라 **광역 경사만** 제공하며 착륙선 규모 지형은 아님 |
| 행성 영상 — NASA Solar System Treks, GIBS | 실연동. 허용 목록의 레이어·줌만 프록시하고 디스크에 캐시 |
| 궤도·일식·전력·링크·로버 | 결정적 계산, 문헌 기준값으로 검증 |
| J2 수치 전파 | 근사 (해석적 세차율과 3% 이내 일치). 고차 중력·제3체·항력 없음. 궤도 뷰에 오버레이 가능 |
| GMAT 스크립트 생성 / 리포트 가져오기 | 구현. 가져온 궤적은 궤도 뷰에 오버레이로 그려짐. 생성 스크립트는 GMAT으로 실행해 검증하지 못함(미설치) |
| GMAT 실행 (`gmat.run`) | `GMAT_BIN` 없으면 사용 불가로 표시 |
| SE 수명주기, CML 1–9, 임무 세그먼트, MDL 분과 | 참조 데이터 + CML 1–5 규칙 기반 평가 (교육용, 공식 리뷰 아님) |
| CubeSat 개념 | 6U 시나리오(12 kg 제한, 디스펜서 제약) |

**게임** — 시나리오 3개(달 남극 휘발성 물질 탐사 / 6U CubeSat / 화성 기상·중계), 시드 기반 미션 생성, 분과 좌석, 부품 카탈로그, 트레이드 스터디, 1일 단위 미션 시뮬레이션, 재생 가능한 미션 타임라인, CML 기반 단계 게이트, 결정적 채점과 피드백, 제출, 리더보드.

**연구 지식 플랫폼** — 미션 문제, 가설, 사용자 기여, 설계 변경, AI 평가, 도구 실행, 시뮬레이션, 결과가 출처·가정·검증 수준과 함께 기록됩니다. `/api/knowledge/context`가 인용 번호가 붙은 RAG 컨텍스트를 반환하고, 같은 검색이 모델 기반 요청 분석 프롬프트에 들어가며 사용된 출처가 요청 기록에 남습니다.

**보안·신뢰성** — scrypt 해시 비밀번호, 폐기 가능한 불투명 세션, HttpOnly 쿠키, 로그인 속도 제한, WebSocket 일회용 티켓, 서버 측 역할 검사, CSRF 오리진 검사, CSP, 해시 체인 감사 로그, 영속 제안·요청·버전, 시크릿은 환경에서만 읽고 응답·로그에서 제거(OpenAI 키 형식 포함).

## 검증 상태

검증됨:
- 서버: 116개 테스트 (인증, 감사 체인 변조 탐지, 4개 WebSocket 동시 편집·충돌·잠금·재접속, 세 시나리오 모두 브리핑부터 채점·제출까지 완주, 재시작 후 대기 제안 복원, OpenAI 제공자의 요청 형식·검증·오류 매핑(전송 계층 대역), text-to-3D 컴파일러, DEM 보간·경사 수학, 타일 프록시 허용 목록, HTTPS 제공)
- NASA 실데이터: LOLA·MOLA 고도가 공개된 지형 수치와 일치, Trek·GIBS 타일 수신
- 브라우저: 31개 E2E 검사 (가입 → 미션 생성 → NASA 영상으로 텍스처된 장면 → 두 참가자 동기화 → 카탈로그 부품 → text-to-3D 승인 후 GLB 로딩과 동기화 → 자연어 요청 → J2 오버레이 → 시뮬레이션 → 평가 대시보드)
- XR(에뮬레이터): `immersive-ar` 세션 시작, 컨트롤러로 공간 슬라이더 그랩, 놓을 때 편집 커밋, 데스크톱 참가자 동기화, 세션 종료
- OpenAI 실호출: `gpt-6-astra`로 구조화 응답 1건, 요청 분석 → text-to-3D → 승인 → 배포 1건을 수동으로 확인

**검증하지 못한 것**
- **실물 헤드셋**: Quest 실기 테스트를 하지 못했습니다. 패스스루 표시, 손 추적 핀치 그랩, 텍스트 가독성·편안함, 새 그래픽의 기기 프레임률은 미확인입니다. XR에서 패널 버튼 레이 클릭, 공간 키보드, 부품 그랩·배치, 원격 참가자 아바타 표시는 코드는 있으나 자동 검사 대상이 아니었습니다.
- **4대 동시 헤드셋**: 프로토콜 수준에서 4개 연결을 테스트했고 브라우저 E2E는 3개 컨텍스트입니다.
- **언어 모델 경로의 자동 회귀**: 자동 테스트는 대역 모델을 씁니다. 실호출은 위의 수동 확인 2건뿐이며, 모델 기반 다중 도구 계획과 스크립트 생성은 실호출로 돌려 보지 않았습니다.
- **GMAT**: 생성 스크립트와 `gmat.run`은 실제 GMAT으로 실행해 보지 못했습니다. 리포트 가져오기는 GMAT ReportFile 형식으로 쓴 자체 전파 결과로 테스트했습니다.

알려진 한계: 지식 검색은 어휘 기반(BM25)입니다. 궤도 뷰의 지구는 중심 천체일 때만 그려지며, 달·화성 미션에서 안테나가 지구를 향하도록 조준하지는 않습니다. 타임라인 재생은 태양 기하(일식 구간)의 미리보기이고 수치는 미션 시뮬레이션이 계산합니다.

## 데이터 출처

행성 영상·지형: NASA/GSFC/Arizona State University (LROC), NASA/GSFC/MIT (LOLA), NASA/JPL/USGS (Viking MDIM 2.1), NASA/GSFC (MOLA), NASA Earth Observatory (Blue Marble, VIIRS) — NASA Solar System Treks, NASA GIBS, PDS Geosciences Node 경유. 천체력: NASA/JPL Horizons.
