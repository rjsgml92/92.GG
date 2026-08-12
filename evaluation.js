const express = require('express');
const axios = require('axios');
const { GoogleGenAI, Type } = require('@google/genai');

const router = express.Router();
const RIOT_API_KEY = process.env.RIOT_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const DDRAGON_VERSION = process.env.DDRAGON_VERSION || '16.15.1';
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const PLATFORM_CONFIG = {
    kr: { regional: 'asia', label: '한국' },
    jp1: { regional: 'asia', label: '일본' },
    euw1: { regional: 'europe', label: '유럽 서부' },
    eun1: { regional: 'europe', label: '유럽 북동부' },
    tr1: { regional: 'europe', label: '터키' },
    na1: { regional: 'americas', label: '북미' },
    br1: { regional: 'americas', label: '브라질' },
    la1: { regional: 'americas', label: '라틴아메리카 북부' },
    la2: { regional: 'americas', label: '라틴아메리카 남부' }
};

const QUEUE_NAMES = {
    420: '솔로 랭크',
    440: '자유 랭크',
    450: '칼바람 나락',
    430: '일반',
    490: '빠른 대전',
    1700: '아레나'
};

const evaluationRequests = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [key, times] of evaluationRequests.entries()) {
        const recent = times.filter(time => time >= cutoff);
        if (recent.length) evaluationRequests.set(key, recent);
        else evaluationRequests.delete(key);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

function requireRiotKey(req, res, next) {
    if (!RIOT_API_KEY) {
        return res.status(503).json({
            error: 'RIOT_API_KEY_NOT_CONFIGURED',
            message: '서버에 Riot API 키가 설정되지 않았습니다.'
        });
    }
    next();
}

function evaluationRateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (evaluationRequests.get(key) || []).filter(time => now - time < RATE_LIMIT_WINDOW_MS);

    if (recent.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({
            error: 'TOO_MANY_EVALUATIONS',
            message: 'AI 평가는 10분에 5번까지 가능합니다. 잠시 후 다시 시도해 주세요.'
        });
    }

    recent.push(now);
    evaluationRequests.set(key, recent);
    next();
}

function getRouting(platformValue) {
    const platform = String(platformValue || '').toLowerCase();
    const config = PLATFORM_CONFIG[platform];
    if (!config) {
        const error = new Error('지원하지 않는 서버입니다.');
        error.status = 400;
        throw error;
    }
    return { platform, ...config };
}

function riotHeaders() {
    return { 'X-Riot-Token': RIOT_API_KEY };
}

function cleanRiotId(value, fieldName) {
    const text = String(value || '').trim();
    if (!text || text.length > 40) {
        const error = new Error(`${fieldName}을(를) 확인해 주세요.`);
        error.status = 400;
        throw error;
    }
    return text;
}

async function getAccount(gameName, tagLine, routing) {
    const url = `https://${routing.regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const { data } = await axios.get(url, { headers: riotHeaders(), timeout: 10000 });
    return data;
}

async function getMatch(matchId, routing) {
    const url = `https://${routing.regional}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
    const { data } = await axios.get(url, { headers: riotHeaders(), timeout: 12000 });
    return data;
}

async function getTimeline(matchId, routing) {
    const url = `https://${routing.regional}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`;
    const { data } = await axios.get(url, { headers: riotHeaders(), timeout: 12000 });
    return data;
}

function queueName(queueId, gameMode) {
    return QUEUE_NAMES[queueId] || gameMode || '기타 모드';
}

function positionName(position) {
    return ({ TOP: '탑', JUNGLE: '정글', MIDDLE: '미드', BOTTOM: '원거리 딜러', UTILITY: '서포터' })[position] || '포지션 미상';
}

function participantPosition(participant) {
    return participant.teamPosition || participant.individualPosition || 'UNKNOWN';
}

function safeRatio(numerator, denominator, digits = 1) {
    if (!denominator) return 0;
    return Number((numerator / denominator).toFixed(digits));
}

