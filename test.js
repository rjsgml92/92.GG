// test.js
const axios = require('axios');

// 1. 너의 개인 API 키 세팅
const RIOT_API_KEY = "RGAPI-36321dd8-4272-4679-bc19-59415c97c8b9";

// 2. 대한민국에서 가장 확실하게 존재하는 계정 (페이커 선수 닉네임)으로 테스트
const gameName = encodeURIComponent("Hide on bush");
const tagLine = encodeURIComponent("KR1");

async function checkMyAPI() {
    console.log("=== 라이엇 API 키 작동 여부 테스트 시작 ===");
    try {
        // 아시아 서버에 페이커 선수 정보 요청
        const url = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}?api_key=${RIOT_API_KEY}`;
        
        console.log("1. 라이엇 서버에 신호 보내는 중...");
        const response = await axios.get(url);
        
        console.log("\n✅ [테스트 결과: 대성공!]");
        console.log("너의 API 키는 아주 정상적으로 잘 작동하고 있어!");
        console.log("----------------------------------------");
        console.log("▶ 가져온 데이터:", response.data);
        console.log("----------------------------------------");

    } catch (error) {
        console.log("\n❌ [테스트 결과: 실패]");
        if (error.response) {
            const status = error.response.status;
            console.log(`응답 에러 코드: ${status} (${error.response.statusText})`);
            
            if (status === 403) {
                console.log("💡 조언: 403 Forbidden인 것을 보니, 발급받은 지 24시간이 지나서 키가 만료된 것 같아! 라이엇 개발자 사이트에서 [Regenerate] 버튼을 눌러 새 키를 복사해 와야 해.");
            } else if (status === 404) {
                console.log("💡 조언: 404 Not Found인 것을 보니, 입력한 닉네임#태그를 라이엇 데이터베이스에서 찾을 수 없어. 다른 닉네임으로 테스트해봐!");
            }
        } else {
            console.log("에러 내용:", error.message);
            console.log("💡 조언: 인터넷 연결 상태나 네트워크 환경(방화벽 등)을 확인해봐.");
        }
    }
}

checkMyAPI();