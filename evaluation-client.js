'use strict';

const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'http://localhost:3000'
    : location.hostname.endsWith('github.io')
        ? 'https://nine2-gg.onrender.com'
        : '';

const state = {
    profile: null,
    matches: [],
    analyzing: false,
    selectedMatchIndex: null,
    lastReport: null
};

const elements = Object.fromEntries([
    'searchForm', 'platform', 'gameName', 'tagLine', 'searchButton', 'searchStatus',
    'demoButton', 'profileSection', 'profileIcon', 'profileName', 'profileMeta',
    'aiAvailability', 'matchList', 'analysisLoading', 'analysisSection', 'scoreRing',
    'grade', 'score', 'sourceBadge', 'confidenceBadge', 'analyzedMatch', 'verdict',
    'summary', 'focusTitle', 'focusTarget', 'focusCue', 'metricGrid', 'scoreMethod',
    'pillarGrid', 'momentumLabel', 'momentumSummary', 'timelineChart', 'timeline',
    'keyMoments', 'strengths', 'improvements', 'nextGamePlan', 'coverageList',
    'dataLimit', 'analysisNotice', 'copyReportButton'
].map(id => [id, document.getElementById(id)]));

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function numberValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function signedNumber(value, suffix = '') {
    const number = numberValue(value);
    return `${number > 0 ? '+' : ''}${number.toLocaleString('ko-KR')}${suffix}`;
}

