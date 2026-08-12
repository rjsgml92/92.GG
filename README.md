# GG.92

리그 오브 레전드 전적 검색과 경기 종료 후 AI 복기를 제공하는 웹사이트입니다.

## 로컬 실행

```powershell
npm install
$env:RIOT_API_KEY="RGAPI-..."
$env:GEMINI_API_KEY="..." # 선택: 없으면 통계 기반 평가
npm start
```

- 정적 페이지: `index.html`, `evaluation.html`
- 백엔드: `server.js` (기본 포트 3000)
- AI 평가 API: `evaluation.js`

API 키는 `.env`나 배포 서비스의 환경 변수에만 보관하고 Git에 커밋하지 않습니다. `.env.example`에는 필요한 변수 이름만 정리되어 있습니다.

## Render 환경 변수

- `RIOT_API_KEY`: Riot Developer Portal에서 발급한 키
- `GEMINI_API_KEY`: Google AI Studio에서 발급한 Gemini API 키
- `GEMINI_MODEL`: 기본값 `gemini-3.5-flash-lite`
- `DDRAGON_VERSION`: 기본값 `16.15.1`

Gemini 호출은 공식 `@google/genai` JavaScript SDK를 사용합니다. 무료 티어의 정확한 요청 한도는 Google AI Studio의 Rate limits 화면에서 확인합니다.

## 평가 흐름

1. Riot ID와 서버로 PUUID를 조회합니다.
2. 최근 경기 목록을 불러옵니다.
3. 선택한 경기의 Match-V5와 Timeline 데이터를 요약합니다.
4. AI 키가 있으면 익명화한 경기 통계만 Gemini로 보내고, 없으면 통계 기반 평가를 표시합니다.

공개 운영 전에는 Riot Developer Portal에 제품을 등록하고, 프로덕션 키·사용자 인증·지속형 rate limit·봇 방지를 추가하는 것을 권장합니다.
