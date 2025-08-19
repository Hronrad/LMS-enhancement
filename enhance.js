// ==UserScript==
// @name         南大LMS智慧教育平台|MOOC增强
// @namespace    http://tampermonkey.net/
// @version      0.18
// @description  超简LMS视频播放 + 自动下一个 + 智能停止 + 无视频自动跳转 + 视频倍速控制 + 解除播放限制
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
    const MAX_NO_VIDEO_CHECKS = 3;
    let currentSpeed = 1;
    let processedVideos = new Set(); // 防止重复处理视频
    
    // 检测当前网站
    const isICourse163 = location.hostname.includes('icourse163.org');


    // 简化：解除视频播放限制
    function removeVideoRestrictions() {
        const videos = document.querySelectorAll('video:not([data-restrictions-removed])');
        
        videos.forEach(video => {
            // 标记已处理，防止重复
            video.setAttribute('data-restrictions-removed', 'true');
            
            // 解除限制
            video.setAttribute('allow-foward-seeking', 'true');
            video.setAttribute('data-allow-download', 'true');
            video.setAttribute('allow-right-click', 'true');
            video.removeAttribute('forward-seeking-warning');
            video.controls = true;
            
            // 移除右键限制
            video.oncontextmenu = null;
            
            console.log('✅ 解除视频限制');
        });
    }

    // 简化：解除页面限制
    function removePageRestrictions() {
        document.oncontextmenu = null;
        document.onselectstart = null;
        document.ondragstart = null;
        document.onkeydown = null;
        
        console.log('✅ 解除页面限制');
    }

    // 简化：监控限制（减少频繁触发）
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

    // 创建速度控制UI
    function createSpeedControlUI() {
        if (document.getElementById('lms-speed-button')) return; // 防止重复创建
        
        const speedButton = document.createElement('button');
        speedButton.id = 'lms-speed-button';
        speedButton.innerHTML = `${currentSpeed}x`;
        speedButton.style.cssText = `position:fixed;top:20px;right:20px;width:60px;height:35px;background:#007bff;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;z-index:10000;box-shadow:0 4px 12px rgba(0,123,255,0.3);transition:all 0.3s ease`;
        
        const speedMenu = document.createElement('div');
        speedMenu.id = 'lms-speed-menu';
        speedMenu.style.cssText = `position:fixed;top:60px;right:20px;background:white;border:1px solid #ddd;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.15);z-index:10001;display:none;min-width:120px;overflow:hidden`;
        
        [0.1, 1, 3, 16].forEach(speed => {
            const item = document.createElement('div');
            item.textContent = `${speed}x`;
            item.style.cssText = `padding:12px 16px;cursor:pointer;transition:background 0.2s ease;${speed === currentSpeed ? 'background:#e3f2fd;font-weight:bold' : ''}`;
            item.onmouseenter = () => item.style.background = speed === currentSpeed ? '#bbdefb' : '#f5f5f5';
            item.onmouseleave = () => item.style.background = speed === currentSpeed ? '#e3f2fd' : 'white';
            item.onclick = () => {
                setVideoSpeed(speed);
                speedButton.innerHTML = `${speed}x`;
                speedMenu.style.display = 'none';
                speedMenu.querySelectorAll('div').forEach((div, i) => {
                    const itemSpeed = [0.1, 1, 3, 16][i];
                    div.style.background = itemSpeed === speed ? '#e3f2fd' : 'white';
                    div.style.fontWeight = itemSpeed === speed ? 'bold' : 'normal';
                });
            };
            speedMenu.appendChild(item);
        });
        
        speedButton.onmouseenter = () => {
            speedButton.style.background = '#0056b3';
            speedButton.style.transform = 'translateY(-2px)';
            speedButton.style.boxShadow = '0 6px 16px rgba(0,123,255,0.4)';
        };
        speedButton.onmouseleave = () => {
            speedButton.style.background = '#007bff';
            speedButton.style.transform = 'translateY(0)';
            speedButton.style.boxShadow = '0 4px 12px rgba(0,123,255,0.3)';
        };
        
        speedButton.onclick = () => speedMenu.style.display = speedMenu.style.display === 'none' ? 'block' : 'none';
        document.onclick = (e) => { 
            if (!speedMenu.contains(e.target) && e.target !== speedButton) 
                speedMenu.style.display = 'none'; 
        };
        
        document.body.appendChild(speedButton);
        document.body.appendChild(speedMenu);
    }
    
    function setVideoSpeed(speed) {
        currentSpeed = speed;
        document.querySelectorAll('video').forEach(video => video.playbackRate = speed);
        console.log(`设置播放速度: ${speed}x`);
    }
    
    // icourse163 专用：简化初始化
    function initICourse163() {
        removeVideoRestrictions();
        removePageRestrictions();
        monitorRestrictions();
        createSpeedControlUI();
        
        // 简单的视频速度应用
        setInterval(() => {
            document.querySelectorAll('video').forEach(video => {
                if (video.playbackRate !== currentSpeed) {
                    video.playbackRate = currentSpeed;
                }
            });
        }, 2000);
        
        console.log('✅ icourse163 增强功能已启用：解除限制 + 倍速控制');
    }
    
    // 如果是 icourse163 网站，只运行简化功能
    if (isICourse163) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(initICourse163, 500));
        } else {
            setTimeout(initICourse163, 500);
        }
        return;
    }
    
    // 以下是原有的南大LMS完整功能代码...
    
    // 重写页面可见性API
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    
    // 拦截XMLHttpRequest用于虚拟多开
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
                    console.log('检测到播放请求:', url, jsonData);
                    createVirtualSessions(url, jsonData);
                    setTimeout(() => processedRequests.delete(requestKey), 10000);
                }
            } catch (e) {
                console.log('数据解析失败:', e);
            }
        }
        
        return originalSend.call(this, data);
    };
    
    // 创建虚拟播放会话
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
                    console.log(`跳过虚拟会话${i}，持续时间异常:`, duration);
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
                }).then(response => {
                    console.log(`虚拟会话${i}响应: ${response.status}`);
                }).catch(error => {
                    console.log(`虚拟会话${i}错误:`, error.message);
                });
                
                console.log(`发送虚拟会话${i} (duration: ${duration}):`, virtualData);
                
            }, i * 400 + Math.random() * 300);
        }
    }
    
    // 用户操作检测
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
                        console.log('检测到用户手动暂停');
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
    
    // 检查下一个按钮
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
            'button[ng-click*="goNext"]'
        ];
        
        for (const selector of nextSelectors) {
            const nextButton = document.querySelector(selector);
            if (nextButton && nextButton.offsetParent !== null) {
                return true;
            }
        }
        
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
        
        return Array.from(videos).every(video => 
            video.ended || (video.duration > 0 && video.currentTime >= video.duration)
        );
    }
    
    function checkNoVideoAutoNext() {
        if (scriptPaused) return;
        
        if (!hasVideos()) {
            if (hasNextButton()) {
                noVideoCheckCount++;
                if (noVideoCheckCount >= MAX_NO_VIDEO_CHECKS) {
                    console.log('📄 检测到无视频页面，自动跳转');
                    noVideoCheckCount = 0;
                    autoClickNext();
                }
            } else {
                console.log('没有视频也没有下一个按钮，暂停脚本');
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
        console.log('🛑 脚本已暂停');
        
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
                console.log('视频播放完成');
                
                setTimeout(() => {
                    if (checkAllVideosCompleted()) {
                        console.log('所有视频播放完成');
                        
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
        
        console.log('🚀 执行自动跳转');
        
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
            'button[ng-click*="goNext"]'
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
    
    // 定时器
    setInterval(keepVideoPlaying, 2000);
    setInterval(performVirtualUserAction, 1000);
    setInterval(setupVideoCompletionHandler, 3000);
    setInterval(checkNoVideoAutoNext, 6000);
    
    // 初始化
    function init() {
        keepVideoPlaying();
        setupVideoCompletionHandler();
        createSpeedControlUI();
        removeVideoRestrictions();
        removePageRestrictions();
        monitorRestrictions();
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(init, 1000);
            setTimeout(checkNoVideoAutoNext, 3000);
        });
    } else {
        setTimeout(init, 1000);
        setTimeout(checkNoVideoAutoNext, 3000);
    }
    
    console.log('LMS视频超简播放脚本启动 v0.18 - 极简版');
    
})();