function placeholderImage(label = 'GG') {
    const safeLabel = String(label || 'GG').slice(0, 2).toUpperCase().replace(/[^A-Z0-9가-힣]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="18" fill="#e8e2d8"/><text x="48" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="700" fill="#4e5960">${safeLabel || 'GG'}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function safeImageUrl(value, fallbackLabel) {
    const url = String(value || '');
    return /^(https:\/\/|data:image\/)/i.test(url) ? url : placeholderImage(fallbackLabel);
}

function attachImageFallbacks(root = document) {
    root.querySelectorAll('img[data-fallback]').forEach(image => {
        image.addEventListener('error', () => {
            image.onerror = null;
            image.src = placeholderImage(image.dataset.fallback);
        }, { once: true });
    });
}

function showStatus(message, type = 'error') {
    elements.searchStatus.textContent = message;
    elements.searchStatus.className = `status-message${type === 'info' ? ' is-info' : ''}`;
}

function clearStatus() {
    elements.searchStatus.textContent = '';
    elements.searchStatus.className = 'status-message hidden';
}

async function fetchJson(url, options = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        let data;
        try { data = await response.json(); } catch { data = {}; }
        if (!response.ok) throw new Error(data.message || `요청에 실패했습니다. (${response.status})`);
        return data;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('분석 응답이 늦어지고 있습니다. 잠시 후 다시 시도해 주세요.');
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '날짜 미상';
    return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function setBusy(isBusy) {
    state.analyzing = isBusy;
    elements.analysisLoading.classList.toggle('hidden', !isBusy);
    elements.demoButton.disabled = isBusy;
    elements.searchButton.disabled = isBusy;
    elements.matchList.querySelectorAll('.match-card').forEach(button => { button.disabled = isBusy; });
}

function renderMatches(data) {
    if (!data?.profile) throw new Error('소환사 프로필 응답이 올바르지 않습니다.');
    state.profile = data.profile;
    state.matches = Array.isArray(data.matches) ? data.matches : [];
    state.selectedMatchIndex = null;

    elements.profileIcon.src = safeImageUrl(data.profile.profileIconUrl, 'GG');
    elements.profileIcon.dataset.fallback = 'GG';
    elements.profileName.textContent = `${data.profile.gameName} #${data.profile.tagLine}`;
    elements.profileMeta.textContent = `${data.profile.platformLabel || '한국'} · 레벨 ${numberValue(data.profile.summonerLevel)}`;
    elements.aiAvailability.textContent = data.aiAvailable ? 'AI 코칭 사용 가능' : '통계 코칭으로 제공';

    if (!state.matches.length) {
        elements.matchList.innerHTML = '<div class="paper-card loading-card"><p class="loading-title">최근 경기를 찾지 못했습니다.</p><p class="loading-copy">게임 모드와 Riot ID를 확인해 주세요.</p></div>';
    } else {
        elements.matchList.innerHTML = state.matches.map((match, index) => {
            const result = match.win ? '승리' : '패배';
            const imageUrl = safeImageUrl(match.championImageUrl, match.championName);
            const supported = match.analysisSupported !== false;
            return `<button type="button" class="match-card ${match.win ? 'is-win' : ''}" data-index="${index}" aria-label="${escapeHtml(match.championName)} ${result} 경기 ${supported ? '리포트 보기' : '분석 미지원'}" ${supported ? '' : 'disabled'}>
                <img class="match-champion" src="${escapeHtml(imageUrl)}" data-fallback="${escapeHtml(match.championName)}" alt="${escapeHtml(match.championName)}">
                <span>
                    <span class="match-topline">
                        <span class="result-badge">${result}</span>
                        <span class="match-name">${escapeHtml(match.championName)}</span>
                        <span class="match-role">${escapeHtml(match.positionLabel)}</span>
                    </span>
                    <span class="match-stats">${numberValue(match.kills)} / ${numberValue(match.deaths)} / ${numberValue(match.assists)} · KDA ${numberValue(match.kda).toFixed(2)} · KP ${numberValue(match.killParticipationPercent)}%</span>
                    <span class="match-sub">${escapeHtml(match.queue)} · ${numberValue(match.durationMinutes)}분 · CS ${numberValue(match.cs)} (${numberValue(match.csPerMinute).toFixed(1)}/분) · ${formatDate(match.gameCreation)}</span>
                </span>
                <span class="match-cta">${supported ? '리포트 보기 →' : '해당 모드 미지원'}</span>
            </button>`;
        }).join('');
    }

    elements.matchList.querySelectorAll('.match-card').forEach(button => {
        button.addEventListener('click', () => analyzeMatch(numberValue(button.dataset.index)));
    });
    attachImageFallbacks(elements.profileSection);
    elements.profileSection.classList.remove('hidden');
}

function normalizeScorecard(data) {
    const evaluation = data.evaluation || {};
    return data.scorecard || {
        score: numberValue(evaluation.score),
        grade: evaluation.grade || '-',
        metrics: [],
        pillars: [],
        momentum: { label: '5분 단위 흐름', summary: '제공된 체크포인트를 기준으로 표시합니다.' },
        method: '종료 통계와 5분 단위 타임라인을 함께 사용한 한 경기 평가'
    };
}

function renderMetrics(scorecard, match) {
    let metrics = Array.isArray(scorecard.metrics) ? scorecard.metrics : [];
    if (!metrics.length && match) {
        metrics = [
            { label: 'KDA', value: `${numberValue(match.kills)}/${numberValue(match.deaths)}/${numberValue(match.assists)}`, target: '경기 기록', good: true },
            { label: '점수', value: String(scorecard.score), target: '한 경기 퍼포먼스', good: numberValue(scorecard.score) >= 70 }
        ];
    }
    elements.metricGrid.innerHTML = metrics.map(metric => `<div class="metric-card ${metric.good ? 'is-good' : 'is-watch'}">
        <p class="metric-label">${escapeHtml(metric.label)}</p>
        <p class="metric-value">${escapeHtml(metric.value)}</p>
        <p class="metric-target">연습선 ${escapeHtml(metric.target)}</p>
    </div>`).join('');
}

function renderPillars(scorecard) {
    const pillars = Array.isArray(scorecard.pillars) ? scorecard.pillars : [];
    if (!pillars.length) {
        elements.pillarGrid.innerHTML = '<p class="section-description">세부 축 점수는 새 리포트 응답부터 표시됩니다.</p>';
        return;
    }
    elements.pillarGrid.innerHTML = pillars.map(pillar => {
        const score = Math.round(Math.max(0, Math.min(100, numberValue(pillar.score))));
        const tone = score >= 80 ? 'is-strong' : score < 60 ? 'is-watch' : '';
        return `<article class="pillar-card ${tone}">
            <div class="pillar-top"><span class="pillar-label">${escapeHtml(pillar.label)}</span><span class="pillar-score">${score}</span></div>
            <p class="pillar-status">${escapeHtml(pillar.status)}</p>
            <div class="pillar-track" aria-hidden="true"><div class="pillar-fill" style="width:${score}%"></div></div>
            <p class="pillar-evidence">${escapeHtml(pillar.evidence)}</p>
        </article>`;
    }).join('');
}

function renderTimeline(checkpoints, scorecard) {
    const items = (Array.isArray(checkpoints) ? checkpoints : []).filter(point => point?.versusLane);
    const momentum = scorecard.momentum || {};
    elements.momentumLabel.textContent = momentum.label || '경기 흐름';
    elements.momentumSummary.textContent = momentum.summary || '';

    if (!items.length) {
        elements.timelineChart.innerHTML = '<div class="chart-empty">동일 포지션 상대와 비교할 타임라인이 없습니다.</div>';
        elements.timeline.innerHTML = '';
        return;
    }

    const width = 720;
    const height = 220;
    const left = 54;
    const right = 22;
    const top = 22;
    const bottom = 38;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const values = items.map(item => numberValue(item.versusLane.goldDiff));
    const maxAbs = Math.max(500, Math.ceil(Math.max(...values.map(Math.abs)) / 250) * 250);
    const xFor = index => items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth;
    const yFor = value => top + ((maxAbs - value) / (maxAbs * 2)) * plotHeight;
    const zeroY = yFor(0);
    const points = items.map((item, index) => `${xFor(index).toFixed(1)},${yFor(values[index]).toFixed(1)}`).join(' ');
    const areaPath = `M ${xFor(0).toFixed(1)} ${zeroY.toFixed(1)} L ${points.replaceAll(' ', ' L ')} L ${xFor(items.length - 1).toFixed(1)} ${zeroY.toFixed(1)} Z`;
    const gridValues = [maxAbs, 0, -maxAbs];
    const ariaLabel = `동일 포지션 상대 골드 차: ${items.map((item, index) => `${item.minute}분 ${signedNumber(values[index], '골드')}`).join(', ')}`;

    elements.timelineChart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
        <defs><linearGradient id="goldFlowArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#347f91" stop-opacity=".3"/><stop offset="1" stop-color="#347f91" stop-opacity=".02"/></linearGradient></defs>
        ${gridValues.map(value => `<line x1="${left}" y1="${yFor(value)}" x2="${width - right}" y2="${yFor(value)}" stroke="${value === 0 ? '#8c9699' : '#dcd8cf'}" stroke-width="${value === 0 ? 1.4 : 1}" stroke-dasharray="${value === 0 ? '5 4' : '2 5'}"/><text x="${left - 9}" y="${yFor(value) + 4}" text-anchor="end" fill="#7e888c" font-size="10" font-weight="700">${value > 0 ? '+' : ''}${value}</text>`).join('')}
        <path d="${areaPath}" fill="url(#goldFlowArea)"/>
        <polyline points="${points}" fill="none" stroke="#21667a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        ${items.map((item, index) => `<g><circle cx="${xFor(index)}" cy="${yFor(values[index])}" r="5" fill="#fffdf7" stroke="${values[index] >= 0 ? '#21667a' : '#a83e36'}" stroke-width="3"><title>${item.minute}분: ${signedNumber(values[index], 'G')}, ${signedNumber(item.versusLane.csDiff, 'CS')}</title></circle><text x="${xFor(index)}" y="${height - 12}" text-anchor="middle" fill="#6c777f" font-size="10" font-weight="800">${item.minute}분</text></g>`).join('')}
    </svg>`;

    elements.timeline.innerHTML = items.map(item => {
        const diff = numberValue(item.versusLane.goldDiff);
        return `<article class="checkpoint">
            <p class="checkpoint-minute">${numberValue(item.minute)}분</p>
            <p class="checkpoint-diff ${diff >= 0 ? 'is-positive' : 'is-negative'}">${signedNumber(diff, 'G')}</p>
            <p class="checkpoint-sub">${signedNumber(item.versusLane.csDiff, 'CS')} · ${signedNumber(item.versusLane.xpDiff, 'XP')}</p>
        </article>`;
    }).join('');
}

function renderMoments(data) {
    const rawMoments = Array.isArray(data.reviewMoments) && data.reviewMoments.length
        ? data.reviewMoments
        : Array.isArray(data.evaluation?.keyMoments) ? data.evaluation.keyMoments : [];
    const moments = rawMoments.map(item => typeof item === 'string'
        ? { minute: '', tone: 'neutral', label: item, detail: '리플레이에서 전후 상황을 확인하세요.' }
        : item);

    if (!moments.length) {
        elements.keyMoments.innerHTML = '<p class="moment-detail">자동으로 고른 구간이 없습니다.</p>';
        return;
    }
    elements.keyMoments.innerHTML = moments.map(moment => `<article class="moment-item is-${escapeHtml(moment.tone || 'neutral')}">
        <span class="moment-time">${moment.minute === '' ? '복기' : `${escapeHtml(moment.minute)}분`}</span>
        <p class="moment-label">${escapeHtml(moment.label)}</p>
        <p class="moment-detail">${escapeHtml(moment.detail || '')}</p>
    </article>`).join('');
}

function renderInsights(container, items) {
    const normalized = Array.isArray(items) ? items : [];
    if (!normalized.length) {
        container.innerHTML = '<p class="section-description">표시할 코칭 메모가 없습니다.</p>';
        return;
    }
    container.innerHTML = normalized.map(raw => {
        const item = typeof raw === 'string' ? { title: raw, evidence: '', action: '' } : raw;
        return `<article class="insight-card">
            <h4>${escapeHtml(item.title)}</h4>
            <p class="insight-evidence">${escapeHtml(item.evidence)}</p>
            ${item.action ? `<p class="insight-action"><strong>다음 행동</strong><span>${escapeHtml(item.action)}</span></p>` : ''}
        </article>`;
    }).join('');
}

function normalizePlanItem(raw, index) {
    if (typeof raw === 'string') return { title: `체크 ${index + 1}`, target: raw, cue: '', check: '' };
    return {
        title: raw?.title || `체크 ${index + 1}`,
        target: raw?.target || '',
        cue: raw?.cue || '',
        check: raw?.check || ''
    };
}

function renderPlan(items) {
    const plans = (Array.isArray(items) ? items : []).slice(0, 3).map(normalizePlanItem);
    elements.nextGamePlan.innerHTML = plans.map(plan => `<li class="plan-card">
        <h4>${escapeHtml(plan.title)}</h4>
        <p class="plan-target">${escapeHtml(plan.target)}</p>
        ${(plan.cue || plan.check) ? `<p class="plan-detail">${plan.cue ? `<strong>실행 신호</strong> · ${escapeHtml(plan.cue)}<br>` : ''}${plan.check ? `<strong>확인</strong> · ${escapeHtml(plan.check)}` : ''}</p>` : ''}
    </li>`).join('');
}

function renderCoverage(meta, dataLimit) {
    const coverage = Array.isArray(meta?.coverage) ? meta.coverage : ['경기 종료 통계', '5분 타임라인'];
    elements.coverageList.innerHTML = coverage.map(item => `<span class="coverage-chip">${escapeHtml(item)}</span>`).join('');
    elements.dataLimit.textContent = dataLimit || meta?.caveat || 'API에서 확인할 수 없는 플레이 장면과 의도는 평가하지 않습니다.';
}

function renderEvaluation(data) {
    if (!data?.evaluation || !data?.match) throw new Error('평가 응답이 올바르지 않습니다.');
    state.lastReport = data;
    const evaluation = data.evaluation;
    const scorecard = normalizeScorecard(data);
    const score = Math.round(Math.max(0, Math.min(100, numberValue(scorecard.score, evaluation.score))));
    const grade = scorecard.grade || evaluation.grade || '-';
    const meta = data.analysisMeta || {};
    const plans = Array.isArray(evaluation.nextGamePlan) ? evaluation.nextGamePlan : [];
    const focus = typeof evaluation.focus === 'object' && evaluation.focus
        ? evaluation.focus
        : normalizePlanItem(plans[0] || '한 가지 목표를 정하고 게임 종료 후 다시 확인하기', 0);

    elements.scoreRing.style.setProperty('--score', score);
    elements.scoreRing.setAttribute('aria-label', `한 경기 퍼포먼스 ${score}점, ${grade} 등급`);
    elements.grade.textContent = grade;
    elements.score.textContent = `${score} / 100`;
    elements.verdict.textContent = evaluation.verdict || '경기 리포트';
    elements.summary.textContent = evaluation.summary || '';
    elements.analyzedMatch.textContent = `${data.match.championName || '챔피언'} · ${numberValue(data.match.kills)}/${numberValue(data.match.deaths)}/${numberValue(data.match.assists)}`;

    const isGemini = data.source === 'gemini';
    elements.sourceBadge.textContent = isGemini ? 'AI 코칭 · 고정 점수' : '통계 코칭 · 고정 점수';
    elements.sourceBadge.className = `source-badge${isGemini ? '' : ' is-stats'}`;
    elements.confidenceBadge.textContent = `근거 신뢰도 ${meta.confidence || '보통'}`;

    elements.focusTitle.textContent = focus.title || '다음 게임 한 가지';
    elements.focusTarget.textContent = focus.target || '';
    elements.focusCue.textContent = [focus.cue ? `실행 신호 · ${focus.cue}` : '', focus.check ? `확인 · ${focus.check}` : ''].filter(Boolean).join('  /  ');
    elements.scoreMethod.textContent = scorecard.method || '';

    renderMetrics(scorecard, data.match);
    renderPillars(scorecard);
    renderTimeline(data.checkpoints, scorecard);
    renderMoments(data);
    renderInsights(elements.strengths, evaluation.strengths);
    renderInsights(elements.improvements, evaluation.improvements);
    renderPlan(plans);
    renderCoverage(meta, evaluation.dataLimit);

    elements.analysisNotice.textContent = data.notice || '';
    elements.analysisSection.classList.remove('hidden');
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => elements.analysisSection.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }), 30);
}

async function analyzeMatch(index) {
    if (state.analyzing || !state.matches[index] || !state.profile) return;
    clearStatus();
    state.selectedMatchIndex = index;
    elements.analysisSection.classList.add('hidden');
    elements.matchList.querySelectorAll('.match-card').forEach((button, buttonIndex) => button.classList.toggle('is-selected', buttonIndex === index));
    setBusy(true);
    try {
        const data = await fetchJson(`${API_BASE}/api/evaluation/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platform: state.profile.platform,
                gameName: state.profile.gameName,
                tagLine: state.profile.tagLine,
                matchId: state.matches[index].matchId
            })
        });
        renderEvaluation(data);
    } catch (error) {
        showStatus(error.message);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
        setBusy(false);
    }
}

