// ==UserScript==
// @name         南大LMS智慧教育平台增强
// @namespace    http://tampermonkey.net/
// @version      0.15
// @description  超简LMS视频播放 + 自动下一个 + 智能停止 + 无视频自动跳转
// @author       Hronrad
// @license    GPL-3.0-only
// @match        https://lms.nju.edu.cn/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    
    let isUserPaused = false;
    let lastUserAction = 0;
    let processedRequests = new Set(); // 防止重复处理
    let isVirtualRequest = false; // 标记虚拟请求
    let allVideosCompleted = false; // 标记所有视频是否播放完成
    let scriptPaused = false; // 标记脚本是否已暂停
    let noVideoCheckCount = 0; // 无视频检查计数器
    const MAX_NO_VIDEO_CHECKS = 3; // 最大无视频检查次数
    let currentSpeed = 1; // 当前播放速度
    
    // 创建速度控制UI
   function createSpeedControlUI() {
    const speedButton = document.createElement('button');
    speedButton.innerHTML = `${currentSpeed}x`;
    speedButton.style.cssText = `position:fixed;top:20px;right:20px;width:60px;height:35px;background:#007bff;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;z-index:10000;box-shadow:0 4px 12px rgba(0,123,255,0.3);transition:all 0.3s ease`;
    
    const speedMenu = document.createElement('div');
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
            // 更新菜单项高亮
            speedMenu.querySelectorAll('div').forEach((div, i) => {
                const itemSpeed = [0.1, 1, 3, 16][i];
                div.style.background = itemSpeed === speed ? '#e3f2fd' : 'white';
                div.style.fontWeight = itemSpeed === speed ? 'bold' : 'normal';
            });
        };
        speedMenu.appendChild(item);
    });
    
    // 按钮悬停效果
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
    document.onclick = (e) => { if (!speedMenu.contains(e.target) && e.target !== speedButton) speedMenu.style.display = 'none'; };
    
    document.body.appendChild(speedButton);
    document.body.appendChild(speedMenu);
}
    
    // 设置视频播放速度
    function setVideoSpeed(speed) {
        currentSpeed = speed;
        document.querySelectorAll('video').forEach(video => video.playbackRate = speed);
        console.log(`设置播放速度: ${speed}x`);
    }
    
    // 重写页面可见性API
    Object.defineProperty(document, 'hidden', { 
        get: () => false,
        configurable: true 
    });
    
    Object.defineProperty(document, 'visibilityState', { 
        get: () => 'visible',
        configurable: true 
    });
    
    // 阻止visibilitychange事件
    document.addEventListener('visibilitychange', (e) => {
        e.stopImmediatePropagation();
    }, true);
    
    // 拦截XMLHttpRequest用于虚拟多开
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this._method = method;
        this._url = url;
        this._isVirtual = isVirtualRequest; // 标记是否为虚拟请求
        return originalOpen.call(this, method, url, ...args);
    };
    
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(data) {
        const url = this._url || '';
        
        // 如果脚本已暂停，不处理新的请求
        if (scriptPaused) {
            return originalSend.call(this, data);
        }
        
        // 只处理真实请求，避免虚拟请求触发递归
        if (!this._isVirtual && 
            (url.includes('/statistics/api/online-videos') || 
             url.includes('/api/course/activities-read/')) && 
            this._method === 'POST' && data) {
            
            try {
                const jsonData = JSON.parse(data);
                const requestKey = `${url}-${JSON.stringify(jsonData)}`;
                
                // 防止重复处理相同请求
                if (!processedRequests.has(requestKey)) {
                    processedRequests.add(requestKey);
                    console.log('检测到播放请求:', url, jsonData);
                    
                    // 创建虚拟会话
                    createVirtualSessions(url, jsonData);
                    
                    // 清理过期的请求记录
                    setTimeout(() => {
                        processedRequests.delete(requestKey);
                    }, 10000);
                }
            } catch (e) {
                console.log('数据解析失败:', e);
            }
        }
        
        // 发送原始请求
        return originalSend.call(this, data);
    };
    
    // 创建虚拟播放会话 - 使用fetch避免触发XMLHttpRequest拦截
    function createVirtualSessions(url, originalData) {
        // 如果脚本已暂停，不创建虚拟会话
        if (scriptPaused) {
            return;
        }
        
        const sessionCount = 10; 
        const maxDuration = 30; // 最大持续时间限制，避免服务器拒绝
        
        // 计算原始数据的持续时间
        const originalDuration = (originalData.end || 0) - (originalData.start || 0);
        const isLargeDuration = originalDuration > maxDuration;
        
        for (let i = 1; i < sessionCount; i++) {
            setTimeout(() => {
                // 如果脚本已暂停，停止创建会话
                if (scriptPaused) {
                    return;
                }
                
                // 修改会话数据，模拟不同的播放会话
                const virtualData = JSON.parse(JSON.stringify(originalData));
                
                if (isLargeDuration) {
                    // 如果原始持续时间过长，创建多个小片段
                    const segmentDuration = Math.min(maxDuration, Math.floor(originalDuration / sessionCount) + 5);
                    const baseStart = originalData.start || 0;
                    
                    // 为每个虚拟会话分配不同的时间段
                    virtualData.start = baseStart + (i - 1) * segmentDuration + Math.floor(Math.random() * 3);
                    virtualData.end = virtualData.start + segmentDuration + Math.floor(Math.random() * 3);
                    
                    // 确保不超过原始结束时间
                    if (virtualData.end > originalData.end) {
                        virtualData.end = originalData.end;
                    }
                    
                    // 确保start不超过end
                    if (virtualData.start >= virtualData.end) {
                        virtualData.start = virtualData.end - Math.min(5, segmentDuration);
                    }
                } else {
                    // 原始持续时间合理，只添加微小偏移
                    if (virtualData.start !== undefined) {
                        virtualData.start += Math.floor(Math.random() * 3);
                    }
                    if (virtualData.end !== undefined) {
                        virtualData.end += Math.floor(Math.random() * 3);
                    }
                }
                
                // 验证数据有效性
                const duration = (virtualData.end || 0) - (virtualData.start || 0);
                if (duration <= 0 || duration > maxDuration * 2) {
                    console.log(`跳过虚拟会话${i}，持续时间异常:`, duration);
                    return;
                }
                
                // 使用fetch发送虚拟请求，避免触发我们的拦截器
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify(virtualData),
                    credentials: 'same-origin'
                }).then(response => {
                    if (response.ok) {
                        console.log(`虚拟会话${i}响应: ${response.status}`);
                    } else {
                        console.log(`虚拟会话${i}失败: ${response.status} (duration: ${duration})`);
                    }
                }).catch(error => {
                    console.log(`虚拟会话${i}错误:`, error.message);
                });
                
                console.log(`发送虚拟会话${i} (duration: ${duration}):`, virtualData);
                
            }, i * 400 + Math.random() * 300); // 增加延迟分散请求
        }
    }
    
    // 精准的用户操作检测
    function detectUserAction(e) {
        const target = e.target;
        
        // 检测是否点击了视频控制相关元素
        if (target.closest('.vjs-play-control') || 
            target.closest('.vjs-big-play-button') ||
            target.closest('button') ||
            target.tagName === 'BUTTON') {
            
            lastUserAction = Date.now();
            
            // 如果点击的是暂停相关按钮，标记为用户暂停
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
    
    // 监听所有用户交互
    document.addEventListener('click', detectUserAction, true);
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            lastUserAction = Date.now();
        }
    }, true);
    
    // 检查是否有可用的下一个按钮
    function hasNextButton() {
        console.log('🔍 检查下一个按钮...');
        
        // 检查Angular导航
        try {
            const angular = window.angular;
            if (angular) {
                const scope = angular.element(document.body).scope();
                if (scope && scope.navigation && scope.navigation.nextItem) {
                    console.log('✅ 找到Angular导航按钮');
                    return true;
                }
                
                // 检查nextActivity
                if (scope && scope.nextActivity) {
                    console.log('✅ 找到nextActivity');
                    return true;
                }
            }
        } catch (e) {
            console.log('Angular检查失败:', e);
        }
        
        // 检查具体的按钮选择器（基于HTML结构）
        const nextSelectors = [
            'button[ng-click*="changeActivity(nextActivity)"]',
            'button[ng-if="nextActivity"]',
            'a[ng-click*="goToNextTopic()"]',
            'a.next[ng-if*="!isLastTopic()"]',
            'span.icon-student-circle[ng-click*="navigation.goNext"]',
            'span.icon-student-circle[ng-click*="goNext"]',
            '.next-page-button',
            'button[ng-click*="goNext"]',
            'a[ng-click*="goNext"]'
        ];
        
        for (const selector of nextSelectors) {
            try {
                const nextButton = document.querySelector(selector);
                if (nextButton && nextButton.offsetParent !== null) {
                    console.log('✅ 找到下一个按钮:', selector, nextButton);
                    return true;
                }
            } catch (e) {
                console.log(`选择器失败 ${selector}:`, e);
            }
        }
        
        // 文本内容检查（更精确）
        const textSelectors = [
            'button:contains("下一个")',
            'a:contains("下一个")',
            'span:contains("下一个")'
        ];
        
        for (const selector of textSelectors) {
            try {
                const elements = document.querySelectorAll(selector.split(':contains')[0]);
                const nextButton = Array.from(elements).find(el => 
                    el.textContent.trim().includes('下一个') && el.offsetParent !== null
                );
                if (nextButton) {
                    console.log('✅ 找到文本匹配的按钮:', nextButton.textContent.trim());
                    return true;
                }
            } catch (e) {
                console.log(`文本选择器失败 ${selector}:`, e);
            }
        }
        
        console.log('❌ 没有找到下一个按钮');
        return false;
    }
    
    // 检查页面是否有视频
    function hasVideos() {
        const videos = document.querySelectorAll('video');
        return videos.length > 0;
    }
    
    // 检查所有视频是否播放完成
    function checkAllVideosCompleted() {
        const videos = document.querySelectorAll('video');
        if (videos.length === 0) {
            return false;
        }
        
        let completedCount = 0;
        videos.forEach(video => {
            if (video.ended || (video.duration > 0 && video.currentTime >= video.duration)) {
                completedCount++;
            }
        });
        
        return completedCount === videos.length;
    }
    
    // 检查无视频页面并自动跳转
    function checkNoVideoAutoNext() {
        // 如果脚本已暂停，不执行检查
        if (scriptPaused) {
            return;
        }
        
        // 检查是否有视频
        if (!hasVideos()) {
            // 检查是否有下一个按钮
            if (hasNextButton()) {
                noVideoCheckCount++;
                console.log(`无视频页面检测 ${noVideoCheckCount}/${MAX_NO_VIDEO_CHECKS}`);
                
                // 连续检查几次确认没有视频后才跳转
                if (noVideoCheckCount >= MAX_NO_VIDEO_CHECKS) {
                    console.log('📄 检测到无视频页面且有下一个按钮，自动跳转');
                    noVideoCheckCount = 0; // 重置计数器
                    autoClickNext();
                }
            } else {
                // 没有下一个按钮且没有视频，暂停脚本
                console.log('没有视频也没有下一个按钮，暂停脚本');
                pauseScript();
            }
        } else {
            // 有视频，重置计数器
            noVideoCheckCount = 0;
        }
    }
    
    // 暂停脚本的所有活动
    function pauseScript() {
        if (scriptPaused) {
            return;
        }
        
        scriptPaused = true;
        allVideosCompleted = true;
        console.log('🛑 脚本已暂停所有活动');
        
        // 停止所有视频
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            if (!video.paused) {
                video.pause();
            }
        });
    }
    
    // 自动播放逻辑
    function keepVideoPlaying() {
        // 如果脚本已暂停，不执行自动播放
        if (scriptPaused) {
            return;
        }
        
        const videos = document.querySelectorAll('video');
        
        videos.forEach(video => {
            if (video.paused) {
                // 检查是否是用户主动暂停
                const timeSinceUserAction = Date.now() - lastUserAction;
                
                if (isUserPaused && timeSinceUserAction < 3000) {
                    // 用户刚刚暂停，不要自动播放
                    return;
                }
                
                // 尝试自动播放
                if (video.readyState >= 2) {
                    video.play().then(() => {
                        isUserPaused = false;
                    }).catch(() => {
                        // 播放失败，可能是用户主动暂停
                    });
                }
            } else {
                // 视频正在播放，重置暂停状态
                if (isUserPaused && Date.now() - lastUserAction > 2000) {
                    isUserPaused = false;
                }
            }
        });
    }
    
    // 虚拟用户操作 - 定期触发播放事件来产生更多虚拟请求
    function performVirtualUserAction() {
        // 如果脚本已暂停，不执行虚拟用户操作
        if (scriptPaused) {
            return;
        }
        
        const videos = document.querySelectorAll('video');
        const playButtons = document.querySelectorAll('.vjs-play-control');
        
        if (videos.length > 0 && !isUserPaused) {
            // 模拟用户暂停然后播放的操作
            videos.forEach((video, index) => {
                if (!video.paused) {
                    // 先暂停
                    if (playButtons[index]) {
                        const pauseEvent = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        playButtons[index].dispatchEvent(pauseEvent);
                    } else {
                        video.pause();
                    }
                    
                    // 100ms后重新播放（触发新的播放统计）
                    setTimeout(() => {
                        if (scriptPaused) {
                            return; // 如果脚本已暂停，不继续播放
                        }
                        
                        if (playButtons[index]) {
                            const playEvent = new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            });
                            playButtons[index].dispatchEvent(playEvent);
                        } else {
                            video.play().catch(() => {});
                        }
                        console.log('执行虚拟用户操作 - 暂停/播放循环');
                    }, 100);
                }
            });
        }
    }
    
    // 设置视频完成监听器
    function setupVideoCompletionHandler() {
        const videos = document.querySelectorAll('video');
        
        videos.forEach(video => {
            // 避免重复添加监听器
            if (video.hasAttribute('data-completion-handler')) {
                return;
            }
            video.setAttribute('data-completion-handler', 'true');
            video.playbackRate = currentSpeed;
            
            console.log('为视频添加完成监听器:', video);
            
            video.addEventListener('ended', function() {
                console.log('视频播放完成，准备自动跳转到下一个');
                
                // 延迟2秒后执行跳转，确保视频完全结束
                setTimeout(() => {
                    // 检查是否所有视频都播放完成
                    if (checkAllVideosCompleted()) {
                        console.log('所有视频播放完成');
                        
                        // 检查是否有下一个按钮
                        if (hasNextButton()) {
                            autoClickNext();
                        } else {
                            console.log('没有找到下一个按钮，暂停脚本');
                            pauseScript();
                        }
                    } else {
                        // 还有视频未完成，尝试跳转
                        autoClickNext();
                    }
                }, 2000);
            });
        });
    }
    
    // 自动点击下一个的函数
    function autoClickNext() {
        // 如果脚本已暂停，不执行跳转
        if (scriptPaused) {
            return;
        }
        
        console.log('🚀 开始执行自动跳转...');
        
        // 优先尝试Angular导航
        try {
            const angular = window.angular;
            if (angular) {
                const scope = angular.element(document.body).scope();
                
                // 检查changeActivity(nextActivity)
                if (scope && scope.nextActivity && scope.changeActivity) {
                    console.log('✅ 使用changeActivity(nextActivity)');
                    scope.changeActivity(scope.nextActivity);
                    scope.$apply();
                    return;
                }
                
                // 检查goToNextTopic
                if (scope && scope.goToNextTopic && typeof scope.goToNextTopic === 'function') {
                    console.log('✅ 使用goToNextTopic()');
                    scope.goToNextTopic();
                    scope.$apply();
                    return;
                }
                
                // 检查navigation.goNext
                if (scope && scope.navigation && scope.navigation.goNext) {
                    console.log('✅ 使用navigation.goNext()');
                    scope.navigation.goNext();
                    scope.$apply();
                    return;
                }
            }
        } catch (e) {
            console.log('Angular导航失败:', e);
        }
        
        // 尝试点击具体的按钮
        const nextSelectors = [
            'button[ng-click*="changeActivity(nextActivity)"]',
            'button[ng-if="nextActivity"]',
            'a[ng-click*="goToNextTopic()"]',
            'a.next[ng-if*="!isLastTopic()"]',
            'span.icon-student-circle[ng-click*="navigation.goNext"]',
            'span.icon-student-circle[ng-click*="goNext"]',
            'button[ng-click*="goNext"]',
            'a[ng-click*="goNext"]',
            '.next-page-button'
        ];
        
        for (const selector of nextSelectors) {
            try {
                const nextButton = document.querySelector(selector);
                if (nextButton && nextButton.offsetParent !== null) {
                    console.log('✅ 点击按钮:', selector, nextButton);
                    
                    // 先尝试通过Angular执行
                    if (nextButton.hasAttribute('ng-click') && window.angular) {
                        const ngClick = nextButton.getAttribute('ng-click');
                        try {
                            const scope = window.angular.element(nextButton).scope();
                            if (scope) {
                                console.log('执行ng-click:', ngClick);
                                scope.$eval(ngClick);
                                scope.$apply();
                                return;
                            }
                        } catch (e) {
                            console.log('Angular执行失败:', e);
                        }
                    }
                    
                    // 如果Angular执行失败，尝试直接点击
                    nextButton.click();
                    
                    // 强制触发事件
                    const clickEvent = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    });
                    nextButton.dispatchEvent(clickEvent);
                    
                    console.log('✅ 自动跳转执行完成');
                    return;
                }
            } catch (e) {
                console.log(`选择器 ${selector} 失败:`, e);
            }
        }
        
        // 最后尝试文本匹配
        const allElements = document.querySelectorAll('button, a, span[ng-click], div[ng-click]');
        for (const element of allElements) {
            const text = element.textContent.trim();
            const ngClick = element.getAttribute('ng-click') || '';
            
            if ((text.includes('下一个') || ngClick.includes('changeActivity') || 
                 ngClick.includes('goToNextTopic') || ngClick.includes('goNext')) && 
                 element.offsetParent !== null) {
                
                console.log('✅ 点击文本匹配按钮:', text, element);
                
                // 尝试Angular执行
                if (ngClick && window.angular) {
                    try {
                        const scope = window.angular.element(element).scope();
                        if (scope) {
                            scope.$eval(ngClick);
                            scope.$apply();
                            return;
                        }
                    } catch (e) {
                        console.log('Angular执行失败:', e);
                    }
                }
                
                // 直接点击
                element.click();
                return;
            }
        }
        
        console.log('❌ 没有找到任何可点击的按钮，暂停脚本');
        pauseScript();
    }
    
    // 每2秒检查一次视频播放状态
    setInterval(keepVideoPlaying, 2000);
    
    // 每1秒执行一次虚拟用户操作
    setInterval(performVirtualUserAction, 1000);
    
    // 定期检查新的视频元素（处理动态加载）
    setInterval(setupVideoCompletionHandler, 3000);
    
    // 新增：每6秒检查无视频页面并自动跳转
    setInterval(checkNoVideoAutoNext, 6000);
    
    // 页面加载完成后立即检查
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                keepVideoPlaying();
                setupVideoCompletionHandler();
                createSpeedControlUI();
            }, 1000);
            setTimeout(checkNoVideoAutoNext, 3000); // 页面加载后3秒开始检查
        });
    } else {
        setTimeout(() => {
            keepVideoPlaying();
            setupVideoCompletionHandler();
            createSpeedControlUI();
        }, 1000);
        setTimeout(checkNoVideoAutoNext, 3000); // 页面加载后3秒开始检查
    }
    
    console.log('LMS视频超简播放脚本启动 v0.15 - 智能时间段分割版 + 虚拟用户操作 + 自动下一个 + 智能停止 + 无视频自动跳转+ 视频倍速控制');
    
})();