function summarizeMatch(match, puuid) {
    const info = match.info;
    const player = info.participants.find(participant => participant.puuid === puuid);
    if (!player) return null;

    const minutes = Math.max(info.gameDuration / 60, 1);
    return {
        matchId: match.metadata.matchId,
        queue: queueName(info.queueId, info.gameMode),
        gameCreation: info.gameCreation,
        durationMinutes: Math.round(minutes),
        win: Boolean(player.win),
        championName: player.championName,
        championImageUrl: `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${player.championName}.png`,
        position: participantPosition(player),
        positionLabel: positionName(participantPosition(player)),
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        kda: safeRatio(player.kills + player.assists, Math.max(player.deaths, 1), 2),
        cs: (player.totalMinionsKilled || 0) + (player.neutralMinionsKilled || 0),
        csPerMinute: safeRatio((player.totalMinionsKilled || 0) + (player.neutralMinionsKilled || 0), minutes, 1),
        damage: player.totalDamageDealtToChampions || 0,
        visionScore: player.visionScore || 0
    };
}

function findLaneOpponent(player, participants) {
    const position = participantPosition(player);
    const enemyTeam = participants.filter(participant => participant.teamId !== player.teamId);
    return enemyTeam.find(participant => participantPosition(participant) === position) || null;
}

function participantFrame(frame, participantId) {
    return frame?.participantFrames?.[String(participantId)] || frame?.participantFrames?.[participantId] || null;
}

function checkpoint(frames, minute, player, opponent) {
    const target = minute * 60 * 1000;
    const frame = frames.find(item => item.timestamp >= target) || frames[frames.length - 1];
    const mine = participantFrame(frame, player.participantId);
    const enemy = opponent ? participantFrame(frame, opponent.participantId) : null;
    if (!mine) return null;

    const mineCs = (mine.minionsKilled || 0) + (mine.jungleMinionsKilled || 0);
    const enemyCs = enemy ? (enemy.minionsKilled || 0) + (enemy.jungleMinionsKilled || 0) : null;
    return {
        minute,
        gold: mine.totalGold || 0,
        cs: mineCs,
        level: mine.level || 0,
        versusLane: enemy ? {
            champion: opponent.championName,
            goldDiff: (mine.totalGold || 0) - (enemy.totalGold || 0),
            csDiff: mineCs - enemyCs,
            xpDiff: (mine.xp || 0) - (enemy.xp || 0)
        } : null
    };
}

function buildFiveMinuteCheckpoints(frames, durationMinutes, player, opponent) {
    // Timeline frames are recorded roughly once a minute.  A five-minute cadence
    // keeps the review readable while still showing how an advantage changed.
    const lastCompleteCheckpoint = Math.floor(durationMinutes / 5) * 5;
    const minutes = [];
    for (let minute = 5; minute <= lastCompleteCheckpoint; minute += 5) minutes.push(minute);
    return minutes.map(minute => checkpoint(frames, minute, player, opponent)).filter(Boolean);
}

function buildEvaluationData(match, timeline, puuid) {
    const info = match.info;
    const player = info.participants.find(participant => participant.puuid === puuid);
    if (!player) {
        const error = new Error('선택한 경기에서 플레이어 정보를 찾지 못했습니다.');
        error.status = 404;
        throw error;
    }

    const opponent = findLaneOpponent(player, info.participants);
    const team = info.participants.filter(participant => participant.teamId === player.teamId);
    const teamKills = team.reduce((sum, participant) => sum + (participant.kills || 0), 0);
    const teamDamage = team.reduce((sum, participant) => sum + (participant.totalDamageDealtToChampions || 0), 0);
    const durationMinutes = Math.max(info.gameDuration / 60, 1);
    const frames = timeline?.info?.frames || [];
    const participantId = player.participantId;

    const deaths = [];
    const objectives = [];
    for (const frame of frames) {
        for (const event of frame.events || []) {
            if (event.type === 'CHAMPION_KILL' && event.victimId === participantId) {
                deaths.push({
                    minute: Number((event.timestamp / 60000).toFixed(1))
                });
            }
            if (event.type === 'ELITE_MONSTER_KILL') {
                const killer = info.participants.find(participant => participant.participantId === event.killerId);
                objectives.push({
                    minute: Number((event.timestamp / 60000).toFixed(1)),
                    type: event.monsterType,
                    subtype: event.monsterSubType || null,
                    side: killer ? (killer.teamId === player.teamId ? 'ALLY' : 'ENEMY') : 'UNKNOWN'
                });
            }
        }
    }

    const basic = summarizeMatch(match, puuid);
    return {
        result: basic.win ? '승리' : '패배',
        queue: basic.queue,
        durationMinutes: basic.durationMinutes,
        champion: player.championName,
        position: positionName(participantPosition(player)),
        opponentChampion: opponent?.championName || null,
        combat: {
            kills: player.kills,
            deaths: player.deaths,
            assists: player.assists,
            kda: basic.kda,
            killParticipationPercent: Math.round(((player.kills + player.assists) / Math.max(teamKills, 1)) * 100),
            largestKillingSpree: player.largestKillingSpree || 0
        },
        economy: {
            gold: player.goldEarned || 0,
            cs: basic.cs,
            csPerMinute: basic.csPerMinute
        },
        contribution: {
            championDamage: player.totalDamageDealtToChampions || 0,
            teamDamageSharePercent: Math.round(((player.totalDamageDealtToChampions || 0) / Math.max(teamDamage, 1)) * 100),
            damageTaken: player.totalDamageTaken || 0,
            visionScore: player.visionScore || 0,
            visionPerMinute: safeRatio(player.visionScore || 0, durationMinutes, 2),
            wardsPlaced: player.wardsPlaced || 0,
            wardsKilled: player.wardsKilled || 0
        },
        checkpoints: buildFiveMinuteCheckpoints(frames, durationMinutes, player, opponent),
        deathTimings: deaths,
        objectives: objectives.slice(0, 20)
    };
}