elements.searchForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.analyzing) return;
    clearStatus();
    elements.profileSection.classList.add('hidden');
    elements.analysisSection.classList.add('hidden');
    elements.searchButton.textContent = '경기 불러오는 중';
    setBusy(true);
    const params = new URLSearchParams({
        platform: elements.platform.value,
        gameName: elements.gameName.value.trim(),
        tagLine: elements.tagLine.value.trim().replace(/^#/, '')
    });
    try {
        const data = await fetchJson(`${API_BASE}/api/evaluation/matches?${params}`, {}, 30000);
        renderMatches(data);
        showStatus('최근 경기를 불러왔습니다. 복기할 한 판을 선택하세요.', 'info');
    } catch (error) {
        showStatus(error.message);
    } finally {
        setBusy(false);
        elements.searchButton.textContent = '최근 경기 찾기';
    }
});

elements.demoButton.addEventListener('click', async () => {
    if (state.analyzing) return;
    clearStatus();
    elements.analysisSection.classList.add('hidden');
    elements.demoButton.textContent = '샘플 분석 중';
    setBusy(true);
    try {
        const data = await fetchJson(`${API_BASE}/api/evaluation/demo`, { method: 'POST' });
        renderEvaluation(data);
    } catch (error) {
        showStatus(error.message);
    } finally {
        setBusy(false);
        elements.demoButton.textContent = '샘플 리포트 보기';
    }
});

