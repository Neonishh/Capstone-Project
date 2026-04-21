import sys
import os
from ultralytics import YOLO

def main():
    if len(sys.argv) < 2:
        print("Error: No screenshot path provided")
        return
    
    img_path = sys.argv[1]
    if not os.path.exists(img_path):
        print(f"Error: File {img_path} not found")
        return

    try:
        model = YOLO('yolov8n.pt') # Ensure you have a model file
        results = model(img_path)
        print(results[0].tojson())
    except Exception as e:
        print(f"Vision Processing Failed: {str(e)}")

if __name__ == '__main__':
    main()
