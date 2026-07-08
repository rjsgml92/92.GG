// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const DDRAGON_VERSION = "14.22.1"; 

function normalizeLane(position) {
    const value = String(position || "").toUpperCase();

    if (["TOP", "JUNGLE", "MIDDLE"].includes(value)) return value;
    if (value === "MID") return "MIDDLE";
    if (["BOTTOM", "UTILITY"].includes(value)) return "BOTTOM";

    return "NONE";
}

function getLaneGroup(participant) {
    return normalizeLane(
        participant?.individualPosition ||
        participant?.teamPosition ||
        participant?.lane ||
        participant?.position ||
        participant?.role
    );
}

function formatLaneLabel(laneGroup) {
    switch (laneGroup) {
        case "TOP": return "탑";
        case "JUNGLE": return "정글";
        case "MIDDLE": return "미드";
        case "BOTTOM": return "봇";
        default: return "라인";
    }
}

function buildLaneSnapshot(participants, frameParticipantFrames) {
    return participants.reduce((acc, participant) => {
        const frame = frameParticipantFrames?.[String(participant.participantId)] || {};
        const cs = frame.minionsKilled ?? participant.totalMinionsKilled ?? 0;
        const neutralCs = frame.neutralMinionsKilled ?? frame.jungleMinionsKilled ?? participant.neutralMinionsKilled ?? 0;
        const gold = frame.totalGold ?? participant.goldEarned ?? 0;

        acc.gold += gold;
        acc.cs += cs + neutralCs;
        acc.kills += participant.kills ?? 0;
        acc.deaths += participant.deaths ?? 0;
        acc.assists += participant.assists ?? 0;
        acc.names.push(participant.riotIdGameName || participant.summonerName || participant.championName);
        return acc;
    }, { gold: 0, cs: 0, kills: 0, deaths: 0, assists: 0, names: [] });
}

function buildParticipantSnapshot(participant, frameParticipantFrames) {
    const frame = frameParticipantFrames?.[String(participant.participantId)] || {};
    const cs = frame.minionsKilled ?? participant.totalMinionsKilled ?? 0;
    const neutralCs = frame.neutralMinionsKilled ?? frame.jungleMinionsKilled ?? participant.neutralMinionsKilled ?? 0;
    const gold = frame.totalGold ?? participant.goldEarned ?? 0;

    return {
        participantId: participant.participantId,
        teamId: participant.teamId,
        laneGroup: getLaneGroup(participant),
        name: participant.riotIdGameName || participant.summonerName || participant.championName,
        championName: participant.championName,
        gold,
        cs: cs + neutralCs,
        kills: participant.kills ?? 0,
        deaths: participant.deaths ?? 0,
        assists: participant.assists ?? 0
    };
}

function compareLaneSnapshots(mySnapshot, enemySnapshot) {
    const goldDiff = mySnapshot.gold - enemySnapshot.gold;
    const csDiff = mySnapshot.cs - enemySnapshot.cs;
    const score = goldDiff + (csDiff * 20);

    if (score > 120) return { result: "WIN", label: "승리", score, goldDiff, csDiff };
    if (score < -120) return { result: "LOSE", label: "패배", score, goldDiff, csDiff };
    return { result: "EVEN", label: "비김", score, goldDiff, csDiff };
}

function getLaneVerdict(myLane, enemyLane) {
    const goldDiff = myLane.gold - enemyLane.gold;
    const csDiff = myLane.cs - enemyLane.cs;
    const score = goldDiff + (csDiff * 20);

    if (score > 120) return { result: "WIN", label: "승리", score, goldDiff, csDiff };
    if (score < -120) return { result: "LOSE", label: "패배", score, goldDiff, csDiff };
    return { result: "EVEN", label: "비김", score, goldDiff, csDiff };
}