elements.copyReportButton.addEventListener('click', async () => {
    const data = state.lastReport;
    if (!data) return;
    const evaluation = data.evaluation || {};
    const scorecard = normalizeScorecard(data);
    const focus = evaluation.focus || normalizePlanItem(evaluation.nextGamePlan?.[0] || '', 0);
    const text = [
        'GG.92 경기 리포트',
        `${data.match.championName || '챔피언'} · ${data.match.kills}/${data.match.deaths}/${data.match.assists}`,
        `${scorecard.grade || evaluation.grade} · ${scorecard.score ?? evaluation.score}/100`,
        evaluation.verdict || '',
        evaluation.summary || '',
        '',
        `다음 게임: ${focus.title || ''}`,
        focus.target || '',
        focus.cue ? `실행 신호: ${focus.cue}` : '',
        focus.check ? `확인: ${focus.check}` : ''
    ].filter(Boolean).join('\n');

    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }
    elements.copyReportButton.textContent = '복사 완료';
    window.setTimeout(() => { elements.copyReportButton.textContent = '리포트 복사'; }, 1500);
});

const initialParams = new URLSearchParams(location.search);
if (initialParams.get('gameName')) elements.gameName.value = initialParams.get('gameName').slice(0, 40);
if (initialParams.get('tagLine')) elements.tagLine.value = initialParams.get('tagLine').replace(/^#/, '').slice(0, 20);