function gradeFromScore(score) {
    if (score >= 92) return 'S';
    if (score >= 84) return 'A';
    if (score >= 74) return 'B';
    if (score >= 62) return 'C';
    return 'D';
}

function buildStatEvaluation(data) {
    const support = data.position === '서포터';
    const jungle = data.position === '정글';
    let score = 55;
    score += data.result === '승리' ? 10 : 0;
    score += Math.min(data.combat.kda * 3, 15);
    score += Math.min(data.combat.killParticipationPercent / 10, 8);
    score += support ? Math.min(data.contribution.visionPerMinute * 4, 8) : Math.min(data.economy.csPerMinute, 8);
    score -= Math.min(data.combat.deaths * 1.8, 15);
    score = Math.max(35, Math.min(98, Math.round(score)));

    const strengths = [];
    const improvements = [];

    if (data.combat.kda >= 3) strengths.push({ title: '교전 기여', evidence: `KDA ${data.combat.kda}, 킬 관여 ${data.combat.killParticipationPercent}%` });
    if (!support && !jungle && data.economy.csPerMinute >= 7) strengths.push({ title: '성장 유지', evidence: `분당 CS ${data.economy.csPerMinute}` });
    if (data.contribution.teamDamageSharePercent >= 25) strengths.push({ title: '딜 기여', evidence: `팀 피해량의 ${data.contribution.teamDamageSharePercent}%` });
    if (data.contribution.visionPerMinute >= (support ? 1.5 : 0.7)) strengths.push({ title: '시야 기여', evidence: `분당 시야 점수 ${data.contribution.visionPerMinute}` });
    if (!strengths.length) strengths.push({ title: '경기 완주', evidence: `${data.durationMinutes}분 동안 ${data.combat.killParticipationPercent}%의 킬에 관여` });

    if (data.combat.deaths >= 6) improvements.push({ title: '데스 관리', evidence: `${data.combat.deaths}데스 — 위험 구간 진입 전 시야와 아군 위치 확인 필요` });
    if (!support && !jungle && data.economy.csPerMinute < 6) improvements.push({ title: 'CS 수급', evidence: `분당 CS ${data.economy.csPerMinute} — 교전 전후 사이드 웨이브 회수 점검` });
    if (data.contribution.visionPerMinute < (support ? 1.2 : 0.5)) improvements.push({ title: '시야 루틴', evidence: `분당 시야 점수 ${data.contribution.visionPerMinute}` });
    const weakestCheckpoint = data.checkpoints
        .filter(item => item.versusLane)
        .reduce((weakest, item) => !weakest || item.versusLane.goldDiff < weakest.versusLane.goldDiff ? item : weakest, null);
    if (weakestCheckpoint?.versusLane?.goldDiff < -500) {
        improvements.push({ title: '라인전 손실 억제', evidence: `${weakestCheckpoint.minute}분 상대 대비 ${weakestCheckpoint.versusLane.goldDiff}골드` });
    }
    if (!improvements.length) improvements.push({ title: '이득 전환 속도', evidence: '좋았던 지표를 다음 오브젝트와 시야 장악으로 더 빠르게 연결해 보세요.' });

    return {
        grade: gradeFromScore(score),
        score,
        verdict: data.result === '승리' ? '승리에 기여한 경기' : '복기 가치가 큰 경기',
        summary: `${data.champion} ${data.position} 경기입니다. 5분 간격 성장 흐름과 확인 가능한 전투·시야 지표를 기준으로 평가했습니다.`,
        strengths: strengths.slice(0, 3),
        improvements: improvements.slice(0, 3),
        nextGamePlan: [
            '첫 10분에는 불필요한 데스를 줄이고 핵심 성장 자원을 놓치지 않기',
            '오브젝트 60초 전에 귀환·아이템·시야 준비를 끝내기',
            '교전 뒤 가장 가까운 확정 이득 하나를 선택해 연결하기'
        ],
        keyMoments: data.deathTimings.slice(0, 3).map(item => `${item.minute}분 데스 구간 복기`),
        dataLimit: 'API 통계와 이벤트만 사용한 평가이며 화면 움직임, 스킬 사용, 음성 소통은 확인할 수 없습니다.'
    };
}

