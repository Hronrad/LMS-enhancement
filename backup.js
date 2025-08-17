// ==UserScript==
// @name         LMS视频超简播放
// @namespace    http://tampermonkey.net/
// @version      0.14
// @description  超简LMS视频播放
// @author       You
// @match        https://lms.nju.edu.cn/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let isUserPaused = false;
    let lastUserAction = 0;
    let autoSessionTimer = null;
    let courseApiUrl = null;
    let isSessionActive = false;
    let videoTotalDuration = 0;
    let coveredSegments = new Set(); // 记录已覆盖的时间段

    // 重写页面可见性API
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });

    // 阻止visibilitychange事件
    document.addEventListener('visibilitychange', (e) => {
        e.stopImmediatePropagation();
    }, true);

    // 获取当前视频时间和总时长
    function getVideoInfo() {
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
            const video = videos[0];
            return {
                currentTime: Math.floor(video.currentTime || 0),
                duration: Math.floor(video.duration || 0)
            };
        }
        return { currentTime: 0, duration: videoTotalDuration };
    }

    // 启动自动会话
    function startAutoSessions() {
        if (autoSessionTimer || !courseApiUrl) return;

        isSessionActive = true;
        console.log('启动自动虚拟会话系统 - 全覆盖模式');

        // 立即发送第一批
        sendVirtualSessions();

        // 定时发送
        autoSessionTimer = setInterval(() => {
            sendVirtualSessions();
        }, 10000); // 10秒间隔，更频繁地覆盖
    }

    // 发送虚拟会话 - 覆盖整个视频长度
    function sendVirtualSessions() {
        if (!courseApiUrl) return;

        const videoInfo = getVideoInfo();
        const currentTime = videoInfo.currentTime;
        const totalDuration = videoInfo.duration;

        // 更新总时长
        if (totalDuration > 0) {
            videoTotalDuration = totalDuration;
        }

        console.log(`发送虚拟会话 - 当前: ${currentTime}秒, 总长: ${totalDuration}秒`);

        // 如果没有总时长，使用估计值
        const estimatedDuration = totalDuration > 0 ? totalDuration : Math.max(3600, currentTime + 1800); // 至少1小时或当前时间+30分钟
        
        // 生成覆盖整个视频的时间段
        const segmentDuration = 30; // 每个片段30秒
        const sessionCount = 20; // 每次发送20个会话
        
        const segments = generateCoverageSegments(estimatedDuration, segmentDuration, sessionCount);
        
        segments.forEach((segment, index) => {
            setTimeout(() => {
                const sessionData = {
                    start: segment.start,
                    end: segment.end
                };

                fetch(courseApiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify(sessionData),
                    credentials: 'same-origin'
                }).then(response => {
                    const status = response.status;
                    if (status === 200 || status === 201) {
                        console.log(`覆盖会话${index + 1} 成功 - ${status}`);
                        coveredSegments.add(`${segment.start}-${segment.end}`);
                    } else {
                        console.log(`覆盖会话${index + 1} 失败 - ${status}`);
                    }
                }).catch(error => {
                    console.log(`覆盖会话${index + 1} 错误:`, error.message);
                });

                console.log(`发送覆盖会话${index + 1}: ${segment.start}-${segment.end} (${segment.end - segment.start}秒)`);

            }, index * 150 + Math.random() * 100); // 错开发送时间
        });
    }

    // 生成覆盖时间段
    function generateCoverageSegments(totalDuration, segmentDuration, count) {
        const segments = [];
        const totalSegments = Math.ceil(totalDuration / segmentDuration);
        
        // 优先覆盖未覆盖的区域
        const uncoveredSegments = [];
        for (let i = 0; i < totalSegments; i++) {
            const start = i * segmentDuration;
            const end = Math.min(start + segmentDuration, totalDuration);
            const segmentKey = `${start}-${end}`;
            
            if (!coveredSegments.has(segmentKey)) {
                uncoveredSegments.push({ start, end });
            }
        }
        
        // 如果未覆盖的段不够，添加一些随机段
        while (segments.length < count) {
            if (uncoveredSegments.length > 0) {
                // 优先选择未覆盖的段
                const segment = uncoveredSegments.shift();
                segments.push(segment);
            } else {
                // 创建随机段，但尽量避免重叠
                const start = Math.floor(Math.random() * Math.max(1, totalDuration - segmentDuration));
                const end = Math.min(start + segmentDuration + Math.floor(Math.random() * 10), totalDuration);
                
                if (end > start) {
                    segments.push({ start, end });
                }
            }
        }
        
        return segments.slice(0, count);
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
                        console.log('检测到用户暂停');
                    }
                });
            }, 100);
        }
    }

    document.addEventListener('click', detectUserAction, true);
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') lastUserAction = Date.now();
    }, true);

    // 自动播放
    function keepVideoPlaying() {
        const videos = document.querySelectorAll('video');

        videos.forEach(video => {
            if (video.paused) {
                const timeSinceUserAction = Date.now() - lastUserAction;

                if (isUserPaused && timeSinceUserAction < 3000) return;

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

    // 检测课程并启动系统
    function initializeSystem() {
        const videos = document.querySelectorAll('video');

        if (videos.length > 0 && !isSessionActive) {
            // 尝试多种方式获取课程ID
            let courseId = null;

            // 方法1: 从URL提取
            const urlMatch = window.location.href.match(/\/course\/(\d+)/);
            if (urlMatch) {
                courseId = urlMatch[1];
            }

            // 方法2: 从当前路径推测
            if (!courseId) {
                const pathMatch = window.location.pathname.match(/\/(\d+)/);
                if (pathMatch) {
                    courseId = pathMatch[1];
                }
            }

            if (courseId) {
                courseApiUrl = `/api/course/activities-read/${courseId}`;
                console.log(`检测到课程 ID: ${courseId}`);
                console.log(`API 地址: ${courseApiUrl}`);

                // 获取视频信息
                const videoInfo = getVideoInfo();
                if (videoInfo.duration > 0) {
                    console.log(`视频总长度: ${videoInfo.duration}秒`);
                    videoTotalDuration = videoInfo.duration;
                }

                // 等待一下再启动，确保页面完全加载
                setTimeout(() => {
                    startAutoSessions();
                }, 2000);
            } else {
                console.log('无法获取课程ID，继续尝试...');
            }
        }
    }

    // 定时器
    setInterval(keepVideoPlaying, 3000);
    setInterval(() => {
        if (!isSessionActive) {
            initializeSystem();
        }
    }, 2000);

    // 初始化
    function initialize() {
        console.log('LMS视频脚本初始化 - 全覆盖模式...');
        keepVideoPlaying();
        setTimeout(initializeSystem, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 500);
    }

    // 清理
    window.addEventListener('beforeunload', () => {
        if (autoSessionTimer) {
            clearInterval(autoSessionTimer);
            autoSessionTimer = null;
        }
        isSessionActive = false;
    });

    // 显示覆盖状态
    setInterval(() => {
        if (isSessionActive) {
            console.log(`已覆盖 ${coveredSegments.size} 个时间段`);
        }
    }, 30000);

    console.log('LMS视频超简播放脚本启动 v14.0 - 全覆盖虚拟会话版');

})();