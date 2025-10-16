@echo off
chcp 65001 >nul
title OCR验证码识别服务 - 一键安装并启动
color 0A

echo ========================================
echo    OCR验证码识别服务
echo    全自动安装和启动
echo ========================================
echo.

REM ============================================
REM 第一步：检查Python环境
REM ============================================
echo [步骤 1/5] 检查Python环境...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo ========================================
    echo [错误] 未检测到Python环境！
    echo ========================================
    echo.
    echo 请先安装 Python 3.7 或更高版本
    echo 下载地址: https://www.python.org/downloads/
    echo.
    echo 安装时请务必勾选:
    echo   [✓] Add Python to PATH
    echo.
    echo 安装完成后，请重新运行本脚本
    echo ========================================
    echo.
    pause
    exit /b 1
)

python --version
echo [✓] Python环境正常
echo.

REM ============================================
REM 第二步：检查pip工具
REM ============================================
echo [步骤 2/5] 检查pip工具...
python -m pip --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] pip不可用，正在尝试修复...
    python -m ensurepip --default-pip
    if %errorlevel% neq 0 (
        color 0C
        echo [错误] 无法修复pip，请手动重装Python
        pause
        exit /b 1
    )
)
echo [✓] pip工具正常
echo.

REM ============================================
REM 第三步：检查依赖库是否已安装
REM ============================================
echo [步骤 3/5] 检查依赖库...
python -c "import flask, flask_cors, ddddocr" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] 检测到依赖未安装，开始自动安装...
    echo.
    
    REM 升级pip
    echo [3.1] 升级pip工具...
    python -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple >nul 2>&1
    echo [✓] pip已升级
    echo.
    
    REM 安装依赖
    echo [3.2] 安装依赖库（使用清华镜像源）...
    echo       这可能需要几分钟，请耐心等待...
    echo.
    
    echo    正在安装 flask...
    python -m pip install flask==2.3.2 -i https://pypi.tuna.tsinghua.edu.cn/simple
    if %errorlevel% neq 0 (
        echo [!] 清华源失败，尝试官方源...
        python -m pip install flask==2.3.2
        if %errorlevel% neq 0 (
            color 0C
            echo [错误] flask 安装失败
            pause
            exit /b 1
        )
    )
    echo [✓] flask 安装完成
    
    echo    正在安装 flask-cors...
    python -m pip install flask-cors==4.0.0 -i https://pypi.tuna.tsinghua.edu.cn/simple
    if %errorlevel% neq 0 (
        python -m pip install flask-cors==4.0.0
        if %errorlevel% neq 0 (
            color 0C
            echo [错误] flask-cors 安装失败
            pause
            exit /b 1
        )
    )
    echo [✓] flask-cors 安装完成
    
    echo    正在安装 ddddocr（OCR识别引擎）...
    python -m pip install ddddocr==1.4.11 -i https://pypi.tuna.tsinghua.edu.cn/simple
    if %errorlevel% neq 0 (
        python -m pip install ddddocr==1.4.11
        if %errorlevel% neq 0 (
            color 0C
            echo [错误] ddddocr 安装失败
            pause
            exit /b 1
        )
    )
    echo [✓] ddddocr 安装完成
    
    echo.
    echo ========================================
    echo [✓] 所有依赖安装成功！
    echo ========================================
    echo.
) else (
    echo [✓] 所有依赖已安装
    echo.
)

REM ============================================
REM 第四步：最终检查
REM ============================================
echo [步骤 4/5] 最终环境检查...
python -c "import flask, flask_cors, ddddocr" >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [错误] 依赖库验证失败
    pause
    exit /b 1
)
echo [✓] 环境检查完成，一切就绪！
echo.

REM ============================================
REM 第五步：启动服务
REM ============================================
echo [步骤 5/5] 启动OCR识别服务...
echo.
color 0B
echo ========================================
echo    服务启动中...
echo ========================================
echo.
echo 服务地址: http://127.0.0.1:5000
echo 健康检查: http://127.0.0.1:5000/health
echo.
echo 提示:
echo   * 保持此窗口打开，服务才能运行
echo   * 按 Ctrl+C 可以停止服务
echo   * 关闭窗口也会停止服务
echo ========================================
echo.

REM 检查startocr.py是否存在
if not exist "startocr.py" (
    color 0C
    echo [错误] 找不到 startocr.py 文件
    echo 请确保此脚本与 startocr.py 在同一目录
    pause
    exit /b 1
)

REM 启动服务
python startocr.py

REM 服务停止后的处理
echo.
echo ========================================
echo 服务已停止
echo ========================================
echo.
pause
