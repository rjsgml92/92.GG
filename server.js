// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const DDRAGON_VERSION = "14.22.1"; 

// 🎮 게임 큐 ID별 매치 종류 한글 변환 함수
function getQueueModeKr(queueId, gameMode) {
    switch(queueId) {
        case 420: return "솔랭";
        case 440: return "자유랭";
        case 450: return "칼바람";
        case 430: return "일반";
        case 490: return "빠른 대전";
        case 1700: return "아레나";
        default: 
            if(gameMode === "CLASSIC") return "일반 국전";
            return gameMode;
    }
}

app.get('/api/summoner/:gameName/:tagLine', async (req, res) => {
    let errorTracker = {};

    try {
        const gameName = encodeURIComponent(req.params.gameName);
        const tagLine = encodeURIComponent(req.params.tagLine);
        
        console.log(`[종합 전적 요청] ${req.params.gameName} # ${req.params.tagLine}`);

        let accountResponse;
        try {
            const accountUrl = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}?api_key=${RIOT_API_KEY}`;
            accountResponse = await axios.get(accountUrl);
        } catch (e) {
            return res.status(e.response?.status || 500).json({
                error: "계정 조회 실패",
                message: `닉네임#태그가 틀렸거나 API키가 만료됨. (코드: ${e.response?.status})`
            });
        }

        const puuid = accountResponse.data.puuid;

        let summonerResponse;
        try {
            const summonerUrl = `https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${RIOT_API_KEY}`;
            summonerResponse = await axios.get(summonerUrl);
        } catch (e) {
            return res.status(e.response?.status || 500).json({
                error: "소환사 정보 조회 실패",
                message: `기본 정보를 가져오지 못했습니다. (코드: ${e.response?.status})`
            });
        }

        let tierInfo = { tier: "UNRANKED", rank: "", leaguePoints: 0, wins: 0, losses: 0, winRate: "0%" };
        try {
            const leagueUrl = `https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${RIOT_API_KEY}`;
            const leagueResponse = await axios.get(leagueUrl);
            const soloRank = leagueResponse.data.find(entry => entry.queueType === "RANKED_SOLO_5x5");
            
            if (soloRank) {
                tierInfo = {
                    tier: soloRank.tier,
                    rank: soloRank.rank,
                    leaguePoints: soloRank.leaguePoints,
                    wins: soloRank.wins,
                    losses: soloRank.losses,
                    winRate: ((soloRank.wins / (soloRank.wins + soloRank.losses)) * 100).toFixed(1) + "%"
                };
            }
        } catch (tierError) {
            console.log("⚠️ 티어 정보 조회 실패:", tierError.message);
            errorTracker.tier_api = `실패 (코드: ${tierError.response?.status || 'Network'})`;
        }

        let matchHistory = [];
        try {
            const matchIdsUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5&api_key=${RIOT_API_KEY}`;
            const matchIdsResponse = await axios.get(matchIdsUrl);
            const matchIds = matchIdsResponse.data;

            const matchHistoryPromises = matchIds.map(async (matchId) => {
                try {
                    const matchDetailUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${RIOT_API_KEY}`;
                    const matchDetail = await axios.get(matchDetailUrl);
                    const myData = matchDetail.data.info.participants.find(p => p.puuid === puuid);
                    
                    const normalItems = [myData.item0, myData.item1, myData.item2, myData.item3, myData.item4, myData.item5]
                        .filter(id => id !== 0); 

                    while (normalItems.length < 6) {
                        normalItems.push(0);
                    }

                    const finalItemOrder = [...normalItems, myData.item6];
                    const queueId = matchDetail.data.info.queueId;
                    const gameModeRaw = matchDetail.data.info.gameMode;

                    // 👥 1:1 비교를 위한 매치 전체 참가자 데이터 매핑
                    const participants = matchDetail.data.info.participants.map(p => ({
                        gameName: p.riotIdGameName || p.summonerName,
                        tagLine: p.riotIdTagline || "KR1",
                        championName: p.championName,
                        championImageUrl: `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${p.championName}.png`,
                        kills: p.kills,
                        deaths: p.deaths,
                        assists: p.assists,
                        kda: ((p.kills + p.assists) / (p.deaths || 1)).toFixed(2),
                        totalDamageDealtToChampions: p.totalDamageDealtToChampions,
                        goldEarned: p.goldEarned,
                        totalMinionsKilled: p.totalMinionsKilled + p.neutralMinionsKilled,
                        visionScore: p.visionScore,
                        win: p.win
                    }));
                    
                    return {
                        matchId: matchId,
                        // 💡 영어 모드명 대신 친근한 한글 텍스트 대입
                        gameMode: getQueueModeKr(queueId, gameModeRaw),
                        gameDuration: matchDetail.data.info.gameDuration,
                        win: myData.win,
                        championName: myData.championName,
                        championImageUrl: `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${myData.championName}.png`,
                        kills: myData.kills,
                        deaths: myData.deaths,
                        assists: myData.assists,
                        kda: ((myData.kills + myData.assists) / (myData.deaths || 1)).toFixed(2),
                        totalDamageDealtToChampions: myData.totalDamageDealtToChampions,
                        goldEarned: myData.goldEarned,
                        totalMinionsKilled: myData.totalMinionsKilled + myData.neutralMinionsKilled,
                        visionScore: myData.visionScore,
                        itemIds: finalItemOrder,
                        participants: participants
                    };
                } catch (e) {
                    return { matchId: matchId, error: "매치 로드 실패" };
                }
            });
            matchHistory = await Promise.all(matchHistoryPromises);
        } catch (matchError) {
            console.log("⚠️ 매치 리스트 조회 실패:", matchError.message);
            errorTracker.match_list_api = `실패 (코드: ${matchError.response?.status})`;
        }

        res.json({
            errors: Object.keys(errorTracker).length > 0 ? errorTracker : "None",
            profile: {
                gameName: accountResponse.data.gameName,
                tagLine: accountResponse.data.tagLine,
                summonerLevel: summonerResponse.data.summonerLevel,
                profileIconUrl: `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/profileicon/${summonerResponse.data.profileIconId}.png`,
                rankInfo: tierInfo
            },
            history: matchHistory
        });

    } catch (error) {
        console.error("Fatal Error:", error.message);
        res.status(500).json({ error: "서버 내부 치명적 에러", message: error.message });
    }
});

// 기존: app.listen(3000, () => { ... })
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});