function normalizeAiEvaluation(value, fallback) {
    const result = value && typeof value === 'object' ? value : {};
    const normalizeItems = items => Array.isArray(items)
        ? items.slice(0, 3).map(item => typeof item === 'string' ? { title: item, evidence: '' } : {
            title: String(item?.title || '').slice(0, 80),
            evidence: String(item?.evidence || '').slice(0, 240)
        }).filter(item => item.title)
        : [];

    return {
        grade: /^[SABCD][+-]?$/.test(String(result.grade || '')) ? result.grade : fallback.grade,
        score: Number.isFinite(Number(result.score)) ? Math.max(0, Math.min(100, Math.round(Number(result.score)))) : fallback.score,
        verdict: String(result.verdict || fallback.verdict).slice(0, 100),
        summary: String(result.summary || fallback.summary).slice(0, 600),
        strengths: normalizeItems(result.strengths).length ? normalizeItems(result.strengths) : fallback.strengths,
        improvements: normalizeItems(result.improvements).length ? normalizeItems(result.improvements) : fallback.improvements,
        nextGamePlan: Array.isArray(result.nextGamePlan)
            ? result.nextGamePlan.slice(0, 3).map(item => String(item).slice(0, 220))
            : fallback.nextGamePlan,
        keyMoments: Array.isArray(result.keyMoments)
            ? result.keyMoments.slice(0, 4).map(item => String(item).slice(0, 220))
            : fallback.keyMoments,
        dataLimit: String(result.dataLimit || fallback.dataLimit).slice(0, 300)
    };
}

function extractJson(text) {
    const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('AI 응답에서 JSON을 찾지 못했습니다.');
    return JSON.parse(cleaned.slice(start, end + 1));
}

