from flask import Flask, request, jsonify
from flask_cors import CORS
import ddddocr
import base64

app = Flask(__name__)
CORS(app)  # 允许所有来源跨域

# 初始化ddddocr
ocr = ddddocr.DdddOcr(show_ad=False)

@app.route('/ocr', methods=['POST'])
def ocr_api():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': '缺少图像数据'}), 400
            
        img_b64 = data.get('image', '')
        img_bytes = base64.b64decode(img_b64)
        text = ocr.classification(img_bytes)
        
        # 清理结果，只保留字母和数字
        clean_text = ''.join(c for c in text if c.isalnum())
        
        print(f"识别结果: '{text}' -> '{clean_text}'")
        return jsonify({'text': clean_text})
        
    except Exception as e:
        print(f"OCR识别错误: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'OK'})

if __name__ == '__main__':
    print("启动ddddocr验证码识别服务...")
    print("服务地址: http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=False)