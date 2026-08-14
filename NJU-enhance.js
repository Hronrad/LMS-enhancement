// ==UserScript==
// @name         南大LMS智慧教育平台|MOOC增强
// @namespace    http://tampermonkey.net/
// @version      0.51
// @description  南大LMS原生播放按钮自动播放、后台播放保护、自动下一节、统一认证自动填表 + MOOC倍速控制 + 一键下载课件
// @author       Hronrad
// @license    GPL-3.0-only
// @match        https://lms.nju.edu.cn/*
// @match        https://www.icourse163.org/*
// @match        https://icourse163.org/*
// @match        https://authserver.nju.edu.cn/authserver/login*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    let lastUserAction = 0;
    let allVideosCompleted = false;
    let scriptPaused = false;
    let noVideoCheckCount = 0;
    const MAX_NO_VIDEO_CHECKS = 5;
    let currentSpeed = 1;
    const boundVideos = new WeakSet();
    const userPausedVideos = new WeakSet();
    const videoWatchStates = new WeakMap();
    const observedControlDocuments = new WeakSet();
    let internalControlAction = false;
    let nextInProgress = false;
    let lastAutoPlayAttempt = 0;
    let autoPlayPending = true;
    let contentReady = false;
    let pageLoadTime = Date.now();
    let lastPlayerProgressAt = 0;
    let playVerificationTimer = null;
    let backgroundTransitionAt = 0;
    let backgroundWatchdog = null;
    let backgroundWatchdogUrl = null;
    let backgroundFallbackTimer = null;
    let backgroundPlaybackExpected = false;
    let lastBackgroundRecoveryAttempt = 0;
    const BACKGROUND_RETRY_COOLDOWN = 3000;

    const SPEED_STORAGE_KEY = `lms-video-speed-${location.hostname}`;
    const SETTINGS_STORAGE_KEY = 'lms-enhance-settings';

    const isICourse163 = location.hostname.includes('icourse163.org');
    const isAuthServer = location.hostname.includes('authserver.nju.edu.cn');

    const GlobalSettings = {
        config: {
            autoLogin: false,
            username: '',
            password: '',
            authSubmitDelayMs: 800,
            autoJump: true
        },
        load() {
            try {
                const shared = typeof GM_getValue === 'function'
                    ? GM_getValue(SETTINGS_STORAGE_KEY, null)
                    : null;
                const saved = shared || localStorage.getItem(SETTINGS_STORAGE_KEY);
                if (saved) {
                    const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
                    Object.keys(this.config).forEach(key => {
                        if (Object.prototype.hasOwnProperty.call(parsed, key)) this.config[key] = parsed[key];
                    });
                }
            } catch (e) {}
        },
        save() {
            try {
                if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_STORAGE_KEY, this.config);
                localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.config));
            } catch (e) {}
        }
    };
    GlobalSettings.load();
    if (!isICourse163 && !isAuthServer) {
        GlobalSettings.config.autoJump = true;
    }

    const authAutomationState = {
        submitTimer: null,
        submitInFlight: false,
        forceRunUntil: 0,
        sliderSolving: false,
        sliderLastSignature: '',
        sliderPendingSignature: '',
        sliderLastAttemptAt: 0,
        sliderFeedbackTimer: null,
        sliderAttempts: 0,
        sliderLastFeedbackState: '',
        observer: null,
        pollTimer: null,
        completed: false,
        lastStatus: ''
    };

    if (isAuthServer) {
        whenDocumentReady(initAuthLoginAssistant);
        return;
    }

    function getAllowedSpeeds() {
        return [0.1, 0.5, 1, 1.5, 2, 3, 16];
    }

    function whenDocumentReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    }

    function setNativeInputValue(input, value) {
        if (!input) return;
        const prototype = input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function simulateNativeClick(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            const EventClass = type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
            element.dispatchEvent(new EventClass(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                button: 0,
                buttons: type.endsWith('down') ? 1 : 0,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true
            }));
        });
        return true;
    }

    function setAuthStatus(message) {
        if (authAutomationState.lastStatus === message) return;
        authAutomationState.lastStatus = message;
        const status = document.getElementById('lms-auth-status');
        if (status) status.textContent = message;
        console.info(`[LMS enhance auth] ${message}`);
    }

    function stopAuthChallengeMonitoring() {
        if (authAutomationState.observer) {
            authAutomationState.observer.disconnect();
            authAutomationState.observer = null;
        }
        if (authAutomationState.pollTimer) {
            window.clearInterval(authAutomationState.pollTimer);
            authAutomationState.pollTimer = null;
        }
        if (authAutomationState.sliderFeedbackTimer) {
            window.clearTimeout(authAutomationState.sliderFeedbackTimer);
            authAutomationState.sliderFeedbackTimer = null;
        }
    }

    function canRunAuthAutomation() {
        return Boolean(GlobalSettings.config.autoLogin || Date.now() < authAutomationState.forceRunUntil);
    }

    function isVisibleElement(element) {
        if (!element || element.disabled) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0
            && element.getClientRects().length > 0;
    }

    function findAuthLoginElements() {
        const findVisible = selectors => Array.from(document.querySelectorAll(selectors)).find(element =>
            element.getClientRects().length > 0 && !element.disabled
        );
        const username = findVisible(
            '#username, input[name="username"], input[name="userName"], input[autocomplete="username"], input[id*="user"], input[type="text"]'
        );
        const password = findVisible(
            '#password, #pwd, input[name="password"], input[autocomplete="current-password"], input[type="password"]'
        );
        const buttons = Array.from(document.querySelectorAll(
            '#login_submit, #loginSubmit, #loginButton, .auth_login_btn, .login-btn, button[type="submit"], input[type="submit"], button'
        )).filter(button => !button.closest('#lms-auth-helper'));
        const submit = buttons.find(button => {
            const text = `${button.textContent || ''} ${button.value || ''} ${button.getAttribute('aria-label') || ''}`;
            return /登录|login/i.test(text) && button.getClientRects().length > 0 && !button.disabled;
        }) || buttons.find(button => /submit/i.test(button.type || '') && button.getClientRects().length > 0 && !button.disabled);
        return { username, password, submit };
    }

    function fillAndSubmitAuthLogin(forceSubmit = false) {
        const { username, password, submit } = findAuthLoginElements();
        if (!username || !password) {
            setAuthStatus('等待登录表单加载');
            return false;
        }
        if (!GlobalSettings.config.username || !GlobalSettings.config.password) {
            setAuthStatus('请先保存学号和密码');
            return false;
        }
        setNativeInputValue(username, GlobalSettings.config.username);
        setNativeInputValue(password, GlobalSettings.config.password);
        setAuthStatus('账号密码已填入');
        if (!forceSubmit && !GlobalSettings.config.autoLogin) return true;
        if (!submit) {
            setAuthStatus('已填表，等待登录按钮');
            return false;
        }
        if (forceSubmit) {
            authAutomationState.forceRunUntil = Date.now() + 60000;
            authAutomationState.completed = false;
            authAutomationState.sliderAttempts = 0;
            authAutomationState.sliderLastFeedbackState = '';
            authAutomationState.sliderLastSignature = '';
            authAutomationState.sliderPendingSignature = '';
        }
        if (authAutomationState.submitTimer || authAutomationState.submitInFlight) return true;
        const delay = Math.max(0, Number(GlobalSettings.config.authSubmitDelayMs) || 0);
        setAuthStatus(delay > 0 ? `账号密码已填入，${delay}ms 后登录` : '账号密码已填入，正在登录');
        authAutomationState.submitTimer = window.setTimeout(() => {
            authAutomationState.submitTimer = null;
            if (!canRunAuthAutomation()) return;
            authAutomationState.submitInFlight = true;
            try {
                submit.focus();
                if (typeof submit.click === 'function') submit.click();
                else simulateNativeClick(submit);
                setAuthStatus('已点击登录，等待安全验证');
                window.setTimeout(() => {
                    authAutomationState.submitInFlight = false;
                    trySolveAuthSlider();
                }, 250);
            } catch (error) {
                authAutomationState.submitInFlight = false;
                setAuthStatus(`点击登录失败：${error.message || error}`);
            }
        }, delay);
        return true;
    }

    function findAuthSliderChallenge() {
        const container = document.querySelector('#sliderCaptchaDiv #captcha-id');
        const slider = document.querySelector('#sliderCaptchaDiv #sliderDiv .slider');
        const background = document.querySelector('#sliderCaptchaDiv #slider-img1');
        const puzzle = document.querySelector('#sliderCaptchaDiv #slider-img2');
        if (!container || !slider || !background || !puzzle || !isVisibleElement(container) || !isVisibleElement(slider)) return null;
        return { container, slider, background, puzzle };
    }

    function authSliderSignature(challenge) {
        const background = String(challenge?.background?.src || '');
        const puzzle = String(challenge?.puzzle?.src || '');
        return `${background.length}:${background.slice(-32)}|${puzzle.length}:${puzzle.slice(-32)}`;
    }

    function loadAuthImage(source) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('拼图图片加载失败'));
            image.src = source;
        });
    }

    async function solveAuthSliderImages(backgroundSource, puzzleSource) {
        const [background, puzzle] = await Promise.all([
            loadAuthImage(backgroundSource),
            loadAuthImage(puzzleSource)
        ]);
        const backgroundWidth = background.naturalWidth || background.width;
        const backgroundHeight = background.naturalHeight || background.height;
        const puzzleWidth = puzzle.naturalWidth || puzzle.width;
        const puzzleHeight = puzzle.naturalHeight || puzzle.height;
        const backgroundCanvas = document.createElement('canvas');
        const puzzleCanvas = document.createElement('canvas');
        const backgroundContext = backgroundCanvas.getContext('2d', { willReadFrequently: true });
        const puzzleContext = puzzleCanvas.getContext('2d', { willReadFrequently: true });
        if (!backgroundContext || !puzzleContext) throw new Error('无法创建拼图 Canvas');
        backgroundCanvas.width = backgroundWidth;
        backgroundCanvas.height = backgroundHeight;
        puzzleCanvas.width = puzzleWidth;
        puzzleCanvas.height = puzzleHeight;
        backgroundContext.drawImage(background, 0, 0, backgroundWidth, backgroundHeight);
        puzzleContext.drawImage(puzzle, 0, 0, puzzleWidth, puzzleHeight);
        return findAuthSliderPositionFromPixels(
            backgroundContext.getImageData(0, 0, backgroundWidth, backgroundHeight).data,
            backgroundWidth,
            backgroundHeight,
            puzzleContext.getImageData(0, 0, puzzleWidth, puzzleHeight).data,
            puzzleWidth,
            puzzleHeight
        );
    }

    function findAuthSliderPositionFromPixels(backgroundPixels, backgroundWidth, backgroundHeight, puzzlePixels, puzzleWidth, puzzleHeight) {
        const mask = new Uint8Array(puzzleWidth * puzzleHeight);
        const integralWidth = puzzleWidth + 1;
        const integral = new Uint32Array(integralWidth * (puzzleHeight + 1));
        let opaqueCount = 0;
        for (let y = 0; y < puzzleHeight; y += 1) {
            let rowSum = 0;
            for (let x = 0; x < puzzleWidth; x += 1) {
                const opaque = puzzlePixels[(y * puzzleWidth + x) * 4 + 3] > 8 ? 1 : 0;
                mask[y * puzzleWidth + x] = opaque;
                opaqueCount += opaque;
                rowSum += opaque;
                integral[(y + 1) * integralWidth + x + 1] = integral[y * integralWidth + x + 1] + rowSum;
            }
        }
        if (!opaqueCount) throw new Error('拼图透明轮廓为空');

        const areaSum = (left, top, right, bottom) => (
            integral[bottom * integralWidth + right]
            - integral[top * integralWidth + right]
            - integral[bottom * integralWidth + left]
            + integral[top * integralWidth + left]
        );
        const boundary = [];
        const inner = [];
        const innerRadius = 4;
        for (let y = 0; y < puzzleHeight; y += 1) {
            for (let x = 0; x < puzzleWidth; x += 1) {
                if (!mask[y * puzzleWidth + x]) continue;
                const left = Math.max(0, x - 1);
                const top = Math.max(0, y - 1);
                const right = Math.min(puzzleWidth, x + 2);
                const bottom = Math.min(puzzleHeight, y + 2);
                if (areaSum(left, top, right, bottom) < 9) boundary.push([x, y]);
                if (x >= innerRadius && y >= innerRadius && x + innerRadius < puzzleWidth && y + innerRadius < puzzleHeight
                    && areaSum(x - innerRadius, y - innerRadius, x + innerRadius + 1, y + innerRadius + 1) === 81) {
                    inner.push([x, y]);
                }
            }
        }
        if (!boundary.length || !inner.length) throw new Error('拼图轮廓特征不足');

        const mapY = puzzleHeight === backgroundHeight
            ? y => y
            : y => Math.min(backgroundHeight - 1, Math.round(y * (backgroundHeight - 1) / Math.max(1, puzzleHeight - 1)));
        const maxOffset = backgroundWidth - puzzleWidth;
        if (maxOffset < 1) throw new Error('拼图尺寸异常');
        const whiteDiagonal = Math.sqrt(3 * 255 * 255);
        let bestX = 0;
        let bestScore = Infinity;
        let secondScore = Infinity;
        for (let offsetX = 0; offsetX <= maxOffset; offsetX += 1) {
            let whiteDistance = 0;
            let whiteCount = 0;
            let boundaryLuminance = 0;
            for (const [x, y] of boundary) {
                const source = (mapY(y) * backgroundWidth + offsetX + x) * 4;
                const r = backgroundPixels[source];
                const g = backgroundPixels[source + 1];
                const b = backgroundPixels[source + 2];
                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);
                whiteDistance += Math.hypot(255 - r, 255 - g, 255 - b) / whiteDiagonal;
                if (min > 175 && max - min < 100) whiteCount += 1;
                boundaryLuminance += (r + g + b) / 3;
            }
            let innerChroma = 0;
            let innerLuminance = 0;
            let innerLuminanceSquared = 0;
            for (const [x, y] of inner) {
                const source = (mapY(y) * backgroundWidth + offsetX + x) * 4;
                const r = backgroundPixels[source];
                const g = backgroundPixels[source + 1];
                const b = backgroundPixels[source + 2];
                const luminance = (r + g + b) / 3;
                innerChroma += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
                innerLuminance += luminance;
                innerLuminanceSquared += luminance * luminance;
            }
            const boundaryMean = boundaryLuminance / boundary.length;
            const innerMean = innerLuminance / inner.length;
            const innerVariance = Math.max(0, innerLuminanceSquared / inner.length - innerMean * innerMean);
            const contrast = (boundaryMean - innerMean) / 255;
            const score = 1.5 * (whiteDistance / boundary.length)
                + 1.5 * (1 - whiteCount / boundary.length)
                + 0.8 * (innerChroma / inner.length)
                + 0.7 * (Math.sqrt(innerVariance) / 128)
                + 0.5 * (innerMean / 255)
                + Math.max(0, 0.12 - contrast) * 4;
            if (score < bestScore) {
                secondScore = bestScore;
                bestScore = score;
                bestX = offsetX;
            } else if (score < secondScore) {
                secondScore = score;
            }
        }
        return {
            x: bestX,
            score: bestScore,
            confidence: Number.isFinite(secondScore) ? secondScore - bestScore : 0,
            backgroundWidth,
            backgroundHeight
        };
    }

    function createMouseEvent(type, clientX, clientY, target) {
        const view = resolveEventView(target);
        const MouseEventCtor = view && view.MouseEvent ? view.MouseEvent : MouseEvent;
        return new MouseEventCtor(type, {
            bubbles: true,
            cancelable: true,
            view,
            clientX,
            clientY,
            screenX: (view && Number.isFinite(view.screenX) ? view.screenX : window.screenX || 0) + clientX,
            screenY: (view && Number.isFinite(view.screenY) ? view.screenY : window.screenY || 0) + clientY
        });
    }

    function resolveEventView(target) {
        if (target && target.window === target) return target;
        if (target && target.defaultView) return target.defaultView;
        if (target && target.ownerDocument && target.ownerDocument.defaultView) return target.ownerDocument.defaultView;
        return document.defaultView || window;
    }

    function simulateNativeSliderDrag(slider, targetPosition, shouldContinue = canRunAuthAutomation) {
        return new Promise((resolve, reject) => {
            if (!shouldContinue()) {
                resolve(false);
                return;
            }
            if (!slider || !isVisibleElement(slider)) return reject(new Error('未找到可见滑块'));
            const rect = slider.getBoundingClientRect();
            const startX = rect.left + rect.width / 2;
            const startY = rect.top + rect.height / 2;
            const distance = Math.max(1, targetPosition);
            const steps = Math.max(18, Math.ceil(distance / 8));
            const moveDelay = 8;
            const doc = slider.ownerDocument || document;
            const view = doc.defaultView || window;
            slider.dispatchEvent(createMouseEvent('mousedown', startX, startY, slider));
            let step = 0;
            const tick = () => {
                if (!shouldContinue()) {
                    resolve(false);
                    return;
                }
                if (step <= steps) {
                    const progress = step / steps;
                    const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
                    const wobble = step > 0 && step < steps ? Math.sin(step * 1.7) * 0.7 : 0;
                    const x = startX + distance * eased + wobble;
                    const move = createMouseEvent('mousemove', x, startY, doc);
                    doc.dispatchEvent(move);
                    view.dispatchEvent(createMouseEvent('mousemove', x, startY, view));
                    step += 1;
                    window.setTimeout(tick, moveDelay);
                    return;
                }
                const end = createMouseEvent('mouseup', startX + distance, startY, doc);
                doc.dispatchEvent(end);
                view.dispatchEvent(createMouseEvent('mouseup', startX + distance, startY, view));
                window.setTimeout(() => resolve(true), 80);
            };
            window.setTimeout(tick, 120);
        });
    }

    function inspectAuthSliderFeedback() {
        const success = document.querySelector('#sliderCaptchaDiv .sliderContainer_success');
        const failure = document.querySelector('#sliderCaptchaDiv .sliderContainer_fail');
        if (success && isVisibleElement(success)) {
            if (authAutomationState.sliderLastFeedbackState !== 'success') {
                authAutomationState.sliderLastFeedbackState = 'success';
                authAutomationState.completed = true;
                authAutomationState.sliderPendingSignature = '';
                authAutomationState.sliderAttempts = 0;
                authAutomationState.forceRunUntil = 0;
                stopAuthChallengeMonitoring();
                setAuthStatus('安全验证已通过，正在登录');
            }
            return true;
        }
        if (failure && isVisibleElement(failure)) {
            if (authAutomationState.sliderLastFeedbackState !== 'failure') {
                authAutomationState.sliderLastFeedbackState = 'failure';
                window.clearTimeout(authAutomationState.sliderFeedbackTimer);
                authAutomationState.sliderFeedbackTimer = null;
                authAutomationState.sliderPendingSignature = '';
                authAutomationState.sliderLastSignature = '';
                setAuthStatus('滑块未通过，等待新拼图重试');
                window.setTimeout(trySolveAuthSlider, 900);
            }
            return true;
        }
        if (authAutomationState.sliderLastFeedbackState) authAutomationState.sliderLastFeedbackState = '';
        return false;
    }

    async function trySolveAuthSlider() {
        if (authAutomationState.completed || !canRunAuthAutomation() || authAutomationState.sliderSolving) return false;
        if (inspectAuthSliderFeedback()) return true;
        const challenge = findAuthSliderChallenge();
        if (!challenge) return false;
        const { slider, background, puzzle } = challenge;
        if (!background.src || !puzzle.src || !background.complete || !puzzle.complete
            || !background.naturalWidth || !puzzle.naturalWidth) {
            setAuthStatus('已检测到滑块，等待拼图加载');
            return true;
        }
        const signature = authSliderSignature(challenge);
        if (signature === authAutomationState.sliderPendingSignature) return true;
        if (signature === authAutomationState.sliderLastSignature && Date.now() - authAutomationState.sliderLastAttemptAt < 1800) return true;
        if (authAutomationState.sliderAttempts >= 6) {
            setAuthStatus('滑块连续失败，请检查页面后重试');
            return true;
        }

        authAutomationState.sliderSolving = true;
        authAutomationState.sliderLastSignature = signature;
        authAutomationState.sliderLastAttemptAt = Date.now();
        authAutomationState.sliderAttempts += 1;
        setAuthStatus(`正在识别登录滑块（第 ${authAutomationState.sliderAttempts} 次）`);
        try {
            const track = document.querySelector('#sliderCaptchaDiv #sliderDiv');
            const trackWidth = track?.getBoundingClientRect().width || 280;
            const result = await solveAuthSliderImages(background.src, puzzle.src);
            const target = Math.max(1, Math.round(result.x * trackWidth / result.backgroundWidth));
            console.info(`[LMS enhance auth] 拼图缺口=${result.x}px，拖动=${target}px，评分=${result.score.toFixed(3)}，置信差=${result.confidence.toFixed(3)}`);
            setAuthStatus(`已定位缺口，正在拖动 ${target}px`);
            if (!await simulateNativeSliderDrag(slider, target)) return true;
            authAutomationState.sliderPendingSignature = signature;
            setAuthStatus('滑块已拖动，等待验证结果');
            window.clearTimeout(authAutomationState.sliderFeedbackTimer);
            authAutomationState.sliderFeedbackTimer = window.setTimeout(() => {
                authAutomationState.sliderFeedbackTimer = null;
                if (inspectAuthSliderFeedback()) return;
                authAutomationState.sliderPendingSignature = '';
                authAutomationState.sliderLastSignature = '';
                setAuthStatus('未收到滑块结果，正在重试');
                trySolveAuthSlider();
            }, 2500);
        } catch (error) {
            authAutomationState.sliderLastSignature = '';
            setAuthStatus(`滑块识别失败：${error.message || error}`);
            window.setTimeout(trySolveAuthSlider, 600);
        } finally {
            authAutomationState.sliderSolving = false;
        }
        return true;
    }

    function initAuthLoginAssistant() {
        if (!document.body || document.getElementById('lms-auth-helper')) return;
        const panel = document.createElement('section');
        panel.id = 'lms-auth-helper';
        panel.style.cssText = `
            position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
            width: 320px; padding: 16px; color: #172033; background: #fff;
            border: 1px solid #d9e1ec; border-radius: 8px;
            box-shadow: 0 12px 36px rgba(15, 23, 42, .2); font: 14px/1.45 system-ui, sans-serif;
        `;
        panel.innerHTML = `
            <div style="font-weight:700;font-size:16px;margin-bottom:12px;">统一认证登录助手</div>
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                <input id="lms-auth-auto" type="checkbox" ${GlobalSettings.config.autoLogin ? 'checked' : ''}>
                <span>自动填表并登录</span>
            </label>
            <label style="display:block;margin-bottom:10px;">学号
                <input id="lms-auth-username" autocomplete="username" value="${escapeHtml(GlobalSettings.config.username)}"
                    style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid #cbd5e1;border-radius:5px;box-sizing:border-box;">
            </label>
            <label style="display:block;margin-bottom:10px;">密码
                <input id="lms-auth-password" type="password" autocomplete="current-password" value="${escapeHtml(GlobalSettings.config.password)}"
                    style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid #cbd5e1;border-radius:5px;box-sizing:border-box;">
            </label>
            <label style="display:block;margin-bottom:10px;">自动登录延时（ms）
                <input id="lms-auth-delay" type="number" min="0" step="100" value="${Math.max(0, Number(GlobalSettings.config.authSubmitDelayMs) || 0)}"
                    style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid #cbd5e1;border-radius:5px;box-sizing:border-box;">
            </label>
            <div style="display:flex;gap:8px;margin-top:12px;">
                <button id="lms-auth-save" type="button" style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;cursor:pointer;">保存</button>
                <button id="lms-auth-login" type="button" style="flex:1;padding:8px;border:0;border-radius:5px;background:#2563eb;color:#fff;cursor:pointer;">立即填表登录</button>
            </div>
            <div id="lms-auth-status" style="margin-top:10px;color:#64748b;font-size:12px;">所有信息仅保存在本地</div>
        `;
        document.body.appendChild(panel);

        const savePanelConfig = () => {
            GlobalSettings.config.autoLogin = document.getElementById('lms-auth-auto').checked;
            GlobalSettings.config.username = document.getElementById('lms-auth-username').value.trim();
            GlobalSettings.config.password = document.getElementById('lms-auth-password').value;
            GlobalSettings.config.authSubmitDelayMs = Math.max(0, Number(document.getElementById('lms-auth-delay').value) || 0);
            GlobalSettings.save();
            document.getElementById('lms-auth-status').textContent = '设置已保存到本地';
        };
        document.getElementById('lms-auth-save').addEventListener('click', savePanelConfig);
        document.getElementById('lms-auth-login').addEventListener('click', () => {
            savePanelConfig();
            fillAndSubmitAuthLogin(true);
        });

        let checks = 0;
        const timer = window.setInterval(() => {
            checks += 1;
            if (GlobalSettings.config.autoLogin && fillAndSubmitAuthLogin(false)) {
                window.clearInterval(timer);
            } else if (checks >= 20) {
                window.clearInterval(timer);
            }
        }, 750);

        authAutomationState.observer = new MutationObserver(() => {
            if (canRunAuthAutomation()) trySolveAuthSlider();
        });
        authAutomationState.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'style'] });
        authAutomationState.pollTimer = window.setInterval(() => {
            if (canRunAuthAutomation()) trySolveAuthSlider();
        }, 500);
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
    }

    function checkContentReady() {
        const hasMainContent = document.querySelector('[ng-view]') ||
                              document.querySelector('.main-content') ||
                              document.querySelector('#main') ||
                              document.querySelector('.content-area');

        const hasAngular = window.angular && document.querySelector('[ng-app]');
        const timeElapsed = Date.now() - pageLoadTime > 2000;

        const ready = (hasMainContent || hasAngular) && timeElapsed;

        return ready;
    }

    function waitForContentReady(callback, maxWait = 15000) {
        const startTime = Date.now();

        function check() {
            if (checkContentReady()) {
                contentReady = true;
                callback();
            } else if (Date.now() - startTime < maxWait) {
                setTimeout(check, 1000);
            } else {
                contentReady = true;
                callback();
            }
        }

        check();
    }

    function handlePageChange() {
        scriptPaused = false;
        allVideosCompleted = false;
        nextInProgress = false;
        lastAutoPlayAttempt = 0;
        autoPlayPending = true;
        noVideoCheckCount = 0;
        contentReady = false;
        pageLoadTime = Date.now();
        lastPlayerProgressAt = 0;
        backgroundPlaybackExpected = true;
        lastBackgroundRecoveryAttempt = 0;
        if (playVerificationTimer) {
            clearTimeout(playVerificationTimer);
            playVerificationTimer = null;
        }

        waitForContentReady(() => {});
    }

    function setupPageChangeListener() {
        let currentUrl = location.href;
        let currentHash = location.hash;

        const observer = new MutationObserver(() => {
            if (location.href !== currentUrl || location.hash !== currentHash) {
                currentUrl = location.href;
                currentHash = location.hash;
                handlePageChange();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        window.addEventListener('hashchange', handlePageChange);
        window.addEventListener('popstate', handlePageChange);
    }

    function loadSavedSpeed() {
        try {
            const savedSpeed = localStorage.getItem(SPEED_STORAGE_KEY);
            if (savedSpeed) {
                const speed = parseFloat(savedSpeed);
                if (getAllowedSpeeds().includes(speed)) {
                    currentSpeed = speed;
                } else if (!isICourse163) {
                    currentSpeed = 1;
                }
            }
        } catch (e) {}
    }

    function saveSpeed(speed) {
        try {
            localStorage.setItem(SPEED_STORAGE_KEY, speed.toString());
            window.dispatchEvent(new CustomEvent('lms-speed-changed', {
                detail: { speed, timestamp: Date.now() }
            }));
        } catch (e) {}
    }

    function syncSpeedAcrossTabs() {
        window.addEventListener('lms-speed-changed', (e) => {
            if (e.detail.speed !== currentSpeed) {
                currentSpeed = e.detail.speed;
                applySpeedToVideos();
                updateSpeedButton();
            }
        });

        window.addEventListener('storage', (e) => {
            if (e.key === SPEED_STORAGE_KEY && e.newValue) {
                const newSpeed = parseFloat(e.newValue);
                if (getAllowedSpeeds().includes(newSpeed) && newSpeed !== currentSpeed) {
                    currentSpeed = newSpeed;
                    applySpeedToVideos();
                    updateSpeedButton();
                }
            }
        });
    }

    function applySpeedToVideos() {
        // Change only the media clock. Do not seek, dispatch synthetic progress
        // events, or replace the LMS heartbeat that records watched ranges.
        queryAllDeep('video').forEach(video => {
            try {
                if (Number.isFinite(currentSpeed) && currentSpeed > 0 &&
                    video.playbackRate !== currentSpeed) {
                    video.playbackRate = currentSpeed;
                }
            } catch (e) {}
        });
    }

    function isVisibleElement(element) {
        if (!element || element.disabled) return false;
        const elementWindow = element.ownerDocument?.defaultView || window;
        const style = elementWindow.getComputedStyle(element);
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getClientRects().length > 0;
    }

    function collectSameOriginDocuments(rootDocument = document, result = []) {
        if (!rootDocument || result.includes(rootDocument)) return result;
        result.push(rootDocument);

        rootDocument.querySelectorAll('iframe').forEach(frame => {
            try {
                if (frame.contentDocument) {
                    collectSameOriginDocuments(frame.contentDocument, result);
                }
            } catch (e) {}
        });

        return result;
    }

    function queryAllDeep(selector) {
        const results = [];

        function visitRoot(root) {
            if (!root || typeof root.querySelectorAll !== 'function') return;
            root.querySelectorAll(selector).forEach(element => results.push(element));
            root.querySelectorAll('*').forEach(element => {
                if (element.shadowRoot) visitRoot(element.shadowRoot);
            });
        }

        collectSameOriginDocuments().forEach(visitRoot);
        return results;
    }

    function findNativePlayButton() {
        const selectors = [
            'button[aria-label="播放"]',
            'button[title="播放"]',
            '[role="button"][aria-label="播放"]',
            '.vjs-big-play-button',
            '.vjs-play-control.vjs-paused'
        ];

        for (const selector of selectors) {
            const button = queryAllDeep(selector).find(isVisibleElement);
            if (button) return button;
        }

        return queryAllDeep('button, [role="button"]')
            .find(button => isVisibleElement(button) &&
                /^播放(?:视频)?$/.test(button.textContent.trim()));
    }

    function findNativePauseButton() {
        const selectors = [
            'button[aria-label="暂停"]',
            'button[title="暂停"]',
            '[role="button"][aria-label="暂停"]',
            '.vjs-play-control.vjs-playing'
        ];

        for (const selector of selectors) {
            const button = queryAllDeep(selector).find(isVisibleElement);
            if (button) return button;
        }

        return queryAllDeep('button, [role="button"]')
            .find(button => isVisibleElement(button) &&
                /^暂停(?:视频)?$/.test(button.textContent.trim()));
    }

    function getPlayableVideos() {
        return queryAllDeep('video').filter(video => !video.ended);
    }

    function hasActuallyPlayingVideo() {
        return getPlayableVideos().some(video => !video.paused && video.readyState >= 2);
    }

    function hasRecentlyAdvancedVideo() {
        return Date.now() - lastPlayerProgressAt < 2500;
    }

    function clickNativePlayButton(force = false) {
        if (!force && Date.now() - lastAutoPlayAttempt < 5000) return false;
        const videosBeforeClick = getPlayableVideos();
        const mediaIsDefinitelyPaused = videosBeforeClick.length > 0 &&
            videosBeforeClick.every(video => video.paused);
        const button = findNativePlayButton() ||
            (mediaIsDefinitelyPaused ? findNativePauseButton() : null);
        if (!button) return false;

        const beforeTimes = videosBeforeClick.map(video => video.currentTime);
        // Muted media is allowed to start without a trusted user gesture in
        // Chrome. Keep this as a fallback for unattended course playback.
        videosBeforeClick.forEach(video => {
            if (video.paused) video.muted = true;
        });
        lastAutoPlayAttempt = Date.now();
        internalControlAction = true;
        try {
            button.focus({ preventScroll: true });
            // Use the player control's own handler. Calling video.play() here
            // would bypass the LMS progress wiring and can be blocked by the
            // browser autoplay policy.
            button.click();
        } finally {
            setTimeout(() => {
                internalControlAction = false;
            }, 300);
        }

        if (playVerificationTimer) clearTimeout(playVerificationTimer);
        playVerificationTimer = setTimeout(() => {
            const videosAfterClick = getPlayableVideos();
            const progressed = videosAfterClick.some((video, index) =>
                !video.paused &&
                (video.currentTime > (beforeTimes[index] ?? -1) + 0.15 ||
                 Date.now() - lastPlayerProgressAt < 1500)
            );
            if (progressed) {
                autoPlayPending = false;
            } else {
                console.warn('[LMS enhance] Native play control was clicked, but media time did not advance; will retry.');
            }
            playVerificationTimer = null;
        }, 1600);
        return true;
    }

    function recoverBackgroundPlayback() {
        if (isICourse163 || isAuthServer || scriptPaused) return;
        if (!GlobalSettings.config.autoJump) return;
        if (!backgroundPlaybackExpected && !autoPlayPending) return;

        const videos = getPlayableVideos();
        const pausedVideos = videos.filter(video => video.paused && !video.ended);
        if (pausedVideos.some(video => userPausedVideos.has(video))) return;
        if (videos.length === 0) {
            if (Date.now() - lastBackgroundRecoveryAttempt < BACKGROUND_RETRY_COOLDOWN) return;
            if (findNativePlayButton()) {
                lastBackgroundRecoveryAttempt = Date.now();
                clickNativePlayButton(true);
            }
            return;
        }
        if (pausedVideos.length === 0) return;
        if (Date.now() - lastBackgroundRecoveryAttempt < BACKGROUND_RETRY_COOLDOWN) return;

        // A visibility/blur transition is not a user pause. Clear any pause
        // marker that may have been set by a near-simultaneous control click.
        pausedVideos.forEach(video => {
            userPausedVideos.delete(video);
            video.muted = true;
        });
        autoPlayPending = true;
        lastBackgroundRecoveryAttempt = Date.now();
        clickNativePlayButton(true);
    }

    function handleBackgroundStateChange(event) {
        if (isICourse163 || isAuthServer) return;
        backgroundTransitionAt = Date.now();
        autoPlayPending = true;

        const leavingPage = event?.type === 'blur' || document.hidden;
        const videos = getPlayableVideos();
        const explicitlyPaused = videos.some(video =>
            video.paused && userPausedVideos.has(video)
        );
        const playbackWasActive = !explicitlyPaused &&
            (hasActuallyPlayingVideo() || hasRecentlyAdvancedVideo());
        if (leavingPage && explicitlyPaused) {
            backgroundPlaybackExpected = false;
            autoPlayPending = false;
        }
        if (leavingPage && playbackWasActive) {
            backgroundPlaybackExpected = true;
        }
        if (leavingPage && playbackWasActive) {
            // Installed at document-start, so this runs before LMS handlers
            // that pause media merely because the tab/window lost focus.
            event?.stopImmediatePropagation();
        }

        // The microtask handles an immediate pause. Later retries are spaced
        // beyond the click cooldown so a successful click cannot be toggled.
        queueMicrotask(recoverBackgroundPlayback);
        [250, 3500, 7000].forEach(delay => {
            setTimeout(recoverBackgroundPlayback, delay);
        });
    }

    function startBackgroundWatchdog() {
        if (isICourse163 || isAuthServer || backgroundWatchdog || backgroundFallbackTimer) return;

        try {
            const source = `setInterval(() => postMessage(Date.now()), 1000);`;
            backgroundWatchdogUrl = URL.createObjectURL(
                new Blob([source], { type: 'text/javascript' })
            );
            backgroundWatchdog = new Worker(backgroundWatchdogUrl);
            backgroundWatchdog.onmessage = () => {
                if (document.hidden || !document.hasFocus()) {
                    recoverBackgroundPlayback();
                }
            };
            backgroundWatchdog.onerror = () => {
                backgroundWatchdog?.terminate();
                backgroundWatchdog = null;
                if (backgroundWatchdogUrl) {
                    URL.revokeObjectURL(backgroundWatchdogUrl);
                    backgroundWatchdogUrl = null;
                }
                console.warn('[LMS enhance] Background worker stopped; page timer remains active.');
            };
        } catch (error) {
            backgroundWatchdog = null;
            console.warn('[LMS enhance] Background worker unavailable; using page timer fallback.');
        }

        // Chrome may reject blob workers under a strict CSP. Keep a normal
        // timer as a secondary path; it is sufficient until the tab is frozen.
        backgroundFallbackTimer = setInterval(() => {
            if (document.hidden || !document.hasFocus()) {
                recoverBackgroundPlayback();
            }
        }, 1500);
    }

    function findPlayerForTarget(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const player = target.closest('.video-js, .vjs-player, [class*="video-player"], [class*="video-container"]');
        if (player) return player;
        if (target.tagName === 'VIDEO') return target;
        return null;
    }

    function protectPlayingPlayerFromMouseLeave(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const player = path.map(findPlayerForTarget).find(Boolean) || findPlayerForTarget(event.target);
        if (!player) return;
        const related = event.relatedTarget;
        if (related && player.contains && player.contains(related)) return;

        // This only blocks the LMS' player-level mouse-leave pause while media
        // is already running. It does not fake page visibility or tab focus.
        if (hasActuallyPlayingVideo() || hasRecentlyAdvancedVideo() ||
            player.matches?.('.vjs-playing') || player.querySelector?.('.vjs-playing')) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }

    // Install before the LMS registers its own hover handlers. This prevents
    // player-level mouseleave/pointerleave handlers from pausing active media.
    window.addEventListener('mouseout', protectPlayingPlayerFromMouseLeave, true);
    window.addEventListener('mouseleave', protectPlayingPlayerFromMouseLeave, true);
    window.addEventListener('pointerout', protectPlayingPlayerFromMouseLeave, true);
    window.addEventListener('pointerleave', protectPlayingPlayerFromMouseLeave, true);
    window.addEventListener('blur', handleBackgroundStateChange, true);
    document.addEventListener('visibilitychange', handleBackgroundStateChange, true);

    function setupNativeControlListeners() {
        collectSameOriginDocuments().forEach(controlDocument => {
            if (observedControlDocuments.has(controlDocument)) return;
            observedControlDocuments.add(controlDocument);
            controlDocument.addEventListener('click', detectUserAction, true);
            controlDocument.addEventListener('keydown', detectUserKeyAction, true);
            controlDocument.addEventListener('mouseleave', protectPlayingPlayerFromMouseLeave, true);
            controlDocument.addEventListener('mouseout', protectPlayingPlayerFromMouseLeave, true);
            controlDocument.addEventListener('pointerleave', protectPlayingPlayerFromMouseLeave, true);
            controlDocument.addEventListener('pointerout', protectPlayingPlayerFromMouseLeave, true);
            controlDocument.addEventListener('visibilitychange', handleBackgroundStateChange, true);
        });
    }

    function updateSpeedButton() {
        const speedButton = document.getElementById('lms-speed-button');
        const speedMenu = document.getElementById('lms-speed-menu');

        if (speedButton) {
            speedButton.innerHTML = `${currentSpeed}x`;
        }

        if (speedMenu) {
            speedMenu.querySelectorAll('[data-lms-speed]').forEach(div => {
                const itemSpeed = Number(div.dataset.lmsSpeed);
                div.style.background = itemSpeed === currentSpeed ? '#e3f2fd' : 'white';
                div.style.fontWeight = itemSpeed === currentSpeed ? 'bold' : 'normal';
            });
        }
    }

    function removeVideoRestrictions() {
        if (!GlobalSettings.config.autoJump) return;

        const videos = document.querySelectorAll('video:not([data-restrictions-removed])');

        videos.forEach(video => {
            video.setAttribute('data-restrictions-removed', 'true');
            video.setAttribute('data-allow-download', 'true');
            video.setAttribute('allow-right-click', 'true');
            // Do not remove the platform's forward-seeking guard. The LMS
            // usually records watched ranges, not merely currentTime, so a
            // seek to the end must not be treated as completed viewing.
            video.oncontextmenu = null;
        });
    }

    function removePageRestrictions() {
        if (!GlobalSettings.config.autoJump) return;

        document.oncontextmenu = null;
        document.onselectstart = null;
        document.ondragstart = null;
        // Keep the LMS/player keyboard handler intact. Clearing it can leave
        // Video.js controls out of sync with the media element.
    }

    function monitorRestrictions() {
        if (!GlobalSettings.config.autoJump) return;

        const observer = new MutationObserver((mutations) => {
            let needsUpdate = false;

            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1 && (node.tagName === 'VIDEO' || node.querySelector('video'))) {
                            needsUpdate = true;
                        }
                    });
                }
            });

            if (needsUpdate) {
                setTimeout(removeVideoRestrictions, 200);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function createSpeedControlUI() {
        if (document.getElementById('lms-speed-container')) return;

        const container = document.createElement('div');
        container.id = 'lms-speed-container';
        container.style.cssText = `
            position: fixed;
            top: 50%;
            right: -45px;
            transform: translateY(-50%);
            z-index: 10000;
            transition: right 0.3s ease;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
        `;

        const speedButton = document.createElement('button');
        speedButton.id = 'lms-speed-button';
        speedButton.innerHTML = `${currentSpeed}x`;
        speedButton.style.cssText = `
            width: 60px;
            height: 35px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 8px 0 0 8px;
            font-size: 14px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,123,255,0.3);
            transition: all 0.3s ease;
            margin-bottom: 5px;
        `;

        const speedMenu = document.createElement('div');
        speedMenu.id = 'lms-speed-menu';
        speedMenu.style.cssText = `
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px 0 0 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.15);
            min-width: 80px;
            overflow: hidden;
            opacity: 0;
            transform: translateX(10px);
            transition: all 0.3s ease;
            pointer-events: none;
        `;

        getAllowedSpeeds().forEach(speed => {
            const item = document.createElement('div');
            item.dataset.lmsSpeed = String(speed);
            item.textContent = `${speed}x`;
            item.style.cssText = `
                padding: 10px 16px;
                cursor: pointer;
                transition: background 0.2s ease;
                font-size: 13px;
                text-align: center;
                ${speed === currentSpeed ? 'background: #e3f2fd; font-weight: bold;' : ''}
            `;
            item.onmouseenter = () => item.style.background = speed === currentSpeed ? '#bbdefb' : '#f5f5f5';
            item.onmouseleave = () => item.style.background = speed === currentSpeed ? '#e3f2fd' : 'white';
            item.onclick = () => {
                setVideoSpeed(speed);
                speedButton.innerHTML = `${speed}x`;
                updateMenuSelection(speedMenu, speed);
            };
            speedMenu.appendChild(item);
        });

        const speedWarning = document.createElement('div');
        speedWarning.textContent = '超过 2x 倍速可能会导致进度不生效';
        speedWarning.style.cssText = `
            width: 190px;
            padding: 9px 12px;
            color: #b45309;
            background: #fffbeb;
            font-size: 12px;
            line-height: 1.45;
            white-space: normal;
        `;
        speedMenu.appendChild(speedWarning);

        const divider = document.createElement('div');
        divider.style.cssText = 'height: 1px; background: #ddd; margin: 5px 0;';
        speedMenu.appendChild(divider);

        const settingsItem = document.createElement('div');
        settingsItem.textContent = '⚙️ 设置';
        settingsItem.style.cssText = `
            padding: 10px 16px;
            cursor: pointer;
            transition: background 0.2s ease;
            font-size: 13px;
            text-align: center;
        `;
        settingsItem.onmouseenter = () => settingsItem.style.background = '#f5f5f5';
        settingsItem.onmouseleave = () => settingsItem.style.background = 'white';
        settingsItem.onclick = () => showSettingsPanel();
        speedMenu.appendChild(settingsItem);

        function updateMenuSelection(menu, selectedSpeed) {
            menu.querySelectorAll('[data-lms-speed]').forEach(div => {
                const itemSpeed = Number(div.dataset.lmsSpeed);
                div.style.background = itemSpeed === selectedSpeed ? '#e3f2fd' : 'white';
                div.style.fontWeight = itemSpeed === selectedSpeed ? 'bold' : 'normal';
            });
        }

        container.appendChild(speedButton);
        container.appendChild(speedMenu);

        let isExpanded = false;

        function showControls() {
            isExpanded = true;
            container.style.right = '0px';
            speedButton.style.background = '#0056b3';
            speedButton.style.transform = 'scale(1.05)';
            speedMenu.style.opacity = '1';
            speedMenu.style.transform = 'translateX(0)';
            speedMenu.style.pointerEvents = 'auto';
        }

        function hideControls() {
            isExpanded = false;
            container.style.right = '-45px';
            speedButton.style.background = '#007bff';
            speedButton.style.transform = 'scale(1)';
            speedMenu.style.opacity = '0';
            speedMenu.style.transform = 'translateX(10px)';
            speedMenu.style.pointerEvents = 'none';
        }

        speedButton.onclick = (e) => {
            e.stopPropagation();
            if (isExpanded) hideControls();
            else showControls();
        };

        document.addEventListener('click', (e) => {
            if (isExpanded && !container.contains(e.target)) hideControls();
        });
        document.body.appendChild(container);
    }

    function setVideoSpeed(speed) {
        currentSpeed = speed;
        saveSpeed(speed);
        applySpeedToVideos();
        updateSpeedButton();
    }

    function initICourse163() {
        loadSavedSpeed();
        syncSpeedAcrossTabs();
        removeVideoRestrictions();
        removePageRestrictions();
        monitorRestrictions();
        createSpeedControlUI();

        setInterval(() => {
            applySpeedToVideos();
        }, 2000);
    }

    if (isICourse163) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(initICourse163, 500));
        } else {
            setTimeout(initICourse163, 500);
        }
        return;
    }

    loadSavedSpeed();
    syncSpeedAcrossTabs();

    function detectUserAction(e) {
        const target = e.target;
        const control = target.closest && target.closest(
            '.vjs-play-control, .vjs-big-play-button, video, ' +
            'button[aria-label="播放"], button[aria-label="暂停"], ' +
            'button[title="播放"], button[title="暂停"], [role="button"]'
        );
        if (!control) return;
        if (internalControlAction) return;

        lastUserAction = Date.now();
        const controlLabel = `${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''} ${control.textContent || ''}`;
        if (/播放|暂停/.test(controlLabel)) autoPlayPending = false;
        const video = control.tagName === 'VIDEO'
            ? control
            : control.closest('.video-js, .vjs-player')?.querySelector('video');

        if (video) {
            // Read the state after the player has handled the click. This keeps
            // auto-resume from fighting an intentional user pause.
            setTimeout(() => {
                if (video.paused && !video.ended) {
                    userPausedVideos.add(video);
                    autoPlayPending = false;
                } else if (!video.paused) {
                    userPausedVideos.delete(video);
                    autoPlayPending = false;
                }
            }, 0);
        }
    }

    function detectUserKeyAction(e) {
        if (e.code === 'Space') {
            lastUserAction = Date.now();
        }
    }

    setupNativeControlListeners();

    function hasNextButton() {
        try {
            const angular = window.angular;
            if (angular) {
                const scope = angular.element(document.body).scope();
                if ((scope && scope.navigation && scope.navigation.nextItem) ||
                    (scope && scope.nextActivity)) {
                    return true;
                }
            }
        } catch (e) {}

        const nextSelectors = [
            'button[ng-click*="changeActivity(nextActivity)"]',
            'button[ng-if="nextActivity"]',
            'a[ng-click*="goToNextTopic()"]',
            'a.next[ng-if*="!isLastTopic()"]',
            'span.icon-student-circle[ng-click*="navigation.goNext"]',
            'button[ng-click*="goNext"]',
            'a.next[ng-click="goToNextTopic()"]',
            'button.button[ng-click*="changeActivity(nextActivity)"]'
        ];

        for (const selector of nextSelectors) {
            const nextButton = document.querySelector(selector);
            if (nextButton && nextButton.offsetParent !== null) {
                return true;
            }
        }

        try {
            const nextTopicLink = document.querySelector('a.next[ng-click="goToNextTopic()"]');
            if (nextTopicLink) {
                const scope = window.angular.element(nextTopicLink).scope();
                if (scope && typeof scope.isLastTopic === 'function') {
                    if (!scope.isLastTopic() && nextTopicLink.offsetParent !== null) {
                        return true;
                    }
                }
            }

            const nextActivityBtn = document.querySelector('button[ng-click*="changeActivity(nextActivity)"]');
            if (nextActivityBtn) {
                const scope = window.angular.element(nextActivityBtn).scope();
                if (scope && scope.nextActivity && nextActivityBtn.offsetParent !== null) {
                    return true;
                }
            }
        } catch (e) {}

        const elements = document.querySelectorAll('button, a');
        for (const el of elements) {
            if (el.textContent.includes('下一个') && el.offsetParent !== null) {
                return true;
            }
        }

        return false;
    }

    function hasVideos() {
        return queryAllDeep('video').length > 0 ||
            !!findNativePlayButton() ||
            !!findNativePauseButton();
    }

    function isVideoComplete(video) {
        const state = videoWatchStates.get(video);
        const mediaEnded = video.ended ||
            (Number.isFinite(video.duration) &&
             video.duration > 0 &&
             video.currentTime >= video.duration - 0.25);

        if (!mediaEnded) return false;
        if (!state || !Number.isFinite(video.duration)) return mediaEnded;

        // maxContinuousTime only advances with normal timeupdate events. A
        // large forward seek cannot mark an unwatched range as completed.
        return !state.invalidSeek && state.maxContinuousTime >= video.duration - 1;
    }

    function checkAllVideosCompleted() {
        const videos = queryAllDeep('video')
            .filter(video => video.duration > 0 || video.ended || !video.paused);
        if (videos.length === 0) return false;

        return videos.every(isVideoComplete);
    }

    function checkNoVideoAutoNext() {
        if (scriptPaused) return;
        if (!GlobalSettings.config.autoJump) return;

        if (!contentReady) {
            return;
        }

        if (!hasVideos()) {
            if (hasNextButton()) {
                noVideoCheckCount++;
                if (noVideoCheckCount >= MAX_NO_VIDEO_CHECKS) {
                    noVideoCheckCount = 0;
                    autoClickNext();
                }
            } else {
                pauseScript();
            }
        } else {
            noVideoCheckCount = 0;
        }
    }

    function pauseScript() {
        if (scriptPaused) return;

        scriptPaused = true;
        allVideosCompleted = true;
    }

    function keepVideoPlaying() {
        if (scriptPaused) return;
        if (!GlobalSettings.config.autoJump) return;

        const videos = getPlayableVideos();
        const actualPlayback = videos.some(video => !video.paused && !video.ended &&
            (hasRecentlyAdvancedVideo() || video.currentTime > 0));
        if (actualPlayback) {
            autoPlayPending = false;
            return;
        }

        // In a protected cross-origin frame the media element may be hidden
        // from the userscript. Only in that case use the native control state.
        if (videos.length === 0 && findNativePauseButton()) {
            autoPlayPending = false;
            return;
        }
        if (!autoPlayPending && videos.every(video => !video.paused)) return;

        // Respect an explicit user pause. Automatic playback is only retried
        // during initial chapter loading or after automatic navigation.
        const recentlyPausedByUser = Date.now() - lastUserAction < 3000 ||
            videos.some(video => userPausedVideos.has(video));
        if (!recentlyPausedByUser) {
            autoPlayPending = true;
            clickNativePlayButton();
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForProgressFlush() {
        // The LMS owns the actual heartbeat and completion request. Do not
        // intercept it; simply leave the activity in place long enough for
        // the player's final event to be submitted before changing chapters.
        await sleep(5000);
        return true;
    }

    function setupVideoCompletionHandler() {


        const videos = queryAllDeep('video');

        videos.forEach(video => {
            if (boundVideos.has(video)) return;
            boundVideos.add(video);
            videoWatchStates.set(video, {
                maxContinuousTime: Math.max(0, video.currentTime || 0),
                lastTime: Math.max(0, video.currentTime || 0),
                started: !video.paused,
                seekingFrom: null,
                invalidSeek: false,
                seekGapEnd: null
            });
            video.addEventListener('play', () => {
                const state = videoWatchStates.get(video);
                if (state) state.started = true;
                userPausedVideos.delete(video);
                autoPlayPending = false;
                backgroundPlaybackExpected = true;
                applySpeedToVideos();
            });
            video.addEventListener('loadedmetadata', applySpeedToVideos);
            video.addEventListener('playing', () => {
                // `playing` only confirms the player accepted the request.
                // Actual time advancement is verified by `timeupdate`.
            });
            video.addEventListener('pause', () => {
                if (video.ended) return;
                const state = videoWatchStates.get(video);
                // A click that happens after the blur/visibility transition is
                // an explicit user pause, even if the user returns quickly.
                const userPaused = Date.now() - lastUserAction < 1200 &&
                    lastUserAction >= backgroundTransitionAt;
                if (userPaused) {
                    userPausedVideos.add(video);
                    autoPlayPending = false;
                    backgroundPlaybackExpected = false;
                } else if (state?.started) {
                    // A player-level hover/focus handler paused media without a
                    // user click. Allow the native control retry loop to recover.
                    userPausedVideos.delete(video);
                    autoPlayPending = true;
                    backgroundPlaybackExpected = true;
                }
            });
            video.addEventListener('timeupdate', () => {
                const state = videoWatchStates.get(video);
                if (!state || video.seeking) return;

                const current = video.currentTime;
                const allowedStep = Math.max(2.5, currentSpeed * 2.5);
                if (current >= state.lastTime && current - state.lastTime <= allowedStep) {
                    state.maxContinuousTime = Math.max(state.maxContinuousTime, current);
                    lastPlayerProgressAt = Date.now();
                    if (state.invalidSeek && state.seekGapEnd !== null &&
                        current >= state.seekGapEnd - 0.25) {
                        state.invalidSeek = false;
                        state.seekGapEnd = null;
                    }
                }
                state.lastTime = current;
            });
            video.addEventListener('seeking', () => {
                const state = videoWatchStates.get(video);
                if (state && state.seekingFrom === null) {
                    state.seekingFrom = state.lastTime;
                }
            });
            video.addEventListener('seeked', () => {
                const state = videoWatchStates.get(video);
                if (!state) return;

                const previous = state.seekingFrom ?? state.lastTime;
                const movedForwardPastWatched = video.currentTime >
                    Math.max(previous + 2, state.maxContinuousTime + 2);

                if (movedForwardPastWatched) {
                    state.invalidSeek = true;
                    state.seekGapEnd = video.currentTime;
                    console.warn('[LMS enhance] Forward seek detected; the skipped range must be watched before completion can be recorded.');
                } else {
                    state.lastTime = video.currentTime;
                }

                state.seekingFrom = null;
            });
            video.addEventListener('ended', async function() {
                if (scriptPaused || nextInProgress || !checkAllVideosCompleted()) return;

                backgroundPlaybackExpected = false;
                nextInProgress = true;
                const flushed = await waitForProgressFlush();

                if (flushed && GlobalSettings.config.autoJump) {
                    if (hasNextButton()) autoClickNext();
                    else pauseScript();
                } else if (!flushed) {
                    console.warn('[LMS enhance] Progress request did not finish successfully; automatic navigation was cancelled.');
                }

                setTimeout(() => {
                    nextInProgress = false;
                }, 3000);
            });
        });
    }

    function autoClickNext() {
        if (scriptPaused) return;

        const nextSelectors = [
            'button[ng-click*="changeActivity(nextActivity)"]',
            'button[ng-if="nextActivity"]',
            'a[ng-click*="goToNextTopic()"]',
            'a.next[ng-if*="!isLastTopic()"]',
            'button[ng-click*="goNext"]',
            'a.next[ng-click="goToNextTopic()"]',
            'button.button[ng-click*="changeActivity(nextActivity)"]'
        ];

        for (const selector of nextSelectors) {
            const nextButton = document.querySelector(selector);
            if (nextButton && nextButton.offsetParent !== null) {
                nextButton.click();
                return;
            }
        }

        const allElements = document.querySelectorAll('button, a, span[ng-click]');
        for (const element of allElements) {
            const text = element.textContent.trim();
            const ngClick = element.getAttribute('ng-click') || '';

            if ((text.includes('下一个') || ngClick.includes('changeActivity') ||
                 ngClick.includes('goToNextTopic') || ngClick.includes('goNext')) &&
                 element.offsetParent !== null) {

                element.click();
                return;
            }
        }

        pauseScript();
    }

    setInterval(() => {
        setupNativeControlListeners();
        applySpeedToVideos();
        keepVideoPlaying();
    }, 2000);
    setInterval(() => {
        setupVideoCompletionHandler();
    }, 3000);
    setInterval(checkNoVideoAutoNext, 6000);

    function init() {
        loadSavedSpeed();
        createSpeedControlUI();
        applySpeedToVideos();
        keepVideoPlaying();
        setupVideoCompletionHandler();
        setupPageChangeListener();
        startBackgroundWatchdog();

        waitForContentReady(() => {
            setTimeout(checkNoVideoAutoNext, 3000);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(init, 1000);
        });
    } else {
        setTimeout(init, 1000);
    }

    function showSettingsPanel() {
        let panel = document.getElementById('lms-settings-panel');
        if (panel) {
            panel.style.display = 'flex';
            return;
        }

        panel = document.createElement('div');
        panel.id = 'lms-settings-panel';
        panel.style.cssText = `
            display: flex;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 20000;
            align-items: center;
            justify-content: center;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            min-width: 400px;
            max-width: 500px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        `;

        content.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h3 style="margin: 0; font-size: 18px;">增强脚本设置</h3>
                <button id="close-settings" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">×</button>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: flex; align-items: center; margin-bottom: 12px;">
                    <input type="checkbox" id="setting-auth-auto" ${GlobalSettings.config.autoLogin ? 'checked' : ''} style="margin-right: 8px;">
                    <span>统一认证自动填表并登录</span>
                </label>
                <div style="margin-left: 24px; margin-bottom: 12px; display:grid; gap:8px;">
                    <label style="font-size: 13px; color: #666;">学号
                        <input type="text" id="setting-auth-username" autocomplete="username" value="${escapeHtml(GlobalSettings.config.username)}" style="display:block;width:100%;margin-top:4px;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;">
                    </label>
                    <label style="font-size: 13px; color: #666;">密码
                        <input type="password" id="setting-auth-password" autocomplete="current-password" value="${escapeHtml(GlobalSettings.config.password)}" style="display:block;width:100%;margin-top:4px;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;">
                    </label>
                    <label style="font-size: 13px; color: #666;">自动登录延时（ms）
                        <input type="number" id="setting-auth-delay" min="0" step="100" value="${Math.max(0, Number(GlobalSettings.config.authSubmitDelayMs) || 0)}" style="display:block;width:100%;margin-top:4px;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;">
                    </label>
                    <div style="font-size:12px;color:#777;">账号信息仅保存在当前浏览器本地。</div>
                </div>
                <label style="display: flex; align-items: center; margin-bottom: 12px; border-top: 1px solid #eee; padding-top: 12px;">
                    <input type="checkbox" id="setting-auto-jump" ${GlobalSettings.config.autoJump ? 'checked' : ''} style="margin-right: 8px;">
                    <div>
                        <span style="font-weight: 500;">开启视频辅助功能</span>
                        <div style="font-size: 12px; color: #666; margin-top: 2px;">点击播放器原生播放键，并在播放完成后进入下一节</div>
                    </div>
                </label>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                <button id="cancel-settings" style="padding: 8px 16px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer;">取消</button>
                <button id="save-settings" style="padding: 8px 16px; border: none; background: #007bff; color: white; border-radius: 4px; cursor: pointer;">保存</button>
            </div>
        `;

        panel.appendChild(content);
        document.body.appendChild(panel);

        document.getElementById('close-settings').onclick = () => panel.style.display = 'none';
        document.getElementById('cancel-settings').onclick = () => panel.style.display = 'none';
        panel.onclick = (e) => {
            if (e.target === panel) panel.style.display = 'none';
        };

        document.getElementById('save-settings').onclick = () => {
            GlobalSettings.config.autoLogin = document.getElementById('setting-auth-auto').checked;
            GlobalSettings.config.username = document.getElementById('setting-auth-username').value.trim();
            GlobalSettings.config.password = document.getElementById('setting-auth-password').value;
            GlobalSettings.config.authSubmitDelayMs = Math.max(0, Number(document.getElementById('setting-auth-delay').value) || 0);
            GlobalSettings.config.autoJump = document.getElementById('setting-auto-jump').checked;
            GlobalSettings.save();
            panel.style.display = 'none';
        };
    }

if (location.hostname === 'lms.nju.edu.cn' && location.pathname.includes('/course/')) {
    const btn = document.createElement('button');
    btn.textContent = '📥 选择下载课件';
    btn.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:9999;padding:12px 20px;background:#28BD6E;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.2)';
    btn.onclick = async () => {
        const courseIdMatch = location.pathname.match(/\/course\/(\d+)/);
        if (!courseIdMatch) return alert('无法识别课程ID');
        const courseId = courseIdMatch[1];
        
        const hashMatch = location.hash.match(/sub_course_id=(\d+)/);
        const subCourseId = hashMatch ? hashMatch[1] : '0';
        
        btn.textContent = '⏳ 正在获取课件列表...';
        btn.disabled = true;
        
        try {
            const response = await fetch(`/api/courses/${courseId}/activities?sub_course_id=${subCourseId}`, {
                credentials: 'same-origin',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) throw new Error('API请求失败');
            const data = await response.json();
            
            const allFiles = [];
            if (data.activities) {
                data.activities.forEach(activity => {
                    if (activity.type === 'material' && activity.uploads) {
                        activity.uploads.forEach(upload => {
                            if ((upload.reference_id || upload.id) && upload.name) {
                                allFiles.push({
                                    name: upload.name,
                                    reference_id: upload.reference_id,
                                    file_id: upload.id,
                                    activity_id: activity.id,
                                    url: upload.reference_id ? 
                                         `/api/uploads/reference/${upload.reference_id}/blob` : 
                                         `/api/uploads/${upload.id}/blob`,
                                    activity_title: activity.title,
                                    type: upload.type,
                                    allow_download: upload.allow_download || false
                                });
                            }
                        });
                    }
                });
            }
            
            btn.textContent = '📥 下载全部课件';
            btn.disabled = false;
            
            if (!allFiles.length) return alert('未找到课件');
            
            if (!allFiles.length) return alert('没有可下载的文件');

            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:20000;display:flex;justify-content:center;align-items:center;';
            
            const content = document.createElement('div');
            content.style.cssText = 'background:white;padding:20px;border-radius:8px;width:500px;max-width:90%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
            
            content.innerHTML = `<h3 style="margin:0 0 15px 0;font-size:18px;">选择要下载的课件 (共${allFiles.length}个)</h3>`;
            
            const list = document.createElement('div');
            list.style.cssText = 'overflow-y:auto;flex:1;border:1px solid #eee;margin-bottom:15px;padding:5px;border-radius:4px;';
            
            const checkboxes = [];
            allFiles.forEach((f, i) => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:6px;border-bottom:1px solid #f5f5f5;display:flex;align-items:center;';
                
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.id = `dl-file-${i}`;
                cb.style.marginRight = '8px';
                
                const label = document.createElement('label');
                label.htmlFor = `dl-file-${i}`;
                label.textContent = `[${f.activity_title}] ${f.name}`;
                label.style.cssText = 'font-size:13px;cursor:pointer;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                label.title = label.textContent;
                
                item.appendChild(cb);
                item.appendChild(label);
                list.appendChild(item);
                checkboxes.push({ cb, file: f });
            });
            
            content.appendChild(list);
            
            const btns = document.createElement('div');
            btns.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:10px;';
            
            const toggleBtn = document.createElement('button');
            toggleBtn.textContent = '全选/清空';
            toggleBtn.style.cssText = 'padding:6px 12px;border:1px solid #ddd;background:#f8f9fa;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
            toggleBtn.onclick = () => {
                const hasChecked = checkboxes.some(x => x.cb.checked);
                checkboxes.forEach(x => x.cb.checked = !hasChecked);
            };
            btns.appendChild(toggleBtn);
            
            const rightBtns = document.createElement('div');
            rightBtns.style.cssText = 'display:flex;gap:10px;';
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '取消';
            closeBtn.style.cssText = 'padding:6px 16px;border:1px solid #ddd;background:white;border-radius:4px;cursor:pointer;';
            closeBtn.onclick = () => document.body.removeChild(modal);
            
            const dlBtn = document.createElement('button');
            dlBtn.textContent = '下载选中';
            dlBtn.style.cssText = 'padding:6px 16px;border:none;background:#28BD6E;color:white;border-radius:4px;cursor:pointer;';
            dlBtn.onclick = async () => {
                const selected = checkboxes.filter(x => x.cb.checked).map(x => x.file);
                if (!selected.length) return alert('请至少选择一个文件');
                
                document.body.removeChild(modal);
                
                for (let i = 0; i < selected.length; i++) {
                    const file = selected[i];
                    let downloadUrl = file.url;
                    let isBlobUrl = false;
                    
                    try {
                        const isImage = file.type === 'image' || /\.(png|jpg|jpeg|gif|bmp)$/i.test(file.name);

                        if ((isImage || !file.reference_id) && file.file_id) {
                            const directUrl = `/api/uploads/${file.file_id}/blob?preview=true`;
                            const blobResp = await fetch(directUrl);
                            if (blobResp.ok) {
                                const blob = await blobResp.blob();
                                downloadUrl = URL.createObjectURL(blob);
                                isBlobUrl = true;
                            }
                        } 
                        else if (file.activity_id && file.reference_id) {
                            const typeStr = file.type || 'document';
                            const apiUrl = `/api/uploads/reference/${typeStr}/${file.reference_id}/url?preview=true&refer_id=${file.activity_id}&refer_type=learning_activity`;
                            const resp = await fetch(apiUrl);
                            if (resp.ok) {
                                const json = await resp.json();
                                if (json.url) downloadUrl = json.url;
                            }
                        }
                    } catch (e) {}

                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = file.name;
                    a.target = '_blank';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    
                    if (isBlobUrl) {
                        setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
                    }
                    
                    if (i < selected.length - 1) {
                        await new Promise(r => setTimeout(r, 800));
                    }
                }
            };
            
            rightBtns.appendChild(closeBtn);
            rightBtns.appendChild(dlBtn);
            btns.appendChild(rightBtns);
            
            content.appendChild(btns);
            
            modal.onclick = (e) => { if (e.target === modal) document.body.removeChild(modal); };
            modal.appendChild(content);
            document.body.appendChild(modal);
            
        } catch (error) {
            btn.textContent = '📥 下载全部课件';
            btn.disabled = false;
            alert('获取课件列表失败: ' + error.message);
        }
    };
    setTimeout(() => document.body.appendChild(btn), 2000);
}

})();
