# 南大LMS智慧教育平台|MOOC增强

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Browser Support](https://img.shields.io/badge/Browser-Chrome%20%7C%20Firefox%20%7C%20Edge%20%7C%20Safari-4285F4?logo=googlechrome&logoColor=white)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6?logo=windows&logoColor=white)](https://www.tampermonkey.net/)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Compatible-green?logo=tampermonkey)](https://www.tampermonkey.net/)

请使用篡改猴|油猴插件 Tampermonkey 来进行安装

最新功能(v 0.30)：可通过配置ocr服务自动识别登录验证码；可自动下载课件。

## 一键安装

### 第一步
**请先安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展**

各浏览器具体链接：

[![Chrome](https://img.shields.io/badge/Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
[![Firefox](https://img.shields.io/badge/Firefox-FF7139?style=for-the-badge&logo=firefox&logoColor=white)](https://addons.mozilla.org/zh-CN/firefox/addon/tampermonkey/)
[![Edge](https://img.shields.io/badge/Edge-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/%E7%AF%A1%E6%94%B9%E7%8C%B4/iikmkjmpaadaobahmlepeloendndfphd)
[![Safari](https://img.shields.io/badge/Safari-000000?style=for-the-badge&logo=safari&logoColor=white)](https://apps.apple.com/us/app/tampermonkey/id1482490089)
[![Opera](https://img.shields.io/badge/Opera-FF1B2D?style=for-the-badge&logo=opera&logoColor=white)](https://addons.opera.com/zh-cn/extensions/details/tampermonkey-beta/)

### 第二步
第一次安装需要打开浏览器的开发者模式。

Edge浏览器: 地址栏输入edge://extensions/并回车，打开开发人员模式
<img src="./image/developer.png" alt="edge" width="250">

Chrome浏览器: 地址栏输入chrome://extensions/并回车，打开开发人员模式

其他浏览器同理。

### 第三步
点击下面的按钮直接安装最新版本：

[![Install Script](https://img.shields.io/badge/Install-UserScript-green?style=for-the-badge&logo=tampermonkey)](https://greasyfork.org/zh-CN/scripts/546406-%E5%8D%97%E5%A4%A7lms%E6%99%BA%E6%85%A7%E6%95%99%E8%82%B2%E5%B9%B3%E5%8F%B0-mooc%E5%A2%9E%E5%BC%BA/)

## 自动更新

脚本已配置自动更新功能

## 配置OCR验证码识别
如果需要自动识别登录验证码，请按以下步骤操作（如已有相应API接口可直接在第二步填入）：

### 第一步
下载startocr.bat文件并保存在本地任意目录，双击运行，等待命令行窗口提示`启动ddddocr验证码识别服务...\\
服务地址: http://127.0.0.1:5000`即运行成功，无需关闭该 cmd 窗口。

该脚本为傻瓜式一键操作脚本，如该批处理脚本无法正常运行，请手动运行`startocr.py`文件，确保已安装 Python3 和 ddddocr 库。

### 第二步
在登录页面 authserver.nju.edu.cn 的右侧菜单开启自动识别，并填入API地址`http://127.0.0.1:5000/ocr`。

## 功能简介
1. ▶️解除自动暂停，可后台播放
2. 🚫解除禁用右键，不可跳转进度条等限制
3. ⏩自动加速视频课程完成进度
4. ⏭️播放完成后自动播放下一个视频，跳过无视频页面
5. 🚀侧边菜单可控制多种倍速0.1x/1x/3x/16x
6. 🚀可自动识别登录验证码（需配置OCR服务）

## 使用演示
其他功能自动开启，如需倍速请按下图从右侧菜单选择所需倍速
![演示动图](./image/demo.gif)

## 温馨提示
- 当您在对应网站看到页面右侧蓝色隐藏倍速按钮时，代表脚本已经成功安装并生效。

- 如遇页面卡顿/功能失效等问题，以及“系统繁忙”提示时，请立即通过 `ctrl + shift + R` 刷新缓存，以及 `F5` 强制刷新。

- 建议遵循适度使用和非必要不使用的准则。使用过程中您可随时选择关闭该脚本。由使用此脚本导致的任何问题请自行承担风险。

- 欢迎反馈问题和建议！

## TODO List

📋 **功能扩展计划**

- ☐ 


**⭐ 如果这个脚本对您有帮助，请给个 Star 支持一下！(\*╹▽╹\*)**

(P.S.引流:欢迎关注B站 Hronrad)