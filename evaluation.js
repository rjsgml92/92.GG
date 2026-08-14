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
const SUPPORTED_EVALUATION_QUEUES = new Set([420, 440, 430, 490]);

const evaluationRequests = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

// A single match cannot prove a player's rank or long-term skill. These values are
// deliberately broad coaching reference lines, not patch-specific tier averages.
const ROLE_EXPECTATIONS = {
    TOP: { csPerMinute: 7, killParticipation: 48, visionPerMinute: 0.55, deathsPer10: 1.7 },
    JUNGLE: { csPerMinute: 5.5, killParticipation: 58, visionPerMinute: 0.8, deathsPer10: 1.8 },
    MIDDLE: { csPerMinute: 7, killParticipation: 52, visionPerMinute: 0.55, deathsPer10: 1.65 },
    BOTTOM: { csPerMinute: 7.5, killParticipation: 52, visionPerMinute: 0.45, deathsPer10: 1.55 },
    UTILITY: { csPerMinute: null, killParticipation: 60, visionPerMinute: 1.45, deathsPer10: 1.9 },
    UNKNOWN: { csPerMinute: 6, killParticipation: 52, visionPerMinute: 0.65, deathsPer10: 1.75 }
};

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
    const platform = 'kr';
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

function clamp(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function rounded(value, digits = 0) {
    const multiplier = 10 ** digits;
    return Math.round((Number(value) || 0) * multiplier) / multiplier;
}

function signed(value, suffix = '') {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : ''}${number.toLocaleString('ko-KR')}${suffix}`;
}

function roleExpectation(position) {
    return ROLE_EXPECTATIONS[position] || ROLE_EXPECTATIONS.UNKNOWN;
}

function scoreAgainstTarget(value, target, spread, inverse = false) {
    const delta = inverse ? target - value : value - target;
    return clamp(65 + (delta / Math.max(spread, 0.01)) * 35);
}

function summarizeMatch(match, puuid) {
    const info = match.info;
    const player = info.participants.find(participant => participant.puuid === puuid);
    if (!player) return null;

    const minutes = Math.max(info.gameDuration / 60, 1);
    const team = info.participants.filter(participant => participant.teamId === player.teamId);
    const teamKills = team.reduce((sum, participant) => sum + (participant.kills || 0), 0);
    return {
        matchId: match.metadata.matchId,
        queueId: info.queueId,
        queue: queueName(info.queueId, info.gameMode),
        analysisSupported: SUPPORTED_EVALUATION_QUEUES.has(info.queueId),
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
        killParticipationPercent: Math.round(((player.kills + player.assists) / Math.max(teamKills, 1)) * 100),
        cs: (player.totalMinionsKilled || 0) + (player.neutralMinionsKilled || 0),
        csPerMinute: safeRatio((player.totalMinionsKilled || 0) + (player.neutralMinionsKilled || 0), minutes, 1),
        gold: player.goldEarned || 0,
        goldPerMinute: safeRatio(player.goldEarned || 0, minutes, 0),
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
    const enemyTeam = info.participants.filter(participant => participant.teamId !== player.teamId);
    const teamKills = team.reduce((sum, participant) => sum + (participant.kills || 0), 0);
    const teamDamage = team.reduce((sum, participant) => sum + (participant.totalDamageDealtToChampions || 0), 0);
    const teamGold = team.reduce((sum, participant) => sum + (participant.goldEarned || 0), 0);
    const durationMinutes = Math.max(info.gameDuration / 60, 1);
    const frames = timeline?.info?.frames || [];
    const participantId = player.participantId;
    const participantById = new Map(info.participants.map(participant => [participant.participantId, participant]));

    const deaths = [];
    const objectives = [];
    const combatEvents = [];
    for (const frame of frames) {
        for (const event of frame.events || []) {
            const minute = Number(((event.timestamp || 0) / 60000).toFixed(1));
            if (event.type === 'CHAMPION_KILL') {
                const victim = participantById.get(event.victimId);
                const playerAssisted = Array.isArray(event.assistingParticipantIds) && event.assistingParticipantIds.includes(participantId);
                if (event.victimId === participantId) {
                    const killer = participantById.get(event.killerId);
                    deaths.push({
                        minute,
                        killerChampion: killer?.championName || null,
                        assistCount: Array.isArray(event.assistingParticipantIds) ? event.assistingParticipantIds.length : 0
                    });
                }
                if (event.killerId === participantId || playerAssisted) {
                    combatEvents.push({
                        minute,
                        type: event.killerId === participantId ? 'KILL' : 'ASSIST',
                        victimChampion: victim?.championName || null,
                        shutdownBounty: event.shutdownBounty || 0
                    });
                }
            }
            if (event.type === 'ELITE_MONSTER_KILL') {
                const killer = participantById.get(event.killerId);
                const killerTeamId = event.killerTeamId || killer?.teamId;
                objectives.push({
                    minute,
                    type: event.monsterType,
                    subtype: event.monsterSubType || null,
                    side: killerTeamId ? (killerTeamId === player.teamId ? 'ALLY' : 'ENEMY') : 'UNKNOWN',
                    securedByPlayer: event.killerId === participantId
                });
            }
        }
    }

    const basic = summarizeMatch(match, puuid);
    const positionKey = participantPosition(player);
    const data = {
        result: basic.win ? '승리' : '패배',
        queue: basic.queue,
        durationMinutes: basic.durationMinutes,
        champion: player.championName,
        position: positionName(positionKey),
        positionKey,
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
            goldPerMinute: safeRatio(player.goldEarned || 0, durationMinutes, 0),
            teamGoldSharePercent: Math.round(((player.goldEarned || 0) / Math.max(teamGold, 1)) * 100),
            cs: basic.cs,
            csPerMinute: basic.csPerMinute
        },
        contribution: {
            championDamage: player.totalDamageDealtToChampions || 0,
            damagePerMinute: safeRatio(player.totalDamageDealtToChampions || 0, durationMinutes, 0),
            teamDamageSharePercent: Math.round(((player.totalDamageDealtToChampions || 0) / Math.max(teamDamage, 1)) * 100),
            damageTaken: player.totalDamageTaken || 0,
            visionScore: player.visionScore || 0,
            visionPerMinute: safeRatio(player.visionScore || 0, durationMinutes, 2),
            wardsPlaced: player.wardsPlaced || 0,
            wardsKilled: player.wardsKilled || 0,
            controlWardsBought: player.visionWardsBoughtInGame || 0
        },
        opponent: opponent ? {
            champion: opponent.championName,
            kills: opponent.kills || 0,
            deaths: opponent.deaths || 0,
            assists: opponent.assists || 0,
            gold: opponent.goldEarned || 0,
            goldPerMinute: safeRatio(opponent.goldEarned || 0, durationMinutes, 0),
            cs: (opponent.totalMinionsKilled || 0) + (opponent.neutralMinionsKilled || 0),
            csPerMinute: safeRatio((opponent.totalMinionsKilled || 0) + (opponent.neutralMinionsKilled || 0), durationMinutes, 1),
            championDamage: opponent.totalDamageDealtToChampions || 0,
            visionPerMinute: safeRatio(opponent.visionScore || 0, durationMinutes, 2)
        } : null,
        teamContext: {
            kills: teamKills,
            deaths: enemyTeam.reduce((sum, participant) => sum + (participant.kills || 0), 0),
            gold: teamGold
        },
        checkpoints: buildFiveMinuteCheckpoints(frames, durationMinutes, player, opponent),
        deathTimings: deaths,
        combatEvents: combatEvents.slice(0, 50),
        objectives: objectives.slice(0, 20)
    };

    data.scorecard = buildScorecard(data);
    data.reviewMoments = buildReviewMoments(data);
    data.analysisMeta = buildAnalysisMeta(data);
    return data;
}

function average(values) {
    const usable = values.filter(value => Number.isFinite(Number(value)));
    return usable.length ? usable.reduce((sum, value) => sum + Number(value), 0) / usable.length : 0;
}

function pillarStatus(score) {
    if (score >= 80) return '강점';
    if (score >= 65) return '안정';
    if (score >= 50) return '주의';
    return '우선 개선';
}

function buildMomentum(checkpoints) {
    const items = checkpoints.filter(item => item.versusLane);
    if (!items.length) {
        return { label: '비교 데이터 부족', summary: '동일 포지션 상대와 비교할 타임라인이 없습니다.', biggestRise: null, biggestDrop: null };
    }

    const swings = items.slice(1).map((item, index) => ({
        fromMinute: items[index].minute,
        toMinute: item.minute,
        change: item.versusLane.goldDiff - items[index].versusLane.goldDiff
    }));
    const biggestRise = swings.reduce((best, item) => !best || item.change > best.change ? item : best, null);
    const biggestDrop = swings.reduce((worst, item) => !worst || item.change < worst.change ? item : worst, null);
    const start = items[0].versusLane.goldDiff;
    const finish = items[items.length - 1].versusLane.goldDiff;
    const spread = Math.max(...items.map(item => item.versusLane.goldDiff)) - Math.min(...items.map(item => item.versusLane.goldDiff));

    let label = '접전 흐름';
    if (start <= -300 && finish >= 200) label = '회복한 경기';
    else if (start >= 300 && finish <= start - 700) label = '리드가 줄어든 경기';
    else if (items.every(item => item.versusLane.goldDiff >= 0) && finish >= 300) label = '꾸준한 우위';
    else if (items.every(item => item.versusLane.goldDiff <= 0) && finish <= -300) label = '추격이 필요했던 흐름';
    else if (spread >= 1000) label = '변동이 큰 경기';

    return {
        label,
        summary: `${items[0].minute}분 ${signed(start, 'G')}에서 ${items[items.length - 1].minute}분 ${signed(finish, 'G')}로 마쳤습니다.`,
        biggestRise,
        biggestDrop
    };
}

function buildScorecard(data) {
    const target = roleExpectation(data.positionKey);
    const laneCheckpoints = data.checkpoints.filter(item => item.versusLane);
    const earlyCheckpoints = laneCheckpoints.filter(item => item.minute <= 15);
    const earlySample = earlyCheckpoints.length ? earlyCheckpoints : laneCheckpoints.slice(0, 2);
    const earlyGoldDiff = average(earlySample.map(item => item.versusLane.goldDiff));
    const earlyCsDiff = average(earlySample.map(item => item.versusLane.csDiff));
    const earlyXpDiff = average(earlySample.map(item => item.versusLane.xpDiff));
    const earlyScore = earlySample.length
        ? clamp(65 + (earlyGoldDiff / 600) * 20 + (earlyCsDiff / 12) * 10 + (earlyXpDiff / 600) * 5)
        : 65;

    const lastLane = laneCheckpoints[laneCheckpoints.length - 1]?.versusLane || null;
    const laneGoldScore = lastLane ? clamp(65 + (lastLane.goldDiff / 1200) * 35) : 65;
    const growthBase = target.csPerMinute == null
        ? scoreAgainstTarget(data.economy.goldPerMinute, data.opponent?.goldPerMinute || data.economy.goldPerMinute, 100)
        : scoreAgainstTarget(data.economy.csPerMinute, target.csPerMinute, 2.2);
    const growthScore = clamp(growthBase * 0.58 + laneGoldScore * 0.42);

    const kdaScore = scoreAgainstTarget(data.combat.kda, 2.6, 3.2);
    const participationScore = scoreAgainstTarget(data.combat.killParticipationPercent, target.killParticipation, 32);
    const damageShareScore = scoreAgainstTarget(data.contribution.teamDamageSharePercent, data.positionKey === 'UTILITY' ? 12 : 20, 16);
    const combatScore = clamp(kdaScore * 0.36 + participationScore * 0.34 + damageShareScore * 0.3);

    const deathsPer10 = safeRatio(data.combat.deaths, data.durationMinutes / 10, 2);
    const survivalScore = scoreAgainstTarget(deathsPer10, target.deathsPer10, 1.7, true);
    const visionScore = scoreAgainstTarget(data.contribution.visionPerMinute, target.visionPerMinute, data.positionKey === 'UTILITY' ? 1 : 0.8);
    const disciplineScore = clamp(survivalScore * 0.58 + visionScore * 0.42);

    const scores = {
        early: Math.round(earlyScore),
        growth: Math.round(growthScore),
        combat: Math.round(combatScore),
        discipline: Math.round(disciplineScore)
    };
    const overall = Math.round(scores.early * 0.25 + scores.growth * 0.2 + scores.combat * 0.35 + scores.discipline * 0.2);
    const growthEvidence = target.csPerMinute == null
        ? `분당 골드 ${data.economy.goldPerMinute}, 상대 ${data.opponent?.goldPerMinute ?? '비교 불가'}`
        : `분당 CS ${data.economy.csPerMinute} (연습선 ${target.csPerMinute}), 최종 비교 ${lastLane ? signed(lastLane.goldDiff, 'G') : '없음'}`;
    const earlyEvidence = earlySample.length
        ? `15분 이내 평균 ${signed(Math.round(earlyGoldDiff), 'G')} · ${signed(Math.round(earlyCsDiff), 'CS')}`
        : '동일 포지션 상대 타임라인을 확인하지 못함';

    const pillars = [
        { key: 'early', label: data.positionKey === 'JUNGLE' ? '초반 성장' : '초반 주도권', score: scores.early, status: pillarStatus(scores.early), evidence: earlyEvidence },
        { key: 'growth', label: '자원 운영', score: scores.growth, status: pillarStatus(scores.growth), evidence: growthEvidence },
        { key: 'combat', label: '교전 영향력', score: scores.combat, status: pillarStatus(scores.combat), evidence: `KDA ${data.combat.kda} · 킬 관여 ${data.combat.killParticipationPercent}% · 피해 비중 ${data.contribution.teamDamageSharePercent}%` },
        { key: 'discipline', label: '생존·시야', score: scores.discipline, status: pillarStatus(scores.discipline), evidence: `10분당 데스 ${deathsPer10} · 분당 시야 ${data.contribution.visionPerMinute}` }
    ];

    return {
        score: overall,
        grade: gradeFromScore(overall),
        pillars,
        momentum: buildMomentum(data.checkpoints),
        metrics: [
            { key: 'kda', label: 'KDA', value: String(data.combat.kda), target: '2.6+', good: data.combat.kda >= 2.6 },
            { key: 'kp', label: '킬 관여', value: `${data.combat.killParticipationPercent}%`, target: `${target.killParticipation}%+`, good: data.combat.killParticipationPercent >= target.killParticipation },
            target.csPerMinute == null
                ? { key: 'gpm', label: '분당 골드', value: String(data.economy.goldPerMinute), target: '상대와 비교', good: !data.opponent || data.economy.goldPerMinute >= data.opponent.goldPerMinute }
                : { key: 'cspm', label: '분당 CS', value: String(data.economy.csPerMinute), target: `${target.csPerMinute}+`, good: data.economy.csPerMinute >= target.csPerMinute },
            { key: 'vision', label: '분당 시야', value: String(data.contribution.visionPerMinute), target: `${target.visionPerMinute}+`, good: data.contribution.visionPerMinute >= target.visionPerMinute },
            { key: 'deaths', label: '10분당 데스', value: String(deathsPer10), target: `${target.deathsPer10} 이하`, good: deathsPer10 <= target.deathsPer10 }
        ],
        targets: target,
        method: '승패와 무관하게 초반 25% · 자원 20% · 교전 35% · 생존·시야 20%를 합산한 한 경기 퍼포먼스 점수'
    };
}

function objectiveLabel(objective) {
    const subtypeNames = {
        AIR_DRAGON: '바람 드래곤', EARTH_DRAGON: '대지 드래곤', FIRE_DRAGON: '화염 드래곤',
        WATER_DRAGON: '바다 드래곤', HEXTECH_DRAGON: '마법공학 드래곤', CHEMTECH_DRAGON: '화학공학 드래곤',
        ELDER_DRAGON: '장로 드래곤'
    };
    if (objective.type === 'DRAGON') return subtypeNames[objective.subtype] || '드래곤';
    if (objective.type === 'BARON_NASHOR') return '바론';
    if (objective.type === 'RIFTHERALD') return '전령';
    if (objective.type === 'HORDE') return '공허 유충';
    return '주요 오브젝트';
}

function buildReviewMoments(data) {
    const moments = [];
    const laneItems = data.checkpoints.filter(item => item.versusLane);
    const best = laneItems.reduce((item, point) => !item || point.versusLane.goldDiff > item.versusLane.goldDiff ? point : item, null);
    const worst = laneItems.reduce((item, point) => !item || point.versusLane.goldDiff < item.versusLane.goldDiff ? point : item, null);

    if (best && best.versusLane.goldDiff >= 300) {
        moments.push({ minute: best.minute, tone: 'positive', label: '가장 큰 상대 우위', detail: `${best.versusLane.champion} 대비 ${signed(best.versusLane.goldDiff, 'G')} · ${signed(best.versusLane.csDiff, 'CS')}` });
    }
    if (worst && worst.versusLane.goldDiff <= -300) {
        moments.push({ minute: worst.minute, tone: 'negative', label: '가장 큰 상대 열세', detail: `${worst.versusLane.champion} 대비 ${signed(worst.versusLane.goldDiff, 'G')} · ${signed(worst.versusLane.csDiff, 'CS')}` });
    }

    const drop = data.scorecard.momentum.biggestDrop;
    if (drop && drop.change <= -400) {
        moments.push({ minute: drop.toMinute, tone: 'negative', label: '골드 흐름 하락', detail: `${drop.fromMinute}~${drop.toMinute}분 상대 격차가 ${signed(drop.change, 'G')} 변함` });
    }
    const rise = data.scorecard.momentum.biggestRise;
    if (rise && rise.change >= 400) {
        moments.push({ minute: rise.toMinute, tone: 'positive', label: '골드 흐름 회복', detail: `${rise.fromMinute}~${rise.toMinute}분 상대 격차가 ${signed(rise.change, 'G')} 변함` });
    }

    for (const death of data.deathTimings) {
        const nextEnemyObjective = data.objectives.find(objective => objective.side === 'ENEMY' && objective.minute >= death.minute && objective.minute - death.minute <= 2);
        if (nextEnemyObjective) {
            moments.push({
                minute: death.minute,
                tone: 'negative',
                label: '오브젝트 전 생존 복기',
                detail: `데스 ${rounded(nextEnemyObjective.minute - death.minute, 1)}분 뒤 상대 팀이 ${objectiveLabel(nextEnemyObjective)} 획득 · 인과관계는 리플레이로 확인`
            });
        }
    }

    const majorObjectives = data.objectives.filter(objective => ['BARON_NASHOR', 'ELDER_DRAGON', 'RIFTHERALD'].includes(objective.type));
    for (const objective of majorObjectives.slice(0, 2)) {
        moments.push({
            minute: objective.minute,
            tone: objective.side === 'ALLY' ? 'positive' : objective.side === 'ENEMY' ? 'negative' : 'neutral',
            label: `${objective.side === 'ALLY' ? '아군' : objective.side === 'ENEMY' ? '상대' : '팀 미상'} ${objectiveLabel(objective)}`,
            detail: objective.securedByPlayer ? '직접 처치 기록 확인' : '팀 이벤트이며 개인 관여 여부는 API만으로 확인 불가'
        });
    }

    if (!moments.length) {
        for (const death of data.deathTimings.slice(0, 3)) {
            moments.push({ minute: death.minute, tone: 'neutral', label: '데스 구간', detail: '직전 30초의 시야·아군 거리·보유 자원을 리플레이에서 확인' });
        }
    }

    const unique = new Map();
    for (const moment of moments) unique.set(`${moment.minute}-${moment.label}`, moment);
    return [...unique.values()].sort((a, b) => a.minute - b.minute).slice(0, 6);
}

function buildAnalysisMeta(data) {
    const coverage = ['경기 종료 통계'];
    if (data.checkpoints.length) coverage.push(`${data.checkpoints.length}개 5분 체크포인트`);
    if (data.opponent) coverage.push('동일 포지션 상대 비교');
    if (data.deathTimings.length || data.combatEvents.length) coverage.push('킬·데스 이벤트 시각');
    if (data.objectives.length) coverage.push('팀 오브젝트 이벤트');
    const signalCount = coverage.length;
    const confidence = signalCount >= 5 ? '높음' : signalCount >= 3 ? '보통' : '낮음';
    return {
        confidence,
        coverage,
        caveat: '화면 움직임, 스킬 적중, 콜, 시야 밖 정보와 개인의 오브젝트 관여는 확인할 수 없습니다.'
    };
}

function gradeFromScore(score) {
    if (score >= 90) return 'S';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    return 'D';
}

function buildStatEvaluation(data) {
    const ordered = [...data.scorecard.pillars].sort((a, b) => b.score - a.score);
    const pillarInsight = (pillar, improving = false) => {
        const content = {
            early: {
                title: improving ? '초반 손실선 관리' : '초반 주도권',
                action: improving ? '첫 귀환과 10분 시점에 상대와의 골드·CS 차를 한 번씩 확인하세요.' : '같은 귀환·웨이브 루틴을 다음 경기 15분까지 반복해 보세요.'
            },
            growth: {
                title: improving ? '자원 공백 줄이기' : '자원 운영',
                action: improving ? '교전이 끝나면 10초 안에 가장 가까운 안전한 웨이브나 캠프 하나를 선택하세요.' : '교전 전후의 자원 회수 순서를 유지해 성장 리듬을 재현하세요.'
            },
            combat: {
                title: improving ? '교전 합류 품질' : '교전 영향력',
                action: improving ? '싸움 전 아군 핵심 스킬과 내 진입 각을 확인하고, 늦은 단독 진입을 한 번 줄이세요.' : '현재의 합류 타이밍을 유지하되 교전 뒤 확정 이득까지 연결하세요.'
            },
            discipline: {
                title: improving ? '생존·시야 루틴' : '안정적인 생존·시야',
                action: improving ? '오브젝트 90초 전 귀환 후 와드와 아군 위치를 확인하고 시야 없는 입구는 혼자 지나가지 마세요.' : '오브젝트 전 시야 준비와 안전한 동선을 같은 순서로 반복하세요.'
            }
        }[pillar.key];
        return { title: content.title, evidence: pillar.evidence, action: content.action };
    };
    const strongest = ordered[0];
    const weakest = ordered[ordered.length - 1];
    const strengths = ordered.slice(0, 2).map(pillar => pillarInsight(pillar, false));
    const improvements = [...ordered].reverse().slice(0, 2).map(pillar => pillarInsight(pillar, true));
    const nextGamePlan = buildNextGamePlan(data, [...ordered].reverse());

    return {
        grade: data.scorecard.grade,
        score: data.scorecard.score,
        verdict: `${strongest.label}은 좋았고, ${weakest.label}은 다음 복기 우선순위입니다.`,
        summary: `${data.champion} ${data.position} ${data.result} 경기입니다. ${data.scorecard.momentum.summary} 승패 보너스 없이 확인 가능한 통계와 타임라인만 평가했습니다.`,
        strengths,
        improvements,
        focus: nextGamePlan[0],
        nextGamePlan,
        keyMoments: data.reviewMoments,
        dataLimit: data.analysisMeta.caveat
    };
}

function buildNextGamePlan(data, pillarsByPriority) {
    const target = data.scorecard.targets;
    const planFor = {
        early: () => ({
            title: '15분 손실선 지키기',
            target: '15분 상대 골드 차 -300G 이상',
            cue: '첫 귀환 직후와 8분 오브젝트가 뜨기 전',
            check: '종료 후 10·15분 골드 차를 확인'
        }),
        growth: () => data.positionKey === 'UTILITY' ? ({
            title: '귀환 공백 줄이기',
            target: '상대 서포터와 분당 골드 격차 30 이내',
            cue: '웨이브가 밀린 뒤 또는 오브젝트 90초 전',
            check: '마지막 체크포인트 상대 골드 차를 확인'
        }) : ({
            title: '분당 CS 연습선',
            target: `분당 CS ${target.csPerMinute} 이상`,
            cue: '교전 종료 직후 10초 안에 다음 안전 자원 선택',
            check: '게임 종료 화면에서 CS/분을 확인'
        }),
        combat: () => ({
            title: '합류 한 번 더',
            target: `킬 관여 ${target.killParticipation}% 이상`,
            cue: '아군 2명 이상이 모이고 주요 스킬이 준비됐을 때',
            check: '종료 후 킬 관여율과 늦은 합류 1회를 복기'
        }),
        discipline: () => data.contribution.visionPerMinute < target.visionPerMinute ? ({
            title: '오브젝트 전 시야 루틴',
            target: `분당 시야 ${target.visionPerMinute} 이상`,
            cue: '드래곤·전령·바론 90초 전 귀환',
            check: '시야 점수와 시야 없는 입구 진입 횟수를 확인'
        }) : ({
            title: '위험 데스 줄이기',
            target: `10분당 데스 ${target.deathsPer10} 이하`,
            cue: '아군 두 명 이상이 보이지 않거나 시야 없는 강가 진입 전',
            check: '각 데스 30초 전 미니맵·보유 골드·아군 거리를 확인'
        })
    };

    const seen = new Set();
    const plans = [];
    for (const pillar of pillarsByPriority) {
        if (!planFor[pillar.key] || seen.has(pillar.key)) continue;
        seen.add(pillar.key);
        plans.push(planFor[pillar.key]());
        if (plans.length === 3) break;
    }
    return plans;
}

function normalizeAiEvaluation(value, fallback) {
    const result = value && typeof value === 'object' ? value : {};
    const normalizeItems = items => Array.isArray(items)
        ? items.slice(0, 2).map(item => typeof item === 'string' ? { title: item, evidence: '', action: '' } : {
            title: String(item?.title || '').slice(0, 80),
            evidence: String(item?.evidence || '').slice(0, 260),
            action: String(item?.action || '').slice(0, 260)
        }).filter(item => item.title)
        : [];

    return {
        grade: fallback.grade,
        score: fallback.score,
        verdict: String(result.verdict || fallback.verdict).slice(0, 100),
        summary: String(result.summary || fallback.summary).slice(0, 600),
        strengths: normalizeItems(result.strengths).length ? normalizeItems(result.strengths) : fallback.strengths,
        improvements: normalizeItems(result.improvements).length ? normalizeItems(result.improvements) : fallback.improvements,
        focus: fallback.focus,
        nextGamePlan: fallback.nextGamePlan,
        keyMoments: fallback.keyMoments,
        dataLimit: fallback.dataLimit
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
        'scorecard의 score와 grade는 서버가 고정한 값이므로 새 점수나 등급을 만들거나 재평가하지 마세요.',
        '제공된 JSON 수치와 이벤트만 근거로 쓰고, 보이지 않는 행동·의도·포지셔닝·스킬 사용을 지어내지 마세요.',
        'objectives는 팀 이벤트입니다. securedByPlayer가 true가 아니면 사용자가 획득에 기여했다고 표현하지 마세요.',
        '데스와 뒤이은 오브젝트 사이의 인과를 단정하지 말고, 리플레이 확인이 필요한 정황으로만 표현하세요.',
        'MMR, 티어, 장기 실력을 추정하지 마세요. 승패만으로 잘함과 못함을 판단하지 마세요.',
        '한국어로 짧고 구체적으로 작성하고, 모든 evidence에는 입력에 있는 정확한 수치나 시각을 최소 하나 넣으세요.',
        'action은 다음 경기에서 플레이어가 직접 관찰하거나 확인할 수 있는 한 문장으로 쓰세요.',
        '반드시 JSON 하나만 출력하세요. 키는 verdict, summary, strengths, improvements만 사용하세요.',
        'strengths와 improvements는 각각 {title, evidence, action} 객체 배열이며 정확히 2개입니다.'
    ].join(' ');

    const coachingItemSchema = {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING },
            evidence: { type: Type.STRING },
            action: { type: Type.STRING }
        },
        required: ['title', 'evidence', 'action']
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
                    verdict: { type: Type.STRING },
                    summary: { type: Type.STRING },
                    strengths: { type: Type.ARRAY, items: coachingItemSchema },
                    improvements: { type: Type.ARRAY, items: coachingItemSchema }
                },
                required: ['verdict', 'summary', 'strengths', 'improvements']
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
        if (!SUPPORTED_EVALUATION_QUEUES.has(match.info.queueId)) {
            return res.status(400).json({
                error: 'UNSUPPORTED_GAME_MODE',
                message: '정확한 포지션 비교를 위해 소환사의 협곡 일반·랭크·빠른 대전만 평가할 수 있습니다.'
            });
        }
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
            reportVersion: 2,
            match: summarizeMatch(match, account.puuid),
            evaluation: result.evaluation,
            checkpoints: data.checkpoints,
            scorecard: data.scorecard,
            reviewMoments: data.reviewMoments,
            analysisMeta: data.analysisMeta,
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
        positionKey: 'MIDDLE',
        opponentChampion: 'Syndra',
        combat: {
            kills: 8,
            deaths: 4,
            assists: 10,
            kda: 4.5,
            killParticipationPercent: 62,
            largestKillingSpree: 5
        },
        economy: { gold: 14280, goldPerMinute: 461, teamGoldSharePercent: 22, cs: 221, csPerMinute: 7.1 },
        contribution: {
            championDamage: 28450,
            damagePerMinute: 918,
            teamDamageSharePercent: 27,
            damageTaken: 18420,
            visionScore: 24,
            visionPerMinute: 0.77,
            wardsPlaced: 10,
            wardsKilled: 4,
            controlWardsBought: 2
        },
        opponent: {
            champion: 'Syndra', kills: 5, deaths: 6, assists: 7,
            gold: 13670, goldPerMinute: 441, cs: 211, csPerMinute: 6.8,
            championDamage: 25120, visionPerMinute: 0.61
        },
        teamContext: { kills: 29, deaths: 24, gold: 64900 },
        checkpoints: [
            { minute: 5, gold: 1850, cs: 37, level: 5, versusLane: { champion: 'Syndra', goldDiff: 40, csDiff: 1, xpDiff: 30 } },
            { minute: 10, gold: 3450, cs: 76, level: 8, versusLane: { champion: 'Syndra', goldDiff: 180, csDiff: 4, xpDiff: 120 } },
            { minute: 15, gold: 5680, cs: 116, level: 10, versusLane: { champion: 'Syndra', goldDiff: 420, csDiff: 9, xpDiff: 260 } },
            { minute: 20, gold: 8140, cs: 151, level: 13, versusLane: { champion: 'Syndra', goldDiff: 760, csDiff: 13, xpDiff: 410 } },
            { minute: 25, gold: 10820, cs: 188, level: 15, versusLane: { champion: 'Syndra', goldDiff: 540, csDiff: 8, xpDiff: 220 } },
            { minute: 30, gold: 13540, cs: 216, level: 17, versusLane: { champion: 'Syndra', goldDiff: 610, csDiff: 10, xpDiff: 180 } }
        ],
        deathTimings: [{ minute: 7.8 }, { minute: 18.4 }, { minute: 25.1 }, { minute: 29.6 }],
        combatEvents: [],
        objectives: [
            { minute: 11.2, type: 'DRAGON', subtype: 'AIR_DRAGON', side: 'ALLY', securedByPlayer: false },
            { minute: 16.3, type: 'RIFTHERALD', subtype: null, side: 'ALLY', securedByPlayer: false },
            { minute: 23.7, type: 'BARON_NASHOR', subtype: null, side: 'ENEMY', securedByPlayer: false }
        ]
    };
    data.scorecard = buildScorecard(data);
    data.reviewMoments = buildReviewMoments(data);
    data.analysisMeta = buildAnalysisMeta(data);
    const fallback = buildStatEvaluation(data);

    try {
        const result = await askGemini(data, fallback);
        res.json({
            reportVersion: 2,
            match: {
                matchId: 'DEMO_001',
                championName: 'Ahri',
                kills: 8,
                deaths: 4,
                assists: 10
            },
            evaluation: result.evaluation,
            checkpoints: data.checkpoints,
            scorecard: data.scorecard,
            reviewMoments: data.reviewMoments,
            analysisMeta: data.analysisMeta,
            source: result.source,
            notice: result.source === 'stats' ? 'GEMINI_API_KEY가 없어 통계 기반 데모를 표시합니다.' : '익명 샘플 경기로 Gemini 연결을 확인한 데모입니다.'
        });
    } catch (error) {
        console.error('[evaluation/demo]', error.status || error.message);
        res.json({
            reportVersion: 2,
            match: { matchId: 'DEMO_001', championName: 'Ahri', kills: 8, deaths: 4, assists: 10 },
            evaluation: fallback,
            checkpoints: data.checkpoints,
            scorecard: data.scorecard,
            reviewMoments: data.reviewMoments,
            analysisMeta: data.analysisMeta,
            source: 'stats',
            notice: `Gemini 호출 실패: ${String(error.message || '알 수 없는 오류').slice(0, 160)}`
        });
    }
});

module.exports = router;