async function askGemini(data, fallback) {
    if (!gemini) return { evaluation: fallback, source: 'stats' };

    const system = [
        '당신은 리그 오브 레전드의 사후 경기 복기를 돕는 코치입니다.',
        '제공된 JSON 수치와 이벤트만 근거로 사용하고, 특히 checkpoints의 5분 단위 변화에 근거해 평가하세요. 보이지 않는 행동이나 의도를 지어내지 마세요.',
        '실시간 플레이 지시, MMR 추정, 확정적인 실력 등급 판정은 하지 마세요.',
        '한국어로 간결하고 구체적으로 작성하세요.',
        '반드시 JSON 하나만 출력하세요. 키: grade, score, verdict, summary, strengths, improvements, nextGamePlan, keyMoments, dataLimit.',
        'strengths와 improvements는 각각 {title, evidence} 객체 배열이며 최대 3개, nextGamePlan은 문자열 배열 3개입니다.',
        'grade는 S/A/B/C/D 중 하나, score는 0~100 정수입니다.'
    ].join(' ');

    const coachingItemSchema = {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING },
            evidence: { type: Type.STRING }
        },
        required: ['title', 'evidence']
    };
    const response = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: `다음은 익명화한 한 경기 데이터입니다. 평가해 주세요.\n${JSON.stringify(data)}`,
        config: {
            systemInstruction: system,
            maxOutputTokens: 1400,
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    grade: { type: Type.STRING, enum: ['S', 'A', 'B', 'C', 'D'] },
                    score: { type: Type.INTEGER },
                    verdict: { type: Type.STRING },
                    summary: { type: Type.STRING },
                    strengths: { type: Type.ARRAY, items: coachingItemSchema },
                    improvements: { type: Type.ARRAY, items: coachingItemSchema },
                    nextGamePlan: { type: Type.ARRAY, items: { type: Type.STRING } },
                    keyMoments: { type: Type.ARRAY, items: { type: Type.STRING } },
                    dataLimit: { type: Type.STRING }
                },
                required: ['grade', 'score', 'verdict', 'summary', 'strengths', 'improvements', 'nextGamePlan', 'keyMoments', 'dataLimit']
            }
        }
    });
    return { evaluation: normalizeAiEvaluation(extractJson(response.text), fallback), source: 'gemini' };
}

function riotErrorResponse(error, res) {
    const status = error.status || error.response?.status || 500;
    const messages = {
        400: error.message || '요청 값을 확인해 주세요.',
        401: 'Riot API 인증에 실패했습니다.',
        403: 'Riot API 키가 만료되었거나 권한이 없습니다.',
        404: 'Riot ID 또는 경기 정보를 찾지 못했습니다.',
        429: 'Riot API 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.'
    };
    return res.status(status).json({
        error: 'RIOT_API_ERROR',
        message: messages[status] || '경기 데이터를 가져오지 못했습니다.'
    });
}

router.get('/matches', requireRiotKey, async (req, res) => {
    try {
        const routing = getRouting(req.query.platform);
        const gameName = cleanRiotId(req.query.gameName, '게임 이름');
        const tagLine = cleanRiotId(req.query.tagLine, '태그');
        const account = await getAccount(gameName, tagLine, routing);

        const summonerUrl = `https://${routing.platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(account.puuid)}`;
        const matchIdsUrl = `https://${routing.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(account.puuid)}/ids?start=0&count=5`;
        const [summonerResult, matchIdsResult] = await Promise.all([
            axios.get(summonerUrl, { headers: riotHeaders(), timeout: 10000 }),
            axios.get(matchIdsUrl, { headers: riotHeaders(), timeout: 10000 })
        ]);

        const matches = await Promise.all(matchIdsResult.data.map(matchId => getMatch(matchId, routing)));
        const summaries = matches.map(match => summarizeMatch(match, account.puuid)).filter(Boolean);

        res.json({
            profile: {
                gameName: account.gameName,
                tagLine: account.tagLine,
                platform: routing.platform,
                platformLabel: routing.label,
                summonerLevel: summonerResult.data.summonerLevel,
                profileIconUrl: `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/profileicon/${summonerResult.data.profileIconId}.png`
            },
            matches: summaries,
            aiAvailable: Boolean(gemini)
        });
    } catch (error) {
        console.error('[evaluation/matches]', error.response?.status || error.message);
        riotErrorResponse(error, res);
    }
});

router.post('/analyze', requireRiotKey, evaluationRateLimit, async (req, res) => {
    try {
        const routing = getRouting(req.body.platform);
        const gameName = cleanRiotId(req.body.gameName, '게임 이름');
        const tagLine = cleanRiotId(req.body.tagLine, '태그');
        const matchId = cleanRiotId(req.body.matchId, '경기 ID');

        if (!matchId.toUpperCase().startsWith(`${routing.platform.toUpperCase()}_`)) {
            return res.status(400).json({ error: 'INVALID_MATCH_ID', message: '선택한 서버와 경기 ID가 일치하지 않습니다.' });
        }

        const account = await getAccount(gameName, tagLine, routing);
        const [match, timeline] = await Promise.all([
            getMatch(matchId, routing),
            getTimeline(matchId, routing)
        ]);
        const data = buildEvaluationData(match, timeline, account.puuid);
        const fallback = buildStatEvaluation(data);

        let result;
        try {
            result = await askGemini(data, fallback);
        } catch (aiError) {
            console.error('[evaluation/gemini]', aiError.status || aiError.message);
            result = { evaluation: fallback, source: 'stats', aiError: 'Gemini 호출에 실패해 통계 기반 평가를 표시합니다.' };
        }

        res.json({
            match: summarizeMatch(match, account.puuid),
            evaluation: result.evaluation,
            checkpoints: data.checkpoints,
            source: result.source,
            notice: result.aiError || (result.source === 'stats' ? 'GEMINI_API_KEY가 없어 통계 기반 평가를 표시합니다.' : null)
        });
    } catch (error) {
        console.error('[evaluation/analyze]', error.response?.status || error.message);
        riotErrorResponse(error, res);
    }
});

