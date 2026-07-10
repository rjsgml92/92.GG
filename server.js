// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const DDRAGON_VERSION = "14.22.1"; 

const LANE_SLOT_ORDER = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

function normalizePosition(position) {
    const value = String(position || "").toUpperCase();
    if (["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"].includes(value)) return value;
    if (value === "MID") return "MIDDLE";
    if (value === "SUPPORT") return "UTILITY";
    return "NONE";
}

function getPosition(participant) {
    return normalizePosition(
        participant?.teamPosition ||
        participant?.individualPosition ||
        participant?.lane ||
        participant?.position ||
        participant?.role
    );
}

function getLaneGroupFromPosition(position) {
    if (position === "BOTTOM" || position === "UTILITY") return "BOTTOM";
    if (["TOP", "JUNGLE", "MIDDLE"].includes(position)) return position;
    return "NONE";
}

function getLaneGroup(participant) {
    return getLaneGroupFromPosition(getPosition(participant));
}

function getLaneLabel(laneGroup) {
    switch (laneGroup) {
        case "TOP": return "탑";
        case "JUNGLE": return "정글";
        case "MIDDLE": return "미드";
        case "BOTTOM": return "봇";
        default: return "라인";
    }
}

function getParticipantFrame(frameMap, participantId) {
    return frameMap?.[String(participantId)] || frameMap?.[participantId] || null;
}

function buildLaneUnit(participants, frameMap) {
    return participants.reduce((acc, participant) => {
        const frame = getParticipantFrame(frameMap, participant.participantId);
        const laneCs = frame?.minionsKilled ?? participant.totalMinionsKilled ?? 0;
        const jungleCs = frame?.jungleMinionsKilled ?? frame?.neutralMinionsKilled ?? participant.neutralMinionsKilled ?? 0;
        const gold = frame?.totalGold ?? participant.goldEarned ?? 0;
        const xp = frame?.xp ?? 0;
        const level = frame?.level ?? 0;

        acc.gold += gold;
        acc.cs += laneCs + jungleCs;
        acc.xp += xp;
        acc.level += level;
        acc.names.push(participant.riotIdGameName || participant.summonerName || participant.championName);
        acc.champions.push(participant.championName);
        return acc;
    }, { gold: 0, cs: 0, xp: 0, level: 0, names: [], champions: [] });
}

function getLaneVerdict(myLane, enemyLane) {
    const goldDiff = myLane.gold - enemyLane.gold;
    const csDiff = myLane.cs - enemyLane.cs;
    const xpDiff = myLane.xp - enemyLane.xp;
    const score = goldDiff + (csDiff * 18) + (xpDiff * 0.12);

    if (score >= 180) return { result: "WIN", label: "승리", score, goldDiff, csDiff, xpDiff };
    if (score <= -180) return { result: "LOSE", label: "패배", score, goldDiff, csDiff, xpDiff };
    return { result: "EVEN", label: "비김", score, goldDiff, csDiff, xpDiff };
}

function inferPositionByParticipantId(participant) {
    const slotIndex = ((participant.participantId - 1) % 5);
    return LANE_SLOT_ORDER[slotIndex] || "NONE";
}

function getLaneMembersByPosition(participants, teamId, position) {
    const laneGroup = getLaneGroupFromPosition(position);
    if (laneGroup === "BOTTOM") {
        return participants.filter(p => p.teamId === teamId && ["BOTTOM", "UTILITY"].includes(getPosition(p)));
    }
    return participants.filter(p => p.teamId === teamId && getLaneGroup(p) === laneGroup);
}

function getLaneMembersBySlot(participants, teamId, position) {
    const laneGroup = getLaneGroupFromPosition(position);
    const team = participants.filter(p => p.teamId === teamId).sort((a, b) => a.participantId - b.participantId);
    if (laneGroup === "BOTTOM") return team.filter(p => ["BOTTOM", "UTILITY"].includes(inferPositionByParticipantId(p)));
    return team.filter(p => getLaneGroupFromPosition(inferPositionByParticipantId(p)) === laneGroup);
}

async function getTimelineFrame(matchId) {
    try {
        const timelineUrl = `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${RIOT_API_KEY}`;
        const timelineResponse = await axios.get(timelineUrl);
        const frames = timelineResponse.data?.info?.frames || [];
        const targetFrame = frames.find(f => f.timestamp >= 900000) || frames[frames.length - 1];
        return targetFrame?.participantFrames || null;
    } catch (e) {
        console.log(`[lane-analysis] timeline failed for ${matchId}:`, e.response?.status || e.message);
        return null;
    }
}

async function fetchLaneAnalysis(matchId, myParticipant, allParticipants) {
    const frameMap = await getTimelineFrame(matchId);
    const enemyTeamId = allParticipants.find(p => p.teamId !== myParticipant.teamId)?.teamId;

    if (!enemyTeamId) {
        return {
            laneGroup: "UNKNOWN",
            result: "UNKNOWN",
            label: "판정 불가",
            detail: "상대 팀 정보를 찾지 못했습니다."
        };
    }

    const directPosition = getPosition(myParticipant);
    const inferredPosition = directPosition === "NONE" ? inferPositionByParticipantId(myParticipant) : directPosition;
    const laneGroup = getLaneGroupFromPosition(inferredPosition);

    let myLane = getLaneMembersByPosition(allParticipants, myParticipant.teamId, inferredPosition);
    let enemyLane = getLaneMembersByPosition(allParticipants, enemyTeamId, inferredPosition);
    let source = "position";

    if (!myLane.length || !enemyLane.length) {
        myLane = getLaneMembersBySlot(allParticipants, myParticipant.teamId, inferredPosition);
        enemyLane = getLaneMembersBySlot(allParticipants, enemyTeamId, inferredPosition);
        source = "slot";
    }

    if (!myLane.length) myLane = [myParticipant];
    if (!enemyLane.length) {
        const sameSlot = ((myParticipant.participantId - 1) % 5) + 1;
        enemyLane = allParticipants.filter(p => p.teamId === enemyTeamId && (((p.participantId - 1) % 5) + 1) === sameSlot);
        source = "slot";
    }

    if (!enemyLane.length) {
        return {
            laneGroup,
            result: "UNKNOWN",
            label: "판정 불가",
            detail: "상대 라인 정보를 찾지 못했습니다."
        };
    }

    const myStats = buildLaneUnit(myLane, frameMap);
    const enemyStats = buildLaneUnit(enemyLane, frameMap);
    const verdict = getLaneVerdict(myStats, enemyStats);
    const laneLabel = getLaneLabel(laneGroup);
    const sourceLabel = source === "slot" ? "추정" : "기준";

    return {
        laneGroup,
        result: verdict.result,
        label: verdict.label,
        detail: `${laneLabel} ${sourceLabel} ${myStats.gold.toLocaleString()}G / ${myStats.cs}CS vs ${enemyStats.gold.toLocaleString()}G / ${enemyStats.cs}CS`,
        goldDiff: verdict.goldDiff,
        csDiff: verdict.csDiff,
        xpDiff: Math.round(verdict.xpDiff),
        myTeamNames: myStats.names,
        enemyTeamNames: enemyStats.names
    };
}
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
        const laneStats = Object.values(participantFrames).map(pf => ({
            puuid: pf.puuid,
            totalGold: pf.totalGold,
            totalCs: (pf.minionsKilled || 0) + (pf.jungleMinionsKilled || pf.neutralMinionsKilled || 0)
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
