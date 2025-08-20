// ==UserScript==
// @name         南大LMS智慧教育平台|MOOC增强
// @namespace    http://tampermonkey.net/
// @version      0.20
// @description  南大LMS平台与MOOC平台加速进度 + 自动下一个 + 智能停止 + 无视频自动跳转 + 视频倍速控制 + 解除播放限制
// @author       Hronrad
// @license    GPL-3.0-only
// @match        https://lms.nju.edu.cn/*
// @match        https://www.icourse163.org/*
// @match        https://icourse163.org/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    
    let isUserPaused = false;
    let lastUserAction = 0;
    let processedRequests = new Set();
    let isVirtualRequest = false;
    let allVideosCompleted = false;
    let scriptPaused = false;
    let noVideoCheckCount = 0;
    const MAX_NO_VIDEO_CHECKS = 5;
    let currentSpeed = 1;
    let processedVideos = new Set();
    let contentReady = false;
    let pageLoadTime = Date.now();

    const SPEED_STORAGE_KEY = `lms-video-speed-${location.hostname}`;
    
    const isICourse163 = location.hostname.includes('icourse163.org');

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
        noVideoCheckCount = 0;
        contentReady = false;
        pageLoadTime = Date.now();
        
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
                if ([0.1, 1, 3, 16].includes(speed)) {
                    currentSpeed = speed;
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
                if ([0.1, 1, 3, 16].includes(newSpeed) && newSpeed !== currentSpeed) {
                    currentSpeed = newSpeed;
                    applySpeedToVideos();
                    updateSpeedButton();
                }
            }
        });
    }
    
    function applySpeedToVideos() {
        document.querySelectorAll('video').forEach(video => {
            if (video.playbackRate !== currentSpeed) {
                video.playbackRate = currentSpeed;
            }
        });
    }
    
    function updateSpeedButton() {
        const speedButton = document.getElementById('lms-speed-button');
        const speedMenu = document.getElementById('lms-speed-menu');
        
        if (speedButton) {
            speedButton.innerHTML = `${currentSpeed}x`;
        }
        
        if (speedMenu) {
            speedMenu.querySelectorAll('div').forEach((div, i) => {
                const itemSpeed = [0.1, 1, 3, 16][i];
                div.style.background = itemSpeed === currentSpeed ? '#e3f2fd' : 'white';
                div.style.fontWeight = itemSpeed === currentSpeed ? 'bold' : 'normal';
            });
        }
    }

    function removeVideoRestrictions() {
        const videos = document.querySelectorAll('video:not([data-restrictions-removed])');
        
        videos.forEach(video => {
            video.setAttribute('data-restrictions-removed', 'true');
            video.setAttribute('allow-foward-seeking', 'true');
            video.setAttribute('data-allow-download', 'true');
            video.setAttribute('allow-right-click', 'true');
            video.removeAttribute('forward-seeking-warning');
            video.controls = true;
            video.oncontextmenu = null;
        });
    }

    function removePageRestrictions() {
        document.oncontextmenu = null;
        document.onselectstart = null;
        document.ondragstart = null;
        document.onkeydown = null;
    }

    function monitorRestrictions() {
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
        
        [0.1, 1, 3, 16].forEach(speed => {
            const item = document.createElement('div');
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
        
        function updateMenuSelection(menu, selectedSpeed) {
            menu.querySelectorAll('div').forEach((div, i) => {
                const itemSpeed = [0.1, 1, 3, 16][i];
                div.style.background = itemSpeed === selectedSpeed ? '#e3f2fd' : 'white';
                div.style.fontWeight = itemSpeed === selectedSpeed ? 'bold' : 'normal';
            });
        }
        
        container.appendChild(speedButton);
        container.appendChild(speedMenu);
        
        let isExpanded = false;
        let hideTimeout;
        
        function showControls() {
            clearTimeout(hideTimeout);
            isExpanded = true;
            container.style.right = '0px';
            speedButton.style.background = '#0056b3';
            speedButton.style.transform = 'scale(1.05)';
            speedMenu.style.opacity = '1';
            speedMenu.style.transform = 'translateX(0)';
            speedMenu.style.pointerEvents = 'auto';
        }
        
        function hideControls() {
            hideTimeout = setTimeout(() => {
                isExpanded = false;
                container.style.right = '-45px';
                speedButton.style.background = '#007bff';
                speedButton.style.transform = 'scale(1)';
                speedMenu.style.opacity = '0';
                speedMenu.style.transform = 'translateX(10px)';
                speedMenu.style.pointerEvents = 'none';
            }, 300);
        }
        
        container.onmouseenter = showControls;
        container.onmouseleave = hideControls;
        
        speedButton.onclick = (e) => {
            e.stopPropagation();
            if (isExpanded) {
                speedMenu.style.display = speedMenu.style.display === 'none' ? 'block' : 'none';
            }
        };
        
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                speedMenu.style.display = 'block';
            }
        });
        
        const hoverIndicator = document.createElement('div');
        hoverIndicator.style.cssText = `
            position: absolute;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
            width: 3px;
            height: 30px;
            background: linear-gradient(45deg, #007bff, #0056b3);
            border-radius: 3px 0 0 3px;
            opacity: 0.7;
            animation: pulse 2s infinite;
        `;
        
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0%, 100% { opacity: 0.7; }
                50% { opacity: 0.3; }
            }
        `;
        document.head.appendChild(style);
        
        container.appendChild(hoverIndicator);
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
    
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this._method = method;
        this._url = url;
        this._isVirtual = isVirtualRequest;
        return originalOpen.call(this, method, url, ...args);
    };
    
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(data) {
        const url = this._url || '';
        
        if (scriptPaused) {
            return originalSend.call(this, data);
        }
        
        if (!this._isVirtual && 
            (url.includes('/statistics/api/online-videos') || 
             url.includes('/api/course/activities-read/')) && 
            this._method === 'POST' && data) {
            
            try {
                const jsonData = JSON.parse(data);
                const requestKey = `${url}-${JSON.stringify(jsonData)}`;
                
                if (!processedRequests.has(requestKey)) {
                    processedRequests.add(requestKey);
                    createVirtualSessions(url, jsonData);
                    setTimeout(() => processedRequests.delete(requestKey), 10000);
                }
            } catch (e) {}
        }
        
        return originalSend.call(this, data);
    };
    
    function createVirtualSessions(url, originalData) {
        if (scriptPaused) return;
        
        const sessionCount = 10;
        const maxDuration = 30;
        const originalDuration = (originalData.end || 0) - (originalData.start || 0);
        const isLargeDuration = originalDuration > maxDuration;
        
        for (let i = 1; i < sessionCount; i++) {
            setTimeout(() => {
                if (scriptPaused) return;
                
                const virtualData = JSON.parse(JSON.stringify(originalData));
                
                if (isLargeDuration) {
                    const segmentDuration = Math.min(maxDuration, Math.floor(originalDuration / sessionCount) + 5);
                    const baseStart = originalData.start || 0;
                    
                    virtualData.start = baseStart + (i - 1) * segmentDuration + Math.floor(Math.random() * 3);
                    virtualData.end = virtualData.start + segmentDuration + Math.floor(Math.random() * 3);
                    
                    if (virtualData.end > originalData.end) {
                        virtualData.end = originalData.end;
                    }
                    
                    if (virtualData.start >= virtualData.end) {
                        virtualData.start = virtualData.end - Math.min(5, segmentDuration);
                    }
                } else {
                    if (virtualData.start !== undefined) {
                        virtualData.start += Math.floor(Math.random() * 3);
                    }
                    if (virtualData.end !== undefined) {
                        virtualData.end += Math.floor(Math.random() * 3);
                    }
                }
                
                const duration = (virtualData.end || 0) - (virtualData.start || 0);
                if (duration <= 0 || duration > maxDuration * 2) {
                    return;
                }
                
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify(virtualData),
                    credentials: 'same-origin'
                }).then(response => {}).catch(error => {});
                
            }, i * 400 + Math.random() * 300);
        }
    }
    
    function detectUserAction(e) {
        const target = e.target;
        
        if (target.closest('.vjs-play-control') || 
            target.closest('.vjs-big-play-button') ||
            target.closest('button') ||
            target.tagName === 'BUTTON') {
            
            lastUserAction = Date.now();
            
            setTimeout(() => {
                document.querySelectorAll('video').forEach(video => {
                    if (video.paused) {
                        isUserPaused = true;
                    }
                });
            }, 100);
        }
    }
    
    document.addEventListener('click', detectUserAction, true);
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            lastUserAction = Date.now();
        }
    }, true);
    
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
        return document.querySelectorAll('video').length > 0;
    }
    
    function checkAllVideosCompleted() {
        const videos = document.querySelectorAll('video');
        if (videos.length === 0) return false;
        
        return Array.from(videos).every(video => {
            const isEnded = video.ended;
            const isDurationComplete = video.duration > 0 && 
                                 Math.abs(video.currentTime - video.duration) < 1;
            const isNearComplete = video.duration > 0 && 
                             video.currentTime / video.duration >= 0.98;
            
            return isEnded || isDurationComplete || isNearComplete;
        });
    }
    
    function checkNoVideoAutoNext() {
        if (scriptPaused) return;
        
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
        
        document.querySelectorAll('video').forEach(video => {
            if (!video.paused) {
                video.pause();
            }
        });
    }
    
    function keepVideoPlaying() {
        if (scriptPaused) return;
        
        document.querySelectorAll('video').forEach(video => {
            if (video.paused) {
                const timeSinceUserAction = Date.now() - lastUserAction;
                
                if (isUserPaused && timeSinceUserAction < 3000) {
                    return;
                }
                
                if (video.readyState >= 2) {
                    video.play().then(() => {
                        isUserPaused = false;
                    }).catch(() => {});
                }
            } else {
                if (isUserPaused && Date.now() - lastUserAction > 2000) {
                    isUserPaused = false;
                }
            }
        });
    }
    
    function performVirtualUserAction() {
        if (scriptPaused) return;
        
        const videos = document.querySelectorAll('video');
        const playButtons = document.querySelectorAll('.vjs-play-control');
        
        if (videos.length > 0 && !isUserPaused) {
            videos.forEach((video, index) => {
                if (!video.paused) {
                    if (playButtons[index]) {
                        playButtons[index].dispatchEvent(new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        }));
                    } else {
                        video.pause();
                    }
                    
                    setTimeout(() => {
                        if (scriptPaused) return;
                        
                        if (playButtons[index]) {
                            playButtons[index].dispatchEvent(new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            }));
                        } else {
                            video.play().catch(() => {});
                        }
                    }, 100);
                }
            });
        }
    }
    
    function setupVideoCompletionHandler() {
        const videos = document.querySelectorAll('video:not([data-completion-handler])');
        
        videos.forEach(video => {
            video.setAttribute('data-completion-handler', 'true');
            video.playbackRate = currentSpeed;
            
            video.addEventListener('ended', function() {
                setTimeout(() => {
                    if (checkAllVideosCompleted()) {
                        if (hasNextButton()) {
                            autoClickNext();
                        } else {
                            pauseScript();
                        }
                    } else {
                        autoClickNext();
                    }
                }, 2000);
            });
        });
    }
    
    function autoClickNext() {
        if (scriptPaused) return;
        
        try {
            const angular = window.angular;
            if (angular) {
                const scope = angular.element(document.body).scope();
                
                if (scope && scope.nextActivity && scope.changeActivity) {
                    scope.changeActivity(scope.nextActivity);
                    scope.$apply();
                    return;
                }
                
                if (scope && scope.goToNextTopic) {
                    scope.goToNextTopic();
                    scope.$apply();
                    return;
                }
                
                if (scope && scope.navigation && scope.navigation.goNext) {
                    scope.navigation.goNext();
                    scope.$apply();
                    return;
                }
            }
        } catch (e) {}
        
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
                if (nextButton.hasAttribute('ng-click') && window.angular) {
                    try {
                        const scope = window.angular.element(nextButton).scope();
                        if (scope) {
                            scope.$eval(nextButton.getAttribute('ng-click'));
                            scope.$apply();
                            return;
                        }
                    } catch (e) {}
                }
                
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
                
                if (ngClick && window.angular) {
                    try {
                        const scope = window.angular.element(element).scope();
                        if (scope) {
                            scope.$eval(ngClick);
                            scope.$apply();
                            return;
                        }
                    } catch (e) {}
                }
                
                element.click();
                return;
            }
        }
        
        pauseScript();
    }
    
    setInterval(keepVideoPlaying, 2000);
    setInterval(performVirtualUserAction, 1000);
    setInterval(() => {
        setupVideoCompletionHandler();
        applySpeedToVideos();
    }, 3000);
    setInterval(checkNoVideoAutoNext, 6000);
    
    function init() {
        keepVideoPlaying();
        setupVideoCompletionHandler();
        createSpeedControlUI();
        removeVideoRestrictions();
        removePageRestrictions();
        monitorRestrictions();
        applySpeedToVideos();
        setupPageChangeListener();
        
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
    
})();