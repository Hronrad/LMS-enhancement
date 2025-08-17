// ==UserScript==
// @name         LMS视频超简播放
// @namespace    http://tampermonkey.net/
// @version      0.09
// @description  超简LMS视频播放 
// @author       You
// @match        https://lms.nju.edu.cn/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    
    let isUserPaused = false;
    let lastUserAction = 0;
    let processedRequests = new Set(); // 防止重复处理
    let isVirtualRequest = false; // 标记虚拟请求
    
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
        const sessionCount = 10; 
        const maxDuration = 30; // 最大持续时间限制，避免服务器拒绝
        
        // 计算原始数据的持续时间
        const originalDuration = (originalData.end || 0) - (originalData.start || 0);
        const isLargeDuration = originalDuration > maxDuration;
        
        for (let i = 1; i < sessionCount; i++) {
            setTimeout(() => {
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
    
    // 自动播放逻辑
    function keepVideoPlaying() {
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
    
    // 每3秒检查一次
    setInterval(keepVideoPlaying, 3000);
    
    // 页面加载完成后立即检查
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(keepVideoPlaying, 1000);
        });
    } else {
        setTimeout(keepVideoPlaying, 1000);
    }
    
    console.log('LMS视频超简播放脚本启动 v9.0 - 智能时间段分割版');
    
})();