router.post('/demo', evaluationRateLimit, async (req, res) => {
    const data = {
        result: '승리',
        queue: '솔로 랭크',
        durationMinutes: 31,
        champion: 'Ahri',
        position: '미드',
        opponentChampion: 'Syndra',
        combat: {
            kills: 8,
            deaths: 4,
            assists: 10,
            kda: 4.5,
            killParticipationPercent: 62,
            largestKillingSpree: 5
        },
        economy: { gold: 14280, cs: 221, csPerMinute: 7.1 },
        contribution: {
            championDamage: 28450,
            teamDamageSharePercent: 27,
            damageTaken: 18420,
            visionScore: 24,
            visionPerMinute: 0.77,
            wardsPlaced: 10,
            wardsKilled: 4
        },
        checkpoints: [
            { minute: 5, gold: 1850, cs: 37, level: 5, versusLane: { champion: 'Syndra', goldDiff: 40, csDiff: 1, xpDiff: 30 } },
            { minute: 10, gold: 3450, cs: 76, level: 8, versusLane: { champion: 'Syndra', goldDiff: 180, csDiff: 4, xpDiff: 120 } },
            { minute: 15, gold: 5680, cs: 116, level: 10, versusLane: { champion: 'Syndra', goldDiff: 420, csDiff: 9, xpDiff: 260 } },
            { minute: 20, gold: 8140, cs: 151, level: 13, versusLane: { champion: 'Syndra', goldDiff: 760, csDiff: 13, xpDiff: 410 } },
            { minute: 25, gold: 10820, cs: 188, level: 15, versusLane: { champion: 'Syndra', goldDiff: 540, csDiff: 8, xpDiff: 220 } },
            { minute: 30, gold: 13540, cs: 216, level: 17, versusLane: { champion: 'Syndra', goldDiff: 610, csDiff: 10, xpDiff: 180 } }
        ],
        deathTimings: [{ minute: 7.8 }, { minute: 18.4 }, { minute: 25.1 }, { minute: 29.6 }],
        objectives: [
            { minute: 11.2, type: 'DRAGON', subtype: 'AIR_DRAGON', side: 'ALLY' },
            { minute: 16.3, type: 'RIFTHERALD', subtype: null, side: 'ALLY' },
            { minute: 23.7, type: 'BARON_NASHOR', subtype: null, side: 'ENEMY' }
        ]
    };
    const fallback = buildStatEvaluation(data);

    try {
        const result = await askGemini(data, fallback);
        res.json({
            match: {
                matchId: 'DEMO_001',
                championName: 'Ahri',
                kills: 8,
                deaths: 4,
                assists: 10
            },
            evaluation: result.evaluation,
            checkpoints: data.checkpoints,
            source: result.source,
            notice: result.source === 'stats' ? 'GEMINI_API_KEY가 없어 통계 기반 데모를 표시합니다.' : '익명 샘플 경기로 Gemini 연결을 확인한 데모입니다.'
        });
    } catch (error) {
        console.error('[evaluation/demo]', error.status || error.message);
        res.json({
            match: { matchId: 'DEMO_001', championName: 'Ahri', kills: 8, deaths: 4, assists: 10 },
            evaluation: fallback,
            checkpoints: data.checkpoints,
            source: 'stats',
            notice: `Gemini 호출 실패: ${String(error.message || '알 수 없는 오류').slice(0, 160)}`
        });
    }
});

module.exports = router;