async function fetchLaneAnalysis(matchId, myParticipant, allParticipants) {
    let frameParticipantFrames = null;
    try {
        const timelineUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${RIOT_API_KEY}`;
        const timelineResponse = await axios.get(timelineUrl);
        const frames = timelineResponse.data?.info?.frames || [];
        const frame15 = frames.find(f => f.timestamp >= 900000) || frames[frames.length - 1];
        frameParticipantFrames = frame15?.participantFrames || null;
    } catch (e) {
        frameParticipantFrames = null;
    }

    const participantSnapshots = allParticipants.map(participant => buildParticipantSnapshot(participant, frameParticipantFrames));
    const mySnapshot = participantSnapshots.find(p => p.participantId === myParticipant.participantId);

    if (!mySnapshot) {
        return {
            laneGroup: "UNKNOWN",
            result: "UNKNOWN",
            label: "판정 불가",
            detail: "내 참가자 정보를 찾지 못했습니다."
        };
    }

    const directLaneGroup = mySnapshot.laneGroup;
    let myLane;
    let enemyLane;
    let laneGroup = directLaneGroup;
    let usingFallback = false;

    if (directLaneGroup !== "NONE") {
        const allies = participantSnapshots.filter(p => p.teamId === mySnapshot.teamId && p.laneGroup === directLaneGroup);
        const enemies = participantSnapshots.filter(p => p.teamId !== mySnapshot.teamId && p.laneGroup === directLaneGroup);

        if (allies.length && enemies.length) {
            myLane = buildLaneSnapshot(allies, frameParticipantFrames);
            enemyLane = buildLaneSnapshot(enemies, frameParticipantFrames);
        }
    }

    if (!myLane || !enemyLane) {
        usingFallback = true;
        laneGroup = directLaneGroup === "NONE" ? "UNKNOWN" : directLaneGroup;
        const enemyCandidates = participantSnapshots.filter(p => p.teamId !== mySnapshot.teamId);
        if (!enemyCandidates.length) {
            return {
                laneGroup,
                result: "UNKNOWN",
                label: "판정 불가",
                detail: "상대 팀 참가자 정보를 찾지 못했습니다.",
                goldDiff: 0,
                csDiff: 0,
                myTeamNames: [],
                enemyTeamNames: []
            };
        }
        const opponent = enemyCandidates.reduce((best, candidate) => {
            if (!best) return candidate;
            const bestScore = Math.abs((mySnapshot.gold - best.gold)) + Math.abs((mySnapshot.cs - best.cs) * 20);
            const candidateScore = Math.abs((mySnapshot.gold - candidate.gold)) + Math.abs((mySnapshot.cs - candidate.cs) * 20);
            return candidateScore < bestScore ? candidate : best;
        }, null);

        myLane = mySnapshot;
        enemyLane = opponent;
    }

    const verdict = compareLaneSnapshots(myLane, enemyLane);
    const laneName = directLaneGroup !== "NONE" ? formatLaneLabel(directLaneGroup) : "상대";
    const detailPrefix = usingFallback ? "추정" : "기준";

    return {
        laneGroup,
        result: verdict.result,
        label: verdict.label,
        detail: `${laneName} ${detailPrefix} ${myLane.gold.toLocaleString()}G / ${myLane.cs}CS vs ${enemyLane.gold.toLocaleString()}G / ${enemyLane.cs}CS`,
        goldDiff: verdict.goldDiff,
        csDiff: verdict.csDiff,
        myTeamNames: [],
        enemyTeamNames: []
    };
}

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

// 🔴 실시간 게임 상태 확인 API
app.get('/api/live/:gameName/:tagLine', async (req, res) => {
    try {
        const gameName = encodeURIComponent(req.params.gameName);
        const tagLine = encodeURIComponent(req.params.tagLine);
        
        const accountUrl = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}?api_key=${RIOT_API_KEY}`;
        const accountResponse = await axios.get(accountUrl);
        const puuid = accountResponse.data.puuid;

        const specUrl = `https://kr.api.riotgames.com/lol/spectator/v4/active-games/by-summoner/${puuid}?api_key=${RIOT_API_KEY}`;
        const specResponse = await axios.get(specUrl);
        
        res.json(specResponse.data);
    } catch (e) {
        res.status(e.response?.status || 500).json({ error: "현재 게임 중이 아니거나 정보를 가져올 수 없습니다." });
    }
});

// 📈 라인전 승패 분석 API (Timeline 데이터 활용)
app.get('/api/match/:matchId/timeline', async (req, res) => {
    try {
        const matchId = req.params.matchId;
        const timelineUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${RIOT_API_KEY}`;
        const response = await axios.get(timelineUrl);
        const frames = response.data.info.frames;
        
        // 15분(900초) 시점의 프레임 찾기
        const frame15 = frames.find(f => f.timestamp >= 900000) || frames[frames.length - 1];
        const participantFrames = frame15.participantFrames;

        // 각 플레이어의 15분 시점 스탯 추출
        const laneStats = participantFrames.map(pf => ({
            puuid: pf.puuid,
            totalGold: pf.totalGold,
            totalCs: pf.totalMinionsKilled + pf.neutralMinionsKilled
        }));

        res.json({
            timestamp: frame15.timestamp,
            stats: laneStats
        });
    } catch (e) {
        res.status(500).json({ error: "타임라인 데이터를 가져오는 데 실패했습니다." });
    }
});

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
                        participantId: p.participantId,
                        teamId: p.teamId,
                        individualPosition: p.individualPosition,
                        teamPosition: p.teamPosition,
                        lane: p.lane,
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

                    const laneAnalysis = await fetchLaneAnalysis(matchId, myData, matchDetail.data.info.participants);
                    
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
                        participants: participants,
                        laneAnalysis: laneAnalysis
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
